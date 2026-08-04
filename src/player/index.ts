/** 播放器工厂：按环境变量选择后端（mpv 默认 / xiaoai 小爱音箱） */

import type { Player } from './types.js';
import { mpvPlayer } from './mpv.js';
import { XiaoAiPlayer } from './xiaoai.js';

let cached: Player | null = null;

export function getPlayer(): Player {
  if (cached) {
    return cached;
  }
  const backend = (process.env.NETEASECLI_PLAYER || 'mpv').toLowerCase();
  cached = backend === 'xiaoai' ? new XiaoAiPlayer() : mpvPlayer;
  return cached;
}
