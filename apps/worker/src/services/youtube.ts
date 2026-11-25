import type { CollectionResult, MediaItem, ParsedMediaLink } from '@musicflow/shared';
import type { WorkerConfig } from '../config.js';
import { safeFetch } from '../security/ssrf.js';
import type { DiagnosticsService } from './diagnostics.js';
import { YouTubeStreamService } from './youtube-streams.js';

const YOUTUBE_API_ALLOWED_HOSTS = new Set(['www.googleapis.com', 'www.youtube.com']);

export function parseIso8601Duration(iso?: string): number | undefined {
  if (!iso) return undefined;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(iso);
  if (!match) return undefined;
  const hours = Number.parseInt(match[1] ?? '0', 10);
  const minutes = Number.parseInt(match[2] ?? '0', 10);
  const seconds = Number.parseInt(match[3] ?? '0', 10);
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : undefined;
}

interface YouTubeThumbnailSet {
  maxres?: { url: string };
  high?: { url: string };
  medium?: { url: string };
  default?: { url: string };
}

interface YouTubeVideoRaw {
  id: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    publishedAt?: string;
    thumbnails?: YouTubeThumbnailSet;
  };
  contentDetails?: {
    duration?: string;
  };
  status?: {
    license?: string;
  };
}

function pickThumbnail(thumbs?: YouTubeThumbnailSet): string | undefined {
  return thumbs?.maxres?.url || thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url;
}

export class YouTubeService {
  private readonly streamService: YouTubeStreamService;

  constructor(
    private readonly config: WorkerConfig,
    diagnostics?: DiagnosticsService,
  ) {
    this.streamService = new YouTubeStreamService(config, diagnostics);
  }

  getStreamService(): YouTubeStreamService {
    return this.streamService;
  }

  private hasApiKey(): boolean {
    return Boolean(this.config.youtubeApiKey);
  }

  private async apiGet<T>(pathAndQuery: string): Promise<T> {
    const separator = pathAndQuery.includes('?') ? '&' : '?';
    const url = `https://www.googleapis.com/youtube/v3${pathAndQuery}${separator}key=${encodeURIComponent(this.config.youtubeApiKey)}`;
    const res = await safeFetch(url, {
      allowedHosts: YOUTUBE_API_ALLOWED_HOSTS,
      allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
    });

    if (!res.ok) {
      if (res.status === 403 || res.status === 401) {
        throw new Error('Chave YOUTUBE_API_KEY inválida ou cota da YouTube Data API v3 excedida.');
      }
      if (res.status === 404) {
        throw new Error('Vídeo ou playlist do YouTube não encontrado.');
      }
      throw new Error(`Erro na YouTube Data API v3 (HTTP ${res.status}).`);
    }

    return (await res.json()) as T;
  }

  private mapApiVideoToPlaylistItem(video: YouTubeVideoRaw, resourceType: string): MediaItem {
    const title = video.snippet?.title || 'Vídeo sem título';
    const channel = video.snippet?.channelTitle || 'Canal desconhecido';
    const canonicalUrl =
      resourceType === 'shorts'
        ? `https://www.youtube.com/shorts/${video.id}`
        : `https://www.youtube.com/watch?v=${video.id}`;
    const isCC = video.status?.license === 'creativeCommon';
    const license = isCC ? 'Creative Commons (reutilização permitida)' : 'Licença padrão YouTube';

    return {
      id: `youtube:${video.id}`,
      platform: 'youtube',
      resourceType,
      externalId: video.id,
      canonicalUrl,
      title,
      artist: channel,
      channelName: channel,
      durationSeconds: parseIso8601Duration(video.contentDetails?.duration),
      coverUrl: pickThumbnail(video.snippet?.thumbnails),
      releaseDate: video.snippet?.publishedAt?.slice(0, 10),
      licenseType: isCC ? 'creative_commons' : 'standard',
      licenseNote: license,
      downloadEligible: true,
      requiresAuthorizationConfirmation: !isCC,
      eligibilityReason: isCC
        ? 'Licença Creative Commons — disponível para download em MP3 e MP4.'
        : 'Disponível para download de conteúdos próprios ou com autorização do titular.',
    };
  }

  async analyze(parsed: ParsedMediaLink): Promise<CollectionResult> {
    if ((parsed.resourceType === 'playlist' || parsed.resourceType === 'music_playlist') && parsed.playlistId) {
      return this.analyzePlaylist(parsed);
    }

    if (parsed.id) {
      return this.analyzeSingleVideo(parsed);
    }

    throw new Error('Não foi possível identificar o vídeo ou playlist do YouTube.');
  }

  private async analyzeSingleVideo(parsed: ParsedMediaLink): Promise<CollectionResult> {
    const videoId = parsed.id!;

    // Inspect real stream formats & playability; optionally enrich with official YouTube Data API v3
    const [streamMeta, apiVideo] = await Promise.all([
      this.streamService.inspectVideo(videoId),
      this.hasApiKey()
        ? this.apiGet<{ items: YouTubeVideoRaw[] }>(
            `/videos?part=snippet,contentDetails,status&id=${encodeURIComponent(videoId)}`,
          )
            .then((d) => d.items?.[0] ?? null)
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    const title = apiVideo?.snippet?.title || streamMeta.title;
    const channel = apiVideo?.snippet?.channelTitle || streamMeta.author;
    const durationSeconds =
      parseIso8601Duration(apiVideo?.contentDetails?.duration) ?? streamMeta.durationSeconds;
    const coverUrl = pickThumbnail(apiVideo?.snippet?.thumbnails) || streamMeta.coverUrl;
    const isCC =
      apiVideo?.status?.license === 'creativeCommon' || streamMeta.isCreativeCommons;

    const item: MediaItem = {
      id: `youtube:${videoId}`,
      platform: 'youtube',
      resourceType: parsed.resourceType,
      externalId: videoId,
      canonicalUrl: parsed.normalizedUrl,
      title,
      artist: channel,
      channelName: channel,
      durationSeconds,
      coverUrl,
      releaseDate: apiVideo?.snippet?.publishedAt?.slice(0, 10),
      licenseType: isCC ? 'creative_commons' : 'standard',
      licenseNote: isCC ? 'Creative Commons (reutilização permitida)' : streamMeta.licenseNote,
      downloadEligible: streamMeta.playable && streamMeta.availableFormats.length > 0,
      requiresAuthorizationConfirmation: !isCC,
      eligibilityReason: !streamMeta.playable
        ? streamMeta.unavailableReason || 'Conteúdo indisponível para download.'
        : isCC
          ? 'Licença Creative Commons verificada — pronto para baixar em MP3 ou MP4.'
          : 'Formatos reais identificados. Confirme que você possui autorização ou direitos sobre este conteúdo para iniciar o download.',
      availableFormats: streamMeta.availableFormats,
    };

    const legalNotice = !streamMeta.playable
      ? streamMeta.unavailableReason || 'Este vídeo não pode ser baixado por restrição da plataforma.'
      : isCC
        ? 'Conteúdo sob licença Creative Commons. Escolha o formato MP3 ou MP4 desejado para baixar diretamente.'
        : 'Baixe apenas conteúdos próprios, licenciados ou com autorização do titular dos direitos.';

    return {
      platform: 'youtube',
      resourceType: parsed.resourceType,
      canonicalUrl: parsed.normalizedUrl,
      title,
      subtitle: channel,
      coverUrl,
      totalTracks: 1,
      apiMode: this.hasApiKey() ? 'official_api' : 'stream_metadata',
      legalNotice,
      items: [item],
    };
  }

  private async analyzePlaylist(parsed: ParsedMediaLink): Promise<CollectionResult> {
    const playlistId = parsed.playlistId!;

    if (this.hasApiKey()) {
      const playlistMeta = await this.apiGet<{
        items: Array<{
          snippet?: {
            title?: string;
            channelTitle?: string;
            thumbnails?: YouTubeThumbnailSet;
          };
        }>;
      }>(`/playlists?part=snippet&id=${encodeURIComponent(playlistId)}`);

      const pSnippet = playlistMeta.items?.[0]?.snippet;
      if (!pSnippet) {
        throw new Error('Playlist do YouTube não encontrada ou privada.');
      }

      const videoIds: string[] = [];
      let pageToken = '';
      for (let page = 0; page < 4; page++) {
        const listData = await this.apiGet<{
          nextPageToken?: string;
          items: Array<{ contentDetails?: { videoId?: string } }>;
        }>(
          `/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlistId)}${
            pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
          }`,
        );
        for (const item of listData.items ?? []) {
          if (item.contentDetails?.videoId) {
            videoIds.push(item.contentDetails.videoId);
          }
        }
        if (!listData.nextPageToken) break;
        pageToken = listData.nextPageToken;
      }

      const items: MediaItem[] = [];
      for (let i = 0; i < videoIds.length; i += 50) {
        const chunk = videoIds.slice(i, i + 50);
        const videosData = await this.apiGet<{ items: YouTubeVideoRaw[] }>(
          `/videos?part=snippet,contentDetails,status&id=${encodeURIComponent(chunk.join(','))}`,
        );
        for (const v of videosData.items ?? []) {
          items.push(this.mapApiVideoToPlaylistItem(v, 'video'));
        }
      }

      return {
        platform: 'youtube',
        resourceType: parsed.resourceType,
        canonicalUrl: parsed.normalizedUrl,
        title: pSnippet.title || 'Playlist do YouTube',
        subtitle: pSnippet.channelTitle || undefined,
        coverUrl: pickThumbnail(pSnippet.thumbnails) ?? items[0]?.coverUrl,
        totalTracks: items.length,
        apiMode: 'official_api',
        legalNotice:
          'Selecione as faixas autorizadas para baixar em MP3 ou gerar um arquivo ZIP, ou abra os formatos individuais de cada vídeo.',
        items,
      };
    }

    // Fallback without YOUTUBE_API_KEY using InnerTube playlist inspection
    const pl = await this.streamService.inspectPlaylist(playlistId);
    if (!pl.items.length) {
      throw new Error('Playlist vazia, privada ou indisponível.');
    }

    const items: MediaItem[] = pl.items.map((entry, idx) => ({
      id: `youtube:${entry.videoId}`,
      platform: 'youtube',
      resourceType: 'video',
      externalId: entry.videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${entry.videoId}`,
      title: entry.title,
      artist: entry.author,
      channelName: entry.author,
      trackNumber: idx + 1,
      durationSeconds: entry.durationSeconds,
      coverUrl: entry.coverUrl,
      licenseType: 'standard',
      downloadEligible: true,
      requiresAuthorizationConfirmation: true,
      eligibilityReason: 'Disponível para baixar em MP3/ZIP ou inspecionar formatos MP4 mediante confirmação de autorização.',
    }));

    return {
      platform: 'youtube',
      resourceType: parsed.resourceType,
      canonicalUrl: parsed.normalizedUrl,
      title: pl.title,
      subtitle: pl.author,
      coverUrl: pl.coverUrl,
      totalTracks: items.length,
      apiMode: 'stream_metadata',
      legalNotice:
        'Selecione as faixas autorizadas para baixar em MP3 ou gerar um arquivo ZIP, ou clique em Ver formatos em qualquer item.',
      items,
    };
  }
}
