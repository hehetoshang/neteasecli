/** 播放器抽象接口：mpv / 小爱音箱两种后端实现同一接口 */

export interface PlayerStatus {
  title?: string;
  position: number;
  duration: number;
  paused: boolean;
  playing: boolean;
  volume: number;
  loop: string;
}

export interface PlayerPlayOptions {
  loop?: boolean;
}

export interface Player {
  /** 播放音频 URL（替换当前播放） */
  play(url: string, title?: string, options?: PlayerPlayOptions): Promise<void>;
  /** 切换暂停/恢复 */
  pause(): Promise<void>;
  /** 停止播放 */
  stop(): Promise<void>;
  /** 跳转进度（relative 相对 / absolute 绝对，秒） */
  seek(seconds: number, mode?: 'relative' | 'absolute'): Promise<void>;
  setVolume(volume: number): Promise<void>;
  getVolume(): Promise<number>;
  setLoop(mode: 'no' | 'inf' | 'force'): Promise<void>;
  getLoop(): Promise<string>;
  getStatus(): Promise<PlayerStatus>;
  isRunning(): Promise<boolean>;
}
