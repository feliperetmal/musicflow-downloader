import { z } from 'zod';
import type { BitrateKbps } from './types.js';

export const ALLOWED_BITRATES: readonly BitrateKbps[] = [128, 192, 256, 320] as const;

export const SUPPORTED_UPLOAD_EXTENSIONS = [
  '.mp4',
  '.wav',
  '.flac',
  '.m4a',
  '.ogg',
  '.aac',
  '.webm',
  '.mp3',
] as const;

export const BitrateSchema = z.union([
  z.literal(128),
  z.literal(192),
  z.literal(256),
  z.literal(320),
]);

export const Id3MetadataSchema = z.object({
  title: z.string().trim().min(1, 'Título é obrigatório').max(200),
  artist: z.string().trim().min(1, 'Artista é obrigatório').max(200),
  album: z.string().trim().max(200).optional(),
  trackNumber: z.number().int().min(1).max(999).optional(),
  coverUrl: z.string().url().max(1000).optional(),
});

export const ConversionJobRequestSchema = z
  .object({
    sourceType: z.enum(['upload', 'authorized_url', 'youtube', 'spotify_track']),
    outputFormat: z.enum(['mp3', 'mp4']).optional().default('mp3'),
    uploadId: z.string().uuid().optional(),
    authorizedAudioUrl: z.string().url().max(2048).optional(),
    youtubeVideoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/, 'ID de vídeo inválido').optional(),
    searchQuery: z.string().trim().min(2).max(300).optional(),
    videoItag: z.number().int().positive().optional(),
    audioItag: z.number().int().positive().optional(),
    qualityLabel: z.string().trim().max(40).optional(),
    userConfirmedAuthorization: z.boolean().optional().default(true),
    bitrate: BitrateSchema,
    metadata: Id3MetadataSchema,
    durationHintSeconds: z.number().positive().max(86400).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.userConfirmedAuthorization === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'É obrigatório confirmar que você possui direito/autorização sobre o conteúdo.',
        path: ['userConfirmedAuthorization'],
      });
    }
    if (val.sourceType === 'upload' && !val.uploadId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'uploadId é obrigatório quando sourceType é upload.',
        path: ['uploadId'],
      });
    }
    if (val.sourceType === 'authorized_url' && !val.authorizedAudioUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authorizedAudioUrl é obrigatório quando sourceType é authorized_url.',
        path: ['authorizedAudioUrl'],
      });
    }
    if (val.sourceType === 'youtube' && !val.youtubeVideoId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'youtubeVideoId é obrigatório quando sourceType é youtube.',
        path: ['youtubeVideoId'],
      });
    }
    if (val.sourceType === 'spotify_track' && !val.searchQuery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'searchQuery é obrigatório quando sourceType é spotify_track.',
        path: ['searchQuery'],
      });
    }
  });

export function sanitizeFilename(raw: string, fallback = 'musicflow-media'): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

  return cleaned || fallback;
}

export function sanitizeAsciiFilename(raw: string, fallback = 'musicflow-media'): string {
  const ascii = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[<>:"/\\|?*";]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  return ascii || fallback;
}

export function buildContentDispositionAttachment(filenameWithExt: string): string {
  const extMatch = /(\.[A-Za-z0-9]{2,5})$/.exec(filenameWithExt);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  const base = ext ? filenameWithExt.slice(0, -ext.length) : filenameWithExt;

  const utf8Name = `${sanitizeFilename(base, 'musicflow-media')}${ext}`;
  const asciiName = `${sanitizeAsciiFilename(base, 'musicflow-media')}${ext}`;
  const encodedUtf8 = encodeURIComponent(utf8Name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedUtf8}`;
}

export function isDisallowedHostLiteral(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return true;
    }
  }
  return false;
}

export function getBitrateHonestNote(requestedKbps: BitrateKbps, sourceBitrateKbps?: number): string {
  if (typeof sourceBitrateKbps === 'number' && sourceBitrateKbps > 0 && requestedKbps > sourceBitrateKbps) {
    return `A fonte original tem ~${sourceBitrateKbps} kbps. Converter para ${requestedKbps} kbps não recupera detalhes já perdidos na compressão original.`;
  }
  return `Codificado em MP3 ${requestedKbps} kbps preservando a qualidade da fonte original.`;
}
