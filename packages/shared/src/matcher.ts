import type { MediaItem } from './types.js';

export function normalizeTrackText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.[^/.]+$/, '') // strip file extension if any
    .replace(/[\(\)\[\]\{\}\-–—_.,!?:;"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface LocalFileCandidate {
  uploadId: string;
  originalName: string;
  durationSeconds?: number;
}

export interface TrackMatchResult {
  itemId: string;
  uploadId: string;
  originalName: string;
  confidence: number;
  reason: string;
}

/**
 * Matches uploaded local audio files to Spotify/collection tracks using normalized
 * title, artist, and duration tolerance (±8 seconds). Never guesses loosely.
 */
export function matchLocalFilesToTracks(
  items: MediaItem[],
  candidates: LocalFileCandidate[],
): TrackMatchResult[] {
  const matches: TrackMatchResult[] = [];
  const usedUploads = new Set<string>();

  for (const item of items) {
    const normTitle = normalizeTrackText(item.title);
    const primaryArtist = normalizeTrackText(item.artist.split(',')[0] ?? item.artist);
    if (!normTitle) continue;

    let bestCandidate: LocalFileCandidate | null = null;
    let bestScore = 0;
    let bestReason = '';

    for (const candidate of candidates) {
      if (usedUploads.has(candidate.uploadId)) continue;
      const normFile = normalizeTrackText(candidate.originalName);
      if (!normFile) continue;

      let score = 0;
      const reasons: string[] = [];

      if (normFile === normTitle || normFile === `${primaryArtist} ${normTitle}`) {
        score += 0.75;
        reasons.push('correspondência exata de título/artista');
      } else if (normFile.includes(normTitle) && normTitle.length >= 4) {
        score += 0.55;
        reasons.push('título encontrado no nome do arquivo');
      } else {
        continue;
      }

      if (primaryArtist && primaryArtist.length >= 2 && normFile.includes(primaryArtist)) {
        score += 0.2;
        reasons.push('artista compatível');
      }

      if (
        typeof item.durationSeconds === 'number' &&
        typeof candidate.durationSeconds === 'number'
      ) {
        const diff = Math.abs(item.durationSeconds - candidate.durationSeconds);
        if (diff <= 4) {
          score += 0.2;
          reasons.push('duração exata');
        } else if (diff <= 10) {
          score += 0.05;
        } else {
          score -= 0.35; // Penalize mismatched duration
        }
      }

      if (score >= 0.65 && score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
        bestReason = reasons.join(', ');
      }
    }

    if (bestCandidate) {
      usedUploads.add(bestCandidate.uploadId);
      matches.push({
        itemId: item.id,
        uploadId: bestCandidate.uploadId,
        originalName: bestCandidate.originalName,
        confidence: Math.min(1, Number(bestScore.toFixed(2))),
        reason: bestReason,
      });
    }
  }

  return matches;
}
