import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getBitrateHonestNote,
  sanitizeFilename,
  type ConversionJob,
  type ConversionJobRequest,
  type OutputFormat,
  type UploadMetadata,
} from '@musicflow/shared';
import type { WorkerConfig } from '../config.js';
import { log } from '../logger.js';
import { isValidImageMagic, validateUploadedMediaFile } from '../security/file-guard.js';
import { safeFetch, SsrfBlockedError } from '../security/ssrf.js';
import { cleanupExpiredFiles, getTempDirectories, safeUnlink } from './cleanup.js';
import type { DiagnosticsService } from './diagnostics.js';
import { convertToMp3, FFmpegCancelledError, muxToMp4, probeMedia } from './ffmpeg.js';
import { MediaHttpError, YouTubeStreamService } from './youtube-streams.js';

interface InternalUploadRecord extends UploadMetadata {
  filePath: string;
  ownerId: string;
}

interface InternalJobRecord {
  job: ConversionJob;
  request: ConversionJobRequest;
  ownerId: string;
  outputPath?: string;
  abortController: AbortController;
}

export class ForbiddenResourceError extends Error {
  readonly statusCode = 403;
  constructor(message = 'Você não tem permissão para acessar este recurso.') {
    super(message);
    this.name = 'ForbiddenResourceError';
  }
}

class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

export class ConversionQueue {
  private readonly uploads = new Map<string, InternalUploadRecord>();
  private readonly jobs = new Map<string, InternalJobRecord>();
  private readonly pendingQueue: string[] = [];
  private readonly subscribers = new Map<string, Set<(job: ConversionJob) => void>>();
  private readonly youtubeStreams: YouTubeStreamService;
  private activeWorkers = 0;
  private reaperTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: WorkerConfig,
    private readonly diagnostics?: DiagnosticsService,
  ) {
    this.youtubeStreams = new YouTubeStreamService(config, diagnostics);
  }

  startReaper(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      void this.runCleanup();
    }, 60_000);
    this.reaperTimer.unref();
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  async runCleanup(): Promise<void> {
    const dirs = getTempDirectories(this.config);
    const now = Date.now();

    for (const [uploadId, rec] of this.uploads.entries()) {
      if (now - Date.parse(rec.createdAt) > this.config.jobTtlMs) {
        await safeUnlink(rec.filePath);
        this.uploads.delete(uploadId);
      }
    }

    for (const [jobId, rec] of this.jobs.entries()) {
      const isTerminal =
        rec.job.status === 'completed' ||
        rec.job.status === 'failed' ||
        rec.job.status === 'cancelled';
      if (isTerminal && now - Date.parse(rec.job.updatedAt) > this.config.jobTtlMs) {
        await safeUnlink(rec.outputPath);
        this.jobs.delete(jobId);
        this.subscribers.delete(jobId);
      }
    }

    await cleanupExpiredFiles(dirs.uploads, this.config.jobTtlMs);
    await cleanupExpiredFiles(dirs.outputs, this.config.jobTtlMs);
    await cleanupExpiredFiles(dirs.scratch, 15 * 60 * 1000);
  }

  async registerUpload(
    filePath: string,
    originalName: string,
    mimeType: string,
    sizeBytes: number,
    ownerId = 'default',
  ): Promise<UploadMetadata> {
    const signature = await validateUploadedMediaFile(filePath, originalName);
    if (!signature.valid) {
      await safeUnlink(filePath);
      throw new Error(signature.reason || 'Arquivo inválido.');
    }

    let probe;
    try {
      probe = await probeMedia(this.config, filePath);
    } catch (err) {
      await safeUnlink(filePath);
      throw err;
    }

    if (!probe.hasAudio) {
      await safeUnlink(filePath);
      throw new Error('O arquivo enviado não possui nenhuma faixa de áudio.');
    }

    if (probe.durationSeconds && probe.durationSeconds > this.config.maxDurationSeconds) {
      await safeUnlink(filePath);
      throw new Error(
        `A duração do arquivo (${Math.round(probe.durationSeconds)}s) ultrapassa o limite máximo de ${this.config.maxDurationSeconds}s.`,
      );
    }

    const uploadId = crypto.randomUUID();
    const record: InternalUploadRecord = {
      uploadId,
      originalName,
      mimeType,
      sizeBytes,
      durationSeconds: probe.durationSeconds,
      sourceBitrateKbps: probe.sourceBitrateKbps,
      codec: probe.codec,
      createdAt: new Date().toISOString(),
      filePath,
      ownerId,
    };

    this.uploads.set(uploadId, record);
    return {
      uploadId: record.uploadId,
      originalName: record.originalName,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      durationSeconds: record.durationSeconds,
      sourceBitrateKbps: record.sourceBitrateKbps,
      codec: record.codec,
      createdAt: record.createdAt,
    };
  }

  getUpload(uploadId: string, ownerId?: string, isAdminProxy = false): InternalUploadRecord | undefined {
    const rec = this.uploads.get(uploadId);
    if (!rec) return undefined;
    if (ownerId && !isAdminProxy && rec.ownerId !== ownerId) {
      throw new ForbiddenResourceError();
    }
    return rec;
  }

  enqueue(request: ConversionJobRequest, ownerId = 'default', isAdminProxy = false): ConversionJob {
    if (request.sourceType === 'upload') {
      const upload = request.uploadId ? this.uploads.get(request.uploadId) : undefined;
      if (!upload) {
        throw new Error('Arquivo de upload não encontrado ou expirado. Envie o arquivo novamente.');
      }
      if (!isAdminProxy && upload.ownerId !== ownerId) {
        throw new ForbiddenResourceError('Você não tem permissão para converter este arquivo.');
      }
    }

    const outputFormat: OutputFormat = request.outputFormat ?? 'mp3';
    const qualityLabel =
      request.qualityLabel ||
      (outputFormat === 'mp4' ? 'MP4' : `${request.bitrate} kbps`);

    // Prevent duplicate concurrent jobs ONLY for the same owner + source + format + quality
    for (const rec of this.jobs.values()) {
      if (rec.ownerId !== ownerId) continue;
      const isActive = ['queued', 'downloading', 'converting', 'tagging', 'retrying'].includes(
        rec.job.status,
      );
      if (!isActive) continue;
      const sameSource =
        rec.request.sourceType === request.sourceType &&
        rec.request.youtubeVideoId === request.youtubeVideoId &&
        rec.request.searchQuery === request.searchQuery &&
        rec.request.uploadId === request.uploadId &&
        rec.request.authorizedAudioUrl === request.authorizedAudioUrl;
      if (sameSource && rec.job.outputFormat === outputFormat && rec.job.qualityLabel === qualityLabel) {
        return { ...rec.job };
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const job: ConversionJob = {
      id,
      status: 'queued',
      progress: 0,
      stageLabel: 'Preparando download...',
      outputFormat,
      qualityLabel,
      bitrate: request.bitrate,
      sourceType: request.sourceType,
      metadata: request.metadata,
      attempt: 0,
      maxAttempts: this.config.maxJobRetries + 1,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(id, {
      job,
      request: { ...request, outputFormat },
      ownerId,
      abortController: new AbortController(),
    });
    this.pendingQueue.push(id);
    this.pump();

    return { ...job };
  }

  getYouTubeExtractorStatus(): { ytDlpAvailable: boolean; ytDlpVersion?: string } {
    return this.youtubeStreams.getExtractorStatus();
  }

  getJobOwnerId(jobId: string): string | undefined {
    return this.jobs.get(jobId)?.ownerId;
  }

  getJob(jobId: string, ownerId?: string, isAdminProxy = false): ConversionJob | undefined {
    const rec = this.jobs.get(jobId);
    if (!rec) return undefined;
    if (ownerId && !isAdminProxy && rec.ownerId !== ownerId) {
      throw new ForbiddenResourceError();
    }
    return { ...rec.job };
  }

  listJobs(ownerId?: string, isAdminProxy = false): ConversionJob[] {
    return Array.from(this.jobs.values())
      .filter((r) => !ownerId || isAdminProxy || r.ownerId === ownerId)
      .map((r) => ({ ...r.job }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getJobOutputFile(
    jobId: string,
    ownerId?: string,
    isAdminProxy = false,
  ): { filePath: string; filename: string; outputFormat: OutputFormat; ownerId: string } | undefined {
    const rec = this.jobs.get(jobId);
    if (!rec) return undefined;
    if (ownerId && !isAdminProxy && rec.ownerId !== ownerId) {
      throw new ForbiddenResourceError();
    }
    if (rec.job.status !== 'completed' || !rec.outputPath || !rec.job.outputFilename) {
      return undefined;
    }
    return {
      filePath: rec.outputPath,
      filename: rec.job.outputFilename,
      outputFormat: rec.job.outputFormat,
      ownerId: rec.ownerId,
    };
  }

  subscribe(jobId: string, listener: (job: ConversionJob) => void): () => void {
    let set = this.subscribers.get(jobId);
    if (!set) {
      set = new Set();
      this.subscribers.set(jobId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.subscribers.delete(jobId);
      }
    };
  }

  async cancelJob(jobId: string, ownerId?: string, isAdminProxy = false): Promise<ConversionJob | undefined> {
    const rec = this.jobs.get(jobId);
    if (!rec) return undefined;
    if (ownerId && !isAdminProxy && rec.ownerId !== ownerId) {
      throw new ForbiddenResourceError();
    }

    if (rec.job.status === 'completed' || rec.job.status === 'failed' || rec.job.status === 'cancelled') {
      return { ...rec.job };
    }

    const qIdx = this.pendingQueue.indexOf(jobId);
    if (qIdx !== -1) {
      this.pendingQueue.splice(qIdx, 1);
    }

    rec.abortController.abort();
    this.updateJob(rec, {
      status: 'cancelled',
      stageLabel: 'Cancelado pelo usuário',
      error: 'Download cancelado.',
    });
    await safeUnlink(rec.outputPath);
    rec.outputPath = undefined;
    return { ...rec.job };
  }

  retryJob(jobId: string, ownerId?: string, isAdminProxy = false): ConversionJob | undefined {
    const rec = this.jobs.get(jobId);
    if (!rec) return undefined;
    if (ownerId && !isAdminProxy && rec.ownerId !== ownerId) {
      throw new ForbiddenResourceError();
    }
    if (!['failed', 'cancelled'].includes(rec.job.status)) {
      return { ...rec.job };
    }
    rec.abortController = new AbortController();
    rec.outputPath = undefined;
    this.updateJob(rec, {
      status: 'queued',
      progress: 0,
      attempt: 0,
      error: undefined,
      stageLabel: 'Reenfileirado para reprocessamento',
    });
    this.pendingQueue.push(jobId);
    this.pump();
    return { ...rec.job };
  }

  async shutdown(): Promise<void> {
    this.stopReaper();
    for (const rec of this.jobs.values()) {
      rec.abortController.abort();
      await safeUnlink(rec.outputPath);
    }
    for (const upload of this.uploads.values()) {
      await safeUnlink(upload.filePath);
    }
  }

  private updateJob(rec: InternalJobRecord, patch: Partial<ConversionJob>): void {
    rec.job = {
      ...rec.job,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const listeners = this.subscribers.get(rec.job.id);
    if (listeners) {
      const snapshot = { ...rec.job };
      for (const cb of listeners) {
        cb(snapshot);
      }
    }
  }

  private pump(): void {
    while (this.activeWorkers < this.config.concurrency && this.pendingQueue.length > 0) {
      const nextId = this.pendingQueue.shift();
      if (!nextId) break;
      const rec = this.jobs.get(nextId);
      if (!rec || rec.job.status === 'cancelled') continue;

      this.activeWorkers++;
      void this.runJob(rec).finally(() => {
        this.activeWorkers--;
        this.pump();
      });
    }
  }

  private buildSafeOutputFilename(rec: InternalJobRecord): string {
    const outputFormat = rec.job.outputFormat;
    if (outputFormat === 'mp4') {
      const qual = rec.job.qualityLabel ? ` (${rec.job.qualityLabel})` : '';
      return `${sanitizeFilename(`${rec.request.metadata.title}${qual}`)}.mp4`;
    }
    return `${sanitizeFilename(`${rec.request.metadata.artist} - ${rec.request.metadata.title}`)}.mp3`;
  }

  private async runJob(rec: InternalJobRecord): Promise<void> {
    const dirs = getTempDirectories(this.config);
    const maxAttempts = rec.job.maxAttempts;
    const outputFormat = rec.job.outputFormat;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (rec.abortController.signal.aborted) {
        this.updateJob(rec, { status: 'cancelled', stageLabel: 'Cancelado pelo usuário' });
        return;
      }

      this.updateJob(rec, {
        attempt,
        progress: 0,
        error: undefined,
      });

      const scratchPaths: string[] = [];
      const outputFilename = this.buildSafeOutputFilename(rec);
      const outputPath = path.join(dirs.outputs, `${rec.job.id}.${outputFormat}`);

      try {
        if (
          (rec.request.sourceType === 'youtube' || rec.request.sourceType === 'spotify_track') &&
          outputFormat === 'mp4'
        ) {
          await this.processYouTubeMp4(rec, dirs.scratch, outputPath, scratchPaths);
        } else if (
          (rec.request.sourceType === 'youtube' || rec.request.sourceType === 'spotify_track') &&
          outputFormat === 'mp3'
        ) {
          await this.processYouTubeMp3(rec, dirs.scratch, outputPath, scratchPaths);
        } else if (rec.request.sourceType === 'authorized_url' && outputFormat === 'mp4') {
          await this.processAuthorizedUrlMp4(rec, dirs.scratch, outputPath, scratchPaths);
        } else {
          await this.processAudioToMp3(rec, dirs.scratch, outputPath, scratchPaths);
        }

        const stat = await fs.stat(outputPath);
        if (stat.size <= 0) {
          throw new Error('O arquivo gerado está vazio.');
        }

        // Verify output media container & codec integrity with ffprobe
        const integrity = await probeMedia(this.config, outputPath);
        if (outputFormat === 'mp3' && !integrity.hasAudio) {
          throw new Error('Falha na verificação de integridade: MP3 sem trilha de áudio.');
        }
        if (outputFormat === 'mp4' && !integrity.hasVideo) {
          throw new Error('Falha na verificação de integridade: MP4 sem trilha de vídeo.');
        }

        rec.outputPath = outputPath;
        this.updateJob(rec, {
          status: 'completed',
          progress: 100,
          stageLabel: 'Pronto para download',
          outputFilename,
          outputSizeBytes: stat.size,
        });

        log('info', 'Conversão concluída', {
          jobId: rec.job.id,
          outputFormat,
          bitrate: rec.request.bitrate,
          outputSizeBytes: stat.size,
        });
        return;
      } catch (err) {
        await safeUnlink(outputPath);

        if (err instanceof FFmpegCancelledError || rec.abortController.signal.aborted) {
          this.updateJob(rec, {
            status: 'cancelled',
            stageLabel: 'Cancelado pelo usuário',
            error: 'Download cancelado.',
          });
          return;
        }

        const isTransientMediaErr = err instanceof MediaHttpError && err.transient;
        const isRetryable =
          (err instanceof TransientError || isTransientMediaErr) && attempt < maxAttempts;
        if (isRetryable) {
          const jitter = Math.floor(Math.random() * 500);
          const backoffMs = Math.min(8000, attempt * 1500 + jitter);
          this.updateJob(rec, {
            status: 'retrying',
            stageLabel: `Falha temporária — tentando novamente (${attempt + 1}/${maxAttempts})`,
            error: err.message,
          });
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        const message = err instanceof Error ? err.message : 'Erro inesperado durante o processamento.';
        log('error', 'Falha na tarefa de conversão', { jobId: rec.job.id, error: message });
        this.diagnostics?.recordHttpError({
          source: rec.request.sourceType === 'youtube' ? 'youtube' : 'ffmpeg',
          statusCode: err instanceof MediaHttpError ? err.statusCode : undefined,
          message,
        });
        this.updateJob(rec, {
          status: 'failed',
          stageLabel: 'Falha no processamento',
          error: message,
        });
        return;
      } finally {
        await Promise.all(scratchPaths.map((p) => safeUnlink(p)));
      }
    }
  }

  private async processYouTubeMp3(
    rec: InternalJobRecord,
    scratchDir: string,
    outputPath: string,
    scratchPaths: string[],
  ): Promise<void> {
    const rawAudioPath = path.join(scratchDir, `${rec.job.id}-yt-audio.m4a`);
    scratchPaths.push(rawAudioPath);

    this.updateJob(rec, {
      status: 'downloading',
      progress: 5,
      stageLabel: 'Obtendo áudio...',
    });

    let dlResult;
    try {
      dlResult = await this.youtubeStreams.downloadFormatToFile({
        videoId: rec.request.youtubeVideoId,
        searchQuery: rec.request.searchQuery,
        expectedTitle: rec.request.metadata.title,
        expectedArtist: rec.request.metadata.artist,
        durationHintSeconds: rec.request.durationHintSeconds,
        itag: rec.request.audioItag,
        kind: 'audio',
        destPath: rawAudioPath,
        maxBytes: this.config.maxUploadBytes,
        signal: rec.abortController.signal,
        onProgress: (dlPct) => {
          const pct = Math.min(45, Math.max(5, Math.round(5 + dlPct * 0.4)));
          if (pct > rec.job.progress) {
            this.updateJob(rec, {
              status: 'downloading',
              progress: pct,
              stageLabel: `Baixando áudio (${dlPct}%)...`,
            });
          }
        },
      });
    } catch (err) {
      if (rec.abortController.signal.aborted) throw new FFmpegCancelledError();
      if (err instanceof MediaHttpError) throw err;
      throw new TransientError((err as Error).message);
    }

    let durationSeconds = rec.request.durationHintSeconds;
    let sourceBitrateKbps = dlResult.bitrateKbps;

    if (!durationSeconds) {
      const probe = await probeMedia(this.config, rawAudioPath);
      if (!probe.hasAudio) {
        throw new Error('Stream de áudio inválido.');
      }
      durationSeconds = probe.durationSeconds;
      sourceBitrateKbps = probe.sourceBitrateKbps ?? sourceBitrateKbps;
    }

    let coverPath: string | undefined;
    if (rec.request.metadata.coverUrl) {
      coverPath = await this.downloadOptionalCover(
        rec.request.metadata.coverUrl,
        scratchDir,
        rec.job.id,
        rec.abortController.signal,
      );
      if (coverPath) scratchPaths.push(coverPath);
    }

    this.updateJob(rec, {
      status: 'converting',
      progress: 48,
      stageLabel: `Convertendo para MP3 ${rec.request.bitrate} kbps...`,
      sourceBitrateKbps,
      bitrateNote: getBitrateHonestNote(rec.request.bitrate, sourceBitrateKbps),
    });

    await convertToMp3(this.config, {
      inputPath: rawAudioPath,
      outputPath,
      coverImagePath: coverPath,
      bitrate: rec.request.bitrate,
      metadata: rec.request.metadata,
      durationSeconds,
      signal: rec.abortController.signal,
      onProgress: (ffmpegPct) => {
        const scaled = Math.min(98, Math.max(48, Math.round(48 + ffmpegPct * 0.5)));
        if (scaled > rec.job.progress) {
          this.updateJob(rec, {
            status: ffmpegPct >= 92 ? 'tagging' : 'converting',
            progress: scaled,
            stageLabel:
              ffmpegPct >= 92 ? 'Gravando capa e tags...' : `Convertendo áudio (${ffmpegPct}%)...`,
          });
        }
      },
    });
  }

  private async processYouTubeMp4(
    rec: InternalJobRecord,
    _scratchDir: string,
    outputPath: string,
    _scratchPaths: string[],
  ): Promise<void> {
    const resMatch = /(\d{3,4})p/.exec(rec.job.qualityLabel || '');
    const resolutionHeight = resMatch ? Number.parseInt(resMatch[1], 10) : 720;

    this.updateJob(rec, {
      status: 'downloading',
      progress: 5,
      stageLabel: `Baixando vídeo ${rec.job.qualityLabel}...`,
    });

    try {
      await this.youtubeStreams.downloadFormatToFile({
        videoId: rec.request.youtubeVideoId,
        searchQuery: rec.request.searchQuery,
        expectedTitle: rec.request.metadata.title,
        expectedArtist: rec.request.metadata.artist,
        durationHintSeconds: rec.request.durationHintSeconds,
        itag: rec.request.videoItag,
        kind: 'video',
        resolutionHeight,
        destPath: outputPath,
        maxBytes: this.config.maxUploadBytes * 2,
        signal: rec.abortController.signal,
        onProgress: (dlPct) => {
          const pct = Math.min(96, Math.max(5, Math.round(5 + dlPct * 0.91)));
          if (pct > rec.job.progress) {
            this.updateJob(rec, {
              status: dlPct >= 95 ? 'converting' : 'downloading',
              progress: pct,
              stageLabel:
                dlPct >= 95
                  ? 'Finalizando MP4...'
                  : `Baixando vídeo ${rec.job.qualityLabel} (${dlPct}%)...`,
            });
          }
        },
      });
    } catch (err) {
      if (rec.abortController.signal.aborted) throw new FFmpegCancelledError();
      if (err instanceof MediaHttpError) throw err;
      throw new TransientError((err as Error).message);
    }
  }

  private async processAuthorizedUrlMp4(
    rec: InternalJobRecord,
    scratchDir: string,
    outputPath: string,
    scratchPaths: string[],
  ): Promise<void> {
    this.updateJob(rec, {
      status: 'downloading',
      progress: 10,
      stageLabel: 'Baixando vídeo...',
    });
    const downloadedInputPath = await this.downloadAuthorizedSource(
      rec.request.authorizedAudioUrl!,
      scratchDir,
      rec.job.id,
      rec.abortController.signal,
    );
    scratchPaths.push(downloadedInputPath);

    const probe = await probeMedia(this.config, downloadedInputPath);
    if (!probe.hasVideo) {
      throw new Error('A URL informada não contém trilha de vídeo para MP4.');
    }

    this.updateJob(rec, {
      status: 'converting',
      progress: 65,
      stageLabel: 'Finalizando MP4...',
    });

    await muxToMp4(this.config, {
      videoPath: downloadedInputPath,
      outputPath,
      metadata: rec.request.metadata,
      durationSeconds: probe.durationSeconds ?? rec.request.durationHintSeconds,
      videoCodecCopy: probe.videoCodec === 'h264',
      audioCodecCopy: probe.codec === 'aac',
      signal: rec.abortController.signal,
      onProgress: (pct) => {
        const scaled = Math.min(98, Math.max(65, Math.round(65 + pct * 0.33)));
        if (scaled > rec.job.progress) {
          this.updateJob(rec, {
            status: 'converting',
            progress: scaled,
            stageLabel: 'Finalizando MP4...',
          });
        }
      },
    });
  }

  private async processAudioToMp3(
    rec: InternalJobRecord,
    scratchDir: string,
    outputPath: string,
    scratchPaths: string[],
  ): Promise<void> {
    let sourcePath: string;
    let durationSeconds = rec.request.durationHintSeconds;
    let sourceBitrateKbps: number | undefined;

    if (rec.request.sourceType === 'upload') {
      const upload = rec.request.uploadId ? this.uploads.get(rec.request.uploadId) : undefined;
      if (!upload) {
        throw new Error('Arquivo de upload expirado ou não encontrado.');
      }
      sourcePath = upload.filePath;
      durationSeconds = upload.durationSeconds ?? durationSeconds;
      sourceBitrateKbps = upload.sourceBitrateKbps;
    } else {
      this.updateJob(rec, {
        status: 'downloading',
        progress: 10,
        stageLabel: 'Baixando arquivo de áudio...',
      });
      const downloadedInputPath = await this.downloadAuthorizedSource(
        rec.request.authorizedAudioUrl!,
        scratchDir,
        rec.job.id,
        rec.abortController.signal,
      );
      scratchPaths.push(downloadedInputPath);

      const probe = await probeMedia(this.config, downloadedInputPath);
      if (!probe.hasAudio) {
        throw new Error('A fonte baixada não contém uma trilha de áudio válida.');
      }
      if (probe.durationSeconds && probe.durationSeconds > this.config.maxDurationSeconds) {
        throw new Error(
          `A duração do áudio (${Math.round(probe.durationSeconds)}s) excede o limite de ${this.config.maxDurationSeconds}s.`,
        );
      }
      sourcePath = downloadedInputPath;
      durationSeconds = probe.durationSeconds ?? durationSeconds;
      sourceBitrateKbps = probe.sourceBitrateKbps;
    }

    let coverPath: string | undefined;
    if (rec.request.metadata.coverUrl) {
      coverPath = await this.downloadOptionalCover(
        rec.request.metadata.coverUrl,
        scratchDir,
        rec.job.id,
        rec.abortController.signal,
      );
      if (coverPath) scratchPaths.push(coverPath);
    }

    this.updateJob(rec, {
      status: 'converting',
      progress: 25,
      stageLabel: `Convertendo para MP3 ${rec.request.bitrate} kbps...`,
      sourceBitrateKbps,
      bitrateNote: getBitrateHonestNote(rec.request.bitrate, sourceBitrateKbps),
    });

    await convertToMp3(this.config, {
      inputPath: sourcePath,
      outputPath,
      coverImagePath: coverPath,
      bitrate: rec.request.bitrate,
      metadata: rec.request.metadata,
      durationSeconds,
      signal: rec.abortController.signal,
      onProgress: (ffmpegPct) => {
        const scaled = Math.min(98, Math.max(25, Math.round(25 + ffmpegPct * 0.73)));
        if (scaled > rec.job.progress) {
          this.updateJob(rec, {
            status: ffmpegPct >= 92 ? 'tagging' : 'converting',
            progress: scaled,
            stageLabel:
              ffmpegPct >= 92
                ? 'Gravando capa e tags...'
                : `Convertendo áudio (${ffmpegPct}%)...`,
          });
        }
      },
    });
  }

  private async downloadAuthorizedSource(
    urlStr: string,
    scratchDir: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<string> {
    let res: Response;
    try {
      res = await safeFetch(urlStr, {
        allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
        signal,
        timeoutMs: 30_000,
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        throw err;
      }
      throw new TransientError(`Erro de rede ao baixar mídia autorizada: ${(err as Error).message}`);
    }

    if (res.status >= 500 || res.status === 429) {
      throw new TransientError(`Servidor de origem indisponível temporariamente (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Não foi possível baixar o arquivo da URL informada (HTTP ${res.status}).`);
    }

    const urlObj = new URL(urlStr);
    const ext = path.extname(urlObj.pathname).toLowerCase() || '.audio';
    const destPath = path.join(scratchDir, `${jobId}-source${ext}`);

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('Resposta sem corpo de dados.');
    }

    const handle = await fs.open(destPath, 'w');
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > this.config.maxUploadBytes) {
          throw new Error(
            `Arquivo remoto excede o limite de ${Math.round(this.config.maxUploadBytes / 1024 / 1024)} MB.`,
          );
        }
        await handle.write(value);
      }
    } catch (err) {
      await handle.close();
      await safeUnlink(destPath);
      throw err;
    }
    await handle.close();

    const sig = await validateUploadedMediaFile(destPath, `source${ext}`);
    if (!sig.valid) {
      await safeUnlink(destPath);
      throw new Error(sig.reason || 'A URL não retornou um arquivo de mídia válido.');
    }

    return destPath;
  }

  private async downloadOptionalCover(
    coverUrl: string,
    scratchDir: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const res = await safeFetch(coverUrl, {
        allowPrivateNetworkFetch: this.config.allowPrivateNetworkFetch,
        signal,
        timeoutMs: 8_000,
      });
      if (!res.ok) return undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > 5 * 1024 * 1024) return undefined;
      const imgType = isValidImageMagic(buf);
      if (!imgType) return undefined;
      const coverPath = path.join(scratchDir, `${jobId}-cover.${imgType}`);
      await fs.writeFile(coverPath, buf);
      return coverPath;
    } catch {
      return undefined;
    }
  }
}
