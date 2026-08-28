import { getTrackUrl } from '../api/track.js';
import type { Quality, Track } from '../types/index.js';
import type { QueueTrack } from './queue.js';

export interface QueueTrackBuildResult {
  tracks: QueueTrack[];
  skipped: { id: string; reason: string }[];
}

export async function buildQueueTracks(
  sourceTracks: Track[],
  quality: Quality,
): Promise<QueueTrackBuildResult> {
  const resolvedAt = Date.now();
  const results: PromiseSettledResult<QueueTrack>[] = new Array(sourceTracks.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(8, sourceTracks.length) }, async () => {
    while (nextIndex < sourceTracks.length) {
      const index = nextIndex++;
      const track = sourceTracks[index];
      try {
        results[index] = {
          status: 'fulfilled',
          value: {
            id: track.id,
            title: `${track.name} - ${track.artists.map((artist) => artist.name).join('/')}`,
            url: await getTrackUrl(track.id, quality),
            quality,
            duration: track.duration,
            resolvedAt,
          },
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);

  const tracks: QueueTrack[] = [];
  const skipped: { id: string; reason: string }[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      tracks.push(result.value);
    } else {
      skipped.push({
        id: sourceTracks[index].id,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
  return { tracks, skipped };
}

export function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapWith]] = [result[swapWith], result[index]];
  }
  return result;
}
