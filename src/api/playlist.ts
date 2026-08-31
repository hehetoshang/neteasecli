import { getApiClient } from './client.js';
import type { Playlist, Track } from '../types/index.js';
import { getUserProfile } from './user.js';
import { NeteaseCliError } from './errors.js';

const LIKED_PLAYLIST_ALIASES = ['liked', '我喜欢的音乐', '我的收藏'] as const;
const USER_PLAYLIST_PAGE_SIZE = 1000;

interface NeteasePlaylistResponse {
  code: number;
  playlist: {
    id: number;
    name: string;
    description?: string;
    coverImgUrl?: string;
    trackCount: number;
    creator?: { userId: number; nickname: string };
    tracks?: {
      id: number;
      name: string;
      ar?: { id: number; name: string }[];
      al?: { id: number; name: string; picUrl?: string };
      artists?: { id: number; name: string }[];
      album?: { id: number; name: string; picUrl?: string };
      dt?: number;
      duration?: number;
    }[];
  } | null;
}

interface NeteaseUserPlaylistsResponse {
  code: number;
  more?: boolean;
  playlist: {
    id: number;
    name: string;
    description?: string;
    coverImgUrl?: string;
    trackCount: number;
    creator?: { userId: number; nickname: string };
    specialType?: number;
    subscribed?: boolean;
  }[];
}

export type AccountPlaylist = Playlist & {
  kind: 'liked' | 'created' | 'subscribed';
  owned: boolean;
  subscribed: boolean;
  aliases: string[];
};

function transformTrack(track: {
  id: number;
  name: string;
  ar?: { id: number; name: string }[];
  al?: { id: number; name: string; picUrl?: string };
  artists?: { id: number; name: string }[];
  album?: { id: number; name: string; picUrl?: string };
  dt?: number;
  duration?: number;
}): Track {
  const artists = track.ar || track.artists || [];
  const album = track.al || track.album || { id: 0, name: '' };
  return {
    id: String(track.id),
    name: track.name,
    artists: artists.map((a) => ({ id: String(a.id), name: a.name })),
    album: {
      id: String(album.id),
      name: album.name,
      picUrl: album.picUrl,
    },
    duration: track.dt || track.duration || 0,
    uri: `netease:track:${track.id}`,
  };
}

export async function getPlaylistDetail(id: string): Promise<Playlist> {
  const client = getApiClient();

  const response = await client.request<NeteasePlaylistResponse>('/v6/playlist/detail', {
    id,
    n: 100000,
  });

  const playlist = response.playlist;
  if (!playlist) {
    throw new NeteaseCliError('PLAYLIST_NOT_FOUND', `Playlist ${id} was not found`);
  }
  return {
    id: String(playlist.id),
    name: playlist.name,
    description: playlist.description,
    coverUrl: playlist.coverImgUrl,
    trackCount: playlist.trackCount,
    creator: playlist.creator
      ? {
          id: String(playlist.creator.userId),
          name: playlist.creator.nickname,
        }
      : undefined,
    tracks: playlist.tracks?.map(transformTrack),
  };
}

export async function getUserPlaylists(uid?: string): Promise<Playlist[]> {
  const client = getApiClient();

  const userId = uid || (await getUserProfile()).id;
  const rawPlaylists: NeteaseUserPlaylistsResponse['playlist'] = [];
  let offset = 0;
  while (true) {
    const response = await client.request<NeteaseUserPlaylistsResponse>('/user/playlist', {
      uid: userId,
      limit: USER_PLAYLIST_PAGE_SIZE,
      offset,
    });
    rawPlaylists.push(...response.playlist);
    if (!response.more || response.playlist.length === 0) break;
    offset += response.playlist.length;
  }

  return rawPlaylists.map((p) => ({
    id: String(p.id),
    name: p.name,
    description: p.description,
    coverUrl: p.coverImgUrl,
    trackCount: p.trackCount,
    creator: p.creator
      ? {
          id: String(p.creator.userId),
          name: p.creator.nickname,
        }
      : undefined,
  }));
}

export async function getAccountPlaylists(): Promise<AccountPlaylist[]> {
  const client = getApiClient();
  const profile = await getUserProfile();
  const rawPlaylists: NeteaseUserPlaylistsResponse['playlist'] = [];
  let offset = 0;
  while (true) {
    const response = await client.request<NeteaseUserPlaylistsResponse>('/user/playlist', {
      uid: profile.id,
      limit: USER_PLAYLIST_PAGE_SIZE,
      offset,
    });
    rawPlaylists.push(...response.playlist);
    if (!response.more || response.playlist.length === 0) break;
    offset += response.playlist.length;
  }
  return rawPlaylists.map((playlist) => classifyAccountPlaylist(playlist, profile.id));
}

export function classifyAccountPlaylist(
  playlist: NeteaseUserPlaylistsResponse['playlist'][number],
  userId: string,
): AccountPlaylist {
  const liked = playlist.specialType === 5;
  const owned = String(playlist.creator?.userId || '') === userId && !playlist.subscribed;
  const kind: AccountPlaylist['kind'] = liked ? 'liked' : owned ? 'created' : 'subscribed';
  return {
    id: String(playlist.id),
    name: playlist.name,
    description: playlist.description,
    coverUrl: playlist.coverImgUrl,
    trackCount: playlist.trackCount,
    creator: playlist.creator
      ? { id: String(playlist.creator.userId), name: playlist.creator.nickname }
      : undefined,
    kind,
    owned: liked || owned,
    subscribed: kind === 'subscribed',
    aliases: liked ? [...LIKED_PLAYLIST_ALIASES] : [],
  };
}

export function resolveAccountPlaylist(
  playlists: AccountPlaylist[],
  selector: string,
): AccountPlaylist {
  const normalized = selector.trim();
  const normalizedLower = normalized.toLocaleLowerCase();
  const id = normalizedLower.startsWith('netease:playlist:')
    ? normalized.slice('netease:playlist:'.length)
    : normalized;
  const byId = playlists.find((playlist) => playlist.id === id);
  if (byId) return byId;

  const byAlias = playlists.filter((playlist) =>
    playlist.aliases.some((alias) => alias.toLocaleLowerCase() === normalizedLower),
  );
  if (byAlias.length === 1) return byAlias[0];

  const byName = playlists.filter(
    (playlist) => playlist.name.toLocaleLowerCase() === normalizedLower,
  );
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const choices = byName.map((playlist) => `${playlist.name} (${playlist.id})`).join(', ');
    throw new NeteaseCliError(
      'PLAYLIST_AMBIGUOUS',
      `Multiple account playlists match "${normalized}": ${choices}; use a playlist ID`,
    );
  }
  throw new NeteaseCliError(
    'PLAYLIST_NOT_FOUND',
    `Account playlist "${normalized || selector}" was not found`,
  );
}

export async function resolveAccountPlaylistSelector(selector: string): Promise<AccountPlaylist> {
  return resolveAccountPlaylist(await getAccountPlaylists(), selector);
}

/** Resolve a public playlist ID/URI directly, or an account playlist alias/name. */
export async function getPlaylistBySelector(selector: string): Promise<Playlist> {
  const normalized = selector.trim();
  const id = normalized.toLocaleLowerCase().startsWith('netease:playlist:')
    ? normalized.slice('netease:playlist:'.length)
    : normalized;
  if (/^\d+$/.test(id)) return getPlaylistDetail(id);
  const accountPlaylist = await resolveAccountPlaylistSelector(normalized);
  return getPlaylistDetail(accountPlaylist.id);
}
