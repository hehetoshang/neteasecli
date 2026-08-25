import assert from 'node:assert/strict';

import { QueueController, emptyQueueState } from '../dist/player/queue.js';

class MemoryStore {
  state = emptyQueueState(0);

  async read() {
    return structuredClone(this.state);
  }

  async write(state) {
    this.state = structuredClone(state);
  }

  async withLock(operation) {
    return operation();
  }
}

class FakePlayer {
  played = [];
  status = {
    position: 0,
    duration: 180,
    paused: false,
    playing: false,
    volume: 100,
    loop: 'no',
  };

  async play(url, title) {
    this.played.push({ url, title });
    this.status = { ...this.status, title, playing: true, paused: false, position: 0 };
  }

  async pause() {
    this.status.paused = !this.status.paused;
  }

  async stop() {
    this.status.playing = false;
    this.status.paused = false;
  }

  async seek(seconds, mode = 'relative') {
    this.status.position = mode === 'absolute' ? seconds : this.status.position + seconds;
  }

  async setVolume(volume) {
    this.status.volume = volume;
  }

  async getVolume() {
    return this.status.volume;
  }

  async setLoop(mode) {
    this.status.loop = mode;
  }

  async getLoop() {
    return this.status.loop;
  }

  async getStatus() {
    return { ...this.status };
  }

  async isRunning() {
    return this.status.playing;
  }

  finishNaturally() {
    this.status.playing = false;
    this.status.paused = false;
  }
}

const queueTracks = ['a', 'b', 'c'].map((id) => ({
  id,
  title: `Track ${id.toUpperCase()}`,
  url: `https://example.test/${id}.mp3`,
  quality: 'exhigh',
  duration: 180_000,
  resolvedAt: 1_000,
}));

function setup() {
  const player = new FakePlayer();
  const store = new MemoryStore();
  let now = 1_000;
  const controller = new QueueController(player, store, {
    now: () => now,
    resolveUrl: async (id) => `https://example.test/refreshed-${id}.mp3`,
  });
  return { player, store, controller, advanceClock: (ms) => (now += ms) };
}

{
  const { player, controller } = setup();
  await controller.start(queueTracks);
  assert.deepEqual(player.played.map((item) => item.title), ['Track A']);

  player.finishNaturally();
  const afterFirst = await controller.sync();
  assert.equal(afterFirst.currentIndex, 1);
  assert.equal(afterFirst.current.id, 'b');
  assert.deepEqual(afterFirst.history, ['a']);

  player.finishNaturally();
  const afterSecond = await controller.sync();
  assert.equal(afterSecond.current.id, 'c');
  assert.deepEqual(player.played.map((item) => item.title), ['Track A', 'Track B', 'Track C']);
}

{
  const { player, controller } = setup();
  await controller.setRepeat(true);
  await controller.start(queueTracks.slice(0, 2));
  assert.equal((await controller.getSnapshot()).repeat, true);
  player.finishNaturally();
  const repeated = await controller.sync();
  assert.equal(repeated.currentIndex, 0);
  assert.deepEqual(player.played.map((item) => item.title), ['Track A', 'Track A']);

  await controller.setRepeat(false);
  player.finishNaturally();
  assert.equal((await controller.sync()).current.id, 'b');
}

{
  const { player, controller } = setup();
  await controller.start(queueTracks.slice(0, 2));
  await controller.pause();
  assert.equal((await controller.sync()).current.id, 'a');
  assert.deepEqual(player.played.map((item) => item.title), ['Track A']);
}

{
  const { player, controller } = setup();
  await controller.start(queueTracks.slice(0, 2));
  assert.equal((await controller.next()).id, 'b');
  assert.equal(await controller.next(), null);
  const finished = await controller.getSnapshot();
  assert.equal(finished.status, 'finished');
  assert.equal(finished.current.id, 'b');
  assert.equal(player.status.playing, false);
}

{
  const { controller } = setup();
  await controller.start(queueTracks);
  await assert.rejects(() => controller.previous(), /beginning/);
  await controller.next();
  assert.equal((await controller.previous()).id, 'a');
  assert.deepEqual((await controller.getSnapshot()).history, []);
}

{
  const { controller, advanceClock } = setup();
  await controller.start(queueTracks.slice(0, 1));
  advanceClock(11 * 60 * 1000);
  await controller.play(0);
  assert.match((await controller.getSnapshot()).current.url, /refreshed-a/);
  assert.equal((await controller.stop()).status, 'stopped');
  assert.equal((await controller.clear()).tracks.length, 0);
}

console.log('player queue tests passed');
