import { spawn } from 'node:child_process';
import type { BitrateKbps, Id3MetadataInput } from '@musicflow/shared';
import type { WorkerConfig } from '../config.js';

export interface ProbeResult {
  durationSeconds?: number;
  sourceBitrateKbps?: number;
  codec?: string;
  videoCodec?: string;
  hasAudio: boolean;
  hasVideo: boolean;
}

export class FFmpegCancelledError extends Error {
  constructor() {
    super('Conversão cancelada pelo usuário.');
    this.name = 'FFmpegCancelledError';
  }
}

export async function probeMedia(config: WorkerConfig, inputPath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ];

    const proc = spawn(config.ffprobePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Tempo limite excedido ao inspecionar arquivo de mídia (ffprobe).'));
    }, 20_000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Falha ao executar ffprobe: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Arquivo de mídia inválido ou ilegível (ffprobe código ${code}): ${stderr.slice(0, 150)}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as {
          format?: { duration?: string; bit_rate?: string };
          streams?: Array<{ codec_type?: string; codec_name?: string; bit_rate?: string }>;
        };

        const audioStream = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
        const videoStream = (parsed.streams ?? []).find((s) => s.codec_type === 'video');
        const rawDuration = Number.parseFloat(parsed.format?.duration ?? '');
        const rawBitrate = Number.parseInt(audioStream?.bit_rate ?? parsed.format?.bit_rate ?? '', 10);

        resolve({
          hasAudio: Boolean(audioStream),
          hasVideo: Boolean(videoStream),
          codec: audioStream?.codec_name,
          videoCodec: videoStream?.codec_name,
          durationSeconds: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined,
          sourceBitrateKbps:
            Number.isFinite(rawBitrate) && rawBitrate > 0 ? Math.round(rawBitrate / 1000) : undefined,
        });
      } catch {
        reject(new Error('Não foi possível interpretar os metadados do arquivo de áudio.'));
      }
    });
  });
}

function runFfmpegWithProgress(
  config: WorkerConfig,
  args: string[],
  durationSeconds: number | undefined,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new FFmpegCancelledError());
  }

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let settled = false;
    let stderrTail = '';
    let stdoutBuffer = '';
    let lastReported = 0;

    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onAbort);
      reject(err);
    };

    const finishSuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };

    const killProc = () => {
      try {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 1500).unref();
      } catch {
        // Ignore already-exited process
      }
    };

    const onAbort = () => {
      killProc();
      finishError(new FFmpegCancelledError());
    };

    signal.addEventListener('abort', onAbort, { once: true });

    const timeoutTimer = setTimeout(() => {
      killProc();
      finishError(new Error('Tempo limite de processamento do FFmpeg excedido.'));
    }, config.ffmpegTimeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('out_time_us=') && durationSeconds && durationSeconds > 0) {
          const us = Number.parseInt(line.slice('out_time_us='.length), 10);
          if (Number.isFinite(us) && us >= 0) {
            const pct = Math.min(99, Math.max(0, Math.round((us / (durationSeconds * 1_000_000)) * 100)));
            if (pct > lastReported) {
              lastReported = pct;
              onProgress(pct);
            }
          }
        } else if (line === 'progress=end') {
          onProgress(100);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1500);
    });

    proc.on('error', (err) => {
      finishError(new Error(`Erro ao iniciar FFmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (signal.aborted) {
        finishError(new FFmpegCancelledError());
        return;
      }
      if (code !== 0) {
        finishError(new Error(`FFmpeg falhou (código ${code}): ${stderrTail.slice(-300).trim()}`));
        return;
      }
      finishSuccess();
    });
  });
}

export interface ConvertToMp3Options {
  inputPath: string;
  outputPath: string;
  coverImagePath?: string;
  bitrate: BitrateKbps;
  metadata: Id3MetadataInput;
  durationSeconds?: number;
  signal: AbortSignal;
  onProgress: (percent: number) => void;
}

export async function convertToMp3(
  config: WorkerConfig,
  options: ConvertToMp3Options,
): Promise<void> {
  const {
    inputPath,
    outputPath,
    coverImagePath,
    bitrate,
    metadata,
    durationSeconds,
    signal,
    onProgress,
  } = options;

  const args: string[] = [
    '-y',
    '-threads',
    String(config.ffmpegThreads),
    '-i',
    inputPath,
  ];

  if (coverImagePath) {
    args.push('-i', coverImagePath);
    args.push('-map', '0:a:0', '-map', '1:v:0');
    args.push('-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
  } else {
    args.push('-map', '0:a:0', '-vn');
  }

  args.push(
    '-c:a',
    'libmp3lame',
    '-compression_level',
    '2',
    '-b:a',
    `${bitrate}k`,
    '-id3v2_version',
    '3',
    '-write_id3v1',
    '1',
    '-metadata',
    `title=${metadata.title}`,
    '-metadata',
    `artist=${metadata.artist}`,
  );

  if (metadata.album) {
    args.push('-metadata', `album=${metadata.album}`);
  }
  if (typeof metadata.trackNumber === 'number') {
    args.push('-metadata', `track=${metadata.trackNumber}`);
  }

  args.push('-progress', 'pipe:1', '-nostats', outputPath);

  await runFfmpegWithProgress(config, args, durationSeconds, signal, onProgress);
}

export interface MuxMp4Options {
  videoPath: string;
  audioPath?: string;
  outputPath: string;
  metadata: Id3MetadataInput;
  durationSeconds?: number;
  videoCodecCopy: boolean;
  audioCodecCopy: boolean;
  signal: AbortSignal;
  onProgress: (percent: number) => void;
}

export async function muxToMp4(
  config: WorkerConfig,
  options: MuxMp4Options,
): Promise<void> {
  const {
    videoPath,
    audioPath,
    outputPath,
    metadata,
    durationSeconds,
    videoCodecCopy,
    audioCodecCopy,
    signal,
    onProgress,
  } = options;

  const args: string[] = [
    '-y',
    '-threads',
    String(config.ffmpegThreads),
    '-i',
    videoPath,
  ];

  if (audioPath) {
    args.push('-i', audioPath, '-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-map', '0:v:0', '-map', '0:a?');
  }

  args.push(
    '-c:v',
    videoCodecCopy ? 'copy' : 'libx264',
    '-c:a',
    audioCodecCopy ? 'copy' : 'aac',
  );

  if (!audioCodecCopy) {
    args.push('-b:a', '192k');
  }

  args.push(
    '-movflags',
    '+faststart',
    '-metadata',
    `title=${metadata.title}`,
    '-metadata',
    `artist=${metadata.artist}`,
    '-progress',
    'pipe:1',
    '-nostats',
    outputPath,
  );

  await runFfmpegWithProgress(config, args, durationSeconds, signal, onProgress);
}
