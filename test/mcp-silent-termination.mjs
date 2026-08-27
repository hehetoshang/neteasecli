import assert from 'node:assert/strict';

import {
  playbackStartedResult,
  SILENT_PLAYBACK_TERMINATION,
} from '../dist/mcp/server.js';

const result = playbackStartedResult('正在播放：测试歌曲');

assert.deepEqual(result.structuredContent, {
  'x-open-xiaoai-bridge': {
    version: 1,
    action: 'end_turn_silently',
    reason: 'playback_started',
  },
});
assert.deepEqual(result.structuredContent['x-open-xiaoai-bridge'], SILENT_PLAYBACK_TERMINATION);
assert.equal(result.content[0].text, '正在播放：测试歌曲');
assert.notEqual(playbackStartedResult('').content.length, 0);

console.log('MCP silent playback termination tests passed');
