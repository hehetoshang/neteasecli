import { getApiClient } from './client.js';
import type { Track, UserProfile } from '../types/index.js';
import { NeteaseCliError } from './errors.js';
import { getAuthManager } from '../auth/manager.js';

interface NeteaseUserAccountResponse {
  code: number;
  profile: {
    userId: number;
    nickname: string;
    avatarUrl?: string;
  } | null;
}

interface NeteaseLikelistResponse {
  code: number;
  ids: number[];
}

interface NeteaseRecentResponse {
  code: number;
  allData?: {
    playCount: number;
    score: number;
    song: {
      id: number;
      name: string;
      ar?: { id: number; name: string }[];
      al?: { id: number; name: string; picUrl?: string };
      artists?: { id: number; name: string }[];
      album?: { id: number; name: string; picUrl?: string };
      dt?: number;
      duration?: number;
    };
  }[];
}

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

export async function getUserProfile(): Promise<UserProfile> {
  if (!getAuthManager().isAuthenticated()) {
    throw new NeteaseCliError('AUTH_REQUIRED', 'Not logged in');
  }
  const client = getApiClient();
  const response = await client.request<NeteaseUserAccountResponse>('/nuser/account/get');
  if (!response.profile) {
    const hasCredentials = getAuthManager().isAuthenticated();
    throw new NeteaseCliError(
      hasCredentials ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED',
      hasCredentials ? 'Session expired' : 'Not logged in',
    );
  }
  return {
    id: String(response.profile.userId),
    nickname: response.profile.nickname,
    avatarUrl: response.profile.avatarUrl,
  };
}

export async function getLikedTrackIds(): Promise<string[]> {
  const client = getApiClient();
  const userProfile = await getUserProfile();
  const response = await client.request<NeteaseLikelistResponse>('/song/like/get', {
    uid: userProfile.id,
  });
  return response.ids.map(String);
}

export async function likeTrack(id: string, like: boolean = true): Promise<void> {
  const client = getApiClient();
  await client.request('/like', {
    trackId: id,
    like,
  });
}

export async function getRecentTracks(limit: number = 100): Promise<Track[]> {
  const client = getApiClient();
  const response = await client.request<NeteaseRecentResponse>('/play/record', {
    uid: (await getUserProfile()).id,
    type: 0,
    limit,
  });
  return (response.allData || []).map((item) => transformTrack(item.song));
}
