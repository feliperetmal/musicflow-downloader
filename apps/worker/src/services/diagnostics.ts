import fs from 'node:fs';
import type { ConversionJob, DiagnosticHttpError, DiagnosticsSnapshot } from '@musicflow/shared';
import type { WorkerConfig } from '../config.js';
import type { SpotifyAuthService } from './spotify-auth.js';

export class DiagnosticsService {
  private readonly errors: DiagnosticHttpError[] = [];
  private readonly spotifyLatencies: number[] = [];
  private readonly youtubeLatencies: number[] = [];

  recordHttpError(entry: Omit<DiagnosticHttpError, 'timestamp'>): void {
    this.errors.unshift({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    if (this.errors.length > 50) {
      this.errors.length = 50;
    }
  }

  recordLatency(source: 'spotify' | 'youtube', latencyMs: number): void {
    const arr = source === 'spotify' ? this.spotifyLatencies : this.youtubeLatencies;
    arr.push(latencyMs);
    if (arr.length > 40) arr.shift();
  }

  private avg(arr: number[]): number | undefined {
    if (!arr.length) return undefined;
    return Math.round(arr.reduce((sum, n) => sum + n, 0) / arr.length);
  }

  snapshot(
    config: WorkerConfig,
    jobs: ConversionJob[],
    authService: SpotifyAuthService,
    sessionId?: string,
    extractorStatus?: { ytDlpAvailable: boolean; ytDlpVersion?: string },
  ): DiagnosticsSnapshot {
    const ffmpegAvailable =
      config.ffmpegPath === 'ffmpeg' || fs.existsSync(config.ffmpegPath);
    const ffprobeAvailable =
      config.ffprobePath === 'ffprobe' || fs.existsSync(config.ffprobePath);

    const authStatus = authService.getStatus(sessionId);

    const queues = {
      pending: jobs.filter((j) => j.status === 'queued' || j.status === 'retrying').length,
      processing: jobs.filter((j) => j.status === 'downloading').length,
      converting: jobs.filter((j) => j.status === 'converting' || j.status === 'tagging').length,
      completed: jobs.filter((j) => j.status === 'completed').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
      cancelled: jobs.filter((j) => j.status === 'cancelled').length,
    };

    return {
      appVersion: config.appVersion,
      timestamp: new Date().toISOString(),
      workerStatus: ffmpegAvailable && ffprobeAvailable ? 'ok' : 'degraded',
      ffmpeg: {
        available: ffmpegAvailable,
        ffprobeAvailable,
        concurrency: config.concurrency,
        threads: config.ffmpegThreads,
      },
      spotify: {
        clientConfigured: Boolean(config.spotifyClientId),
        hasClientSecret: Boolean(config.spotifyClientSecret),
        developmentMode: true,
        redirectUri: config.spotifyRedirectUri,
        configuredScopes: config.spotifyScopes,
        userAuthenticated: authStatus.authenticated,
        userTokenValid: authStatus.tokenValid,
        userTokenExpiresAt: authStatus.expiresAt,
        grantedScopes: authStatus.scopes,
        knownLimits: [
          'Development Mode: proprietário precisa de Spotify Premium ativo.',
          'Development Mode: até 5 usuários autorizados na allowlist do Dashboard.',
          'Playlists de terceiros podem retornar HTTP 403 em Development Mode.',
          'Spotify Web API não fornece arquivos MP3 completos (proteção DRM).',
        ],
      },
      youtube: {
        officialApiKeyConfigured: Boolean(config.youtubeApiKey),
        streamExtractorReady: true,
        ytDlpAvailable: extractorStatus?.ytDlpAvailable ?? false,
        ytDlpVersion: extractorStatus?.ytDlpVersion,
      },
      queues,
      recentHttpErrors: [...this.errors],
      averageLatencyMs: {
        spotifyApi: this.avg(this.spotifyLatencies),
        youtubeProbe: this.avg(this.youtubeLatencies),
      },
    };
  }
}
