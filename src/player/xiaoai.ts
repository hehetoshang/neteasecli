/**
 * 小爱音箱播放器后端：通过 open-xiaoai-bridge 的 HTTP API 播放/控制。
 *
 * 播放链路：URL 交给 bridge 中转推流（下载 → 解码 PCM → 推流到音箱），
 * 因此暂停/恢复/seek 全部由 bridge 的 StreamPlayer 管理。
 *
 * 环境变量：
 *   - OPENXIAOAI_BASE_URL: bridge HTTP API 地址（默认 http://127.0.0.1:9092）
 */

import axios from 'axios';
import type { Player, PlayerLoopContext, PlayerPlayOptions, PlayerStatus } from './types.js';
import { bridgeClientConfig } from './bridge-security.js';

// 网易云流 URL 防盗链检查的浏览器 UA
const NET_EASE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';

export class XiaoAiPlayer implements Player {
  private readonly baseUrl: string;
  private readonly client;
  private currentTitle?: string;
  private currentUrl?: string;
  private currentDuration = 0;
  private loop = false;
  private lastStatus: PlayerStatus = {
    position: 0,
    duration: 0,
    paused: false,
    playing: false,
    volume: 100,
    loop: 'no',
  };

  constructor() {
    const config = bridgeClientConfig();
    this.baseUrl = config.baseUrl;
    this.client = axios.create(config.axios);
  }

  async play(url: string, title?: string, options?: PlayerPlayOptions): Promise<void> {
    if (options?.loop !== undefined) this.loop = options.loop;
    const response = await this.client.post(`${this.baseUrl}/api/stream/play`, {
      url,
      loop: this.loop,
      headers: { 'User-Agent': NET_EASE_UA },
    });
    if (!response.data?.success) {
      throw new Error(response.data?.error || 'bridge play failed');
    }
    this.currentTitle = title;
    this.currentUrl = url;
    this.currentDuration = Math.floor((response.data.data?.duration_ms || 0) / 1000);
    this.lastStatus = {
      title: this.currentTitle,
      position: Math.floor((response.data.data?.position_ms || 0) / 1000),
      duration: this.currentDuration,
      paused: false,
      playing: true,
      volume: 100,
      loop: this.loop ? 'inf' : 'no',
    };
  }

  async pause(): Promise<void> {
    const status = await this.getStatus();
    const response = await this.client.post(
      status.paused ? `${this.baseUrl}/api/stream/resume` : `${this.baseUrl}/api/stream/pause`,
    );
    if (!response.data?.success) {
      throw new Error(response.data?.error || 'bridge pause failed');
    }
    this.lastStatus.paused = !status.paused;
  }

  async stop(): Promise<void> {
    await this.client.post(`${this.baseUrl}/api/stream/stop`).catch(() => {});
    this.currentUrl = undefined;
    this.lastStatus = { ...this.lastStatus, playing: false, paused: false, position: 0 };
  }

  async seek(seconds: number, mode: 'relative' | 'absolute' = 'relative'): Promise<void> {
    const status = await this.getStatus();
    const target = mode === 'absolute' ? seconds : (status.position || 0) + seconds;
    if (target < 0) {
      throw new Error('Cannot seek before start');
    }
    const response = await this.client.post(`${this.baseUrl}/api/stream/seek`, {
      position_ms: Math.round(target * 1000),
    });
    if (!response.data?.success) {
      throw new Error(response.data?.error || 'bridge seek failed');
    }
    this.lastStatus.position = target;
  }

  async setVolume(_volume: number): Promise<void> {
    throw new Error('not supported on xiaoai player');
  }

  async getVolume(): Promise<number> {
    throw new Error('not supported on xiaoai player');
  }

  async setLoop(mode: 'no' | 'inf' | 'force', context?: PlayerLoopContext): Promise<void> {
    const loop = mode !== 'no';
    const status = await this.getStatus();
    const currentlyLooping = status.loop !== 'no' && status.loop !== 'false';
    if (currentlyLooping === loop) {
      this.loop = loop;
      return;
    }

    const url = context?.url || this.currentUrl;
    if (status.playing && url) {
      const response = await this.client.post(`${this.baseUrl}/api/stream/play`, {
        url,
        loop,
        start_ms: Math.round((context?.position ?? status.position) * 1000),
        headers: { 'User-Agent': NET_EASE_UA },
      });
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'bridge repeat update failed');
      }
      this.currentUrl = url;
      this.currentTitle = context?.title || this.currentTitle;
      if (status.paused) {
        await this.client.post(`${this.baseUrl}/api/stream/pause`);
        this.lastStatus.paused = true;
      }
    }
    this.loop = loop;
    this.lastStatus.loop = this.loop ? 'inf' : 'no';
  }

  async getLoop(): Promise<string> {
    return this.loop ? 'inf' : 'no';
  }

  async getStatus(): Promise<PlayerStatus> {
    try {
      const response = await this.client.get(`${this.baseUrl}/api/stream/status`);
      const data = response.data?.data;
      if (data) {
        this.loop = Boolean(data.loop);
        this.lastStatus = {
          title: this.currentTitle,
          position: Math.floor((data.position_ms || 0) / 1000),
          duration: Math.floor((data.duration_ms || this.currentDuration) / 1000),
          paused: data.state === 'paused',
          playing: data.state === 'playing' || data.state === 'paused',
          volume: 100,
          loop: data.loop ? 'inf' : 'no',
        };
      }
    } catch {
      // bridge 不可达时返回内存中的最后状态
    }
    return this.lastStatus;
  }

  async isRunning(): Promise<boolean> {
    return (await this.getStatus()).playing;
  }
}
