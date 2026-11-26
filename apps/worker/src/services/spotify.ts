import {
  ALLOWED_BITRATES,
  parseMediaLink,
  type AvailableFormatOption,
  type BitrateKbps,
  type CollectionResult,
  type MediaItem,
  type ParsedMediaLink,
} from '@musicflow/shared';
import type { WorkerConfig } from '../config.js';
import { log } from '../logger.js';
import { safeFetch } from '../security/ssrf.js';
import type { DiagnosticsService } from './diagnostics.js';
import type { SpotifyAuthService } from './spotify-auth.js';

const SPOTIFY_API_ALLOWED_HOSTS = new Set(['accounts.spotify.com', 'api.spotify.com', 'open.spotify.com']);

interface SpotifyTokenCache {
  token: string;
  expiresAtMs: number;
}

interface SpotifyImage {
  url: string;
  width?: number;
  height?: number;
}

interface SpotifyArtist {
  name: string;
}

interface SpotifyTrackRaw {
  id: string;
  name: string;
  duration_ms: number;
  track_number?: number;
  external_ids?: { isrc?: string };
  external_urls?: { spotify?: string };
  artists?: SpotifyArtist[];
  album?: {
    name?: string;
    release_date?: string;
    images?: SpotifyImage[];
  };
}

interface SpotifyPlaylistEntryRaw {
  item?: SpotifyTrackRaw | null;
  track?: SpotifyTrackRaw | null;
}

interface SpotifyPlaylistPageRaw {
  items?: SpotifyPlaylistEntryRaw[];
  total?: number;
  limit?: number;
  offset?: number;
  next?: string | null;
}

interface SpotifyPlaylistMetaRaw {
  id: string;
  name: string;
  description?: string;
  external_urls?: { spotify?: string };
  owner?: {
    display_name?: string;
    id?: string;
    external_urls?: { spotify?: string };
  };
  images?: SpotifyImage[];
  items?: SpotifyPlaylistPageRaw;
  tracks?: SpotifyPlaylistPageRaw;
}

export class SpotifyApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

export interface SpotifyAnalyzeOptions {
  sessionId?: string;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number, stage: string) => void;
}

export class SpotifyService {
  private clientTokenCache: SpotifyTokenCache | null = null;
  private readonly metadataCache = new Map<string, { result: CollectionResult; cachedAtMs: number }>();

  constructor(
    private readonly config: WorkerConfig,
    private readonly authService: SpotifyAuthService,
    private readonly diagnostics: DiagnosticsService,
  ) {}

  private setMetadataCache(key: string, result: CollectionResult): void {
    const now = Date.now();
    // Prune expired entries first
    for (const [k, entry] of this.metadataCache.entries()) {
      if (now - entry.cachedAtMs >= 5 * 60 * 1000) {
        this.metadataCache.delete(k);
      }
    }
    // Enforce bounded LRU cache size for low-RAM containers (e.g. Render Free 512 MB)
    const maxEntries = Math.max(10, this.config.maxMetadataCacheEntries);
    while (this.metadataCache.size >= maxEntries) {
      const oldestKey = this.metadataCache.keys().next().value;
      if (!oldestKey) break;
      this.metadataCache.delete(oldestKey);
    }
    this.metadataCache.set(key, { result, cachedAtMs: now });
  }

  private hasClientSecretCredentials(): boolean {
    return Boolean(this.config.spotifyClientId && this.config.spotifyClientSecret);
  }

  private async getClientCredentialsToken(): Promise<string> {
    const now = Date.now();
    if (this.clientTokenCache && this.clientTokenCache.expiresAtMs - 30_000 > now) {
      return this.clientTokenCache.token;
    }

    const basic = Buffer.from(
      `${this.config.spotifyClientId}:${this.config.spotifyClientSecret}`,
      'utf8',
    ).toString('base64');

    const res = await safeFetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      allowedHosts: SPOTIFY_API_ALLOWED_HOSTS,
      allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
    });

    if (!res.ok) {
      this.diagnostics.recordHttpError({
        source: 'spotify',
        statusCode: res.status,
        message: 'Falha ao obter token Client Credentials na Spotify API.',
      });
      throw new SpotifyApiError(
        res.status,
        `Falha ao autenticar na Spotify Web API (HTTP ${res.status}). Verifique SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET.`,
      );
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.clientTokenCache = {
      token: data.access_token,
      expiresAtMs: now + (data.expires_in || 3600) * 1000,
    };
    return this.clientTokenCache.token;
  }

  private async resolveToken(sessionId?: string): Promise<{ token: string; mode: 'user_oauth' | 'client_credentials' } | null> {
    const userToken = await this.authService.getValidAccessToken(sessionId);
    if (userToken) {
      return { token: userToken, mode: 'user_oauth' };
    }
    if (this.hasClientSecretCredentials()) {
      const token = await this.getClientCredentialsToken();
      return { token, mode: 'client_credentials' };
    }
    return null;
  }

  private async apiGet<T>(
    endpoint: string,
    token: string,
    signal?: AbortSignal,
    attempt = 0,
  ): Promise<T> {
    const started = Date.now();
    const res = await safeFetch(`https://api.spotify.com/v1${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      allowedHosts: SPOTIFY_API_ALLOWED_HOSTS,
      allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
      signal,
    });
    const latency = Date.now() - started;
    this.diagnostics.recordLatency('spotify', latency);

    if (res.status === 429 && attempt < 2) {
      const retryAfterSec = Math.min(10, Number.parseInt(res.headers.get('retry-after') || '2', 10) || 2);
      await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
      return this.apiGet<T>(endpoint, token, signal, attempt + 1);
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      let spotifyMsg = '';
      try {
        const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
        spotifyMsg = parsed.error?.message || '';
      } catch {
        // ignore non-json error body
      }

      this.diagnostics.recordHttpError({
        source: 'spotify',
        statusCode: res.status,
        latencyMs: latency,
        message: `GET ${endpoint.split('?')[0]} -> HTTP ${res.status}${spotifyMsg ? `: ${spotifyMsg}` : ''}`,
      });

      if (res.status === 401) {
        throw new SpotifyApiError(401, 'Sessão Spotify expirada ou não autorizada. Conecte sua conta novamente.');
      }
      if (res.status === 403) {
        throw new SpotifyApiError(
          403,
          spotifyMsg ||
            'Acesso negado pela Spotify Web API (HTTP 403). No Development Mode (fev/2026), playlists de terceiros ou usuários fora da allowlist têm acesso restrito.',
        );
      }
      if (res.status === 404) {
        throw new SpotifyApiError(404, 'Faixa, álbum ou playlist do Spotify não encontrado ou privado.');
      }
      if (res.status === 429) {
        throw new SpotifyApiError(429, 'Limite de requisições da Spotify Web API atingido. Aguarde alguns segundos.');
      }
      throw new SpotifyApiError(res.status, `Erro na Spotify Web API (HTTP ${res.status}).`);
    }

    return (await res.json()) as T;
  }

  async resolveShareLink(parsed: ParsedMediaLink, signal?: AbortSignal): Promise<ParsedMediaLink> {
    if (!parsed.isShareShortlink) return parsed;

    const res = await safeFetch(parsed.normalizedUrl, {
      method: 'GET',
      allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
      timeoutMs: 10_000,
      signal,
    });

    const finalParsed = parseMediaLink(res.url);
    if (!finalParsed.isValid || finalParsed.platform !== 'spotify' || finalParsed.isShareShortlink) {
      throw new Error('Não foi possível resolver o link compartilhado do Spotify para uma faixa, álbum ou playlist.');
    }
    return finalParsed;
  }

  private buildTrackFormats(durationSeconds?: number): AvailableFormatOption[] {
    const formats: AvailableFormatOption[] = ALLOWED_BITRATES.filter((b) => b !== 256).map(
      (kbps) => ({
        id: `mp3-${kbps}`,
        format: 'mp3',
        qualityLabel: `${kbps} kbps`,
        bitrateKbps: kbps as BitrateKbps,
        containerLabel: 'MP3',
        estimatedSizeBytes:
          durationSeconds && durationSeconds > 0
            ? Math.round((durationSeconds * kbps * 1000) / 8)
            : undefined,
        requiresTranscode: true,
        verifiedAvailable: true,
      }),
    );

    formats.push({
      id: 'mp4-720p',
      format: 'mp4',
      qualityLabel: '720p',
      resolution: '720p',
      containerLabel: 'MP4',
      requiresTranscode: false,
      verifiedAvailable: true,
    });

    return formats;
  }

  private mapTrackToMediaItem(
    track: SpotifyTrackRaw,
    orderIndex: number,
    fallbackAlbum?: string,
    fallbackCover?: string,
  ): MediaItem {
    const id = track.id || `pos-${orderIndex}`;
    const canonicalUrl = track.external_urls?.spotify || `https://open.spotify.com/track/${id}`;
    const artists = (track.artists ?? []).map((a) => a.name).filter(Boolean).join(', ') || 'Artista desconhecido';
    const coverUrl = track.album?.images?.[0]?.url || fallbackCover;
    const durationSeconds =
      typeof track.duration_ms === 'number' ? Math.round(track.duration_ms / 1000) : undefined;

    return {
      id: `spotify:${id}:${orderIndex}`,
      platform: 'spotify',
      resourceType: 'track',
      externalId: id,
      canonicalUrl,
      title: track.name || 'Faixa sem título',
      artist: artists,
      album: track.album?.name || fallbackAlbum,
      trackNumber: orderIndex,
      durationSeconds,
      coverUrl,
      releaseDate: track.album?.release_date,
      isrc: track.external_ids?.isrc,
      sourceOrigin: 'youtube_stream',
      downloadEligible: true,
      requiresAuthorizationConfirmation: false,
      eligibilityReason: 'Pronto para baixar em MP3 (com capa e tags ID3) ou MP4.',
      availableFormats: this.buildTrackFormats(durationSeconds),
    };
  }

  async analyze(parsedInput: ParsedMediaLink, options: SpotifyAnalyzeOptions = {}): Promise<CollectionResult> {
    const parsed = await this.resolveShareLink(parsedInput, options.signal);
    const cacheKey = `${parsed.normalizedUrl}:${options.sessionId ? 'user' : 'anon'}`;
    const cached = this.metadataCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAtMs < 5 * 60 * 1000) {
      options.onProgress?.(
        cached.result.loadedTracks ?? cached.result.items.length,
        cached.result.knownTotalTracks ?? cached.result.totalTracks,
        `${cached.result.items.length} músicas carregadas (cache)`,
      );
      return cached.result;
    }

    const legalNotice =
      'Selecione as músicas desejadas e clique em "Baixar ZIP" para baixar todas em MP3 automaticamente em um único arquivo compactado.';

    const auth = await this.resolveToken(options.sessionId);

    if (!auth) {
      return this.analyzeWithoutToken(parsed, legalNotice, options.signal);
    }

    if (parsed.resourceType === 'track' && parsed.id) {
      const track = await this.apiGet<SpotifyTrackRaw>(`/tracks/${parsed.id}`, auth.token, options.signal);
      const item = this.mapTrackToMediaItem(track, 1);
      const result: CollectionResult = {
        platform: 'spotify',
        resourceType: 'track',
        canonicalUrl: parsed.normalizedUrl,
        title: item.title,
        subtitle: item.artist,
        coverUrl: item.coverUrl,
        totalTracks: 1,
        knownTotalTracks: 1,
        loadedTracks: 1,
        totalDurationSeconds: item.durationSeconds ?? 0,
        accessStatus: 'full',
        apiMode: 'official_api',
        legalNotice,
        items: [item],
      };
      this.setMetadataCache(cacheKey, result);
      return result;
    }

    if (parsed.resourceType === 'album' && parsed.id) {
      const album = await this.apiGet<{
        id: string;
        name: string;
        release_date?: string;
        artists?: SpotifyArtist[];
        images?: SpotifyImage[];
        tracks: { items: SpotifyTrackRaw[]; total: number; next: string | null };
      }>(`/albums/${parsed.id}?limit=50`, auth.token, options.signal);

      const coverUrl = album.images?.[0]?.url;
      const totalKnown = album.tracks?.total ?? 0;
      const items: MediaItem[] = [];
      let idx = 1;

      for (const t of album.tracks?.items ?? []) {
        items.push(
          this.mapTrackToMediaItem(
            { ...t, album: { name: album.name, release_date: album.release_date, images: album.images } },
            idx++,
            album.name,
            coverUrl,
          ),
        );
      }
      options.onProgress?.(items.length, totalKnown, `Carregando músicas: ${items.length} de ${totalKnown}`);

      let nextOffset = items.length;
      while (nextOffset < totalKnown) {
        if (options.signal?.aborted) throw new Error('Carregamento cancelado.');
        const page = await this.apiGet<{ items: SpotifyTrackRaw[]; next: string | null }>(
          `/albums/${parsed.id}/tracks?limit=50&offset=${nextOffset}`,
          auth.token,
          options.signal,
        );
        if (!page.items.length) break;
        for (const t of page.items) {
          items.push(
            this.mapTrackToMediaItem(
              { ...t, album: { name: album.name, release_date: album.release_date, images: album.images } },
              idx++,
              album.name,
              coverUrl,
            ),
          );
        }
        nextOffset += page.items.length;
        options.onProgress?.(items.length, totalKnown, `Carregando músicas: ${items.length} de ${totalKnown}`);
        if (!page.next) break;
      }

      const totalDurationSeconds = items.reduce((acc, it) => acc + (it.durationSeconds ?? 0), 0);
      const result: CollectionResult = {
        platform: 'spotify',
        resourceType: 'album',
        canonicalUrl: parsed.normalizedUrl,
        title: album.name,
        subtitle: (album.artists ?? []).map((a) => a.name).join(', '),
        ownerName: (album.artists ?? []).map((a) => a.name).join(', '),
        coverUrl,
        totalTracks: totalKnown || items.length,
        knownTotalTracks: totalKnown || items.length,
        loadedTracks: items.length,
        totalDurationSeconds,
        accessStatus: items.length >= totalKnown ? 'full' : 'partial',
        apiMode: 'official_api',
        legalNotice,
        items,
      };
      this.setMetadataCache(cacheKey, result);
      return result;
    }

    if (parsed.resourceType === 'playlist' && parsed.id) {
      const result = await this.analyzePlaylist(parsed, auth.token, legalNotice, options);
      if (result.items.length === 0) {
        const fallback = await this.analyzeWithoutToken(parsed, legalNotice, options.signal);
        if (fallback.items.length > 0) {
          return {
            ...fallback,
            knownTotalTracks: result.knownTotalTracks || fallback.knownTotalTracks,
          };
        }
      }
      if (result.accessStatus === 'full') {
        this.setMetadataCache(cacheKey, result);
      }
      return result;
    }

    throw new Error('Tipo de recurso do Spotify não suportado.');
  }

  private async analyzePlaylist(
    parsed: ParsedMediaLink,
    token: string,
    legalNotice: string,
    options: SpotifyAnalyzeOptions,
  ): Promise<CollectionResult> {
    const playlistId = parsed.id!;
    const meta = await this.apiGet<SpotifyPlaylistMetaRaw>(
      `/playlists/${playlistId}`,
      token,
      options.signal,
    );

    const coverUrl = meta.images?.[0]?.url;
    const ownerName = meta.owner?.display_name || meta.owner?.id || 'Spotify';
    const ownerUrl = meta.owner?.external_urls?.spotify;

    // Support both Feb 2026 (`items`) and legacy (`tracks`) response shapes
    const initialPage = meta.items ?? meta.tracks;
    const knownTotal = initialPage?.total ?? 0;

    const items: MediaItem[] = [];
    const seenPositionKeys = new Set<string>();

    const pushEntries = (entries: SpotifyPlaylistEntryRaw[] | undefined) => {
      if (!entries) return;
      for (const entry of entries) {
        const trackObj = entry.item ?? entry.track;
        if (!trackObj) continue;
        const pos = items.length + 1;
        const dedupeKey = `${pos}:${trackObj.id || trackObj.name}`;
        if (seenPositionKeys.has(dedupeKey)) continue;
        seenPositionKeys.add(dedupeKey);
        items.push(this.mapTrackToMediaItem(trackObj, pos, undefined, coverUrl));
      }
    };

    // First check if `/playlists/{id}` already included initial entries
    if (initialPage?.items?.length) {
      pushEntries(initialPage.items);
      options.onProgress?.(
        items.length,
        knownTotal || items.length,
        `Carregando músicas: ${items.length} de ${knownTotal || items.length}`,
      );
    }

    // Fetch via Feb 2026 `/playlists/{id}/items` endpoint (paginating in pages of 50)
    let offset = items.length;
    let accessStatus: CollectionResult['accessStatus'] = 'full';
    let restrictionReason: string | undefined;

    while (knownTotal === 0 ? offset === 0 : offset < knownTotal) {
      if (options.signal?.aborted) {
        throw new Error('Carregamento da playlist cancelado.');
      }

      const limit = 50;
      try {
        const page = await this.apiGet<SpotifyPlaylistPageRaw>(
          `/playlists/${playlistId}/items?limit=${limit}&offset=${offset}`,
          token,
          options.signal,
        );

        const pageEntries = page.items ?? [];
        if (pageEntries.length === 0) {
          break;
        }

        pushEntries(pageEntries);
        const targetTotal = page.total ?? knownTotal ?? items.length;
        options.onProgress?.(
          items.length,
          targetTotal,
          `Carregando músicas: ${items.length} de ${targetTotal}`,
        );

        offset += pageEntries.length;
        if (!page.next && items.length >= targetTotal) {
          break;
        }
        if (pageEntries.length < limit && !page.next) {
          break;
        }
      } catch (err) {
        if (err instanceof SpotifyApiError && (err.statusCode === 403 || err.statusCode === 401)) {
          accessStatus = items.length > 0 ? 'partial' : 'restricted';
          restrictionReason =
            err.statusCode === 403
              ? `A Spotify API retornou HTTP 403 ao consultar /playlists/${playlistId}/items. Em Development Mode (fev/2026), playlists de terceiros não pertencentes ou colaboradas pelo usuário autenticado têm a listagem de faixas bloqueada (${knownTotal} faixas conhecidas, ${items.length} carregadas).`
              : err.message;
          log('warn', 'Restrição ao paginar /playlists/{id}/items', {
            playlistId,
            statusCode: err.statusCode,
            knownTotal,
            loaded: items.length,
          });
          break;
        }
        throw err;
      }
    }

    if (knownTotal > 0 && items.length < knownTotal && accessStatus === 'full') {
      accessStatus = items.length === 0 ? 'restricted' : 'partial';
      restrictionReason = `Carregadas ${items.length} de ${knownTotal} faixas (algumas faixas podem estar indisponíveis ou restritas pela plataforma).`;
    }

    const finalTotal = knownTotal || items.length;
    options.onProgress?.(items.length, finalTotal, `${items.length} músicas carregadas`);

    const totalDurationSeconds = items.reduce((acc, it) => acc + (it.durationSeconds ?? 0), 0);

    return {
      platform: 'spotify',
      resourceType: 'playlist',
      canonicalUrl: meta.external_urls?.spotify || parsed.normalizedUrl,
      title: meta.name || 'Playlist do Spotify',
      subtitle: `Playlist de ${ownerName}`,
      description: meta.description,
      ownerName,
      ownerUrl,
      coverUrl,
      totalTracks: finalTotal,
      knownTotalTracks: finalTotal,
      loadedTracks: items.length,
      totalDurationSeconds,
      accessStatus,
      restrictionReason,
      requiresSpotifyLogin: accessStatus === 'restricted' && !options.sessionId,
      apiMode: 'official_api',
      legalNotice,
      items,
    };
  }

  private async analyzeWithoutToken(
    parsed: ParsedMediaLink,
    legalNotice: string,
    signal?: AbortSignal,
  ): Promise<CollectionResult> {
    if (parsed.id && ['track', 'album', 'playlist'].includes(parsed.resourceType)) {
      try {
        const embedUrl = `https://open.spotify.com/embed/${parsed.resourceType}/${parsed.id}`;
        const res = await safeFetch(embedUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          allowedHosts: SPOTIFY_API_ALLOWED_HOSTS,
          allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
          signal,
        });
        if (res.ok) {
          const html = await res.text();
          const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(
            html,
          );
          if (match) {
            const parsedJson = JSON.parse(match[1]) as {
              props?: {
                pageProps?: {
                  state?: {
                    data?: {
                      entity?: {
                        type?: string;
                        id?: string;
                        name?: string;
                        title?: string;
                        subtitle?: string;
                        duration?: number;
                        artists?: Array<{ name?: string }>;
                        visualIdentity?: { image?: Array<{ url: string; maxHeight?: number }> };
                        coverArt?: { sources?: Array<{ url: string; height?: number }> };
                        trackList?: Array<{
                          uri?: string;
                          uid?: string;
                          title?: string;
                          subtitle?: string;
                          duration?: number;
                        }>;
                      };
                    };
                  };
                };
              };
            };

            const entity = parsedJson.props?.pageProps?.state?.data?.entity;
            if (entity) {
              const images = entity.visualIdentity?.image ?? [];
              const bestImg =
                [...images].sort((a, b) => (b.maxHeight ?? 0) - (a.maxHeight ?? 0))[0]?.url ||
                entity.coverArt?.sources?.[0]?.url;

              const entityTitle = entity.title || entity.name || `Spotify ${parsed.resourceType}`;

              if (parsed.resourceType === 'track') {
                const artistStr =
                  (entity.artists ?? []).map((a) => a.name).filter(Boolean).join(', ') ||
                  entity.subtitle ||
                  'Artista';
                const durSec =
                  typeof entity.duration === 'number' ? Math.round(entity.duration / 1000) : undefined;
                const item: MediaItem = {
                  id: `spotify:${parsed.id}:1`,
                  platform: 'spotify',
                  resourceType: 'track',
                  externalId: parsed.id,
                  canonicalUrl: parsed.normalizedUrl,
                  title: entityTitle,
                  artist: artistStr,
                  trackNumber: 1,
                  durationSeconds: durSec,
                  coverUrl: bestImg,
                  sourceOrigin: 'youtube_stream',
                  downloadEligible: true,
                  requiresAuthorizationConfirmation: false,
                  eligibilityReason: 'Pronto para baixar em MP3 ou MP4.',
                  availableFormats: this.buildTrackFormats(durSec),
                };

                return {
                  platform: 'spotify',
                  resourceType: 'track',
                  canonicalUrl: parsed.normalizedUrl,
                  title: entityTitle,
                  subtitle: artistStr,
                  coverUrl: bestImg,
                  totalTracks: 1,
                  knownTotalTracks: 1,
                  loadedTracks: 1,
                  totalDurationSeconds: durSec ?? 0,
                  accessStatus: 'full',
                  apiMode: 'stream_metadata',
                  legalNotice: 'Escolha MP3 ou MP4 abaixo para iniciar o download.',
                  items: [item],
                };
              }

              const trackList = entity.trackList ?? [];
              if (trackList.length > 0) {
                const items: MediaItem[] = trackList.map((t, i) => {
                  const trackId = t.uri?.split(':').pop() || t.uid || `${i + 1}`;
                  const durSec =
                    typeof t.duration === 'number' ? Math.round(t.duration / 1000) : undefined;
                  return {
                    id: `spotify:${trackId}:${i + 1}`,
                    platform: 'spotify',
                    resourceType: 'track',
                    externalId: trackId,
                    canonicalUrl: `https://open.spotify.com/track/${trackId}`,
                    title: t.title || `Faixa ${i + 1}`,
                    artist: (t.subtitle || entity.subtitle || 'Artista').replace(/\u00a0/g, ' '),
                    album: parsed.resourceType === 'album' ? entityTitle : undefined,
                    trackNumber: i + 1,
                    durationSeconds: durSec,
                    coverUrl: bestImg,
                    sourceOrigin: 'youtube_stream',
                    downloadEligible: true,
                    requiresAuthorizationConfirmation: false,
                    eligibilityReason: 'Pronto para baixar em MP3 ou ZIP.',
                    availableFormats: this.buildTrackFormats(durSec),
                  };
                });

                const totalDurationSeconds = items.reduce(
                  (acc, it) => acc + (it.durationSeconds ?? 0),
                  0,
                );
                const isCappedAt100 = items.length === 100 && parsed.resourceType === 'playlist';

                return {
                  platform: 'spotify',
                  resourceType: parsed.resourceType,
                  canonicalUrl: parsed.normalizedUrl,
                  title: entityTitle,
                  subtitle: entity.subtitle ? `Por ${entity.subtitle}` : undefined,
                  ownerName: entity.subtitle,
                  coverUrl: bestImg,
                  totalTracks: items.length,
                  knownTotalTracks: items.length,
                  loadedTracks: items.length,
                  totalDurationSeconds,
                  accessStatus: isCappedAt100 ? 'partial' : 'full',
                  restrictionReason: isCappedAt100
                    ? '100 primeiras músicas públicas carregadas automaticamente. Conecte sua conta Spotify no topo para carregar páginas extras de playlists longas.'
                    : undefined,
                  requiresSpotifyLogin: isCappedAt100,
                  apiMode: 'stream_metadata',
                  legalNotice:
                    'Selecione as músicas desejadas para baixar individualmente em MP3 ou todas juntas em ZIP.',
                  items,
                };
              }
            }
          }
        }
      } catch (err) {
        log('warn', 'Falha ao consultar metadados públicos do Spotify', {
          error: (err as Error).message,
        });
      }
    }

    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(parsed.normalizedUrl)}`;
    let title = `Spotify ${parsed.resourceType}`;
    let coverUrl: string | undefined;

    try {
      const res = await safeFetch(oembedUrl, {
        allowedHosts: SPOTIFY_API_ALLOWED_HOSTS,
        allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
        signal,
      });
      if (res.ok) {
        const data = (await res.json()) as { title?: string; thumbnail_url?: string };
        if (data.title) title = data.title;
        if (data.thumbnail_url) coverUrl = data.thumbnail_url;
      }
    } catch {
      // Ignore oEmbed failure
    }

    return {
      platform: 'spotify',
      resourceType: parsed.resourceType,
      canonicalUrl: parsed.normalizedUrl,
      title,
      subtitle: 'Conecte sua conta Spotify para carregar playlists privadas',
      coverUrl,
      totalTracks: 0,
      knownTotalTracks: 0,
      loadedTracks: 0,
      accessStatus: 'auth_required',
      restrictionReason:
        'Esta playlist parece privada ou restrita. Clique em "Conectar com Spotify" para autenticar com sua conta.',
      requiresSpotifyLogin: true,
      apiMode: 'oembed_fallback',
      legalNotice,
      items: [],
    };
  }
}
