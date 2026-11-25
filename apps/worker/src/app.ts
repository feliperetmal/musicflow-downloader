import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import multer from 'multer';
import {
  buildContentDispositionAttachment,
  ConversionJobRequestSchema,
  SUPPORTED_UPLOAD_EXTENSIONS,
  sanitizeFilename,
} from '@musicflow/shared';
import { z } from 'zod';
import type { WorkerConfig } from './config.js';
import { log } from './logger.js';
import { createWorkerAuthMiddleware } from './security/auth.js';
import { createRateLimiter } from './security/rate-limit.js';
import { LinkAnalyzerService } from './services/analyzer.js';
import { getTempDirectories, safeUnlink } from './services/cleanup.js';
import { DiagnosticsService } from './services/diagnostics.js';
import { ConversionQueue } from './services/queue.js';
import { SpotifyAuthService } from './services/spotify-auth.js';

export interface AppContext {
  app: Express;
  queue: ConversionQueue;
  authService: SpotifyAuthService;
  diagnostics: DiagnosticsService;
}

const AnalyzeBodySchema = z.object({
  url: z.string().trim().min(1, 'URL é obrigatória').max(2048),
});

const ZipBodySchema = z.object({
  jobIds: z.array(z.string().uuid()).min(1, 'Selecione pelo menos um arquivo concluído').max(1000),
  zipName: z.string().trim().max(160).optional(),
});

const BatchJobsBodySchema = z.object({
  jobs: z.array(ConversionJobRequestSchema).min(1).max(1000),
});

const HandoffBodySchema = z.object({
  handoff: z.string().min(8).max(200),
});

export function createWorkerApp(config: WorkerConfig): AppContext {
  const app = express();
  const dirs = getTempDirectories(config);
  const diagnostics = new DiagnosticsService();
  const authService = new SpotifyAuthService(config);
  const queue = new ConversionQueue(config, diagnostics);
  const analyzer = new LinkAnalyzerService(config, authService, diagnostics);

  const allowedOrigins = config.corsOrigin
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(
    cors({
      origin: (origin, callback) => {
        if (
          !origin ||
          allowedOrigins.includes('*') ||
          allowedOrigins.includes(origin) ||
          origin.endsWith('.github.io') ||
          origin.startsWith('http://localhost:') ||
          origin.startsWith('http://127.0.0.1:')
        ) {
          callback(null, true);
          return;
        }
        callback(new Error('Origem bloqueada pela política CORS.'));
      },
      credentials: false,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  const limiter = createRateLimiter({
    windowMs: config.rateLimitWindowMs,
    maxRequests: config.rateLimitMaxRequests,
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: config.appVersion,
      service: 'musicflow-worker',
      concurrency: config.concurrency,
      maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
      maxDurationSeconds: config.maxDurationSeconds,
      integrations: {
        spotifyClientConfigured: Boolean(config.spotifyClientId),
        spotifyClientSecretConfigured: Boolean(config.spotifyClientSecret),
        youtubeOfficialApi: Boolean(config.youtubeApiKey),
      },
      activeJobs: queue.listJobs().filter((j) =>
        ['queued', 'downloading', 'converting', 'tagging', 'retrying'].includes(j.status),
      ).length,
    });
  });

  app.get('/ready', (_req, res) => {
    try {
      const probeFile = path.join(config.tempDir, `.ready-probe-${Date.now()}`);
      fs.mkdirSync(config.tempDir, { recursive: true });
      fs.writeFileSync(probeFile, 'ok', 'utf8');
      safeUnlink(probeFile);

      const ffmpegAvailable = fs.existsSync(config.ffmpegPath) || config.ffmpegPath === 'ffmpeg';

      res.json({
        ready: true,
        ffmpeg: ffmpegAvailable ? 'available' : 'missing',
        tempDirWritable: true,
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({
        ready: false,
        error: err instanceof Error ? err.message : 'Falha na verificação de prontidão',
      });
    }
  });

  const requireAuth = createWorkerAuthMiddleware(config.workerApiSecret, allowedOrigins);

  // Public OAuth callback route (for production HTTPS reverse proxy deployments)
  app.get('/auth/spotify/callback', async (req: Request, res: Response) => {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const error = typeof req.query.error === 'string' ? req.query.error : undefined;

      const { handoff, returnTo } = await authService.handleCallback({ code, state, error });
      const isStaticOrPages =
        config.frontendBaseUrl.includes('github.io') || config.frontendBaseUrl.includes('static');
      const target = isStaticOrPages
        ? `${config.frontendBaseUrl}/?spotifyHandoff=${encodeURIComponent(
            handoff,
          )}&returnTo=${encodeURIComponent(returnTo)}`
        : `${config.frontendBaseUrl}/api/auth/spotify/complete?handoff=${encodeURIComponent(
            handoff,
          )}&returnTo=${encodeURIComponent(returnTo)}`;
      res.redirect(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro na autenticação Spotify.';
      res.redirect(`${config.frontendBaseUrl}/?spotifyError=${encodeURIComponent(msg)}`);
    }
  });

  // Authenticate BFF routes; apply rate limiting to resource-intensive endpoints
  // so status polling, SSE streams, and file downloads during batch jobs are never throttled.
  app.use(['/analyze', '/uploads', '/jobs', '/diagnostics'], requireAuth);
  app.use(['/analyze', '/uploads', '/auth/spotify/login'], limiter);
  app.post(['/jobs', '/jobs/batch', '/jobs/zip'], limiter);

  app.get('/auth/spotify/login', (req: Request, res: Response, next: NextFunction) => {
    try {
      const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/';
      const { authorizeUrl } = authService.createLoginUrl(returnTo);
      res.json({ authorizeUrl });
    } catch (err) {
      next(err);
    }
  });

  app.post('/auth/spotify/handoff', (req: Request, res: Response) => {
    const parsed = HandoffBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Token de troca inválido.' });
      return;
    }
    const consumed = authService.consumeHandoff(parsed.data.handoff);
    if (!consumed) {
      res.status(401).json({ error: 'Sessão de login expirada. Tente conectar novamente.' });
      return;
    }
    res.json(consumed);
  });

  app.get('/auth/spotify/status', async (req: Request, res: Response) => {
    const sessionId =
      req.header('x-spotify-session') ||
      (typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined);
    if (sessionId) {
      // Ensure expired or expiring token is proactively refreshed ahead of time
      await authService.getValidAccessToken(sessionId).catch(() => null);
      authService.touchSession(sessionId);
    }
    res.json(authService.getStatus(sessionId));
  });

  app.post('/auth/spotify/logout', (req: Request, res: Response) => {
    const sessionId =
      req.header('x-spotify-session') ||
      (typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined);
    authService.logout(sessionId);
    res.json({ ok: true });
  });

  app.get('/diagnostics', (req: Request, res: Response) => {
    const sessionId = req.header('x-spotify-session') || undefined;
    res.json(
      diagnostics.snapshot(
        config,
        queue.listJobs(),
        authService,
        sessionId,
        queue.getYouTubeExtractorStatus(),
      ),
    );
  });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(dirs.uploads, { recursive: true });
      cb(null, dirs.uploads);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
    },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!SUPPORTED_UPLOAD_EXTENSIONS.includes(ext as (typeof SUPPORTED_UPLOAD_EXTENSIONS)[number])) {
        cb(new Error('Formato de arquivo não suportado. Use MP4, WAV, FLAC, M4A, OGG, AAC, WebM ou MP3.'));
        return;
      }
      cb(null, true);
    },
  });

  app.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = AnalyzeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Requisição inválida.' });
        return;
      }

      const sessionId = req.header('x-spotify-session') || undefined;
      const result = await analyzer.analyze(parsed.data.url, { sessionId });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get('/analyze/stream', async (req: Request, res: Response) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    const parsed = AnalyzeBodySchema.safeParse({ url: rawUrl });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'URL inválida.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const controller = new AbortController();
    req.on('close', () => {
      controller.abort();
    });

    const sendEvent = (payload: unknown) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    try {
      const sessionId = req.header('x-spotify-session') || undefined;
      sendEvent({ type: 'progress', loaded: 0, total: 0, stage: 'Analisando link...' });
      const result = await analyzer.analyze(parsed.data.url, {
        sessionId,
        signal: controller.signal,
        onProgress: (loaded, total, stage) => {
          sendEvent({ type: 'progress', loaded, total, stage });
        },
      });
      sendEvent({
        type: 'complete',
        loaded: result.loadedTracks ?? result.items.length,
        total: result.knownTotalTracks ?? result.totalTracks,
        stage: 'Concluído',
        collection: result,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao analisar link.';
      sendEvent({ type: 'error', loaded: 0, total: 0, stage: 'Erro', error: msg });
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  app.post('/uploads', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Nenhum arquivo enviado no campo "file".' });
        return;
      }

      const metadata = await queue.registerUpload(
        req.file.path,
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
      );

      log('info', 'Upload validado', {
        uploadId: metadata.uploadId,
        sizeBytes: metadata.sizeBytes,
        codec: metadata.codec,
      });

      res.status(201).json(metadata);
    } catch (err) {
      if (req.file) {
        await safeUnlink(req.file.path);
      }
      next(err);
    }
  });

  app.get('/uploads/:id/preview', (req: Request, res: Response) => {
    const record = queue.getUpload(String(req.params.id));
    if (!record || !fs.existsSync(record.filePath)) {
      res.status(404).json({ error: 'Arquivo de pré-visualização não encontrado ou expirado.' });
      return;
    }

    const stat = fs.statSync(record.filePath);
    const total = stat.size;
    const range = req.headers.range;
    res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = Number.parseInt(startStr, 10);
      const end = endStr ? Number.parseInt(endStr, 10) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
        res.status(416).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
      fs.createReadStream(record.filePath, { start, end }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', String(total));
    fs.createReadStream(record.filePath).pipe(res);
  });

  app.post('/jobs', (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ConversionJobRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos.' });
        return;
      }

      const job = queue.enqueue(parsed.data);
      res.status(202).json(job);
    } catch (err) {
      next(err);
    }
  });

  app.post('/jobs/batch', (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = BatchJobsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'Lista de tarefas inválida.' });
        return;
      }

      const created = parsed.data.jobs.map((item) => queue.enqueue(item));
      res.status(202).json({ jobs: created });
    } catch (err) {
      next(err);
    }
  });

  app.get('/jobs', (_req: Request, res: Response) => {
    res.json({ jobs: queue.listJobs() });
  });

  app.get('/jobs/:id', (req: Request, res: Response) => {
    const job = queue.getJob(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'Tarefa não encontrada.' });
      return;
    }
    res.json(job);
  });

  app.post('/jobs/:id/retry', (req: Request, res: Response) => {
    const retried = queue.retryJob(String(req.params.id));
    if (!retried) {
      res.status(404).json({ error: 'Tarefa não encontrada.' });
      return;
    }
    res.json(retried);
  });

  app.get('/jobs/:id/events', (req: Request, res: Response) => {
    const jobId = String(req.params.id);
    const current = queue.getJob(jobId);
    if (!current) {
      res.status(404).json({ error: 'Tarefa não encontrada.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (job: unknown) => {
      res.write(`data: ${JSON.stringify(job)}\n\n`);
    };

    sendEvent(current);
    if (['completed', 'failed', 'cancelled'].includes(current.status)) {
      res.end();
      return;
    }

    const unsubscribe = queue.subscribe(jobId, (updated) => {
      sendEvent(updated);
      if (['completed', 'failed', 'cancelled'].includes(updated.status)) {
        unsubscribe();
        res.end();
      }
    });

    req.on('close', () => {
      unsubscribe();
    });
  });

  app.delete('/jobs/:id', async (req: Request, res: Response) => {
    const cancelled = await queue.cancelJob(String(req.params.id));
    if (!cancelled) {
      res.status(404).json({ error: 'Tarefa não encontrada.' });
      return;
    }
    res.json(cancelled);
  });

  app.post('/jobs/cancel-batch', async (req: Request, res: Response) => {
    const parsed = ZipBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Lista inválida.' });
      return;
    }
    const results = await Promise.all(parsed.data.jobIds.map((id) => queue.cancelJob(id)));
    res.json({ cancelled: results.filter(Boolean) });
  });

  app.get('/jobs/:id/download', (req: Request, res: Response) => {
    const output = queue.getJobOutputFile(String(req.params.id));
    if (!output || !fs.existsSync(output.filePath)) {
      res.status(404).json({ error: 'Arquivo não disponível ou expirado.' });
      return;
    }

    const stat = fs.statSync(output.filePath);
    const ext = output.outputFormat === 'mp4' ? '.mp4' : '.mp3';
    const mimeType = output.outputFormat === 'mp4' ? 'video/mp4' : 'audio/mpeg';
    const base = output.filename.replace(/\.(mp3|mp4)$/i, '');
    const fullFilename = `${sanitizeFilename(base)}${ext}`;

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', buildContentDispositionAttachment(fullFilename));
    fs.createReadStream(output.filePath, { highWaterMark: 256 * 1024 }).pipe(res);
  });

  app.post('/jobs/zip', (req: Request, res: Response) => {
    const parsed = ZipBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Lista de tarefas inválida.' });
      return;
    }

    const files: Array<{ filePath: string; filename: string }> = [];
    const usedNames = new Map<string, number>();

    for (const id of parsed.data.jobIds) {
      const output = queue.getJobOutputFile(id);
      if (output && fs.existsSync(output.filePath)) {
        const ext = output.outputFormat === 'mp4' ? '.mp4' : '.mp3';
        const base = sanitizeFilename(output.filename.replace(/\.(mp3|mp4)$/i, ''));
        const key = `${base}${ext}`;
        const count = (usedNames.get(key) ?? 0) + 1;
        usedNames.set(key, count);
        const uniqueName = count === 1 ? `${base}${ext}` : `${base} (${count})${ext}`;
        files.push({ filePath: output.filePath, filename: uniqueName });
      }
    }

    if (files.length === 0) {
      res.status(404).json({ error: 'Nenhum arquivo concluído encontrado para compactar.' });
      return;
    }

    const rawZipBase = parsed.data.zipName
      ? sanitizeFilename(parsed.data.zipName.replace(/\.zip$/i, ''), 'musicflow-playlist')
      : 'musicflow-playlist';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      buildContentDispositionAttachment(`${rawZipBase}.zip`),
    );

    // Level 1 (fast store/light compression) since MP3/MP4 are already compressed — 5x faster ZIP creation!
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', (err) => {
      log('error', 'Erro ao gerar ZIP', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erro ao gerar arquivo ZIP.' });
      } else {
        res.end();
      }
    });

    archive.pipe(res);
    for (const f of files) {
      archive.file(f.filePath, { name: f.filename });
    }
    void archive.finalize();
  });

  // Centralized error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: `Arquivo excede o limite máximo de ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`,
        });
        return;
      }
      res.status(400).json({ error: `Erro no upload: ${err.message}` });
      return;
    }

    const explicitStatus = (err as { statusCode?: number }).statusCode;
    const statusCode =
      explicitStatus ??
      (err.name === 'SsrfBlockedError'
        ? 403
        : err.message.includes('não encontrado') || err.message.includes('indisponível')
          ? 404
          : 400);

    log('warn', 'Erro tratado na API do worker', { error: err.message, statusCode });
    res.status(statusCode).json({ error: err.message || 'Erro interno no servidor de áudio.' });
  });

  return { app, queue, authService, diagnostics };
}
