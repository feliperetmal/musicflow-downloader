import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../app.js';
import { loadConfig } from '../config.js';
import { ensureTempDirectories } from '../services/cleanup.js';
import { parseIso8601Duration } from '../services/youtube.js';

async function generateTestWav(ffmpegPath: string, targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '44100', '-ac', '2', targetPath],
      { stdio: 'ignore', windowsHide: true },
    );
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

describe('Worker API & Real FFmpeg Integration', () => {
  let tmpRoot: string;
  let sampleWavPath: string;
  const secret = 'test-worker-secret-123';
  let ctx: ReturnType<typeof createWorkerApp>;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'musicflow-test-'));
    const config = loadConfig({
      ...process.env,
      TEMP_DIR: path.join(tmpRoot, 'worker-tmp'),
      WORKER_API_SECRET: secret,
      RATE_LIMIT_MAX_REQUESTS: '100',
      WORKER_CONCURRENCY: '2',
    });
    await ensureTempDirectories(config);
    ctx = createWorkerApp(config);

    sampleWavPath = path.join(tmpRoot, 'tone.wav');
    await generateTestWav(config.ffmpegPath, sampleWavPath);
  });

  afterAll(async () => {
    await ctx.queue.shutdown();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('parses ISO-8601 YouTube durations accurately', () => {
    expect(parseIso8601Duration('PT4M13S')).toBe(253);
    expect(parseIso8601Duration('PT1H2M5S')).toBe(3725);
    expect(parseIso8601Duration('invalid')).toBeUndefined();
  });

  it('enforces worker secret authentication and never bypasses via github.io Origin header', async () => {
    const res = await request(ctx.app).get('/jobs');
    expect(res.status).toBe(401);

    // Spoofing disallowed *.github.io Origin is rejected by strict CORS (403)
    const spoofed = await request(ctx.app)
      .get('/jobs')
      .set('Origin', 'https://attacker.github.io');
    expect(spoofed.status).toBe(403);

    // Even an allowed CORS origin MUST NOT bypass authentication without a valid token
    const allowedOriginNoAuth = await request(ctx.app)
      .get('/jobs')
      .set('Origin', 'http://localhost:3000');
    expect(allowedOriginNoAuth.status).toBe(401);

    const bad = await request(ctx.app).get('/jobs').set('x-worker-secret', 'wrong');
    expect(bad.status).toBe(403);

    const ok = await request(ctx.app).get('/jobs').set('x-worker-secret', secret);
    expect(ok.status).toBe(200);
  });

  it('isolates jobs per individual client session token and authenticates direct downloads via short-lived tickets', async () => {
    const sessA = await request(ctx.app).post('/auth/session');
    const sessB = await request(ctx.app).post('/auth/session');
    expect(sessA.status).toBe(200);
    expect(sessB.status).toBe(200);
    const tokenA = sessA.body.token as string;
    const tokenB = sessB.body.token as string;

    const upA = await request(ctx.app)
      .post('/uploads')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('file', sampleWavPath);
    expect(upA.status).toBe(201);

    // User B cannot convert User A's upload
    const hijackJob = await request(ctx.app)
      .post('/jobs')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        sourceType: 'upload',
        uploadId: upA.body.uploadId,
        userConfirmedAuthorization: true,
        bitrate: 192,
        metadata: { title: 'Hijack', artist: 'B' },
      });
    expect(hijackJob.status).toBe(403);

    // User A starts conversion
    const jobA = await request(ctx.app)
      .post('/jobs')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        sourceType: 'upload',
        uploadId: upA.body.uploadId,
        userConfirmedAuthorization: true,
        bitrate: 192,
        metadata: { title: 'Privada A', artist: 'User A' },
      });
    expect(jobA.status).toBe(202);
    const jobIdA = jobA.body.id as string;

    // User B cannot view User A's job
    const spyJob = await request(ctx.app)
      .get(`/jobs/${jobIdA}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(spyJob.status).toBe(403);

    // Wait for completion
    let finalJob = jobA.body;
    for (let i = 0; i < 40; i++) {
      const poll = await request(ctx.app)
        .get(`/jobs/${jobIdA}`)
        .set('Authorization', `Bearer ${tokenA}`);
      finalJob = poll.body;
      if (finalJob.status === 'completed' || finalJob.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(finalJob.status).toBe('completed');
    expect(finalJob.downloadTicket).toBeTruthy();

    // Download using short-lived signed ticket (without Authorization header, e.g. Safari <a download>)
    const ticketDl = await request(ctx.app)
      .get(`/jobs/${jobIdA}/download?ticket=${encodeURIComponent(finalJob.downloadTicket)}`);
    expect(ticketDl.status).toBe(200);
    expect(ticketDl.headers['content-type']).toContain('audio/mpeg');

    // Prepare ZIP with User A and download via ticket
    const prepZip = await request(ctx.app)
      .post('/jobs/zip/prepare')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ jobIds: [jobIdA], zipName: 'Minha Lista A' });
    expect(prepZip.status).toBe(200);
    expect(prepZip.body.downloadPath).toContain('/jobs/zip/download?');

    const zipTicketDl = await request(ctx.app).get(prepZip.body.downloadPath);
    expect(zipTicketDl.status).toBe(200);
    expect(zipTicketDl.headers['content-type']).toContain('application/zip');
  });

  it('uploads real WAV, converts to MP3 with ID3 tags, downloads MP3 and bundles ZIP', async () => {
    const uploadRes = await request(ctx.app)
      .post('/uploads')
      .set('x-worker-secret', secret)
      .attach('file', sampleWavPath);

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.uploadId).toBeTruthy();
    expect(uploadRes.body.durationSeconds).toBeGreaterThan(1.5);

    const previewRes = await request(ctx.app)
      .get(`/uploads/${uploadRes.body.uploadId}/preview`)
      .set('x-worker-secret', secret);
    expect(previewRes.status).toBe(200);

    const jobRes = await request(ctx.app)
      .post('/jobs')
      .set('x-worker-secret', secret)
      .send({
        sourceType: 'upload',
        uploadId: uploadRes.body.uploadId,
        userConfirmedAuthorization: true,
        bitrate: 192,
        metadata: {
          title: 'Faixa Teste 440Hz',
          artist: 'MusicFlow QA',
          album: 'Suite Integracao',
        },
      });

    expect(jobRes.status).toBe(202);
    const jobId = jobRes.body.id as string;

    // Wait for real FFmpeg conversion to complete
    let finalJob = jobRes.body;
    for (let i = 0; i < 40; i++) {
      const poll = await request(ctx.app).get(`/jobs/${jobId}`).set('x-worker-secret', secret);
      finalJob = poll.body;
      if (finalJob.status === 'completed' || finalJob.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 150));
    }

    expect(finalJob.status).toBe('completed');
    expect(finalJob.progress).toBe(100);
    expect(finalJob.outputSizeBytes).toBeGreaterThan(1000);

    // Download MP3 and verify ID3 header
    const dlRes = await request(ctx.app)
      .get(`/jobs/${jobId}/download`)
      .set('x-worker-secret', secret)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(dlRes.status).toBe(200);
    expect(dlRes.headers['content-type']).toContain('audio/mpeg');
    const mp3Buffer = dlRes.body as Buffer;
    expect(mp3Buffer.subarray(0, 3).toString('ascii')).toBe('ID3');

    // Bundle ZIP and verify PK header
    const zipRes = await request(ctx.app)
      .post('/jobs/zip')
      .set('x-worker-secret', secret)
      .send({ jobIds: [jobId] })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(zipRes.status).toBe(200);
    expect(zipRes.headers['content-type']).toContain('application/zip');
    const zipBuf = zipRes.body as Buffer;
    expect(zipBuf.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('requires explicit user authorization confirmation before converting', async () => {
    const res = await request(ctx.app)
      .post('/jobs')
      .set('x-worker-secret', secret)
      .send({
        sourceType: 'authorized_url',
        authorizedAudioUrl: 'https://example.com/audio.wav',
        userConfirmedAuthorization: false,
        bitrate: 320,
        metadata: { title: 'Test', artist: 'Test' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('confirmar');
  });
});
