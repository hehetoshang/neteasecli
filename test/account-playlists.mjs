import assert from 'node:assert/strict';

import {
  classifyAccountPlaylist,
  resolveAccountPlaylist,
} from '../dist/api/playlist.js';

const userId = '42';
const liked = classifyAccountPlaylist(
  {
    id: 100,
    name: '我喜欢的音乐',
    trackCount: 8,
    specialType: 5,
    creator: { userId: 42, nickname: 'me' },
  },
  userId,
);
const created = classifyAccountPlaylist(
  {
    id: 101,
    name: '通勤',
    trackCount: 12,
    creator: { userId: 42, nickname: 'me' },
  },
  userId,
);
const subscribed = classifyAccountPlaylist(
  {
    id: 102,
    name: '收藏歌单',
    trackCount: 20,
    subscribed: true,
    creator: { userId: 7, nickname: 'other' },
  },
  userId,
);

assert.equal(liked.kind, 'liked');
assert.equal(liked.owned, true);
assert.deepEqual(liked.aliases, ['liked', '我喜欢的音乐', '我的收藏']);
assert.equal(created.kind, 'created');
assert.equal(created.subscribed, false);
assert.equal(subscribed.kind, 'subscribed');
assert.equal(subscribed.subscribed, true);

const playlists = [liked, created, subscribed];
assert.equal(resolveAccountPlaylist(playlists, 'liked').id, '100');
assert.equal(resolveAccountPlaylist(playlists, '我的收藏').id, '100');
assert.equal(resolveAccountPlaylist(playlists, 'netease:playlist:101').id, '101');
assert.equal(resolveAccountPlaylist(playlists, '通勤').id, '101');

assert.throws(
  () => resolveAccountPlaylist([...playlists, { ...created, id: '103' }], '通勤'),
  (error) => error.code === 'PLAYLIST_AMBIGUOUS' && error.message.includes('use a playlist ID'),
);
assert.throws(
  () => resolveAccountPlaylist(playlists, '不存在'),
  (error) => error.code === 'PLAYLIST_NOT_FOUND',
);

console.log('Account playlist tests passed');
