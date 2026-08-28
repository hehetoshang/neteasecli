import assert from 'node:assert/strict';

import { setNoColor } from '../dist/output/color.js';
import { output, setOutputMode } from '../dist/output/json.js';

function capture(callback) {
  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    callback();
  } finally {
    console.log = original;
  }
  return lines;
}

setNoColor(true);

setOutputMode('plain');
const plain = capture(() => {
  output({
    tracks: [
      {
        id: '1',
        name: 'Song',
        artists: [{ name: 'Artist' }],
        album: { id: '10', name: 'Album' },
        uri: 'netease:track:1',
      },
    ],
  });
  output({
    playlists: [{ id: '2', name: 'Mix', trackCount: 3, creator: { id: '20', name: 'Owner' } }],
  });
  output({ albums: [{ id: '3', name: 'Record' }] });
  output({ artists: [{ id: '4', name: 'Singer' }] });
  output({ tracks: [{ id: '5', name: 'Queued', artist: '' }] });
});

assert.deepEqual(plain, [
  '1\tSong\tArtist\tAlbum\tnetease:track:1',
  '2\tMix\t3\tOwner',
  '3\tRecord',
  '4\tSinger',
  '5\tQueued\t\t\t',
]);
assert.doesNotMatch(plain.join('\n'), /\[object Object\]|undefined/);

setOutputMode('human');
const human = capture(() => {
  output({ albums: [{ id: '3', name: 'Record' }] });
  output({ artists: [{ id: '4', name: 'Singer' }] });
});
assert.match(human[0], /Record/);
assert.match(human[1], /Singer/);

console.log('output mode tests passed');
