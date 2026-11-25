import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { Innertube, UniversalCache } from 'youtubei.js';
import {
  ALLOWED_BITRATES,
  type AvailableFormatOption,
  type BitrateKbps,
} from '@musicflow/shared';
import type { WorkerConfig } from '../config.js';
import { log } from '../logger.js';
import type { DiagnosticsService } from './diagnostics.js';

const IOS_USER_AGENT =
  'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)';

export class MediaHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly transient: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'MediaHttpError';
  }
}

export interface YouTubeStreamMetadata {
  videoId: string;
  title: string;
  author: string;
  durationSeconds?: number;
  coverUrl?: string;
  isCreativeCommons: boolean;
  licenseNote: string;
  playable: boolean;
  unavailableReason?: string;
  availableFormats: AvailableFormatOption[];
}

export interface YouTubePlaylistEntry {
  videoId: string;
  title: string;
  author: string;
  durationSeconds?: number;
  coverUrl?: string;
}

export interface YouTubePlaylistResult {
  title: string;
  author?: string;
  coverUrl?: string;
  items: YouTubePlaylistEntry[];
}

interface YtDlpCommandSpec {
  cmd: string;
  baseArgs: string[];
  version: string;
}

interface YtDlpRawFormat {
  format_id?: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  height?: number;
  fps?: number;
  abr?: number;
  tbr?: number;
  filesize?: number;
  filesize_approx?: number;
}

interface YtDlpRawInfo {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  license?: string;
  is_live?: boolean;
  formats?: YtDlpRawFormat[];
}

function parseClockDuration(text?: string): number | undefined {
  if (!text) return undefined;
  const parts = text.trim().split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n) || n < 0)) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

function normalizeHeightLabel(height?: number): { key: string; label: string; order: number } | null {
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 144) return null;
  // Normalize common heights cleanly
  const standardHeights = [144, 240, 360, 480, 720, 1080, 1440, 2160];
  let nearest = height;
  for (const h of standardHeights) {
    if (Math.abs(height - h) <= 20) {
      nearest = h;
      break;
    }
  }
  const label = nearest >= 2160 ? '4K (2160p)' : `${nearest}p`;
  return { key: `${nearest}p`, label, order: nearest };
}

function parseTotalFromContentRange(header: string | null): number | undefined {
  if (!header) return undefined;
  const match = /\/(\d+)$/.exec(header.trim());
  if (!match) return undefined;
  const total = Number.parseInt(match[1], 10);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

function computeBackoffWithJitter(attempt: number, baseMs = 600): number {
  const exp = baseMs * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 400);
  return Math.min(8000, exp + jitter);
}

async function execProbeCmd(
  cmd: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ ok: false, stdout: '' });
    }, timeoutMs);
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: '' });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim() });
    });
  });
}

export class YouTubeStreamService {
  private clientPromise: Promise<Innertube> | null = null;
  private ytDlpPromise: Promise<YtDlpCommandSpec | null> | null = null;
  private cachedYtDlpStatus: { available: boolean; version?: string } = { available: false };
  private readonly videoCache = new Map<string, { meta: YouTubeStreamMetadata; cachedAtMs: number }>();

  constructor(
    private readonly config: WorkerConfig,
    private readonly diagnostics?: DiagnosticsService,
  ) {
    // Warm up yt-dlp detection asynchronously
    void this.resolveYtDlp();
  }

  getExtractorStatus(): { ytDlpAvailable: boolean; ytDlpVersion?: string } {
    return {
      ytDlpAvailable: this.cachedYtDlpStatus.available,
      ytDlpVersion: this.cachedYtDlpStatus.version,
    };
  }

  private resolveYtDlp(): Promise<YtDlpCommandSpec | null> {
    if (!this.ytDlpPromise) {
      this.ytDlpPromise = (async () => {
        const candidates: Array<{ cmd: string; baseArgs: string[] }> = [];
        if (this.config.ytDlpPath) {
          candidates.push({ cmd: this.config.ytDlpPath, baseArgs: [] });
        }
        candidates.push(
          { cmd: 'yt-dlp', baseArgs: [] },
          { cmd: 'python', baseArgs: ['-m', 'yt_dlp'] },
          { cmd: 'python3', baseArgs: ['-m', 'yt_dlp'] },
        );

        for (const c of candidates) {
          const probe = await execProbeCmd(c.cmd, [...c.baseArgs, '--version']);
          if (probe.ok && probe.stdout) {
            this.cachedYtDlpStatus = { available: true, version: probe.stdout.split(/\r?\n/)[0] };
            log('info', 'yt-dlp detectado para extração YouTube', {
              cmd: c.cmd,
              version: this.cachedYtDlpStatus.version,
            });
            return { ...c, version: this.cachedYtDlpStatus.version! };
          }
        }
        this.cachedYtDlpStatus = { available: false };
        return null;
      })();
    }
    return this.ytDlpPromise;
  }

  private getClient(): Promise<Innertube> {
    if (!this.clientPromise) {
      this.clientPromise = Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
      }).catch((err) => {
        this.clientPromise = null;
        throw err;
      });
    }
    return this.clientPromise;
  }

  private async probeStreamUrl(url: string, contentLength?: number): Promise<{ ok: boolean; status: number }> {
    const runProbe = async (rangeHeader: string) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetch(url, {
          headers: {
            Range: rangeHeader,
            'User-Agent': IOS_USER_AGENT,
          },
          signal: controller.signal,
        });
        res.body?.cancel().catch(() => {});
        return { ok: res.status === 206 || res.status === 200, status: res.status };
      } catch {
        return { ok: false, status: 503 };
      } finally {
        clearTimeout(timer);
      }
    };

    const headProbe = await runProbe('bytes=0-0');
    if (!headProbe.ok) return headProbe;

    // Also verify byte past 1 MiB if stream > 1 MiB (catches CDN 403 cutoff at chunk 2!)
    if (contentLength && contentLength > 1048576) {
      const tailProbe = await runProbe('bytes=1048576-1048576');
      if (!tailProbe.ok) return tailProbe;
    }

    return headProbe;
  }

  private classifyHttpError(status: number, context: string): MediaHttpError {
    if (status === 401) {
      return new MediaHttpError(
        401,
        false,
        `Autenticação exigida pelo servidor de mídia (HTTP 401) em ${context}.`,
      );
    }
    if (status === 403) {
      return new MediaHttpError(
        403,
        false,
        `Acesso bloqueado pelo servidor de mídia (HTTP 403) em ${context}. O conteúdo pode exigir autenticação ou ter restrição de download.`,
      );
    }
    if (status === 404 || status === 410) {
      return new MediaHttpError(
        status,
        false,
        `Mídia não encontrada ou URL expirada (HTTP ${status}) em ${context}.`,
      );
    }
    if (status === 429) {
      return new MediaHttpError(
        429,
        true,
        `Limite de requisições do servidor de mídia atingido (HTTP 429).`,
      );
    }
    if (status >= 500) {
      return new MediaHttpError(
        status,
        true,
        `Erro temporário no servidor de mídia (HTTP ${status}).`,
      );
    }
    return new MediaHttpError(status, false, `Servidor de mídia retornou HTTP ${status}.`);
  }

  private classifyYtDlpStderr(stderr: string, videoId: string): MediaHttpError {
    const lower = stderr.toLowerCase();
    if (lower.includes('http error 403') || lower.includes('403 forbidden')) {
      return this.classifyHttpError(403, `yt-dlp (${videoId})`);
    }
    if (lower.includes('http error 401')) {
      return this.classifyHttpError(401, `yt-dlp (${videoId})`);
    }
    if (lower.includes('http error 429') || lower.includes('too many requests')) {
      return this.classifyHttpError(429, `yt-dlp (${videoId})`);
    }
    if (
      lower.includes('video unavailable') ||
      lower.includes('private video') ||
      lower.includes('has been removed')
    ) {
      return new MediaHttpError(404, false, 'Vídeo privado, removido ou indisponível no YouTube.');
    }
    if (lower.includes('sign in to confirm') || lower.includes('age-restricted')) {
      return new MediaHttpError(
        403,
        false,
        'Vídeo exige confirmação de conta/idade no YouTube e não pode ser baixado sem autenticação.',
      );
    }
    return new MediaHttpError(
      502,
      true,
      stderr.trim().split(/\r?\n/).slice(-1)[0] || 'Falha ao obter mídia do YouTube.',
    );
  }

  async inspectVideo(videoId: string): Promise<YouTubeStreamMetadata> {
    const cached = this.videoCache.get(videoId);
    if (cached && Date.now() - cached.cachedAtMs < 5 * 60 * 1000) {
      return cached.meta;
    }

    const started = Date.now();
    const ytdlp = await this.resolveYtDlp();

    if (ytdlp) {
      // Fast path (~0.5s): fetch metadata & exact resolutions via Innertube IOS,
      // while using yt-dlp for the actual download. Fall back to yt-dlp JSON if needed.
      try {
        const fastMeta = await this.inspectVideoFastForYtDlp(videoId);
        if (fastMeta) {
          this.diagnostics?.recordLatency('youtube', Date.now() - started);
          if (fastMeta.playable) {
            this.videoCache.set(videoId, { meta: fastMeta, cachedAtMs: Date.now() });
          }
          return fastMeta;
        }
      } catch {
        // Fall through to yt-dlp JSON inspection
      }

      const meta = await this.inspectVideoViaYtDlp(ytdlp, videoId);
      this.diagnostics?.recordLatency('youtube', Date.now() - started);
      if (meta.playable) {
        this.videoCache.set(videoId, { meta, cachedAtMs: Date.now() });
      }
      return meta;
    }

    const meta = await this.inspectVideoViaInnertubeFallback(videoId);
    this.diagnostics?.recordLatency('youtube', Date.now() - started);
    if (meta.playable) {
      this.videoCache.set(videoId, { meta, cachedAtMs: Date.now() });
    }
    return meta;
  }

  private async inspectVideoFastForYtDlp(videoId: string): Promise<YouTubeStreamMetadata | null> {
    const yt = await this.getClient();
    const iosInfo = await yt.getBasicInfo(videoId, { client: 'IOS' });
    const basic = iosInfo.basic_info;
    const playStatus = iosInfo.playability_status?.status;

    if (basic.is_live) {
      return {
        videoId,
        title: basic.title || 'Transmissão ao vivo',
        author: basic.author || 'YouTube',
        coverUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        isCreativeCommons: false,
        licenseNote: 'Ao vivo',
        playable: false,
        unavailableReason: 'Transmissões ao vivo não são suportadas para download.',
        availableFormats: [],
      };
    }

    if (playStatus && playStatus !== 'OK') {
      return null; // Let yt-dlp check if playable or classify exact restriction
    }

    const adaptive = iosInfo.streaming_data?.adaptive_formats ?? [];
    if (adaptive.length === 0) return null;

    const title = basic.title || 'Vídeo do YouTube';
    const author = basic.author || 'Canal do YouTube';
    const durationSeconds =
      typeof basic.duration === 'number' && basic.duration > 0 ? basic.duration : undefined;
    const thumbs = basic.thumbnail ?? [];
    const coverUrl =
      thumbs.find((t) => (t.width ?? 0) >= 720)?.url ||
      thumbs[0]?.url ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    if (durationSeconds && durationSeconds > this.config.maxDurationSeconds) {
      return {
        videoId,
        title,
        author,
        durationSeconds,
        coverUrl,
        isCreativeCommons: false,
        licenseNote: 'Licença padrão YouTube',
        playable: false,
        unavailableReason: `Duração (${Math.round(durationSeconds / 60)} min) excede o limite configurado.`,
        availableFormats: [],
      };
    }

    const audioStreams = adaptive
      .filter((f) => f.has_audio && !f.has_video)
      .sort((a, b) => {
        const aMp4 = (a.mime_type ?? '').includes('audio/mp4') ? 1 : 0;
        const bMp4 = (b.mime_type ?? '').includes('audio/mp4') ? 1 : 0;
        if (aMp4 !== bMp4) return bMp4 - aMp4;
        return (b.bitrate ?? 0) - (a.bitrate ?? 0);
      });

    const bestAudio = audioStreams[0];
    const formats: AvailableFormatOption[] = [];

    if (bestAudio) {
      const sourceKbps = bestAudio.bitrate ? Math.round(bestAudio.bitrate / 1000) : undefined;
      for (const kbps of ALLOWED_BITRATES) {
        if (kbps === 256) continue;
        const estBytes =
          durationSeconds && durationSeconds > 0
            ? Math.round((durationSeconds * kbps * 1000) / 8)
            : bestAudio.content_length;
        formats.push({
          id: `mp3-${kbps}`,
          format: 'mp3',
          qualityLabel: `${kbps} kbps`,
          bitrateKbps: kbps as BitrateKbps,
          containerLabel: 'MP3',
          estimatedSizeBytes: estBytes,
          requiresTranscode: true,
          verifiedAvailable: true,
          note:
            sourceKbps && kbps > sourceKbps
              ? `Áudio original ~${sourceKbps} kbps`
              : undefined,
        });
      }
    }

    const byRes = new Map<
      string,
      { order: number; label: string; fps?: number; size?: number; isAvc: boolean; isMp4: boolean }
    >();

    for (const v of adaptive) {
      if (!v.has_video) continue;
      const m = /^(\d{3,4})p/i.exec(v.quality_label || '');
      if (!m) continue;
      const resInfo = normalizeHeightLabel(Number.parseInt(m[1], 10));
      if (!resInfo || resInfo.order < 240) continue;

      const mime = (v.mime_type ?? '').toLowerCase();
      const isMp4 = mime.includes('video/mp4');
      const isAvc = mime.includes('avc1');
      const score = (isAvc ? 100 : isMp4 ? 50 : 10) + ((v.fps ?? 30) >= 60 ? 5 : 0);
      const prev = byRes.get(resInfo.key);
      const prevScore = prev
        ? (prev.isAvc ? 100 : prev.isMp4 ? 50 : 10) + ((prev.fps ?? 30) >= 60 ? 5 : 0)
        : -1;

      if (!prev || score > prevScore) {
        byRes.set(resInfo.key, {
          order: resInfo.order,
          label: resInfo.label,
          fps: v.fps,
          size: v.content_length,
          isAvc,
          isMp4,
        });
      }
    }

    const audioSize = bestAudio?.content_length ?? 0;
    for (const [key, v] of Array.from(byRes.entries()).sort((a, b) => a[1].order - b[1].order)) {
      const estSize = v.size ? v.size + audioSize : undefined;
      if (estSize && estSize > this.config.maxUploadBytes * 2) continue;

      formats.push({
        id: `mp4-${key}`,
        format: 'mp4',
        qualityLabel: v.fps && v.fps >= 60 ? `${v.label} 60fps` : v.label,
        resolution: key,
        fps: v.fps,
        containerLabel: 'MP4',
        estimatedSizeBytes: estSize,
        requiresTranscode: false,
        verifiedAvailable: true,
      });
    }

    if (formats.length === 0) return null;

    return {
      videoId,
      title,
      author,
      durationSeconds,
      coverUrl,
      isCreativeCommons: false,
      licenseNote: 'YouTube',
      playable: true,
      availableFormats: formats,
    };
  }

  private async inspectVideoViaYtDlp(
    ytdlp: YtDlpCommandSpec,
    videoId: string,
  ): Promise<YouTubeStreamMetadata> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      ...ytdlp.baseArgs,
      '--js-runtimes',
      `node:${process.execPath}`,
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      url,
    ];

    const { code, stdout, stderr } = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const proc = spawn(ytdlp.cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('Tempo limite excedido ao consultar formatos do vídeo.'));
      }, 30_000);
      proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      proc.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on('close', (c) => {
        clearTimeout(timer);
        resolve({ code: c, stdout: out, stderr: err });
      });
    });

    if (code !== 0 || !stdout.trim()) {
      const classified = this.classifyYtDlpStderr(stderr, videoId);
      this.diagnostics?.recordHttpError({
        source: 'youtube',
        statusCode: classified.statusCode,
        message: classified.message,
      });
      return {
        videoId,
        title: 'Vídeo indisponível',
        author: 'YouTube',
        coverUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        isCreativeCommons: false,
        licenseNote: 'Indisponível',
        playable: false,
        unavailableReason: classified.message,
        availableFormats: [],
      };
    }

    const info = JSON.parse(stdout) as YtDlpRawInfo;
    const title = info.title || 'Vídeo do YouTube';
    const author = info.uploader || info.channel || 'Canal do YouTube';
    const durationSeconds =
      typeof info.duration === 'number' && info.duration > 0 ? Math.round(info.duration) : undefined;
    const coverUrl = info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const licenseRaw = info.license || '';
    const isCreativeCommons = licenseRaw.toLowerCase().includes('creative commons');
    const licenseNote = isCreativeCommons
      ? 'Creative Commons (reutilização permitida)'
      : licenseRaw || 'Licença padrão YouTube';

    if (info.is_live) {
      return {
        videoId,
        title,
        author,
        durationSeconds,
        coverUrl,
        isCreativeCommons,
        licenseNote,
        playable: false,
        unavailableReason: 'Transmissões ao vivo não são suportadas para download.',
        availableFormats: [],
      };
    }

    if (durationSeconds && durationSeconds > this.config.maxDurationSeconds) {
      return {
        videoId,
        title,
        author,
        durationSeconds,
        coverUrl,
        isCreativeCommons,
        licenseNote,
        playable: false,
        unavailableReason: `Duração (${Math.round(durationSeconds / 60)} min) excede o limite de ${Math.round(
          this.config.maxDurationSeconds / 60,
        )} min.`,
        availableFormats: [],
      };
    }

    const rawFormats = info.formats ?? [];
    const audioFormats = rawFormats
      .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
      .sort((a, b) => {
        const aM4a = a.ext === 'm4a' ? 1 : 0;
        const bM4a = b.ext === 'm4a' ? 1 : 0;
        if (aM4a !== bM4a) return bM4a - aM4a;
        return (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0);
      });

    const bestAudio = audioFormats[0];
    const formats: AvailableFormatOption[] = [];

    if (bestAudio) {
      const sourceKbps = bestAudio.abr ? Math.round(bestAudio.abr) : undefined;
      const audioBytes = bestAudio.filesize ?? bestAudio.filesize_approx;
      if (!audioBytes || audioBytes <= this.config.maxUploadBytes) {
        for (const kbps of ALLOWED_BITRATES) {
          if (kbps === 256) continue;
          const estBytes =
            durationSeconds && durationSeconds > 0
              ? Math.round((durationSeconds * kbps * 1000) / 8)
              : audioBytes;
          formats.push({
            id: `mp3-${kbps}`,
            format: 'mp3',
            qualityLabel: `${kbps} kbps`,
            bitrateKbps: kbps as BitrateKbps,
            containerLabel: 'MP3',
            estimatedSizeBytes: estBytes,
            requiresTranscode: true,
            verifiedAvailable: true,
            note:
              sourceKbps && kbps > sourceKbps
                ? `Áudio original ~${sourceKbps} kbps`
                : undefined,
          });
        }
      }
    }

    const videoByHeight = new Map<
      string,
      {
        order: number;
        label: string;
        fps?: number;
        ext?: string;
        size?: number;
        isAvc: boolean;
      }
    >();

    for (const f of rawFormats) {
      if (!f.vcodec || f.vcodec === 'none') continue;
      const resInfo = normalizeHeightLabel(f.height);
      if (!resInfo || resInfo.order < 240) continue;

      const isAvc = f.vcodec.startsWith('avc1');
      const isMp4 = f.ext === 'mp4';
      const score = (isAvc ? 100 : isMp4 ? 50 : 10) + ((f.fps ?? 30) >= 60 ? 5 : 0);
      const size = f.filesize ?? f.filesize_approx;

      const prev = videoByHeight.get(resInfo.key);
      const prevScore = prev ? (prev.isAvc ? 100 : prev.ext === 'mp4' ? 50 : 10) + ((prev.fps ?? 30) >= 60 ? 5 : 0) : -1;

      if (!prev || score > prevScore) {
        videoByHeight.set(resInfo.key, {
          order: resInfo.order,
          label: resInfo.label,
          fps: f.fps,
          ext: f.ext,
          size,
          isAvc,
        });
      }
    }

    const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx ?? 0;
    for (const [key, v] of Array.from(videoByHeight.entries()).sort((a, b) => a[1].order - b[1].order)) {
      const estSize = v.size ? v.size + audioSize : undefined;
      if (estSize && estSize > this.config.maxUploadBytes * 2) continue;

      formats.push({
        id: `mp4-${key}`,
        format: 'mp4',
        qualityLabel: v.fps && v.fps >= 60 ? `${v.label} 60fps` : v.label,
        resolution: key,
        fps: v.fps,
        containerLabel: 'MP4',
        estimatedSizeBytes: estSize,
        requiresTranscode: false,
        verifiedAvailable: true,
      });
    }

    if (formats.length === 0) {
      return {
        videoId,
        title,
        author,
        durationSeconds,
        coverUrl,
        isCreativeCommons,
        licenseNote,
        playable: false,
        unavailableReason: 'Nenhum formato compatível dentro dos limites de tamanho.',
        availableFormats: [],
      };
    }

    return {
      videoId,
      title,
      author,
      durationSeconds,
      coverUrl,
      isCreativeCommons,
      licenseNote,
      playable: true,
      availableFormats: formats,
    };
  }

  private async inspectVideoViaInnertubeFallback(videoId: string): Promise<YouTubeStreamMetadata> {
    const yt = await this.getClient();
    const [iosInfo, webInfo] = await Promise.all([
      yt.getBasicInfo(videoId, { client: 'IOS' }),
      yt.getInfo(videoId).catch(() => null),
    ]);

    const basic = iosInfo.basic_info;
    const playStatus = iosInfo.playability_status?.status;
    const title = basic.title || webInfo?.basic_info?.title || 'Vídeo do YouTube';
    const author = basic.author || webInfo?.basic_info?.author || 'Canal do YouTube';
    const durationSeconds =
      typeof basic.duration === 'number' && basic.duration > 0
        ? basic.duration
        : webInfo?.basic_info?.duration;
    const thumbs = basic.thumbnail ?? webInfo?.basic_info?.thumbnail ?? [];
    const coverUrl =
      thumbs.find((t) => (t.width ?? 0) >= 720)?.url ||
      thumbs[0]?.url ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    if (basic.is_live || (playStatus && playStatus !== 'OK')) {
      return {
        videoId,
        title,
        author,
        durationSeconds,
        coverUrl,
        isCreativeCommons: false,
        licenseNote: 'Indisponível',
        playable: false,
        unavailableReason: iosInfo.playability_status?.reason || 'Vídeo indisponível para download.',
        availableFormats: [],
      };
    }

    const adaptive = iosInfo.streaming_data?.adaptive_formats ?? [];
    const audioStreams = adaptive.filter((f) => f.has_audio && !f.has_video);

    let verifiedAudio: (typeof audioStreams)[number] | null = null;
    let lastStatus = 0;

    for (const candidate of audioStreams.slice(0, 3)) {
      try {
        const url = await candidate.decipher(yt.session.player);
        const probe = await this.probeStreamUrl(url, candidate.content_length);
        lastStatus = probe.status;
        if (probe.ok) {
          verifiedAudio = candidate;
          break;
        }
      } catch {
        // continue
      }
    }

    if (!verifiedAudio) {
      const err = this.classifyHttpError(lastStatus || 403, `fallback (${videoId})`);
      this.diagnostics?.recordHttpError({
        source: 'youtube',
        statusCode: err.statusCode,
        message: err.message,
      });
      return {
        videoId,
        title,
        author,
        durationSeconds,
        coverUrl,
        isCreativeCommons: false,
        licenseNote: 'Licença padrão YouTube',
        playable: false,
        unavailableReason: err.message,
        availableFormats: [],
      };
    }

    const formats: AvailableFormatOption[] = ALLOWED_BITRATES.filter((b) => b !== 256).map((kbps) => ({
      id: `mp3-${kbps}`,
      format: 'mp3',
      qualityLabel: `${kbps} kbps`,
      bitrateKbps: kbps as BitrateKbps,
      containerLabel: 'MP3',
      estimatedSizeBytes:
        durationSeconds ? Math.round((durationSeconds * kbps * 1000) / 8) : verifiedAudio!.content_length,
      audioItag: verifiedAudio!.itag,
      requiresTranscode: true,
      verifiedAvailable: true,
    }));

    return {
      videoId,
      title,
      author,
      durationSeconds,
      coverUrl,
      isCreativeCommons: false,
      licenseNote: 'Licença padrão YouTube',
      playable: true,
      availableFormats: formats,
    };
  }

  async inspectPlaylist(playlistId: string): Promise<YouTubePlaylistResult> {
    const yt = await this.getClient();
    const pl = await yt.getPlaylist(playlistId);
    const items: YouTubePlaylistEntry[] = [];

    for (const rawItem of (pl.items ?? []).slice(0, 100)) {
      const anyItem = rawItem as unknown as {
        id?: string;
        content_id?: string;
        title?: { toString(): string; text?: string };
        author?: { name?: string };
        duration?: { seconds?: number; text?: string };
        thumbnails?: Array<{ url: string }>;
        content_image?: {
          image?: Array<{ url: string }>;
          overlays?: Array<{ badges?: Array<{ text?: string }> }>;
        };
        metadata?: {
          title?: { text?: string; toString(): string };
          metadata?: {
            metadata_rows?: Array<{
              metadata_parts?: Array<{ text?: { text?: string } }>;
            }>;
          };
        };
      };

      const videoId = anyItem.content_id || anyItem.id;
      if (!videoId) continue;

      const title =
        anyItem.metadata?.title?.text ||
        anyItem.title?.text ||
        anyItem.title?.toString() ||
        'Vídeo sem título';

      const author =
        anyItem.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text?.text ||
        anyItem.author?.name ||
        'Canal do YouTube';

      const durationText =
        anyItem.content_image?.overlays?.[0]?.badges?.[0]?.text || anyItem.duration?.text;
      const durationSeconds = anyItem.duration?.seconds ?? parseClockDuration(durationText);

      const coverUrl =
        anyItem.content_image?.image?.[0]?.url ||
        anyItem.thumbnails?.[0]?.url ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      items.push({ videoId, title, author, durationSeconds, coverUrl });
    }

    return {
      title: pl.info?.title || 'Playlist do YouTube',
      author: pl.info?.author?.name,
      coverUrl: pl.info?.thumbnails?.[0]?.url || items[0]?.coverUrl,
      items,
    };
  }

  async downloadFormatToFile(options: {
    videoId?: string;
    searchQuery?: string;
    itag?: number;
    kind: 'audio' | 'video';
    resolutionHeight?: number;
    destPath: string;
    maxBytes: number;
    signal: AbortSignal;
    onProgress?: (percent: number) => void;
  }): Promise<{ mimeType: string; bitrateKbps?: number; bytesWritten: number }> {
    const ytdlp = await this.resolveYtDlp();
    if (ytdlp) {
      return this.downloadViaYtDlp(ytdlp, options);
    }
    let resolvedVideoId = options.videoId;
    if (!resolvedVideoId && options.searchQuery) {
      const yt = await this.getClient();
      const search = await yt.search(options.searchQuery, { type: 'video' });
      const first = search.videos?.[0] as { id?: string; content_id?: string } | undefined;
      resolvedVideoId = first?.id || first?.content_id;
    }
    if (!resolvedVideoId) {
      throw new MediaHttpError(404, false, 'Não foi possível localizar mídia correspondente para esta faixa.');
    }
    return this.downloadViaInnertubeFallback({ ...options, videoId: resolvedVideoId });
  }

  private async downloadViaYtDlp(
    ytdlp: YtDlpCommandSpec,
    options: {
      videoId?: string;
      searchQuery?: string;
      kind: 'audio' | 'video';
      resolutionHeight?: number;
      destPath: string;
      maxBytes: number;
      signal: AbortSignal;
      onProgress?: (percent: number) => void;
    },
  ): Promise<{ mimeType: string; bitrateKbps?: number; bytesWritten: number }> {
    if (options.signal.aborted) {
      throw new Error('Download cancelado.');
    }

    const targetSpec = options.videoId
      ? `https://www.youtube.com/watch?v=${options.videoId}`
      : `ytsearch1:${options.searchQuery}`;
    const labelRef = options.videoId || options.searchQuery || 'mídia';

    const maxH = options.resolutionHeight ?? 720;
    const formatSelector =
      options.kind === 'audio'
        ? 'bestaudio[ext=m4a][abr<=160]/bestaudio[ext=m4a]/bestaudio'
        : `bestvideo[height<=${maxH}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=${maxH}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${maxH}]+bestaudio/best[height<=${maxH}]`;

    const args = [
      ...ytdlp.baseArgs,
      '--js-runtimes',
      `node:${process.execPath}`,
      '--ffmpeg-location',
      this.config.ffmpegPath,
      '--concurrent-fragments',
      '8',
      '--buffer-size',
      '64K',
      '--http-chunk-size',
      '10M',
      '--no-warnings',
      '--no-playlist',
      '--no-part',
      '--newline',
      '--max-filesize',
      String(options.maxBytes),
      '-f',
      formatSelector,
    ];

    if (options.kind === 'video') {
      args.push('--merge-output-format', 'mp4', '--postprocessor-args', 'Merger+ffmpeg:-movflags +faststart');
    }

    args.push('-o', options.destPath, targetSpec);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ytdlp.cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let settled = false;
      let stderrTail = '';
      let stdoutBuf = '';
      let lastPct = 0;

      const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        options.signal.removeEventListener('abort', onAbort);
        reject(err);
      };

      const finishOk = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        options.signal.removeEventListener('abort', onAbort);
        resolve();
      };

      const killProc = () => {
        try {
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 1200).unref();
        } catch {
          // ignore
        }
      };

      const onAbort = () => {
        killProc();
        finishErr(new Error('Download cancelado.'));
      };
      options.signal.addEventListener('abort', onAbort, { once: true });

      const timeoutTimer = setTimeout(() => {
        killProc();
        finishErr(new MediaHttpError(504, true, 'Tempo limite excedido ao baixar mídia do YouTube.'));
      }, this.config.ffmpegTimeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
          if (m) {
            const pct = Math.min(100, Math.max(0, Math.round(Number.parseFloat(m[1]))));
            if (pct > lastPct) {
              lastPct = pct;
              options.onProgress?.(pct);
            }
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
      });

      proc.on('error', (err) => {
        finishErr(new Error(`Falha ao iniciar extrator de mídia: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (options.signal.aborted) {
          finishErr(new Error('Download cancelado.'));
          return;
        }
        if (code !== 0) {
          const classified = this.classifyYtDlpStderr(stderrTail, labelRef);
          this.diagnostics?.recordHttpError({
            source: 'youtube',
            statusCode: classified.statusCode,
            message: classified.message,
          });
          finishErr(classified);
          return;
        }
        options.onProgress?.(100);
        finishOk();
      });
    });

    const stat = await fs.stat(options.destPath);
    if (stat.size <= 0) {
      throw new MediaHttpError(502, true, 'Arquivo baixado está vazio.');
    }

    return {
      mimeType: options.kind === 'video' ? 'video/mp4' : 'audio/mp4',
      bytesWritten: stat.size,
    };
  }

  private async downloadViaInnertubeFallback(options: {
    videoId: string;
    itag?: number;
    kind: 'audio' | 'video';
    destPath: string;
    maxBytes: number;
    signal: AbortSignal;
    onProgress?: (percent: number) => void;
  }): Promise<{ mimeType: string; bitrateKbps?: number; bytesWritten: number }> {
    const yt = await this.getClient();
    const info = await yt.getBasicInfo(options.videoId, { client: 'IOS' });
    const allFormats = [
      ...(info.streaming_data?.formats ?? []),
      ...(info.streaming_data?.adaptive_formats ?? []),
    ];

    const fmt =
      (options.itag ? allFormats.find((f) => f.itag === options.itag) : undefined) ??
      info.chooseFormat({ type: options.kind, quality: 'best' });

    if (!fmt) {
      throw new MediaHttpError(404, false, 'Formato solicitado não disponível.');
    }

    const streamUrl = await fmt.decipher(yt.session.player);
    let totalExpected = fmt.content_length;
    const handle = await fs.open(options.destPath, 'w');
    const chunkSize = 1024 * 1024;
    let bytesWritten = 0;

    try {
      while (true) {
        if (options.signal.aborted) throw new Error('Download cancelado.');
        const start = bytesWritten;
        const end = totalExpected
          ? Math.min(totalExpected - 1, start + chunkSize - 1)
          : start + chunkSize - 1;

        let res: Response | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          res = await fetch(streamUrl, {
            headers: { Range: `bytes=${start}-${end}`, 'User-Agent': IOS_USER_AGENT },
            signal: options.signal,
          });
          if (res.status === 206 || res.status === 200) break;
          const err = this.classifyHttpError(res.status, `${options.kind} (${options.videoId})`);
          if (!err.transient) throw err;
          await new Promise((r) => setTimeout(r, computeBackoffWithJitter(attempt)));
        }

        if (!res || (res.status !== 206 && res.status !== 200)) {
          throw this.classifyHttpError(res?.status ?? 502, `${options.kind} (${options.videoId})`);
        }

        if (!totalExpected) {
          totalExpected = parseTotalFromContentRange(res.headers.get('content-range'));
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength === 0) break;
        await handle.write(buf);
        bytesWritten += buf.byteLength;
        if (totalExpected) {
          options.onProgress?.(Math.min(100, Math.round((bytesWritten / totalExpected) * 100)));
        }
        if ((totalExpected && bytesWritten >= totalExpected) || res.status === 200) break;
      }

      return {
        mimeType: fmt.mime_type || 'audio/mp4',
        bitrateKbps: fmt.bitrate ? Math.round(fmt.bitrate / 1000) : undefined,
        bytesWritten,
      };
    } finally {
      await handle.close();
    }
  }
}
