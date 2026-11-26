import crypto from 'node:crypto';
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
  sessionSecret: string;
  encryptionKey: string;
  adminDiagnosticsSecret: string;
  concurrency: number;
  ffmpegThreads: number;
  ffmpegTimeoutMs: number;
  maxUploadBytes: number;
  maxDurationSeconds: number;
  jobTtlMs: number;
  maxJobRetries: number;
  maxActiveDownloadsPerUser: number;
  maxBatchJobs: number;
  maxStoredOutputFiles: number;
  maxMetadataCacheEntries: number;
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

const EPHEMERAL_RUNTIME_SECRET = crypto.randomBytes(32).toString('hex');

export function loadConfig(env?: NodeJS.ProcessEnv): WorkerConfig {
  if (!env) {
    loadRootDotEnvIfPresent();
  }
  const source = env ?? process.env;
  const nodeEnv = source.NODE_ENV ?? 'development';
  const maxUploadMb = parsePositiveInt(source.MAX_UPLOAD_MB, 200);
  const jobTtlMinutes = parsePositiveInt(
    source.JOB_TTL_MINUTES || source.TEMP_FILE_TTL_MINUTES,
    60,
  );
  const rawSecret = source.SPOTIFY_CLIENT_SECRET ?? '';
  const rawWorkerSecret = source.WORKER_API_SECRET ?? '';
  const workerApiSecret = isPlaceholderSecret(rawWorkerSecret) ? '' : rawWorkerSecret;
  const rawSessionSecret = source.SESSION_SECRET ?? '';
  const sessionSecret = !isPlaceholderSecret(rawSessionSecret)
    ? rawSessionSecret
    : workerApiSecret || EPHEMERAL_RUNTIME_SECRET;
  const rawEncryptionKey = source.ENCRYPTION_KEY ?? '';
  const encryptionKey = !isPlaceholderSecret(rawEncryptionKey)
    ? rawEncryptionKey
    : sessionSecret;

  const frontendBaseUrl = (
    source.FRONTEND_BASE_URL ||
    source.PUBLIC_APP_URL ||
    'http://localhost:3000'
  ).replace(/\/+$/, '');

  let defaultCors = 'http://localhost:3000,http://127.0.0.1:3000';
  if (nodeEnv === 'production' && frontendBaseUrl) {
    try {
      defaultCors = new URL(frontendBaseUrl).origin;
    } catch {
      defaultCors = frontendBaseUrl;
    }
  }

  return {
    appVersion: source.APP_VERSION ?? '4.1.0',
    port: parsePositiveInt(source.PORT, 4000),
    nodeEnv,
    corsOrigin: source.CORS_ORIGIN ?? defaultCors,
    frontendBaseUrl,
    workerApiSecret,
    sessionSecret,
    encryptionKey,
    adminDiagnosticsSecret: source.ADMIN_DIAGNOSTICS_SECRET ?? '',
    concurrency: Math.min(parsePositiveInt(source.WORKER_CONCURRENCY, 4), 8),
    ffmpegThreads: Math.min(parseNonNegativeInt(source.FFMPEG_THREADS, 0), 16),
    ffmpegTimeoutMs: parsePositiveInt(source.FFMPEG_TIMEOUT_MS, 300_000),
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    maxDurationSeconds: parsePositiveInt(source.MAX_DURATION_SECONDS, 1800),
    jobTtlMs: jobTtlMinutes * 60 * 1000,
    maxJobRetries: Math.min(parsePositiveInt(source.MAX_JOB_RETRIES, 2), 5),
    maxActiveDownloadsPerUser: Math.min(parsePositiveInt(source.MAX_ACTIVE_DOWNLOADS_PER_USER, 10), 50),
    maxBatchJobs: Math.min(parsePositiveInt(source.MAX_BATCH_JOBS, 1000), 1000),
    maxStoredOutputFiles: Math.min(parsePositiveInt(source.MAX_STORED_OUTPUT_FILES, 200), 1000),
    maxMetadataCacheEntries: Math.min(parsePositiveInt(source.MAX_METADATA_CACHE_ENTRIES, 100), 500),
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
