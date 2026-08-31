import { Command } from 'commander';
import { getAccountPlaylists, getPlaylistBySelector, getPlaylistDetail } from '../api/playlist.js';
import { output, outputError } from '../output/json.js';
import { ExitCode } from '../types/index.js';
import type { Quality } from '../types/index.js';
import { getQueueController } from '../player/queue.js';
import { buildQueueTracks, shuffled } from '../player/queue-tracks.js';

export function createPlaylistCommand(): Command {
  const playlist = new Command('playlist').description('Playlists');

  playlist
    .command('play')
    .description('Continuously play a playlist')
    .argument('<selector>', 'Playlist ID, account playlist name, or liked/我喜欢的音乐/我的收藏')
    .option('-l, --limit <number>', 'Track count limit')
    .option('--shuffle', 'Shuffle before playback')
    .option('-q, --quality <level>', 'Quality: standard/higher/exhigh/lossless/hires', 'exhigh')
    .action(async (selector: string, options) => {
      try {
        const detail = await getPlaylistBySelector(selector);
        let tracks = detail.tracks || [];
        if (options.limit !== undefined) {
          const limit = Number.parseInt(options.limit, 10);
          if (!Number.isInteger(limit) || limit < 1)
            throw new Error('Limit must be a positive integer');
          tracks = tracks.slice(0, limit);
        }
        if (options.shuffle) tracks = shuffled(tracks);
        const built = await buildQueueTracks(tracks, options.quality as Quality);
        if (built.tracks.length === 0) throw new Error('This playlist has no playable tracks');
        const queue = await getQueueController().start(built.tracks);
        output({
          playlist: { id: detail.id, name: detail.name },
          current: queue.current,
          queued: queue.tracks.length,
          skipped: built.skipped,
          shuffle: Boolean(options.shuffle),
          quality: options.quality,
          message: `Playing playlist ${detail.name}: ${queue.current?.title} (${queue.tracks.length} queued)`,
        });
      } catch (error) {
        outputError('PLAYER_ERROR', error instanceof Error ? error.message : 'Playback failed');
        process.exit(ExitCode.GENERAL_ERROR);
      }
    });

  playlist
    .command('list')
    .description('List my playlists')
    .action(async () => {
      try {
        const playlists = await getAccountPlaylists();
        output({
          playlists: playlists.map((p) => ({
            id: p.id,
            name: p.name,
            trackCount: p.trackCount,
            kind: p.kind,
            owned: p.owned,
            subscribed: p.subscribed,
            aliases: p.aliases,
            creator: p.creator?.name,
          })),
          total: playlists.length,
        });
      } catch (error) {
        outputError('PLAYLIST_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.NETWORK_ERROR);
      }
    });

  playlist
    .command('detail')
    .description('Playlist details')
    .argument('<id>', 'Playlist ID')
    .option('-l, --limit <number>', 'Track count limit', '50')
    .action(async (id: string, options) => {
      try {
        const detail = await getPlaylistDetail(id);
        const limit = parseInt(options.limit);
        output({
          id: detail.id,
          name: detail.name,
          description: detail.description,
          coverUrl: detail.coverUrl,
          trackCount: detail.trackCount,
          creator: detail.creator,
          tracks: detail.tracks?.slice(0, limit).map((t) => ({
            id: t.id,
            name: t.name,
            artist: t.artists.map((a) => a.name).join(', '),
            album: t.album.name,
            duration: t.duration,
            uri: t.uri,
          })),
        });
      } catch (error) {
        outputError('PLAYLIST_ERROR', error instanceof Error ? error.message : 'Failed');
        process.exit(ExitCode.NETWORK_ERROR);
      }
    });

  return playlist;
}
