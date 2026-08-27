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
import type { Player, PlayerStatus } from './types.js';
import { bridgeClientConfig } from './bridge-security.js';

// 网易云流 URL 防盗链检查的浏览器 UA
const NET_EASE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';

function sanitizeBridgeError(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? 'unknown error');
  return text
    .replace(/bearer\s+[a-z0-9._~+/-]+/gi, 'Bearer <redacted>')
    .replace(/(api[_ -]?key|authorization|token)(\s*[:=]\s*)\S+/gi, '$1$2<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function bridgeRequestError(method: string, path: string, error: unknown): Error {
  if (!axios.isAxiosError(error)) {
    return new Error(
      `open-xiaoai-bridge ${method} ${path} failed: ${sanitizeBridgeError(
        error instanceof Error ? error.message : error,
      )}`,
    );
  }
  const data = error.response?.data;
  const reason =
    data && typeof data === 'object'
      ? ((data as { error?: unknown; message?: unknown }).error ??
        (data as { error?: unknown; message?: unknown }).message)
      : undefined;
  const status = error.response?.status
    ? `HTTP ${error.response.status}`
    : error.code || 'request error';
  return new Error(
    `open-xiaoai-bridge ${method} ${path} failed (${status}): ${sanitizeBridgeError(
      reason ?? error.message,
    )}`,
  );
}

export class XiaoAiPlayer implements Player {
  private readonly baseUrl: string;
  private readonly client;
  private currentTitle?: string;
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

  async play(url: string, title?: string): Promise<void> {
    const path = '/api/stream/play';
    let response;
    try {
      response = await this.client.post(`${this.baseUrl}${path}`, {
        url,
        loop: this.loop,
        headers: { 'User-Agent': NET_EASE_UA },
      });
    } catch (error) {
      throw bridgeRequestError('POST', path, error);
    }
    if (!response.data?.success) {
      throw new Error(
        `open-xiaoai-bridge POST ${path} returned success=false: ${sanitizeBridgeError(
          response.data?.error,
        )}`,
      );
    }
    this.currentTitle = title;
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

  async setLoop(mode: 'no' | 'inf' | 'force'): Promise<void> {
    this.loop = mode !== 'no';
    this.lastStatus.loop = this.loop ? 'inf' : 'no';
    // 已播放中的歌曲需要重新设置循环：重新以当前 URL 播放会从头开始，
    // 因此只更新标志，从下一首生效（与 MCP 的 repeat 工具语义一致）。
  }

  async getLoop(): Promise<string> {
    return this.loop ? 'inf' : 'no';
  }

  async getStatus(): Promise<PlayerStatus> {
    try {
      const response = await this.client.get(`${this.baseUrl}/api/stream/status`);
      const data = response.data?.data;
      if (data) {
        this.lastStatus = {
          title: this.currentTitle,
          position: Math.floor((data.position_ms || 0) / 1000),
          duration: Math.floor((data.duration_ms || this.currentDuration) / 1000),
          paused: data.state === 'paused',
          playing: data.state === 'playing',
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
