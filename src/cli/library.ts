import { Command } from 'commander';
import { getLikedTrackIds, likeTrack, getRecentTracks } from '../api/user.js';
import { getTrackDetails } from '../api/track.js';
import { output, outputError } from '../output/json.js';
import { ExitCode } from '../types/index.js';
import type { Quality } from '../types/index.js';
import { getQueueController } from '../player/queue.js';
import { buildQueueTracks, shuffled } from '../player/queue-tracks.js';

export function createLibraryCommand(): Command {
  const library = new Command('library').description('User library');

  library
    .command('play-liked')
    .description('Continuously play liked tracks')
    .option('-l, --limit <number>', 'Track count limit', '50')
    .option('--shuffle', 'Shuffle before playback')
    .option('-q, --quality <level>', 'Quality: standard/higher/exhigh/lossless/hires', 'exhigh')
    .action(async (options) => {
      try {
        const limit = parsePositiveLimit(options.limit);
        const ids = await getLikedTrackIds();
        const selectedIds = ids.slice(0, limit);
        if (selectedIds.length === 0) throw new Error('No liked tracks found');
        const details = await getTrackDetails(selectedIds);
        const detailsById = new Map(details.map((track) => [track.id, track]));
        const ordered = selectedIds.flatMap((id) => {
          const track = detailsById.get(id);
          return track ? [track] : [];
        });
        const source = options.shuffle ? shuffled(ordered) : ordered;
        const built = await buildQueueTracks(source, options.quality as Quality);
        if (built.tracks.length === 0) throw new Error('None of the liked tracks are playable');
        const queue = await getQueueController().start(built.tracks);
        output({
          current: queue.current,
          queued: queue.tracks.length,
          skipped: built.skipped,
          shuffle: Boolean(options.shuffle),
          quality: options.quality,
          message: `Playing liked tracks: ${queue.current?.title} (${queue.tracks.length} queued)`,
        });
      } catch (error) {
        outputError('PLAYER_ERROR', error instanceof Error ? error.message : 'Playback failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  library
    .command('liked')
    .description('Liked tracks')
    .option('-l, --limit <number>', 'Limit', '50')
    .action(async (options) => {
      try {
        const ids = await getLikedTrackIds();
        const limit = parseInt(options.limit);
        const limitedIds = ids.slice(0, limit);

        if (limitedIds.length === 0) {
          output({ tracks: [], total: 0 });
          return;
        }

        const tracks = await getTrackDetails(limitedIds);
        output({
          tracks: tracks.map((t) => ({
            id: t.id,
            name: t.name,
            artist: t.artists.map((a) => a.name).join(', '),
            album: t.album.name,
            uri: t.uri,
          })),
          total: ids.length,
          showing: limitedIds.length,
        });
      } catch (error) {
        outputError('LIBRARY_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.NETWORK_ERROR);
      }
    });

  library
    .command('like')
    .description('Like a track')
    .argument('<track_id>', 'Track ID')
    .action(async (trackId: string) => {
      try {
        await likeTrack(trackId, true);
        output({ message: 'Liked', trackId });
      } catch (error) {
        outputError('LIBRARY_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.NETWORK_ERROR);
      }
    });

  library
    .command('unlike')
    .description('Unlike a track')
    .argument('<track_id>', 'Track ID')
    .action(async (trackId: string) => {
      try {
        await likeTrack(trackId, false);
        output({ message: 'Unliked', trackId });
      } catch (error) {
        outputError('LIBRARY_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.NETWORK_ERROR);
      }
    });

  library
    .command('recent')
    .description('Recently played')
    .option('-l, --limit <number>', 'Limit', '50')
    .action(async (options) => {
      try {
        const limit = parseInt(options.limit);
        const tracks = await getRecentTracks(limit);
        output({
          tracks: tracks.map((t) => ({
            id: t.id,
            name: t.name,
            artist: t.artists.map((a) => a.name).join(', '),
            album: t.album.name,
            uri: t.uri,
          })),
          total: tracks.length,
        });
      } catch (error) {
        outputError('LIBRARY_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.NETWORK_ERROR);
      }
    });

  return library;
}

function parsePositiveLimit(value: string): number {
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Limit must be a positive integer');
  return limit;
}
