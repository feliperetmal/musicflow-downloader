import { cookies } from 'next/headers';

export const SPOTIFY_SESSION_COOKIE = 'mf_spotify_session';

export function getWorkerBaseUrl(): string {
  return (process.env.WORKER_BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');
}

export function getWorkerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const secret = process.env.WORKER_API_SECRET;
  if (secret) {
    headers['x-worker-secret'] = secret;
  }
  return headers;
}

export async function getSpotifySessionIdFromCookies(): Promise<string | undefined> {
  try {
    const store = await cookies();
    return store.get(SPOTIFY_SESSION_COOKIE)?.value;
  } catch {
    return undefined;
  }
}

export async function proxyToWorker(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${getWorkerBaseUrl()}${path}`;
  const incomingHeaders =
    init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init.headers as Record<string, string> | undefined) ?? {};

  const sessionId = await getSpotifySessionIdFromCookies();
  if (sessionId && !incomingHeaders['x-spotify-session']) {
    incomingHeaders['x-spotify-session'] = sessionId;
  }

  return fetch(url, {
    ...init,
    headers: getWorkerHeaders(incomingHeaders),
    cache: 'no-store',
  });
}
