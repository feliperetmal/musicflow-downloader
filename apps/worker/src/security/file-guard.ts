import fs from 'node:fs/promises';
import path from 'node:path';
import { SUPPORTED_UPLOAD_EXTENSIONS } from '@musicflow/shared';

export interface MediaSignatureResult {
  valid: boolean;
  detectedFormat?: string;
  reason?: string;
}

const DISALLOWED_TEXT_PREFIXES = [
  '<!doctype',
  '<html',
  '<svg',
  '<script',
  '<?xml',
  '%pdf-',
  '#!/',
];

export function inspectMediaBuffer(head: Buffer, originalFilename: string): MediaSignatureResult {
  const ext = path.extname(originalFilename).toLowerCase();
  if (!SUPPORTED_UPLOAD_EXTENSIONS.includes(ext as (typeof SUPPORTED_UPLOAD_EXTENSIONS)[number])) {
    return {
      valid: false,
      reason: `Extensão "${ext || '(sem extensão)'}" não suportada. Use MP4, WAV, FLAC, M4A, OGG, AAC, WebM ou MP3.`,
    };
  }

  if (head.length < 4) {
    return { valid: false, reason: 'Arquivo vazio ou corrompido.' };
  }

  // Block Windows PE / Linux ELF executables
  if ((head[0] === 0x4d && head[1] === 0x5a) || (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)) {
    return { valid: false, reason: 'Arquivo executável bloqueado por segurança.' };
  }

  const asciiPrefix = head.subarray(0, 64).toString('utf8').trimStart().toLowerCase();
  if (DISALLOWED_TEXT_PREFIXES.some((prefix) => asciiPrefix.startsWith(prefix))) {
    return { valid: false, reason: 'Arquivo textual/script disfarçado de mídia bloqueado.' };
  }

  // RIFF....WAVE
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('ascii') === 'RIFF' &&
    head.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return { valid: true, detectedFormat: 'wav' };
  }

  // FLAC
  if (head.subarray(0, 4).toString('ascii') === 'fLaC') {
    return { valid: true, detectedFormat: 'flac' };
  }

  // OGG
  if (head.subarray(0, 4).toString('ascii') === 'OggS') {
    return { valid: true, detectedFormat: 'ogg' };
  }

  // ISO BMFF (MP4 / M4A): bytes 4..8 == 'ftyp'
  if (head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp') {
    return { valid: true, detectedFormat: ext === '.m4a' ? 'm4a' : 'mp4' };
  }

  // EBML / WebM / Matroska: 1A 45 DF A3
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { valid: true, detectedFormat: 'webm' };
  }

  // ID3v2 MP3
  if (head.subarray(0, 3).toString('ascii') === 'ID3') {
    return { valid: true, detectedFormat: 'mp3' };
  }

  // MPEG / AAC ADTS frame sync (0xFF 0xE0 mask)
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    // ADTS AAC has layer bits == 00 (bits 2..1 of byte 1)
    const layer = (head[1] >> 1) & 0x03;
    if (layer === 0) {
      return { valid: true, detectedFormat: 'aac' };
    }
    return { valid: true, detectedFormat: 'mp3' };
  }

  return {
    valid: false,
    reason: 'Assinatura binária do arquivo não corresponde a um formato de áudio/vídeo compatível.',
  };
}

export async function validateUploadedMediaFile(filePath: string, originalFilename: string): Promise<MediaSignatureResult> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, 64, 0);
    return inspectMediaBuffer(buffer.subarray(0, bytesRead), originalFilename);
  } finally {
    await handle.close();
  }
}

export function isValidImageMagic(head: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'jpeg';
  }
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return 'png';
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('ascii') === 'RIFF' &&
    head.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}
