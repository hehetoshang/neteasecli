export type NeteaseErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'PLAYLIST_NOT_FOUND'
  | 'PLAYLIST_AMBIGUOUS'
  | 'PLAYLIST_EMPTY'
  | 'NO_PLAYABLE_TRACKS'
  | 'API_ERROR';

export class NeteaseCliError extends Error {
  constructor(
    public readonly code: NeteaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NeteaseCliError';
  }
}

export function normalizeNeteaseError(error: unknown): NeteaseCliError {
  if (error instanceof NeteaseCliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes('not logged in') ||
    normalized.includes('login required') ||
    normalized.includes('missing credential')
  ) {
    return new NeteaseCliError('AUTH_REQUIRED', '未登录网易云音乐，请先执行 neteasecli auth login');
  }
  if (
    normalized.includes('authentication failed') ||
    normalized.includes('cookie expired') ||
    normalized.includes('session expired')
  ) {
    return new NeteaseCliError('AUTH_EXPIRED', '网易云音乐登录已失效，请重新登录');
  }
  return new NeteaseCliError('API_ERROR', message || '网易云音乐接口调用失败');
}

export function formatNeteaseError(error: unknown): string {
  const normalized = normalizeNeteaseError(error);
  return `[${normalized.code}] ${normalized.message}`;
}
