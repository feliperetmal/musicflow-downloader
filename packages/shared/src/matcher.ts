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

export interface ExternalMatchCandidate {
  id: string;
  title: string;
  channel?: string;
  durationSeconds?: number;
}

export interface ExternalMatchValidation {
  matched: ExternalMatchCandidate | null;
  confidence: number;
  reason: string;
}

const NOISE_TERMS = ['karaoke', 'instrumental', 'cover', 'reaction', 'react', 'slowed', 'reverb', '8d audio', '1 hour', '10 hours', 'podcast'];

/**
 * Validates external audio/video search candidates against Spotify track metadata
 * (title, artist, and duration) so unrelated tracks are rejected honestly.
 */
export function validateExternalTrackMatch(
  expected: { title: string; artist: string; durationSeconds?: number },
  candidates: ExternalMatchCandidate[],
): ExternalMatchValidation {
  const normTitle = normalizeTrackText(expected.title);
  const primaryArtist = normalizeTrackText(expected.artist.split(',')[0] ?? expected.artist);
  if (!normTitle) {
    return { matched: null, confidence: 0, reason: 'Título da faixa ausente para validação.' };
  }

  const titleWords = normTitle.split(' ').filter((w) => w.length >= 2);
  let bestCandidate: ExternalMatchCandidate | null = null;
  let bestScore = 0;
  let bestReason = 'Nenhuma fonte compatível encontrada.';

  for (const candidate of candidates) {
    const normCandTitle = normalizeTrackText(candidate.title);
    const normCandChannel = normalizeTrackText(candidate.channel ?? '');
    if (!normCandTitle) continue;

    // Reject obvious mismatched variants unless explicitly part of the requested track title
    const hasUnexpectedNoise = NOISE_TERMS.some(
      (term) => normCandTitle.includes(term) && !normTitle.includes(term),
    );
    if (hasUnexpectedNoise) continue;

    // Enforce duration check first when expected duration is known
    if (
      typeof expected.durationSeconds === 'number' &&
      expected.durationSeconds > 0 &&
      typeof candidate.durationSeconds === 'number' &&
      candidate.durationSeconds > 0
    ) {
      const tolerance = Math.max(15, Math.round(expected.durationSeconds * 0.15));
      const diff = Math.abs(expected.durationSeconds - candidate.durationSeconds);
      if (diff > tolerance) {
        continue;
      }
    }

    let score = 0;
    const reasons: string[] = [];

    if (normCandTitle.includes(normTitle)) {
      score += 0.55;
      reasons.push('título compatível');
    } else if (titleWords.length > 0) {
      const matchedWords = titleWords.filter((w) => normCandTitle.includes(w));
      const ratio = matchedWords.length / titleWords.length;
      if (ratio < 0.75) continue;
      score += 0.45 * ratio;
      reasons.push('palavras-chave do título compatíveis');
    } else {
      continue;
    }

    if (primaryArtist && primaryArtist.length >= 2) {
      const artistInTitle = normCandTitle.includes(primaryArtist);
      const artistInChannel = normCandChannel.includes(primaryArtist);
      if (artistInTitle || artistInChannel) {
        score += 0.3;
        reasons.push('artista compatível');
      }
    }

    if (
      typeof expected.durationSeconds === 'number' &&
      typeof candidate.durationSeconds === 'number' &&
      Math.abs(expected.durationSeconds - candidate.durationSeconds) <= 8
    ) {
      score += 0.15;
      reasons.push('duração validada');
    }

    if (score >= 0.65 && score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
      bestReason = reasons.join(', ');
    }
  }

  return {
    matched: bestCandidate,
    confidence: Math.min(1, Number(bestScore.toFixed(2))),
    reason: bestReason,
  };
}
