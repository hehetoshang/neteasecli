import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getProfile } from '../auth/storage.js';
import { getTrackUrl } from '../api/track.js';
import type { Quality } from '../types/index.js';
import { getPlayer } from './index.js';
import type { Player, PlayerStatus } from './types.js';

export interface QueueTrack {
  id: string;
  title: string;
  url: string;
  quality: Quality;
  duration?: number;
  resolvedAt: number;
}

export type QueuePlaybackStatus = 'idle' | 'playing' | 'paused' | 'stopped' | 'finished';

export interface QueueState {
  version: 1;
  tracks: QueueTrack[];
  currentIndex: number | null;
  history: string[];
  status: QueuePlaybackStatus;
  repeat: boolean;
  updatedAt: number;
}

export interface QueueStore {
  read(): Promise<QueueState>;
  write(state: QueueState): Promise<void>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

export interface QueueSnapshot extends QueueState {
  current: QueueTrack | null;
  remaining: number;
}

interface QueueControllerOptions {
  resolveUrl?: (id: string, quality: Quality) => Promise<string>;
  now?: () => number;
  urlMaxAgeMs?: number;
  onActive?: () => void;
}

const URL_MAX_AGE_MS = 10 * 60 * 1000;
const LOCK_TIMEOUT_MS = 30_000;

export function emptyQueueState(now: number = Date.now()): QueueState {
  return {
    version: 1,
    tracks: [],
    currentIndex: null,
    history: [],
    status: 'idle',
    repeat: false,
    updatedAt: now,
  };
}

export class FileQueueStore implements QueueStore {
  constructor(
    private readonly stateFile: string,
    private readonly lockFile: string = `${stateFile}.lock`,
  ) {}

  async read(): Promise<QueueState> {
    try {
      const content = await fs.promises.readFile(this.stateFile, 'utf8');
      const state = JSON.parse(content) as QueueState;
      if (state.version !== 1 || !Array.isArray(state.tracks)) return emptyQueueState();
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyQueueState();
      throw error;
    }
  }

  async write(state: QueueState): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporaryFile = `${this.stateFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.promises.rename(temporaryFile, this.stateFile);
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.promises.mkdir(path.dirname(this.lockFile), { recursive: true });
    const startedAt = Date.now();
    let handle: fs.promises.FileHandle | undefined;

    while (!handle) {
      try {
        handle = await fs.promises.open(this.lockFile, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await this.removeStaleLock()) continue;
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error('Timed out waiting for the playback queue lock');
        }
        await delay(50);
      }
    }

    try {
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      await fs.promises.unlink(this.lockFile).catch(() => {});
    }
  }

  private async removeStaleLock(): Promise<boolean> {
    try {
      const [pidText, stat] = await Promise.all([
        fs.promises.readFile(this.lockFile, 'utf8'),
        fs.promises.stat(this.lockFile),
      ]);
      const pid = Number(pidText);
      const tooOld = Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS;
      if (!tooOld && Number.isInteger(pid) && isProcessAlive(pid)) return false;
      await fs.promises.unlink(this.lockFile);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }
}

export class QueueController {
  private readonly resolveUrl: (id: string, quality: Quality) => Promise<string>;
  private readonly now: () => number;
  private readonly urlMaxAgeMs: number;
  private readonly onActive?: () => void;

  constructor(
    private readonly player: Player,
    private readonly store: QueueStore,
    options: QueueControllerOptions = {},
  ) {
    this.resolveUrl = options.resolveUrl || getTrackUrl;
    this.now = options.now || Date.now;
    this.urlMaxAgeMs = options.urlMaxAgeMs ?? URL_MAX_AGE_MS;
    this.onActive = options.onActive;
  }

  async start(tracks: QueueTrack[], startIndex: number = 0): Promise<QueueSnapshot> {
    if (tracks.length === 0) throw new Error('Cannot play an empty queue');
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= tracks.length) {
      throw new Error('Queue start index is out of range');
    }

    const snapshot = await this.store.withLock(async () => {
      const previous = await this.store.read();
      const state: QueueState = {
        version: 1,
        tracks: tracks.map((track) => ({ ...track })),
        currentIndex: startIndex,
        history: tracks.slice(0, startIndex).map((track) => track.id),
        status: 'playing',
        repeat: previous.repeat,
        updatedAt: this.now(),
      };
      await this.playCurrent(state);
      await this.save(state);
      return toSnapshot(state);
    });
    this.onActive?.();
    return snapshot;
  }

  async playSingle(track: QueueTrack): Promise<QueueSnapshot> {
    return this.start([track]);
  }

  async add(tracks: QueueTrack[]): Promise<QueueSnapshot> {
    if (tracks.length === 0) throw new Error('No tracks to add');
    return this.store.withLock(async () => {
      const state = await this.store.read();
      state.tracks.push(...tracks.map((track) => ({ ...track })));
      state.updatedAt = this.now();
      await this.store.write(state);
      return toSnapshot(state);
    });
  }

  async play(index?: number): Promise<QueueSnapshot> {
    const snapshot = await this.store.withLock(async () => {
      const state = await this.store.read();
      if (state.tracks.length === 0) throw new Error('The playback queue is empty');
      const target = index ?? state.currentIndex ?? 0;
      if (!Number.isInteger(target) || target < 0 || target >= state.tracks.length) {
        throw new Error('Queue index is out of range');
      }
      state.currentIndex = target;
      state.history = state.tracks.slice(0, target).map((track) => track.id);
      state.status = 'playing';
      await this.playCurrent(state);
      await this.save(state);
      return toSnapshot(state);
    });
    this.onActive?.();
    return snapshot;
  }

  async next(): Promise<QueueTrack | null> {
    const current = await this.store.withLock(async () => {
      const state = await this.store.read();
      const track = await this.advance(state);
      await this.save(state);
      return track;
    });
    if (current) this.onActive?.();
    return current;
  }

  async previous(): Promise<QueueTrack> {
    const current = await this.store.withLock(async () => {
      const state = await this.store.read();
      if (state.currentIndex === null || state.tracks.length === 0) {
        throw new Error('The playback queue is empty');
      }
      if (state.currentIndex === 0) throw new Error('Already at the beginning of the queue');
      state.currentIndex -= 1;
      state.history.pop();
      state.status = 'playing';
      await this.playCurrent(state);
      await this.save(state);
      return state.tracks[state.currentIndex];
    });
    this.onActive?.();
    return current;
  }

  async pause(): Promise<PlayerStatus> {
    return this.store.withLock(async () => {
      const state = await this.store.read();
      if (state.status !== 'playing' && state.status !== 'paused') {
        throw new Error('Nothing is playing');
      }
      await this.player.pause();
      const status = await this.player.getStatus();
      state.status = status.paused ? 'paused' : 'playing';
      await this.save(state);
      return status;
    });
  }

  async stop(): Promise<QueueSnapshot> {
    return this.store.withLock(async () => {
      const state = await this.store.read();
      await this.player.stop();
      state.status = state.tracks.length > 0 ? 'stopped' : 'idle';
      await this.save(state);
      return toSnapshot(state);
    });
  }

  async clear(): Promise<QueueSnapshot> {
    return this.store.withLock(async () => {
      const previous = await this.store.read();
      await this.player.stop();
      const state = emptyQueueState(this.now());
      state.repeat = previous.repeat;
      await this.store.write(state);
      return toSnapshot(state);
    });
  }

  async remove(index: number): Promise<QueueSnapshot> {
    const result = await this.store.withLock(async () => {
      const state = await this.store.read();
      if (!Number.isInteger(index) || index < 0 || index >= state.tracks.length) {
        throw new Error('Queue index is out of range');
      }
      const wasActive = state.status === 'playing' || state.status === 'paused';
      const wasCurrent = state.currentIndex === index;
      state.tracks.splice(index, 1);

      if (state.tracks.length === 0) {
        await this.player.stop();
        state.currentIndex = null;
        state.history = [];
        state.status = 'idle';
      } else if (state.currentIndex !== null && index < state.currentIndex) {
        state.currentIndex -= 1;
      } else if (wasCurrent) {
        state.currentIndex = Math.min(index, state.tracks.length - 1);
        state.history = state.tracks.slice(0, state.currentIndex).map((track) => track.id);
        if (wasActive) {
          state.status = 'playing';
          await this.playCurrent(state);
        }
      }

      await this.save(state);
      return { snapshot: toSnapshot(state), active: wasActive && state.tracks.length > 0 };
    });
    if (result.active) this.onActive?.();
    return result.snapshot;
  }

  async setRepeat(on: boolean): Promise<QueueSnapshot> {
    const snapshot = await this.store.withLock(async () => {
      const state = await this.store.read();
      state.repeat = on;
      if (state.status === 'playing' || state.status === 'paused') {
        const current = state.currentIndex === null ? undefined : state.tracks[state.currentIndex];
        const playerStatus = await this.player.getStatus();
        await this.player.setLoop(
          on ? 'inf' : 'no',
          current
            ? { url: current.url, title: current.title, position: playerStatus.position }
            : undefined,
        );
      }
      await this.save(state);
      return toSnapshot(state);
    });
    if (snapshot.status === 'playing' || snapshot.status === 'paused') this.onActive?.();
    return snapshot;
  }

  async sync(): Promise<QueueSnapshot> {
    const result = await this.store.withLock(async () => {
      const state = await this.store.read();
      if (state.status !== 'playing' && state.status !== 'paused') {
        return { snapshot: toSnapshot(state), active: false };
      }

      const playerStatus = await this.player.getStatus();
      if (playerStatus.playing) {
        state.status = playerStatus.paused ? 'paused' : 'playing';
        await this.save(state);
        return { snapshot: toSnapshot(state), active: true };
      }

      if (state.repeat && state.currentIndex !== null) {
        state.status = 'playing';
        await this.playCurrent(state);
      } else {
        await this.advance(state);
      }
      await this.save(state);
      return {
        snapshot: toSnapshot(state),
        active: state.status === 'playing' || state.status === 'paused',
      };
    });
    return result.snapshot;
  }

  async getSnapshot(): Promise<QueueSnapshot> {
    return toSnapshot(await this.store.read());
  }

  async getStatus(): Promise<{ player: PlayerStatus; queue: QueueSnapshot }> {
    const queue = await this.sync();
    return { player: await this.player.getStatus(), queue };
  }

  private async advance(state: QueueState): Promise<QueueTrack | null> {
    if (state.currentIndex === null || state.tracks.length === 0) {
      throw new Error('The playback queue is empty');
    }
    const current = state.tracks[state.currentIndex];
    if (state.currentIndex >= state.tracks.length - 1) {
      if (state.status === 'finished') return null;
      await this.player.stop();
      state.history.push(current.id);
      state.status = 'finished';
      return null;
    }
    state.history.push(current.id);
    state.currentIndex += 1;
    state.status = 'playing';
    await this.playCurrent(state);
    return state.tracks[state.currentIndex];
  }

  private async playCurrent(state: QueueState): Promise<void> {
    if (state.currentIndex === null) throw new Error('No current queue track');
    const track = state.tracks[state.currentIndex];
    if (!track.url || this.now() - track.resolvedAt >= this.urlMaxAgeMs) {
      track.url = await this.resolveUrl(track.id, track.quality);
      track.resolvedAt = this.now();
    }
    await this.player.play(track.url, track.title, { loop: state.repeat });
    await this.player.setLoop(state.repeat ? 'inf' : 'no');
  }

  private async save(state: QueueState): Promise<void> {
    state.updatedAt = this.now();
    await this.store.write(state);
  }
}

let cachedController: QueueController | undefined;
let cachedProfile: string | undefined;

export function getQueueController(): QueueController {
  const profile = getProfile();
  if (cachedController && cachedProfile === profile) return cachedController;

  const profileDirectory = path.join(os.homedir(), '.config', 'neteasecli', 'profiles', profile);
  const store = new FileQueueStore(path.join(profileDirectory, 'player-queue.json'));
  cachedProfile = profile;
  cachedController = new QueueController(getPlayer(), store, {
    onActive: process.env.NETEASECLI_QUEUE_WORKER === '1' ? undefined : ensureQueueWorker,
  });
  return cachedController;
}

export function ensureQueueWorker(): void {
  const profile = getProfile();
  const profileDirectory = path.join(os.homedir(), '.config', 'neteasecli', 'profiles', profile);
  const pidFile = path.join(profileDirectory, 'queue-worker.pid');
  fs.mkdirSync(profileDirectory, { recursive: true });

  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (Number.isInteger(pid) && isProcessAlive(pid)) return;
  } catch {
    // No live worker.
  }

  const entry = process.argv[1];
  if (!entry) return;
  const args = [...process.execArgv, entry, '--profile', profile, '__queue-worker'];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NETEASECLI_QUEUE_WORKER: '1' },
  });
  if (!child.pid) return;
  fs.writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  child.unref();
}

export async function runQueueWorker(intervalMs: number = 1000): Promise<void> {
  const profile = getProfile();
  const pidFile = path.join(
    os.homedir(),
    '.config',
    'neteasecli',
    'profiles',
    profile,
    'queue-worker.pid',
  );
  const controller = getQueueController();

  try {
    while (true) {
      try {
        const snapshot = await controller.sync();
        if (snapshot.status !== 'playing' && snapshot.status !== 'paused') break;
      } catch {
        const snapshot = await controller.getSnapshot();
        if (snapshot.status !== 'playing' && snapshot.status !== 'paused') break;
      }
      await delay(intervalMs);
    }
  } finally {
    try {
      const recordedPid = Number(await fs.promises.readFile(pidFile, 'utf8'));
      if (recordedPid === process.pid) await fs.promises.unlink(pidFile);
    } catch {
      // Worker file was already replaced or removed.
    }
  }
}

function toSnapshot(state: QueueState): QueueSnapshot {
  const current = state.currentIndex === null ? null : state.tracks[state.currentIndex] || null;
  const remaining =
    state.currentIndex === null
      ? state.tracks.length
      : state.tracks.length - 1 - state.currentIndex;
  return { ...state, tracks: state.tracks.map((track) => ({ ...track })), current, remaining };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
