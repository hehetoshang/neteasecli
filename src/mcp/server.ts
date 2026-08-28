/**
 * neteasecli MCP server：把网易云音乐能力暴露为标准 MCP 工具，供 AI 调用。
 *
 * 工具：搜索、单曲/喜欢列表/歌单播放、队列、上一曲/下一曲及播放器控制
 * 播放后端由环境变量 NETEASECLI_PLAYER 选择（xiaoai = 小爱音箱经 bridge 中转推流）。
 *
 * 运行：neteasecli mcp （stdio transport）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { search } from '../api/search.js';
import { getTrackDetail, getTrackDetails, getTrackUrl } from '../api/track.js';
import { getLikedTrackIds } from '../api/user.js';
import { getPlaylistDetail } from '../api/playlist.js';
import { getPlayer } from '../player/index.js';
import { getQueueController } from '../player/queue.js';
import { buildQueueTracks, shuffled } from '../player/queue-tracks.js';
import type { Quality } from '../types/index.js';
import { PLAYBACK_STARTED_OUTPUT_SCHEMA, playbackStartedResult } from './result-signals.js';

export {
  PLAYBACK_STARTED_SIGNAL as SILENT_PLAYBACK_TERMINATION,
  playbackStartedResult,
} from './result-signals.js';

const QUALITY_VALUES = ['standard', 'higher', 'exhigh', 'lossless', 'hires'] as const;

const SEARCH_TRACK_OUTPUT_SCHEMA = {
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  tracks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      artist: z.string(),
      album: z.string(),
      duration: z.number(),
      uri: z.string(),
    }),
  ),
};

const QUEUE_TRACK_OUTPUT_SCHEMA = z.object({
  id: z.string(),
  title: z.string(),
  quality: z.enum(QUALITY_VALUES),
  duration: z.number().optional(),
  position: z.number().int().positive(),
  current: z.boolean(),
});

const QUEUE_STATUS_OUTPUT_SCHEMA = {
  status: z.enum(['idle', 'playing', 'paused', 'stopped', 'finished']),
  currentIndex: z.number().int().nonnegative().nullable(),
  current: QUEUE_TRACK_OUTPUT_SCHEMA.nullable(),
  remaining: z.number().int().nonnegative(),
  repeat: z.boolean(),
  history: z.array(z.string()),
  tracks: z.array(QUEUE_TRACK_OUTPUT_SCHEMA),
  total: z.number().int().nonnegative(),
};

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
        offset: z.number().int().min(0).default(0).describe('结果偏移量，默认 0'),
      },
      outputSchema: SEARCH_TRACK_OUTPUT_SCHEMA,
    },
    async ({ query, limit, offset }) => {
      const result = await search(query, 'track', limit, offset);
      const structuredContent = {
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        tracks: (result.tracks || []).map((track) => ({
          id: track.id,
          name: track.name,
          artist: track.artists.map((artist) => artist.name).join(', '),
          album: track.album.name,
          duration: track.duration,
          uri: track.uri,
        })),
      };
      if (!result.tracks || result.tracks.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `未找到与 "${query}" 相关的歌曲` }],
          structuredContent,
        };
      }
      const lines = result.tracks.map((t) => formatTrack(t));
      return {
        content: [
          {
            type: 'text' as const,
            text: `搜索 "${query}" 共 ${result.total} 条结果：\n${lines.join('\n')}`,
          },
        ],
        structuredContent,
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
      const controller = getQueueController();
      await controller.setRepeat(loop);
      await controller.playSingle({
        id,
        title,
        url,
        quality: (quality || 'exhigh') as Quality,
        duration: detail.duration,
        resolvedAt: Date.now(),
      });
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
      const { player: status } = await getQueueController().getStatus();
      if (status.playing && !status.paused) {
        await getQueueController().pause();
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
      const { player: status } = await getQueueController().getStatus();
      if (status.paused) {
        await getQueueController().pause(); // pause() 是切换：暂停状态下调用即恢复
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
      await getQueueController().stop();
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
      const { player } = await getQueueController().getStatus();
      if (!player.playing) {
        return { content: [{ type: 'text' as const, text: '当前没有播放' }] };
      }
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
      const { player: status, queue } = await getQueueController().getStatus();
      const mins = Math.floor(status.position / 60);
      const secs = Math.floor(status.position % 60);
      const text = status.playing
        ? `播放中：${status.title || '未知'} ${mins}:${secs.toString().padStart(2, '0')}` +
          (status.paused ? '（已暂停）' : '') +
          `；队列 ${queue.currentIndex === null ? 0 : queue.currentIndex + 1}/${queue.tracks.length}`
        : `当前没有播放（队列状态：${queue.status}，共 ${queue.tracks.length} 首）`;
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
      await getQueueController().setRepeat(on);
      return {
        content: [{ type: 'text' as const, text: on ? '已开启单曲循环' : '已关闭单曲循环' }],
      };
    },
  );

  server.registerTool(
    'next_track',
    {
      title: '下一曲',
      description: '播放队列中的下一首；已到末尾时结束队列播放',
      inputSchema: {},
    },
    async () => {
      const track = await getQueueController().next();
      return track
        ? playbackStartedResult(`正在播放：${track.title}`)
        : { content: [{ type: 'text' as const, text: '播放队列已结束' }] };
    },
  );

  server.registerTool(
    'previous_track',
    {
      title: '上一曲',
      description: '播放队列中的上一首',
      inputSchema: {},
    },
    async () => {
      const track = await getQueueController().previous();
      return playbackStartedResult(`正在播放：${track.title}`);
    },
  );

  server.registerTool(
    'queue_status',
    {
      title: '播放队列',
      description: '查看当前曲目、队列顺序、历史和剩余曲目数',
      inputSchema: {},
      outputSchema: QUEUE_STATUS_OUTPUT_SCHEMA,
    },
    async () => {
      const queue = await getQueueController().sync();
      const lines = queue.tracks.map(
        (track, index) =>
          `${index === queue.currentIndex ? '▶' : ' '} ${index + 1}. ${track.title} [id:${track.id}]`,
      );
      const summary = `状态：${queue.status}；当前：${queue.current?.title || '无'}；剩余：${queue.remaining}；历史：${queue.history.length}`;
      const tracks = queue.tracks.map((track, index) => ({
        id: track.id,
        title: track.title,
        quality: track.quality,
        duration: track.duration,
        position: index + 1,
        current: index === queue.currentIndex,
      }));
      return {
        content: [{ type: 'text' as const, text: `${summary}\n${lines.join('\n')}` }],
        structuredContent: {
          status: queue.status,
          currentIndex: queue.currentIndex,
          current: queue.currentIndex === null ? null : tracks[queue.currentIndex] || null,
          remaining: queue.remaining,
          repeat: queue.repeat,
          history: queue.history,
          tracks,
          total: tracks.length,
        },
      };
    },
  );

  server.registerTool(
    'play_liked',
    {
      title: '播放我喜欢的音乐',
      description: '读取“我喜欢的音乐”并建立连续播放队列',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().default(50).describe('最多加入的歌曲数'),
        shuffle: z.boolean().optional().default(false).describe('是否随机排序'),
        quality: z.enum(QUALITY_VALUES).optional().default('exhigh').describe('音质'),
      },
      outputSchema: PLAYBACK_STARTED_OUTPUT_SCHEMA,
    },
    async ({ limit, shuffle, quality }) => {
      const ids = (await getLikedTrackIds()).slice(0, limit);
      const details = await getTrackDetails(ids);
      const byId = new Map(details.map((track) => [track.id, track]));
      let source = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      if (shuffle) source = shuffled(source);
      const built = await buildQueueTracks(source, quality as Quality);
      if (built.tracks.length === 0) throw new Error('没有可播放的喜欢歌曲');
      const queue = await getQueueController().start(built.tracks);
      return playbackStartedResult(
        `正在播放我喜欢的音乐：${queue.current?.title}（队列 ${queue.tracks.length} 首，跳过 ${built.skipped.length} 首）`,
      );
    },
  );

  server.registerTool(
    'play_playlist',
    {
      title: '播放歌单',
      description: '读取指定网易云歌单并建立连续播放队列',
      inputSchema: {
        playlist_id: z.string().describe('歌单 ID'),
        limit: z.number().int().min(1).max(1000).optional().describe('最多加入的歌曲数'),
        shuffle: z.boolean().optional().default(false).describe('是否随机排序'),
        quality: z.enum(QUALITY_VALUES).optional().default('exhigh').describe('音质'),
      },
      outputSchema: PLAYBACK_STARTED_OUTPUT_SCHEMA,
    },
    async ({ playlist_id, limit, shuffle, quality }) => {
      const playlist = await getPlaylistDetail(playlist_id);
      let source = playlist.tracks || [];
      if (limit !== undefined) source = source.slice(0, limit);
      if (shuffle) source = shuffled(source);
      const built = await buildQueueTracks(source, quality as Quality);
      if (built.tracks.length === 0) throw new Error('歌单中没有可播放的歌曲');
      const queue = await getQueueController().start(built.tracks);
      return playbackStartedResult(
        `正在播放歌单“${playlist.name}”：${queue.current?.title}（队列 ${queue.tracks.length} 首，跳过 ${built.skipped.length} 首）`,
      );
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
