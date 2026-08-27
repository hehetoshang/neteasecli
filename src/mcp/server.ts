/**
 * neteasecli MCP server：把网易云音乐能力暴露为标准 MCP 工具，供 AI 调用。
 *
 * 工具：search_track / play_track / pause / resume / stop / seek / status / repeat
 * 播放后端由环境变量 NETEASECLI_PLAYER 选择（xiaoai = 小爱音箱经 bridge 中转推流）。
 *
 * 运行：neteasecli mcp （stdio transport）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { search } from '../api/search.js';
import { getTrackDetail, getTrackUrl } from '../api/track.js';
import { getPlayer } from '../player/index.js';
import type { Quality } from '../types/index.js';
import { PLAYBACK_STARTED_OUTPUT_SCHEMA, playbackStartedResult } from './result-signals.js';

export {
  PLAYBACK_STARTED_SIGNAL as SILENT_PLAYBACK_TERMINATION,
  playbackStartedResult,
} from './result-signals.js';

const QUALITY_VALUES = ['standard', 'higher', 'exhigh', 'lossless', 'hires'] as const;

function formatTrack(track: {
  id: string;
  name: string;
  artists: { name: string }[];
  duration?: number;
}) {
  const artist = track.artists.map((a) => a.name).join('/');
  const minutes = Math.floor((track.duration || 0) / 60000);
  const secs = Math.floor(((track.duration || 0) % 60000) / 1000);
  return `${track.name} - ${artist} [id:${track.id}]${track.duration ? ` (${minutes}:${secs.toString().padStart(2, '0')})` : ''}`;
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'neteasecli-music',
    version: '3.0.0',
  });

  // 搜索歌曲
  server.registerTool(
    'search_track',
    {
      title: '搜索歌曲',
      description: '在网易云音乐中搜索歌曲，返回歌曲列表（含 id，可用于 play_track）',
      inputSchema: {
        query: z.string().describe('搜索关键词，如 "周杰伦 晴天"'),
        limit: z.number().int().min(1).max(20).default(5).describe('返回数量，默认 5'),
      },
    },
    async ({ query, limit }) => {
      const result = await search(query, 'track', limit);
      if (!result.tracks || result.tracks.length === 0) {
        return { content: [{ type: 'text' as const, text: `未找到与 "${query}" 相关的歌曲` }] };
      }
      const lines = result.tracks.map((t) => formatTrack(t));
      return {
        content: [
          {
            type: 'text' as const,
            text: `搜索 "${query}" 共 ${result.total} 条结果：\n${lines.join('\n')}`,
          },
        ],
      };
    },
  );

  // 播放歌曲
  server.registerTool(
    'play_track',
    {
      title: '播放歌曲',
      description:
        '播放网易云歌曲。提供 track_id 直接播放；或提供 query 自动搜索并播放第一首。' +
        '播放后端由 NETEASECLI_PLAYER 决定（xiaoai = 小爱音箱）',
      inputSchema: {
        track_id: z.string().optional().describe('歌曲 ID（search_track 返回的 id）'),
        query: z.string().optional().describe('搜索关键词，与 track_id 二选一'),
        quality: z.enum(QUALITY_VALUES).optional().default('exhigh').describe('音质'),
        loop: z.boolean().optional().default(false).describe('单曲循环'),
      },
      outputSchema: PLAYBACK_STARTED_OUTPUT_SCHEMA,
    },
    async ({ track_id, query, quality, loop }) => {
      let id = track_id;
      if (!id) {
        if (!query) {
          return {
            content: [{ type: 'text' as const, text: '必须提供 track_id 或 query' }],
            isError: true,
          };
        }
        const result = await search(query, 'track', 1);
        const first = result.tracks?.[0];
        if (!first) {
          return {
            content: [{ type: 'text' as const, text: `未找到与 "${query}" 相关的歌曲` }],
            isError: true,
          };
        }
        id = first.id;
      }
      const [url, detail] = await Promise.all([
        getTrackUrl(id, (quality || 'exhigh') as Quality),
        getTrackDetail(id),
      ]);
      const title = `${detail.name} - ${detail.artists.map((a) => a.name).join('/')}`;
      const player = getPlayer();
      if (loop) {
        await player.setLoop('inf');
      } else {
        await player.setLoop('no');
      }
      await player.play(url, title);
      return playbackStartedResult(`正在播放：${title}${loop ? '（单曲循环）' : ''}`);
    },
  );

  // 暂停/恢复（先查状态再切换，对 mpv toggle 和小爱后端都语义正确）
  server.registerTool(
    'pause',
    {
      title: '暂停播放',
      description: '暂停当前播放（可 resume 恢复）',
      inputSchema: {},
    },
    async () => {
      const status = await getPlayer().getStatus();
      if (status.playing && !status.paused) {
        await getPlayer().pause();
        return { content: [{ type: 'text' as const, text: '已暂停' }] };
      }
      return { content: [{ type: 'text' as const, text: '当前没有播放中的内容' }] };
    },
  );

  server.registerTool(
    'resume',
    {
      title: '恢复播放',
      description: '恢复暂停的播放',
      inputSchema: {},
    },
    async () => {
      const status = await getPlayer().getStatus();
      if (status.paused) {
        await getPlayer().pause(); // pause() 是切换：暂停状态下调用即恢复
        return { content: [{ type: 'text' as const, text: '已恢复播放' }] };
      }
      return {
        content: [{ type: 'text' as const, text: status.playing ? '正在播放中' : '当前没有播放' }],
      };
    },
  );

  // 停止
  server.registerTool(
    'stop',
    {
      title: '停止播放',
      description: '停止当前播放',
      inputSchema: {},
    },
    async () => {
      await getPlayer().stop();
      return { content: [{ type: 'text' as const, text: '已停止' }] };
    },
  );

  // 跳转进度
  server.registerTool(
    'seek',
    {
      title: '跳转播放进度',
      description: '跳转到指定播放位置（秒）。如 60 = 1:00，也支持相对值（负数向前）',
      inputSchema: {
        position_seconds: z.number().describe('目标位置（秒）'),
        relative: z.boolean().optional().default(false).describe('true 表示相对当前位置偏移'),
      },
    },
    async ({ position_seconds, relative }) => {
      await getPlayer().seek(position_seconds, relative ? 'relative' : 'absolute');
      return {
        content: [{ type: 'text' as const, text: `已跳转到 ${position_seconds} 秒` }],
      };
    },
  );

  // 播放状态
  server.registerTool(
    'status',
    {
      title: '播放状态',
      description: '查询当前播放状态（播放中/暂停/歌曲/进度）',
      inputSchema: {},
    },
    async () => {
      const status = await getPlayer().getStatus();
      const mins = Math.floor(status.position / 60);
      const secs = Math.floor(status.position % 60);
      const text = status.playing
        ? `播放中：${status.title || '未知'} ${mins}:${secs.toString().padStart(2, '0')}` +
          (status.paused ? '（已暂停）' : '')
        : '当前没有播放';
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // 单曲循环
  server.registerTool(
    'repeat',
    {
      title: '单曲循环',
      description: '开启/关闭单曲循环',
      inputSchema: {
        on: z.boolean().describe('true 开启循环，false 关闭'),
      },
    },
    async ({ on }) => {
      await getPlayer().setLoop(on ? 'inf' : 'no');
      return {
        content: [{ type: 'text' as const, text: on ? '已开启单曲循环' : '已关闭单曲循环' }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
