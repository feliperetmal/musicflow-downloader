import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { SpotifyAuthStatus } from '@musicflow/shared';
import type { WorkerConfig } from '../config.js';
import { log } from '../logger.js';
import { safeFetch } from '../security/ssrf.js';

const SPOTIFY_ACCOUNTS_HOSTS = new Set(['accounts.spotify.com', 'api.spotify.com']);

interface PendingPkceFlow {
  codeVerifier: string;
  returnTo: string;
  frontendUrl?: string;
  createdAtMs: number;
}

export interface SpotifyUserSession {
  sessionId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  lastUsedMs?: number;
  createdAtMs?: number;
  scopes: string[];
  user: {
    id: string;
    displayName: string;
    product?: string;
    country?: string;
  };
}

interface HandoffEntry {
  sessionId: string;
  returnTo: string;
  createdAtMs: number;
}

export class SpotifyAuthService {
  private readonly pendingFlows = new Map<string, PendingPkceFlow>();
  private readonly sessions = new Map<string, SpotifyUserSession>();
  private readonly handoffs = new Map<string, HandoffEntry>();
  private readonly refreshInFlight = new Map<string, Promise<string | null>>();

  constructor(private readonly config: WorkerConfig) {
    this.loadPersistedSessions();
  }

  private getSessionsFilePath(): string {
    return path.join(this.config.tempDir, '.spotify-sessions.json');
  }

  private getEncryptionKey(): Buffer {
    const secretSource =
      this.config.encryptionKey ||
      this.config.sessionSecret ||
      this.config.workerApiSecret ||
      this.config.spotifyClientId ||
      'musicflow-vault-fallback-secret-2026';
    return crypto.scryptSync(secretSource, 'musicflow-spotify-vault-salt-2026', 32);
  }

  private encryptPayload(plaintext: string): string {
    const key = this.getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
      version: 1,
      encrypted: true,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: encrypted.toString('hex'),
    });
  }

  private decryptPayload(raw: string): string | null {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.encrypted || !parsed.iv || !parsed.tag || !parsed.ciphertext) {
        return null;
      }
      const key = this.getEncryptionKey();
      const iv = Buffer.from(parsed.iv, 'hex');
      const tag = Buffer.from(parsed.tag, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(parsed.ciphertext, 'hex')),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      return null;
    }
  }

  private loadPersistedSessions(): void {
    try {
      const file = this.getSessionsFilePath();
      if (!fs.existsSync(file)) return;
      const raw = fs.readFileSync(file, 'utf8').trim();
      let sessionsJson: string | null = null;
      let isLegacyPlaintext = false;

      if (raw.startsWith('[')) {
        sessionsJson = raw;
        isLegacyPlaintext = true;
      } else {
        sessionsJson = this.decryptPayload(raw);
      }

      if (!sessionsJson) return;
      const parsed = JSON.parse(sessionsJson) as SpotifyUserSession[];
      if (Array.isArray(parsed)) {
        const now = Date.now();
        // Spotify 2026 maximum refresh token window: 180 days (6 months)
        const MAX_INACTIVITY_MS = 180 * 24 * 60 * 60 * 1000;
        for (const s of parsed) {
          if (s?.sessionId && (s.accessToken || s.refreshToken)) {
            const lastActive = s.lastUsedMs || s.createdAtMs || s.expiresAtMs;
            if (now - lastActive < MAX_INACTIVITY_MS) {
              this.sessions.set(s.sessionId, s);
            }
          }
        }
      }

      // Automatically re-encrypt if migrated from legacy plaintext
      if (isLegacyPlaintext) {
        this.persistSessions();
      }
    } catch {
      // Ignore corrupted or unreadable cache gracefully
    }
  }

  private persistSessions(): void {
    try {
      fs.mkdirSync(this.config.tempDir, { recursive: true });
      const target = this.getSessionsFilePath();
      const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      const payload = JSON.stringify(Array.from(this.sessions.values()));
      const encrypted = this.encryptPayload(payload);
      fs.writeFileSync(tmp, encrypted, { mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch {
      // Ignore write errors in read-only test envs
    }
  }

  private sanitizeFrontendUrl(rawUrl: string | undefined): string {
    if (!rawUrl) return this.config.frontendBaseUrl;
    try {
      const parsed = new URL(rawUrl);
      const allowedOrigins = this.config.corsOrigin
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);

      let configuredFrontendOrigin = '';
      try {
        configuredFrontendOrigin = new URL(this.config.frontendBaseUrl).origin;
      } catch {
        // ignore
      }

      const isLocalDev =
        this.config.nodeEnv !== 'production' &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');

      const isExplicitAllowed =
        parsed.origin === configuredFrontendOrigin ||
        allowedOrigins.includes(parsed.origin);

      if (isLocalDev || isExplicitAllowed) {
        return (
          parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, ''))
        );
      }
    } catch {
      // Ignore invalid URL
    }
    return this.config.frontendBaseUrl;
  }

  peekFlowFrontendUrl(state?: string): string {
    if (!state) return this.config.frontendBaseUrl;
    return this.pendingFlows.get(state)?.frontendUrl || this.config.frontendBaseUrl;
  }

  isConfigured(): boolean {
    return Boolean(this.config.spotifyClientId);
  }

  createLoginUrl(returnTo = '/', frontendUrl?: string): { authorizeUrl: string; state: string } {
    if (!this.config.spotifyClientId) {
      throw new Error('SPOTIFY_CLIENT_ID não configurado no servidor.');
    }

    this.pruneExpiredFlows();

    const state = crypto.randomBytes(24).toString('base64url');
    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    // Sanitize returnTo to relative path only (prevent open redirect)
    const safeReturnTo = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';

    this.pendingFlows.set(state, {
      codeVerifier,
      returnTo: safeReturnTo,
      frontendUrl: this.sanitizeFrontendUrl(frontendUrl),
      createdAtMs: Date.now(),
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.spotifyClientId,
      scope: this.config.spotifyScopes.join(' '),
      redirect_uri: this.config.spotifyRedirectUri,
      state,
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
    });

    return {
      authorizeUrl: `https://accounts.spotify.com/authorize?${params.toString()}`,
      state,
    };
  }

  async handleCallback(params: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<{ handoff: string; returnTo: string; frontendUrl?: string }> {
    if (params.error) {
      throw new Error(
        params.error === 'access_denied'
          ? 'Autorização negada pelo usuário no Spotify.'
          : `Erro OAuth Spotify: ${params.error}`,
      );
    }

    if (!params.code || !params.state) {
      throw new Error('Callback OAuth inválido: parâmetros code ou state ausentes.');
    }

    const flow = this.pendingFlows.get(params.state);
    this.pendingFlows.delete(params.state);

    if (!flow || Date.now() - flow.createdAtMs > 10 * 60 * 1000) {
      throw new Error('Estado OAuth expirado ou inválido (proteção CSRF). Tente fazer login novamente.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: this.config.spotifyRedirectUri,
      client_id: this.config.spotifyClientId,
      code_verifier: flow.codeVerifier,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    if (this.config.spotifyClientSecret) {
      const basic = Buffer.from(
        `${this.config.spotifyClientId}:${this.config.spotifyClientSecret}`,
        'utf8',
      ).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    }

    const tokenRes = await safeFetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers,
      body: body.toString(),
      allowedHosts: SPOTIFY_ACCOUNTS_HOSTS,
      allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
    });

    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      log('warn', 'Falha na troca do código OAuth Spotify', {
        status: tokenRes.status,
        detail: detail.slice(0, 120),
      });
      throw new Error(`Falha ao autenticar no Spotify (HTTP ${tokenRes.status}).`);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    const profileRes = await safeFetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      allowedHosts: SPOTIFY_ACCOUNTS_HOSTS,
      allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
    });

    if (profileRes.status === 403) {
      log('warn', 'Usuário Spotify não autorizado no aplicativo em Development Mode', {
        status: profileRes.status,
      });
      throw new Error(
        'Sua conta Spotify ainda não foi liberada no aplicativo "24" (Development Mode). Peça ao administrador para adicionar seu e-mail no Spotify Developer Dashboard.',
      );
    }

    let user: SpotifyUserSession['user'] = {
      id: 'spotify-user',
      displayName: 'Usuário Spotify',
    };
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as {
        id?: string;
        display_name?: string;
        product?: string;
        country?: string;
      };
      user = {
        id: profile.id || 'spotify-user',
        displayName: profile.display_name || profile.id || 'Usuário Spotify',
        product: profile.product,
        country: profile.country,
      };
    } else {
      throw new Error(`Não foi possível consultar o perfil do Spotify (HTTP ${profileRes.status}).`);
    }

    const sessionId = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const session: SpotifyUserSession = {
      sessionId,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAtMs: now + (tokenData.expires_in || 3600) * 1000,
      createdAtMs: now,
      lastUsedMs: now,
      scopes: (tokenData.scope ?? '').split(/\s+/).filter(Boolean),
      user,
    };

    this.sessions.set(sessionId, session);
    this.persistSessions();

    const handoff = crypto.randomBytes(24).toString('base64url');
    this.handoffs.set(handoff, {
      sessionId,
      returnTo: flow.returnTo,
      createdAtMs: Date.now(),
    });

    log('info', 'Sessão OAuth Spotify criada com sucesso', {
      userId: user.id,
      product: user.product,
      scopesCount: session.scopes.length,
      hasRefreshToken: Boolean(session.refreshToken),
    });

    return { handoff, returnTo: flow.returnTo, frontendUrl: flow.frontendUrl };
  }

  consumeHandoff(handoff: string): { sessionId: string; returnTo: string; userId: string } | null {
    const entry = this.handoffs.get(handoff);
    this.handoffs.delete(handoff);
    if (!entry || Date.now() - entry.createdAtMs > 90_000) {
      return null;
    }
    const session = this.sessions.get(entry.sessionId);
    if (!session) {
      return null;
    }
    session.lastUsedMs = Date.now();
    this.persistSessions();
    return { sessionId: entry.sessionId, returnTo: entry.returnTo, userId: session.user.id };
  }

  touchSession(sessionId?: string): void {
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastUsedMs = Date.now();
      this.persistSessions();
    }
  }

  getSession(sessionId?: string): SpotifyUserSession | undefined {
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId);
  }

  async getValidAccessToken(sessionId?: string): Promise<string | null> {
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Proactive renewal: if token expires within 5 minutes (300_000 ms), renew ahead of time
    const PROACTIVE_RENEWAL_WINDOW_MS = 300_000;
    if (session.expiresAtMs - PROACTIVE_RENEWAL_WINDOW_MS > Date.now()) {
      session.lastUsedMs = Date.now();
      return session.accessToken;
    }

    if (!session.refreshToken) {
      if (session.expiresAtMs <= Date.now()) {
        this.sessions.delete(sessionId);
        this.persistSessions();
        return null;
      }
      return session.accessToken;
    }

    // Deduplicate concurrent inflight refresh requests for the same session
    const inFlight = this.refreshInFlight.get(sessionId);
    if (inFlight) {
      return inFlight;
    }

    const refreshPromise = (async (): Promise<string | null> => {
      try {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: session.refreshToken!,
          client_id: this.config.spotifyClientId,
        });

        const headers: Record<string, string> = {
          'Content-Type': 'application/x-www-form-urlencoded',
        };
        if (this.config.spotifyClientSecret) {
          const basic = Buffer.from(
            `${this.config.spotifyClientId}:${this.config.spotifyClientSecret}`,
            'utf8',
          ).toString('base64');
          headers.Authorization = `Basic ${basic}`;
        }

        const res = await safeFetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers,
          body: body.toString(),
          allowedHosts: SPOTIFY_ACCOUNTS_HOSTS,
          allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
        });

        if (!res.ok) {
          log('warn', 'Falha ao renovar token Spotify', { status: res.status });
          if (res.status === 400 || res.status === 401) {
            // Revoked or permanently expired grant
            this.sessions.delete(sessionId);
            this.persistSessions();
            return null;
          }
          // Temporary network failure: return existing token if technically not yet fully expired
          if (session.expiresAtMs > Date.now()) {
            return session.accessToken;
          }
          return null;
        }

        const data = (await res.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in: number;
          scope?: string;
        };

        session.accessToken = data.access_token;
        if (data.refresh_token) {
          session.refreshToken = data.refresh_token; // Handle Spotify 2026 refresh token rotation
        }
        session.expiresAtMs = Date.now() + (data.expires_in || 3600) * 1000;
        session.lastUsedMs = Date.now();
        if (data.scope) {
          session.scopes = data.scope.split(/\s+/).filter(Boolean);
        }
        this.persistSessions();

        log('info', 'Token Spotify renovado proativamente com sucesso', {
          sessionIdPrefix: sessionId.slice(0, 8),
          expiresIn: data.expires_in || 3600,
          rotatedRefresh: Boolean(data.refresh_token),
        });

        return session.accessToken;
      } catch (err) {
        log('warn', 'Erro ao renovar token Spotify', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (session.expiresAtMs > Date.now()) {
          return session.accessToken;
        }
        return null;
      } finally {
        this.refreshInFlight.delete(sessionId);
      }
    })();

    this.refreshInFlight.set(sessionId, refreshPromise);
    return refreshPromise;
  }

  getStatus(sessionId?: string): SpotifyAuthStatus {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const tokenValid = Boolean(session && (session.expiresAtMs > Date.now() || session.refreshToken));

    return {
      authenticated: Boolean(session && tokenValid),
      clientConfigured: Boolean(this.config.spotifyClientId),
      hasClientSecret: Boolean(this.config.spotifyClientSecret),
      developmentMode: true,
      redirectUri: this.config.spotifyRedirectUri,
      scopes: session?.scopes ?? this.config.spotifyScopes,
      expiresAt: session ? new Date(session.expiresAtMs).toISOString() : undefined,
      tokenValid,
      user: session?.user,
    };
  }

  logout(sessionId?: string): void {
    if (sessionId) {
      this.sessions.delete(sessionId);
      this.persistSessions();
    }
  }

  private pruneExpiredFlows(): void {
    const now = Date.now();
    for (const [key, flow] of this.pendingFlows.entries()) {
      if (now - flow.createdAtMs > 10 * 60 * 1000) {
        this.pendingFlows.delete(key);
      }
    }
    for (const [key, h] of this.handoffs.entries()) {
      if (now - h.createdAtMs > 90_000) {
        this.handoffs.delete(key);
      }
    }
  }
}

export function startLocalSpotifyCallbackServer(
  authService: SpotifyAuthService,
  config: WorkerConfig,
): http.Server | null {
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(config.spotifyRedirectUri);
  } catch {
    return null;
  }

  const isLocalCallback =
    (redirectUrl.hostname === '127.0.0.1' || redirectUrl.hostname === 'localhost') &&
    redirectUrl.port === '8888';

  if (!isLocalCallback) return null;

  const server = http.createServer(async (req, res) => {
    let fallbackBase = config.frontendBaseUrl;
    try {
      const url = new URL(req.url || '/', `http://${redirectUrl.host}`);
      if (url.pathname !== redirectUrl.pathname) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code') ?? undefined;
      const state = url.searchParams.get('state') ?? undefined;
      const error = url.searchParams.get('error') ?? undefined;
      fallbackBase = authService.peekFlowFrontendUrl(state).replace(/\/+$/, '');

      const { handoff, returnTo, frontendUrl } = await authService.handleCallback({ code, state, error });
      const base = (frontendUrl || config.frontendBaseUrl).replace(/\/+$/, '');
      const isStaticOrPages =
        base.includes('github.io') || base.includes('static');
      const target = isStaticOrPages
        ? `${base}/?spotifyHandoff=${encodeURIComponent(
            handoff,
          )}&returnTo=${encodeURIComponent(returnTo)}`
        : `${base}/api/auth/spotify/complete?handoff=${encodeURIComponent(
            handoff,
          )}&returnTo=${encodeURIComponent(returnTo)}`;
      res.statusCode = 302;
      res.setHeader('Location', target);
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro na autenticação Spotify.';
      res.statusCode = 302;
      res.setHeader(
        'Location',
        `${fallbackBase}/?spotifyError=${encodeURIComponent(msg)}`,
      );
      res.end();
    }
  });

  server.on('error', (err) => {
    log('warn', 'Não foi possível iniciar callback Spotify em 127.0.0.1:8888', {
      error: err.message,
    });
  });

  server.listen(8888, redirectUrl.hostname, () => {
    log('info', `Spotify OAuth callback escutando em ${config.spotifyRedirectUri}`);
  });

  return server;
}
