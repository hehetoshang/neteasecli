import assert from 'node:assert/strict';

import {
  BRIDGE_CONTROL_KEY,
  playbackStartedResult,
} from '../dist/mcp/result-signals.js';

const result = playbackStartedResult('正在播放：测试歌曲');

assert.equal(result.isError, undefined);
assert.equal(result.content[0].text, '正在播放：测试歌曲');
assert.deepEqual(result.structuredContent, {
  [BRIDGE_CONTROL_KEY]: {
    version: 1,
    action: 'end_turn_silently',
    reason: 'playback_started',
  },
});

console.log('MCP playback signal tests passed');
