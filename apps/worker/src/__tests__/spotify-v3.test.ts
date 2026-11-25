import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { DiagnosticsService } from '../services/diagnostics.js';
import { SpotifyService } from '../services/spotify.js';
import { SpotifyAuthService } from '../services/spotify-auth.js';
import { parseMediaLink } from '@musicflow/shared';

describe('Spotify OAuth PKCE, Feb 2026 /items Pagination & Restriction Handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const testConfig = loadConfig({
    ...process.env,
    SPOTIFY_CLIENT_ID: 'c18da041f1b648ed9fdec51b82717160',
    SPOTIFY_CLIENT_SECRET: 'mock-secret-value-never-leaked',
    SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:8888/callback',
    ALLOW_PRIVATE_NETWORK_FETCH: 'true',
  });

  it('handles PKCE login URL, CSRF state validation, handoff consumption, refresh and logout', async () => {
    const auth = new SpotifyAuthService(testConfig);
    const { authorizeUrl, state } = auth.createLoginUrl('/?tab=spotify');

    expect(authorizeUrl).toContain('code_challenge_method=S256');
    expect(authorizeUrl).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A8888%2Fcallback');

    await expect(
      auth.handleCallback({ code: 'abc', state: 'forged-state' }),
    ).rejects.toThrow(/CSRF/);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_in: 3600,
              scope: 'playlist-read-private playlist-read-collaborative',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ id: 'u1', display_name: 'Pedro QA', product: 'premium' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const { handoff, returnTo } = await auth.handleCallback({ code: 'valid-code', state });
    expect(returnTo).toBe('/?tab=spotify');

    const consumed = auth.consumeHandoff(handoff);
    expect(consumed?.sessionId).toBeTruthy();
    // Single-use handoff cannot be replayed
    expect(auth.consumeHandoff(handoff)).toBeNull();

    const status = auth.getStatus(consumed!.sessionId);
    expect(status.authenticated).toBe(true);
    expect(status.user?.displayName).toBe('Pedro QA');
    expect(JSON.stringify(status)).not.toContain('access-1');
    expect(JSON.stringify(status)).not.toContain('mock-secret-value');

    auth.logout(consumed!.sessionId);
    expect(auth.getStatus(consumed!.sessionId).authenticated).toBe(false);
  });

  it('paginates Feb 2026 /v1/playlists/{id}/items preserving order and Hebrew/English titles', async () => {
    const diagnostics = new DiagnosticsService();
    const auth = new SpotifyAuthService(testConfig);
    const spotify = new SpotifyService(testConfig, auth, diagnostics);

    const makeTrack = (n: number) => ({
      item: {
        id: `trk-${n}`,
        name: n === 1 ? 'שלום עולם (Shalom)' : `Track #${n}`,
        duration_ms: 180000 + n * 1000,
        artists: [{ name: n === 1 ? 'עומר אדם' : `Artist ${n}` }],
        album: {
          name: 'Album Test',
          images: [{ url: 'https://i.scdn.co/image/cover.jpg' }],
        },
        external_urls: { spotify: `https://open.spotify.com/track/trk-${n}` },
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/token')) {
          return new Response(
            JSON.stringify({ access_token: 'app-token', expires_in: 3600 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/v1/playlists/7FJDxus9eWaKJHXvYmtlqb')) {
          return new Response(
            JSON.stringify({
              id: '7FJDxus9eWaKJHXvYmtlqb',
              name: 'Playlist Teste 115 Faixas',
              description: 'Descrição teste',
              owner: { display_name: 'Pedro' },
              images: [{ url: 'https://i.scdn.co/image/pl.jpg' }],
              items: { total: 115, items: [] },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/items?limit=50&offset=0')) {
          return new Response(
            JSON.stringify({
              total: 115,
              limit: 50,
              offset: 0,
              next: 'https://api.spotify.com/v1/playlists/7FJDxus9eWaKJHXvYmtlqb/items?limit=50&offset=50',
              items: Array.from({ length: 50 }, (_, i) => makeTrack(i + 1)),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/items?limit=50&offset=50')) {
          return new Response(
            JSON.stringify({
              total: 115,
              limit: 50,
              offset: 50,
              next: 'https://api.spotify.com/v1/playlists/7FJDxus9eWaKJHXvYmtlqb/items?limit=50&offset=100',
              items: Array.from({ length: 50 }, (_, i) => makeTrack(i + 51)),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/items?limit=50&offset=100')) {
          return new Response(
            JSON.stringify({
              total: 115,
              limit: 50,
              offset: 100,
              next: null,
              items: Array.from({ length: 15 }, (_, i) => makeTrack(i + 101)),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      }),
    );

    const progressUpdates: Array<{ loaded: number; total: number }> = [];
    const parsed = parseMediaLink('https://open.spotify.com/playlist/7FJDxus9eWaKJHXvYmtlqb');
    const result = await spotify.analyze(parsed, {
      onProgress: (loaded, total) => progressUpdates.push({ loaded, total }),
    });

    expect(result.accessStatus).toBe('full');
    expect(result.knownTotalTracks).toBe(115);
    expect(result.loadedTracks).toBe(115);
    expect(result.items).toHaveLength(115);
    expect(result.items[0].title).toBe('שלום עולם (Shalom)');
    expect(result.items[0].artist).toBe('עומר אדם');
    expect(result.items[114].trackNumber).toBe(115);
    expect(progressUpdates.some((p) => p.loaded === 50 && p.total === 115)).toBe(true);
    expect(progressUpdates.some((p) => p.loaded === 100 && p.total === 115)).toBe(true);
    expect(progressUpdates.some((p) => p.loaded === 115 && p.total === 115)).toBe(true);
  });

  it('reports restricted state honestly when /items returns 403 in Development Mode (never faking completeness)', async () => {
    const diagnostics = new DiagnosticsService();
    const auth = new SpotifyAuthService(testConfig);
    const spotify = new SpotifyService(testConfig, auth, diagnostics);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/token')) {
          return new Response(
            JSON.stringify({ access_token: 'app-token', expires_in: 3600 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/v1/playlists/7FJDxus9eWaKJHXvYmtlqb')) {
          return new Response(
            JSON.stringify({
              id: '7FJDxus9eWaKJHXvYmtlqb',
              name: 'Playlist Grande',
              owner: { display_name: 'Outro Usuário' },
              items: { total: 213, items: [] },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ error: { status: 403, message: 'Forbidden' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const parsed = parseMediaLink('https://open.spotify.com/playlist/7FJDxus9eWaKJHXvYmtlqb');
    const result = await spotify.analyze(parsed);

    expect(result.accessStatus).toBe('restricted');
    expect(result.knownTotalTracks).toBe(213);
    expect(result.loadedTracks).toBe(0);
    expect(result.restrictionReason).toContain('HTTP 403');
    expect(result.items).toHaveLength(0);

    const snap = diagnostics.snapshot(testConfig, [], auth);
    expect(snap.recentHttpErrors[0]?.statusCode).toBe(403);
    expect(JSON.stringify(snap)).not.toContain('mock-secret-value');
  });
});
