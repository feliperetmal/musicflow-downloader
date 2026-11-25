import path from 'node:path';
import {
  ALLOWED_BITRATES,
  parseMediaLink,
  type AvailableFormatOption,
  type BitrateKbps,
  type CollectionResult,
  type MediaItem,
} from '@musicflow/shared';
import type { WorkerConfig } from '../config.js';
import { safeFetch } from '../security/ssrf.js';
import type { DiagnosticsService } from './diagnostics.js';
import { SpotifyService, type SpotifyAnalyzeOptions } from './spotify.js';
import type { SpotifyAuthService } from './spotify-auth.js';
import { YouTubeService } from './youtube.js';

export class LinkAnalyzerService {
  private readonly spotify: SpotifyService;
  private readonly youtube: YouTubeService;

  constructor(
    private readonly config: WorkerConfig,
    authService: SpotifyAuthService,
    diagnostics: DiagnosticsService,
  ) {
    this.spotify = new SpotifyService(config, authService, diagnostics);
    this.youtube = new YouTubeService(config, diagnostics);
  }

  async analyze(rawUrl: string, options: SpotifyAnalyzeOptions = {}): Promise<CollectionResult> {
    const parsed = parseMediaLink(rawUrl);
    if (!parsed.isValid) {
      throw new Error(parsed.error || 'Link inválido ou não suportado.');
    }

    if (parsed.platform === 'spotify') {
      return this.spotify.analyze(parsed, options);
    }

    if (parsed.platform === 'youtube') {
      return this.youtube.analyze(parsed);
    }

    if (parsed.platform === 'authorized_url') {
      return this.analyzeDirectAuthorizedUrl(parsed.normalizedUrl);
    }

    throw new Error('Plataforma não suportada.');
  }

  private async analyzeDirectAuthorizedUrl(urlStr: string): Promise<CollectionResult> {
    const res = await safeFetch(urlStr, {
      method: 'HEAD',
      allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
      timeoutMs: 10_000,
    });

    if (!res.ok) {
      throw new Error(`Não foi possível acessar a URL de mídia (HTTP ${res.status}).`);
    }

    const contentLengthHeader = res.headers.get('content-length');
    const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : 0;
    if (contentLength > this.config.maxUploadBytes) {
      throw new Error(
        `O arquivo remoto excede o limite configurado de ${Math.round(this.config.maxUploadBytes / 1024 / 1024)} MB.`,
      );
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const isMediaContentType =
      !contentType ||
      contentType.startsWith('audio/') ||
      contentType.startsWith('video/') ||
      contentType.includes('application/octet-stream');

    if (!isMediaContentType) {
      throw new Error(`Tipo de conteúdo inesperado para áudio/vídeo autorizado: ${contentType}`);
    }

    const urlObj = new URL(urlStr);
    const baseName = decodeURIComponent(path.basename(urlObj.pathname)) || 'midia-autorizada';
    const ext = path.extname(baseName).toLowerCase();
    const title = baseName.replace(/\.[^.]+$/, '') || 'Mídia autorizada';

    const availableFormats: AvailableFormatOption[] = ALLOWED_BITRATES.filter((b) => b !== 256).map(
      (kbps) => ({
        id: `mp3-${kbps}`,
        format: 'mp3',
        qualityLabel: `${kbps} kbps`,
        bitrateKbps: kbps as BitrateKbps,
        containerLabel: 'MP3',
        requiresTranscode: true,
        verifiedAvailable: true,
      }),
    );

    if (ext === '.mp4' || ext === '.webm' || contentType.startsWith('video/')) {
      availableFormats.push({
        id: 'mp4-original',
        format: 'mp4',
        qualityLabel: 'Original',
        containerLabel: 'MP4',
        estimatedSizeBytes: contentLength > 0 ? contentLength : undefined,
        requiresTranscode: ext !== '.mp4',
        verifiedAvailable: true,
      });
    }

    const item: MediaItem = {
      id: `url:${Buffer.from(urlStr).toString('base64url').slice(0, 24)}`,
      platform: 'authorized_url',
      resourceType: ext === '.mp4' || ext === '.webm' ? 'video' : 'audio_file',
      externalId: baseName,
      canonicalUrl: urlStr,
      authorizedAudioUrl: urlStr,
      title,
      artist: urlObj.hostname,
      licenseType: 'authorized',
      sourceOrigin: 'direct_url',
      downloadEligible: true,
      requiresAuthorizationConfirmation: true,
      eligibilityReason: 'Arquivo de mídia pronto para conversão e download.',
      availableFormats,
    };

    return {
      platform: 'authorized_url',
      resourceType: item.resourceType,
      canonicalUrl: urlStr,
      title,
      subtitle: urlObj.hostname,
      totalTracks: 1,
      apiMode: 'direct_source',
      legalNotice:
        'Confirme que você possui autorização para baixar e converter este arquivo para MP3 ou MP4.',
      items: [item],
    };
  }
}
