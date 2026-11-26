/**
 * MusicFlow Downloader Client API Layer
 *
 * Security model:
 * - Production backend URL is configured centrally at build time (NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WORKER_URL).
 * - Visitors NEVER configure server URLs or worker secrets.
 * - No admin worker secrets are ever exposed to or stored in the browser.
 * - Public browser clients authenticate individually using short-lived HMAC-signed
 *   session tokens issued by POST /auth/session and rotated automatically.
 * - Permanent tokens are never placed in URL query strings.
 */

export const SPOTIFY_SESSION_STORAGE_KEY = 'mf_spotify_session';
const CLIENT_TOKEN_STORAGE_KEY = 'mf_client_token';
const CLIENT_TOKEN_EXP_STORAGE_KEY = 'mf_client_token_exp';

let sessionInitInFlight: Promise<string | null> | null = null;

export function getSpotifySessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const fromStorage = window.localStorage.getItem(SPOTIFY_SESSION_STORAGE_KEY);
    if (fromStorage) return fromStorage;

    const match = document.cookie.match(
      new RegExp('(^| )' + SPOTIFY_SESSION_STORAGE_KEY + '=([^;]+)'),
    );
    if (match) return decodeURIComponent(match[2]);
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

export function saveClientSessionToken(token: string, expiresAtIso?: string): void {
  if (typeof window === 'undefined' || !token) return;
  try {
    window.localStorage.setItem(CLIENT_TOKEN_STORAGE_KEY, token);
    if (expiresAtIso) {
      window.localStorage.setItem(CLIENT_TOKEN_EXP_STORAGE_KEY, expiresAtIso);
    }
  } catch {
    // Ignore
  }
}

function getStoredClientToken(): { token: string; expiresAtMs: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const token = window.localStorage.getItem(CLIENT_TOKEN_STORAGE_KEY)?.trim();
    if (!token) return null;
    const expStr = window.localStorage.getItem(CLIENT_TOKEN_EXP_STORAGE_KEY);
    const expiresAtMs = expStr ? Date.parse(expStr) : Date.now() + 60_000;
    return { token, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0 };
  } catch {
    return null;
  }
}

function clearClientSessionToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(CLIENT_TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(CLIENT_TOKEN_EXP_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

export function isStaticPublicHost(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.hostname.includes('github.io') ||
    process.env.NEXT_PUBLIC_STATIC_EXPORT === 'true'
  );
}

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Returns the centrally configured HTTPS production backend URL.
 * Never allows localhost URLs on public HTTPS hosts and never reads visitor overrides.
 */
export function getProductionApiUrl(): string {
  const configured = (
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_WORKER_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');

  if (!configured) return '';

  // Block mixed content / localhost leaks when running on a public HTTPS site
  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    (configured.startsWith('http://') || isLocalhostUrl(configured))
  ) {
    return '';
  }

  return configured;
}

export function isDirectBackendMode(): boolean {
  return Boolean(getProductionApiUrl());
}

export function isBackendAvailable(): boolean {
  if (isDirectBackendMode()) return true;
  // On non-static full-stack Next.js deployments (e.g. local dev or Node host), /api BFF is available
  return !isStaticPublicHost();
}

export function getApiEndpoint(subpath: string): string {
  const cleanPath = subpath.startsWith('/') ? subpath : `/${subpath}`;
  const apiUrl = getProductionApiUrl();
  if (apiUrl) {
    const mapped =
      cleanPath === '/admin/diagnostics' || cleanPath === '/diagnostics'
        ? '/diagnostics'
        : cleanPath;
    return `${apiUrl}${mapped}`;
  }
  if (cleanPath === '/diagnostics') {
    return '/api/admin/diagnostics';
  }
  return `/api${cleanPath}`;
}

export function getJobDownloadUrl(jobId: string, downloadTicket?: string): string {
  const base = getApiEndpoint(`/jobs/${encodeURIComponent(jobId)}/download`);
  if (downloadTicket && isDirectBackendMode()) {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}ticket=${encodeURIComponent(downloadTicket)}`;
  }
  return base;
}

export function getDownloadUrl(subpath: string): string {
  return getApiEndpoint(subpath);
}

/**
 * Ensures the browser holds a valid short-lived individual session token when
 * communicating directly with the HTTPS production backend.
 */
export async function ensureClientSessionToken(forceRefresh = false): Promise<string | null> {
  if (!isDirectBackendMode()) return null;

  const existing = getStoredClientToken();
  const RENEW_WINDOW_MS = 5 * 60 * 1000;
  if (!forceRefresh && existing && existing.expiresAtMs - RENEW_WINDOW_MS > Date.now()) {
    return existing.token;
  }

  if (sessionInitInFlight) {
    return sessionInitInFlight;
  }

  sessionInitInFlight = (async () => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (existing?.token && !forceRefresh) {
        headers.Authorization = `Bearer ${existing.token}`;
      }
      const endpoint =
        existing?.token && !forceRefresh
          ? getApiEndpoint('/auth/session/refresh')
          : getApiEndpoint('/auth/session');

      let res = await fetch(endpoint, { method: 'POST', headers });
      if (!res.ok && existing?.token) {
        // Fallback to creating a fresh client session if refresh failed
        clearClientSessionToken();
        res = await fetch(getApiEndpoint('/auth/session'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (!res.ok) return null;

      const data = (await res.json()) as { token?: string; expiresAt?: string };
      if (data.token) {
        saveClientSessionToken(data.token, data.expiresAt);
        return data.token;
      }
      return null;
    } catch {
      return null;
    } finally {
      sessionInitInFlight = null;
    }
  })();

  return sessionInitInFlight;
}

const WAKEUP_STATUS_CODES = new Set([502, 503, 504]);

export async function checkBackendHealth(): Promise<{ ok: boolean; wakingUp?: boolean }> {
  if (!isBackendAvailable()) {
    return { ok: false };
  }
  try {
    const controller = new AbortController();
    // Allow generous window on Render Free cold start (can take up to ~55s after 15 min idle)
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(getApiEndpoint('/health'), {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (WAKEUP_STATUS_CODES.has(res.status)) {
      return { ok: false, wakingUp: true };
    }
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

export async function clientFetch(subpath: string, init: RequestInit = {}): Promise<Response> {
  if (!isBackendAvailable()) {
    throw new Error('Serviço temporariamente indisponível. Tente novamente em instantes.');
  }

  const endpoint = getApiEndpoint(subpath);
  const buildHeaders = async (forceRefresh = false): Promise<Headers> => {
    const headers = new Headers(init.headers || {});
    const sessionId = getSpotifySessionId();
    if (sessionId && !headers.has('x-spotify-session')) {
      headers.set('x-spotify-session', sessionId);
    }
    if (isDirectBackendMode() && !headers.has('authorization')) {
      const token = await ensureClientSessionToken(forceRefresh);
      if (token) {
        headers.set('authorization', `Bearer ${token}`);
      }
    }
    return headers;
  };

  let res = await fetch(endpoint, {
    ...init,
    headers: await buildHeaders(false),
  });

  // Handle Render Free cold-start spin-up (502/503/504) with a single gentle retry
  if (WAKEUP_STATUS_CODES.has(res.status) && isDirectBackendMode()) {
    await new Promise((r) => setTimeout(r, 3500));
    res = await fetch(endpoint, {
      ...init,
      headers: await buildHeaders(false),
    });
    if (WAKEUP_STATUS_CODES.has(res.status)) {
      throw new Error(
        'O servidor está acordando da hibernação (pode levar até 1 minuto no plano gratuito). Tente novamente em alguns segundos.',
      );
    }
  }

  // Automatically rotate expired client session token once on 401
  if (res.status === 401 && isDirectBackendMode() && !subpath.startsWith('/auth/')) {
    clearClientSessionToken();
    const refreshedHeaders = await buildHeaders(true);
    if (refreshedHeaders.has('authorization')) {
      res = await fetch(endpoint, {
        ...init,
        headers: refreshedHeaders,
      });
    }
  }

  return res;
}

/**
 * Streams Server-Sent Events using fetch() + ReadableStream so Authorization and
 * x-spotify-session headers are sent safely without exposing tokens in URL query strings.
 */
export function streamSseJson<T>(
  subpath: string,
  queryParams: Record<string, string>,
  handlers: {
    onMessage: (data: T) => void;
    onError: (err: Error) => void;
    onDone?: () => void;
  },
): { close: () => void } {
  const controller = new AbortController();

  const url = new URL(
    getApiEndpoint(subpath),
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
  );
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, v);
    }
  }

  void (async () => {
    try {
      if (!isBackendAvailable()) {
        throw new Error('Serviço temporariamente indisponível. Tente novamente em instantes.');
      }

      const headers = new Headers({ Accept: 'text/event-stream' });
      const sessionId = getSpotifySessionId();
      if (sessionId) {
        headers.set('x-spotify-session', sessionId);
      }
      if (isDirectBackendMode()) {
        const token = await ensureClientSessionToken();
        if (token) {
          headers.set('authorization', `Bearer ${token}`);
        }
      }

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errBody = await res.json().catch(() => null);
        throw new Error(
          errBody?.error || 'Não foi possível conectar ao serviço no momento.',
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const dataLines = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
          if (dataLines.length === 0) continue;
          try {
            const parsed = JSON.parse(dataLines.join('\n')) as T;
            handlers.onMessage(parsed);
          } catch {
            // Ignore malformed SSE frame
          }
        }
      }

      handlers.onDone?.();
    } catch (err) {
      if (controller.signal.aborted) return;
      handlers.onError(
        err instanceof Error ? err : new Error('Conexão interrompida.'),
      );
    }
  })();

  return {
    close: () => controller.abort(),
  };
}
