/**
 * MusicFlow Downloader Client API Layer
 * Transparently handles communication with either:
 * 1. Cloud / Docker Worker directly (via NEXT_PUBLIC_WORKER_URL or localStorage override for GitHub Pages)
 * 2. Next.js App Router BFF (/api routes for local development & Vercel)
 */

export const SPOTIFY_SESSION_STORAGE_KEY = 'mf_spotify_session';
export const WORKER_URL_STORAGE_KEY = 'mf_worker_url';
export const WORKER_SECRET_STORAGE_KEY = 'mf_worker_secret';

export function getSpotifySessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const fromStorage = window.localStorage.getItem(SPOTIFY_SESSION_STORAGE_KEY);
    if (fromStorage) return fromStorage;

    const match = document.cookie.match(new RegExp('(^| )' + SPOTIFY_SESSION_STORAGE_KEY + '=([^;]+)'));
    if (match) return match[2];
  } catch {
    // Ignore storage errors in restricted contexts
  }
  return null;
}

export function saveSpotifySessionId(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SPOTIFY_SESSION_STORAGE_KEY, sessionId);
    // 180 days (matches Spotify 2026 maximum refresh token lifetime)
    document.cookie = `${SPOTIFY_SESSION_STORAGE_KEY}=${encodeURIComponent(
      sessionId,
    )}; max-age=${180 * 24 * 60 * 60}; path=/; SameSite=Lax`;
  } catch {
    // Ignore
  }
}

export function clearSpotifySession(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SPOTIFY_SESSION_STORAGE_KEY);
    document.cookie = `${SPOTIFY_SESSION_STORAGE_KEY}=; max-age=0; path=/; SameSite=Lax`;
  } catch {
    // Ignore
  }
}

export function getEffectiveWorkerUrl(): string {
  if (typeof window !== 'undefined') {
    const custom = window.localStorage.getItem(WORKER_URL_STORAGE_KEY)?.trim();
    if (custom) return custom.replace(/\/+$/, '');
  }

  const envUrl = process.env.NEXT_PUBLIC_WORKER_URL?.trim();
  if (envUrl) {
    return envUrl.replace(/\/+$/, '');
  }

  // If running in browser on GitHub Pages without configured worker, return empty string
  if (typeof window !== 'undefined' && window.location.hostname.includes('github.io')) {
    return '';
  }

  return '';
}

export function isDirectWorkerMode(): boolean {
  return Boolean(getEffectiveWorkerUrl());
}

export function getApiEndpoint(subpath: string): string {
  const cleanPath = subpath.startsWith('/') ? subpath : `/${subpath}`;
  const workerUrl = getEffectiveWorkerUrl();
  if (workerUrl) {
    // In direct worker mode, diagnostics is at /diagnostics, and /api prefix is omitted
    const mapped =
      cleanPath === '/admin/diagnostics' || cleanPath === '/diagnostics'
        ? '/diagnostics'
        : cleanPath;
    return `${workerUrl}${mapped}`;
  }
  // In Next.js BFF mode
  if (cleanPath === '/diagnostics') {
    return '/api/admin/diagnostics';
  }
  return `/api${cleanPath}`;
}

export function getEventSourceUrl(subpath: string, queryParams: Record<string, string> = {}): string {
  const url = new URL(getApiEndpoint(subpath), typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, v);
    }
  }

  const sessionId = getSpotifySessionId();
  if (sessionId && !url.searchParams.has('sessionId')) {
    url.searchParams.set('sessionId', sessionId);
  }

  return url.toString();
}

export function getDownloadUrl(subpath: string): string {
  return getApiEndpoint(subpath);
}

export async function clientFetch(subpath: string, init: RequestInit = {}): Promise<Response> {
  const endpoint = getApiEndpoint(subpath);
  const headers = new Headers(init.headers || {});

  const sessionId = getSpotifySessionId();
  if (sessionId && !headers.has('x-spotify-session')) {
    headers.set('x-spotify-session', sessionId);
  }

  if (typeof window !== 'undefined') {
    const customSecret =
      process.env.NEXT_PUBLIC_WORKER_SECRET ||
      window.localStorage.getItem(WORKER_SECRET_STORAGE_KEY)?.trim();
    if (customSecret && !headers.has('x-worker-secret')) {
      headers.set('x-worker-secret', customSecret);
    }
  }

  return fetch(endpoint, {
    ...init,
    headers,
  });
}
