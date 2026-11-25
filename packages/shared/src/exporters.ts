import type { CollectionResult, ExportFormat, MediaItem } from './types.js';

function escapeCsvCell(value: string | number | boolean | undefined): string {
  if (value === undefined || value === null) return '';
  const str = String(value);
  // Prevent CSV formula injection in Excel/Sheets
  const neutralized = /^[=+\-@]/.test(str) ? `'${str}` : str;
  if (/[",\r\n]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

export function exportToCsv(items: MediaItem[]): string {
  const headers = [
    'Título',
    'Artista/Canal',
    'Álbum',
    'Duração (s)',
    'Plataforma',
    'Tipo',
    'URL Canônica',
    'Elegível para MP3',
    'Motivo/Status',
  ];

  const rows = items.map((item) =>
    [
      escapeCsvCell(item.title),
      escapeCsvCell(item.artist),
      escapeCsvCell(item.album ?? ''),
      escapeCsvCell(item.durationSeconds ?? ''),
      escapeCsvCell(item.platform),
      escapeCsvCell(item.resourceType),
      escapeCsvCell(item.canonicalUrl),
      escapeCsvCell(item.downloadEligible ? 'Sim' : 'Não'),
      escapeCsvCell(item.eligibilityReason),
    ].join(','),
  );

  // UTF-8 BOM so Excel PT-BR opens accents cleanly
  return `\uFEFF${headers.join(',')}\r\n${rows.join('\r\n')}`;
}

export function exportToJson(
  items: MediaItem[],
  collection?: Pick<CollectionResult, 'title' | 'platform' | 'resourceType' | 'canonicalUrl'>,
): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      app: 'MusicFlow Downloader',
      collection: collection ?? null,
      totalItems: items.length,
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        artist: item.artist,
        album: item.album ?? null,
        trackNumber: item.trackNumber ?? null,
        durationSeconds: item.durationSeconds ?? null,
        platform: item.platform,
        resourceType: item.resourceType,
        canonicalUrl: item.canonicalUrl,
        coverUrl: item.coverUrl ?? null,
        isrc: item.isrc ?? null,
        downloadEligible: item.downloadEligible,
        eligibilityReason: item.eligibilityReason,
      })),
    },
    null,
    2,
  );
}

export function exportToM3u(items: MediaItem[]): string {
  const lines = ['#EXTM3U'];
  for (const item of items) {
    const duration = typeof item.durationSeconds === 'number' && item.durationSeconds > 0
      ? Math.round(item.durationSeconds)
      : -1;
    const label = `${item.artist} - ${item.title}`.replace(/[\r\n]+/g, ' ').trim();
    lines.push(`#EXTINF:${duration},${label}`);
    lines.push(item.authorizedAudioUrl || item.canonicalUrl);
  }
  return lines.join('\n');
}

export function buildExportPayload(
  format: ExportFormat,
  items: MediaItem[],
  collection?: Pick<CollectionResult, 'title' | 'platform' | 'resourceType' | 'canonicalUrl'>,
): { content: string; mimeType: string; extension: string } {
  switch (format) {
    case 'csv':
      return {
        content: exportToCsv(items),
        mimeType: 'text/csv;charset=utf-8',
        extension: 'csv',
      };
    case 'json':
      return {
        content: exportToJson(items, collection),
        mimeType: 'application/json;charset=utf-8',
        extension: 'json',
      };
    case 'm3u':
      return {
        content: exportToM3u(items),
        mimeType: 'audio/x-mpegurl;charset=utf-8',
        extension: 'm3u',
      };
  }
}
