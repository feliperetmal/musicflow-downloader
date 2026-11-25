import fs from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export interface WorkerConfig {
  appVersion: string;
  port: number;
  nodeEnv: string;
  corsOrigin: string;
  frontendBaseUrl: string;
  workerApiSecret: string;
  adminDiagnosticsSecret: string;
  concurrency: number;
  ffmpegThreads: number;
  ffmpegTimeoutMs: number;
  maxUploadBytes: number;
  maxDurationSeconds: number;
  jobTtlMs: number;
  maxJobRetries: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  ffmpegPath: string;
  ffprobePath: string;
  ytDlpPath: string;
  tempDir: string;
  spotifyClientId: string;
  spotifyClientSecret: string;
  spotifyRedirectUri: string;
  spotifyScopes: string[];
  youtubeApiKey: string;
  allowPrivateNetworkFetch: boolean;
}

function loadRootDotEnvIfPresent(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
      break;
    } catch {
      // Ignore unreadable .env
    }
  }
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isPlaceholderSecret(val: string): boolean {
  const trimmed = val.trim();
  return (
    !trimmed ||
    trimmed === 'SUBSTITUIR_POR_NOVO_SEGREDO' ||
    trimmed.startsWith('change-this')
  );
}

export function loadConfig(env?: NodeJS.ProcessEnv): WorkerConfig {
  if (!env) {
    loadRootDotEnvIfPresent();
  }
  const source = env ?? process.env;
  const maxUploadMb = parsePositiveInt(source.MAX_UPLOAD_MB, 200);
  const jobTtlMinutes = parsePositiveInt(source.JOB_TTL_MINUTES, 60);
  const rawSecret = source.SPOTIFY_CLIENT_SECRET ?? '';

  return {
    appVersion: source.APP_VERSION ?? '3.0.0',
    port: parsePositiveInt(source.PORT, 4000),
    nodeEnv: source.NODE_ENV ?? 'development',
    corsOrigin: source.CORS_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000',
    frontendBaseUrl: (source.FRONTEND_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    workerApiSecret: source.WORKER_API_SECRET ?? '',
    adminDiagnosticsSecret: source.ADMIN_DIAGNOSTICS_SECRET ?? '',
    concurrency: Math.min(parsePositiveInt(source.WORKER_CONCURRENCY, 4), 8),
    ffmpegThreads: Math.min(parseNonNegativeInt(source.FFMPEG_THREADS, 0), 16),
    ffmpegTimeoutMs: parsePositiveInt(source.FFMPEG_TIMEOUT_MS, 300_000),
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    maxDurationSeconds: parsePositiveInt(source.MAX_DURATION_SECONDS, 1800),
    jobTtlMs: jobTtlMinutes * 60 * 1000,
    maxJobRetries: Math.min(parsePositiveInt(source.MAX_JOB_RETRIES, 2), 5),
    rateLimitWindowMs: parsePositiveInt(source.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMaxRequests: parsePositiveInt(source.RATE_LIMIT_MAX_REQUESTS, 60),
    ffmpegPath: source.FFMPEG_PATH || (typeof ffmpegStatic === 'string' ? ffmpegStatic : 'ffmpeg'),
    ffprobePath: source.FFPROBE_PATH || ffprobeStatic?.path || 'ffprobe',
    ytDlpPath: source.YTDLP_PATH || '',
    tempDir: path.resolve(source.TEMP_DIR || path.join(process.cwd(), 'tmp', 'musicflow')),
    spotifyClientId: source.SPOTIFY_CLIENT_ID ?? '',
    spotifyClientSecret: isPlaceholderSecret(rawSecret) ? '' : rawSecret,
    spotifyRedirectUri: source.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:8888/callback',
    spotifyScopes: (source.SPOTIFY_SCOPES ?? 'playlist-read-private playlist-read-collaborative')
      .split(/\s+/)
      .filter(Boolean),
    youtubeApiKey: source.YOUTUBE_API_KEY ?? '',
    allowPrivateNetworkFetch: source.ALLOW_PRIVATE_NETWORK_FETCH === 'true',
  };
}
