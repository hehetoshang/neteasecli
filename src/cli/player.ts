import { Command } from 'commander';
import { getPlayer } from '../player/index.js';
import { getQueueController } from '../player/queue.js';
import { buildQueueTracks } from '../player/queue-tracks.js';
import { getTrackDetails } from '../api/track.js';
import { output, outputError } from '../output/json.js';
import { ExitCode, type Quality } from '../types/index.js';

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

async function requireRunning(): Promise<void> {
  const status = await getQueueController().getStatus();
  if (!status.player.playing) {
    outputError('PLAYER_ERROR', 'Nothing is playing');
    process.exit(ExitCode.GENERAL_ERROR);
  }
}

export function createPlayerCommand(): Command {
  const player = new Command('player').description('Playback control');

  player
    .command('status')
    .description('Current playback status')
    .action(async () => {
      try {
        const { player: status, queue } = await getQueueController().getStatus();
        if (!status.playing) {
          output({
            playing: false,
            queueStatus: queue.status,
            current: queue.current,
            queueLength: queue.tracks.length,
            message: 'Nothing is playing',
          });
          return;
        }
        const repeat = status.loop !== 'no' && status.loop !== 'false';
        output({
          playing: true,
          paused: status.paused,
          title: status.title,
          position: status.position,
          duration: status.duration,
          positionFormatted: formatTime(status.position),
          durationFormatted: formatTime(status.duration),
          volume: Math.round(status.volume),
          repeat,
          currentIndex: queue.currentIndex,
          queueLength: queue.tracks.length,
          remaining: queue.remaining,
          message: `${status.paused ? '⏸' : '▶'} ${status.title || 'Unknown'} ${formatTime(status.position)}/${formatTime(status.duration)} vol:${Math.round(status.volume)}%${repeat ? ' 🔁' : ''}`,
        });
      } catch (error) {
        outputError('PLAYER_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  player
    .command('pause')
    .description('Toggle pause/resume')
    .action(async () => {
      try {
        await requireRunning();
        const status = await getQueueController().pause();
        output({
          paused: status.paused,
          message: status.paused ? 'Paused' : 'Resumed',
        });
      } catch (error) {
        outputError('PLAYER_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  player
    .command('stop')
    .description('Stop playback')
    .action(async () => {
      try {
        await getQueueController().stop();
        output({ message: 'Stopped' });
      } catch (error) {
        outputError('PLAYER_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  player
    .command('seek <seconds>')
    .description('Seek by relative seconds (e.g. 10, -10) or absolute with --absolute')
    .option('--absolute', 'Seek to absolute position')
    .action(async (seconds: string, opts: { absolute?: boolean }) => {
      try {
        await requireRunning();
        const secs = Number(seconds);
        if (isNaN(secs)) {
          outputError('PLAYER_ERROR', 'Invalid seconds value');
          process.exit(ExitCode.GENERAL_ERROR);
          return;
        }
        await getPlayer().seek(secs, opts.absolute ? 'absolute' : 'relative');
        const status = await getPlayer().getStatus();
        output({
          position: status.position,
          duration: status.duration,
          positionFormatted: formatTime(status.position),
          durationFormatted: formatTime(status.duration),
          message: `Seeked to ${formatTime(status.position)}/${formatTime(status.duration)}`,
        });
      } catch (error) {
        outputError('PLAYER_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  player
    .command('volume [level]')
    .description('Get or set volume (0-150)')
    .action(async (level?: string) => {
      try {
        await requireRunning();
        if (level !== undefined) {
          const vol = Number(level);
          if (isNaN(vol)) {
            outputError('PLAYER_ERROR', 'Invalid volume value');
            process.exit(ExitCode.GENERAL_ERROR);
            return;
          }
          await getPlayer().setVolume(vol);
          output({ volume: vol, message: `Volume: ${vol}%` });
        } else {
          const vol = await getPlayer().getVolume();
          output({ volume: vol, message: `Volume: ${Math.round(vol)}%` });
        }
      } catch (error) {
        outputError('PLAYER_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  player
    .command('repeat [mode]')
    .description('Toggle or set repeat mode (off/on)')
    .action(async (mode?: string) => {
      try {
        await requireRunning();
        if (mode !== undefined) {
          if (mode !== 'on' && mode !== 'off') throw new Error('Repeat mode must be on or off');
          await getQueueController().setRepeat(mode === 'on');
          output({ repeat: mode === 'on', message: `Repeat: ${mode}` });
        } else {
          const current = await getQueueController().getSnapshot();
          const isOn = current.repeat;
          await getQueueController().setRepeat(!isOn);
          output({ repeat: !isOn, message: `Repeat: ${!isOn ? 'on' : 'off'}` });
        }
      } catch (error) {
        outputError('PLAYER_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  player
    .command('next')
    .description('Play the next track in the queue')
    .action(async () => {
      try {
        const current = await getQueueController().next();
        output({
          current,
          finished: current === null,
          message: current ? `Now playing: ${current.title}` : 'End of queue',
        });
      } catch (error) {
        outputError('QUEUE_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  player
    .command('previous')
    .alias('prev')
    .description('Play the previous track in the queue')
    .action(async () => {
      try {
        const current = await getQueueController().previous();
        output({ current, message: `Now playing: ${current.title}` });
      } catch (error) {
        outputError('QUEUE_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  const queue = player
    .command('queue')
    .description('View and manage the playback queue')
    .action(async () => {
      try {
        const snapshot = await getQueueController().sync();
        output({
          status: snapshot.status,
          currentIndex: snapshot.currentIndex,
          current: snapshot.current,
          remaining: snapshot.remaining,
          repeat: snapshot.repeat,
          history: snapshot.history,
          tracks: snapshot.tracks.map((track, index) => ({
            ...track,
            position: index + 1,
            current: index === snapshot.currentIndex,
            name: `${index === snapshot.currentIndex ? '▶ ' : ''}${track.title}`,
            artist: '',
          })),
          total: snapshot.tracks.length,
          showing: snapshot.tracks.length,
        });
      } catch (error) {
        outputError('QUEUE_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  queue
    .command('add')
    .description('Add one or more track IDs to the queue')
    .argument('<ids...>', 'Track IDs')
    .option('-q, --quality <level>', 'Quality: standard/higher/exhigh/lossless/hires', 'exhigh')
    .action(async (ids: string[], options) => {
      try {
        const details = await getTrackDetails(ids);
        const detailsById = new Map(details.map((track) => [track.id, track]));
        const ordered = ids.flatMap((id) => {
          const track = detailsById.get(id);
          return track ? [track] : [];
        });
        const built = await buildQueueTracks(ordered, options.quality as Quality);
        if (built.tracks.length === 0) throw new Error('No playable tracks were found');
        const snapshot = await getQueueController().add(built.tracks);
        output({
          added: built.tracks.length,
          skipped: built.skipped,
          queueLength: snapshot.tracks.length,
          message: `Added ${built.tracks.length} track(s) to the queue`,
        });
      } catch (error) {
        outputError('QUEUE_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  queue
    .command('remove')
    .description('Remove a track by its 1-based queue position')
    .argument('<position>', 'Queue position')
    .action(async (position: string) => {
      try {
        const index = Number.parseInt(position, 10) - 1;
        const snapshot = await getQueueController().remove(index);
        output({
          queueLength: snapshot.tracks.length,
          message: `Removed queue position ${position}`,
        });
      } catch (error) {
        outputError('QUEUE_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  queue
    .command('clear')
    .description('Stop playback and clear the queue')
    .action(async () => {
      try {
        await getQueueController().clear();
        output({ message: 'Playback queue cleared' });
      } catch (error) {
        outputError('QUEUE_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  queue
    .command('play')
    .description('Start or resume the queue at a 1-based position')
    .argument('[position]', 'Queue position')
    .action(async (position?: string) => {
      try {
        const index = position === undefined ? undefined : Number.parseInt(position, 10) - 1;
        const snapshot = await getQueueController().play(index);
        output({ current: snapshot.current, message: `Now playing: ${snapshot.current?.title}` });
      } catch (error) {
        outputError('QUEUE_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  return player;
}
