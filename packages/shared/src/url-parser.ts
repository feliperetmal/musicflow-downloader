import type { ParsedMediaLink, Platform } from './types.js';

const SPOTIFY_ID_REGEX = /^[A-Za-z0-9]{22}$/;
const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_REGEX = /^[A-Za-z0-9_-]{10,64}$/;

const SPOTIFY_SHARE_HOSTS = new Set(['spotify.link', 'spoti.fi', 'spotify.app.link']);
const SPOTIFY_OPEN_HOSTS = new Set(['open.spotify.com', 'play.spotify.com']);

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

const AUTHORIZED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.mp4', '.webm'];

export function detectPlatformQuick(input: string): Platform {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return 'unknown';

  if (trimmed.startsWith('spotify:')) return 'spotify';
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase();
    if (SPOTIFY_OPEN_HOSTS.has(host) || SPOTIFY_SHARE_HOSTS.has(host)) return 'spotify';
    if (YOUTUBE_HOSTS.has(host)) return 'youtube';
    const pathLower = url.pathname.toLowerCase();
    if (AUTHORIZED_AUDIO_EXTENSIONS.some((ext) => pathLower.endsWith(ext))) {
      return 'authorized_url';
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

export function parseMediaLink(rawInput: string): ParsedMediaLink {
  const raw = rawInput.trim();
  if (!raw) {
    return {
      raw,
      normalizedUrl: '',
      platform: 'unknown',
      resourceType: 'unknown',
      isShareShortlink: false,
      isValid: false,
      error: 'Cole um link válido do Spotify, YouTube ou fonte autorizada.',
    };
  }

  // Handle spotify:track:..., spotify:album:..., spotify:playlist:...
  const uriMatch = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/i.exec(raw);
  if (uriMatch) {
    const resourceType = uriMatch[1].toLowerCase();
    const id = uriMatch[2];
    return {
      raw,
      normalizedUrl: `https://open.spotify.com/${resourceType}/${id}`,
      platform: 'spotify',
      resourceType,
      id,
      isShareShortlink: false,
      isValid: true,
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      raw,
      normalizedUrl: '',
      platform: 'unknown',
      resourceType: 'unknown',
      isShareShortlink: false,
      isValid: false,
      error: 'URL inválida. Verifique se o link começa com https:// ou http://.',
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      raw,
      normalizedUrl: '',
      platform: 'unknown',
      resourceType: 'unknown',
      isShareShortlink: false,
      isValid: false,
      error: 'Apenas protocolos HTTP e HTTPS são permitidos.',
    };
  }

  const host = url.hostname.toLowerCase();

  // Spotify short share links
  if (SPOTIFY_SHARE_HOSTS.has(host)) {
    if (!url.pathname || url.pathname === '/') {
      return {
        raw,
        normalizedUrl: url.toString(),
        platform: 'spotify',
        resourceType: 'share',
        isShareShortlink: true,
        isValid: false,
        error: 'Link compartilhado do Spotify incompleto.',
      };
    }
    return {
      raw,
      normalizedUrl: url.toString(),
      platform: 'spotify',
      resourceType: 'share',
      isShareShortlink: true,
      isValid: true,
    };
  }

  // Spotify standard links (including /intl-pt/track/...)
  if (SPOTIFY_OPEN_HOSTS.has(host)) {
    const segments = url.pathname.split('/').filter(Boolean);
    const cleaned = segments[0]?.startsWith('intl-') ? segments.slice(1) : segments;
    const type = cleaned[0]?.toLowerCase();
    const id = cleaned[1];

    if ((type === 'track' || type === 'album' || type === 'playlist') && id && SPOTIFY_ID_REGEX.test(id)) {
      return {
        raw,
        normalizedUrl: `https://open.spotify.com/${type}/${id}`,
        platform: 'spotify',
        resourceType: type,
        id,
        isShareShortlink: false,
        isValid: true,
      };
    }

    return {
      raw,
      normalizedUrl: url.toString(),
      platform: 'spotify',
      resourceType: 'unknown',
      isShareShortlink: false,
      isValid: false,
      error: 'Link do Spotify não reconhecido. Use links de música, álbum ou playlist pública.',
    };
  }

  // YouTube & YouTube Music
  if (YOUTUBE_HOSTS.has(host)) {
    const isMusic = host === 'music.youtube.com';

    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      const listId = url.searchParams.get('list') ?? undefined;
      if (id && YOUTUBE_VIDEO_ID_REGEX.test(id)) {
        return {
          raw,
          normalizedUrl: `https://www.youtube.com/watch?v=${id}`,
          platform: 'youtube',
          resourceType: 'video',
          id,
          playlistId: listId && YOUTUBE_PLAYLIST_ID_REGEX.test(listId) ? listId : undefined,
          isShareShortlink: false,
          isValid: true,
        };
      }
      return {
        raw,
        normalizedUrl: url.toString(),
        platform: 'youtube',
        resourceType: 'unknown',
        isShareShortlink: false,
        isValid: false,
        error: 'ID de vídeo youtu.be inválido.',
      };
    }

    const segments = url.pathname.split('/').filter(Boolean);

    // Shorts: /shorts/<id>
    if (segments[0] === 'shorts' && segments[1] && YOUTUBE_VIDEO_ID_REGEX.test(segments[1])) {
      return {
        raw,
        normalizedUrl: `https://www.youtube.com/shorts/${segments[1]}`,
        platform: 'youtube',
        resourceType: 'shorts',
        id: segments[1],
        isShareShortlink: false,
        isValid: true,
      };
    }

    // Playlist: /playlist?list=<id>
    if (segments[0] === 'playlist') {
      const listId = url.searchParams.get('list');
      if (listId && YOUTUBE_PLAYLIST_ID_REGEX.test(listId)) {
        return {
          raw,
          normalizedUrl: `${isMusic ? 'https://music.youtube.com' : 'https://www.youtube.com'}/playlist?list=${listId}`,
          platform: 'youtube',
          resourceType: isMusic ? 'music_playlist' : 'playlist',
          id: listId,
          playlistId: listId,
          isShareShortlink: false,
          isValid: true,
        };
      }
      return {
        raw,
        normalizedUrl: url.toString(),
        platform: 'youtube',
        resourceType: 'playlist',
        isShareShortlink: false,
        isValid: false,
        error: 'Playlist do YouTube sem parâmetro list válido.',
      };
    }

    // Watch: /watch?v=<id> (& optional list=<listId>)
    if (segments[0] === 'watch') {
      const videoId = url.searchParams.get('v');
      const listId = url.searchParams.get('list') ?? undefined;
      if (videoId && YOUTUBE_VIDEO_ID_REGEX.test(videoId)) {
        const validList = listId && YOUTUBE_PLAYLIST_ID_REGEX.test(listId) ? listId : undefined;
        return {
          raw,
          normalizedUrl: `${isMusic ? 'https://music.youtube.com' : 'https://www.youtube.com'}/watch?v=${videoId}${validList ? `&list=${validList}` : ''}`,
          platform: 'youtube',
          resourceType: isMusic ? 'music_video' : 'video',
          id: videoId,
          playlistId: validList,
          isShareShortlink: false,
          isValid: true,
        };
      }
    }

    // Embed or live URLs: /embed/<id> or /live/<id>
    if ((segments[0] === 'embed' || segments[0] === 'live') && segments[1] && YOUTUBE_VIDEO_ID_REGEX.test(segments[1])) {
      return {
        raw,
        normalizedUrl: `https://www.youtube.com/watch?v=${segments[1]}`,
        platform: 'youtube',
        resourceType: 'video',
        id: segments[1],
        isShareShortlink: false,
        isValid: true,
      };
    }

    return {
      raw,
      normalizedUrl: url.toString(),
      platform: 'youtube',
      resourceType: 'unknown',
      isShareShortlink: false,
      isValid: false,
      error: 'Link do YouTube não reconhecido. Use vídeo, Shorts, YouTube Music ou playlist.',
    };
  }

  // Direct authorized audio/media URL (only explicit media file extensions)
  const pathLower = url.pathname.toLowerCase();
  if (AUTHORIZED_AUDIO_EXTENSIONS.some((ext) => pathLower.endsWith(ext))) {
    return {
      raw,
      normalizedUrl: url.toString(),
      platform: 'authorized_url',
      resourceType: 'audio_file',
      isShareShortlink: false,
      isValid: true,
    };
  }

  return {
    raw,
    normalizedUrl: url.toString(),
    platform: 'unknown',
    resourceType: 'unknown',
    isShareShortlink: false,
    isValid: false,
    error: 'Plataforma não suportada. Cole um link do Spotify, YouTube ou URL direta de arquivo de áudio autorizado.',
  };
}

export interface DuplicateCheckResult {
  canonicalUrl: string;
  isDuplicate: boolean;
  existingIndex: number;
}

export function checkDuplicateLink(candidateUrl: string, existingUrls: string[]): DuplicateCheckResult {
  const parsedCandidate = parseMediaLink(candidateUrl);
  const targetCanonical = parsedCandidate.isValid ? parsedCandidate.normalizedUrl : candidateUrl.trim();

  for (let i = 0; i < existingUrls.length; i++) {
    const parsedExisting = parseMediaLink(existingUrls[i]);
    const existingCanonical = parsedExisting.isValid ? parsedExisting.normalizedUrl : existingUrls[i].trim();
    if (targetCanonical && existingCanonical === targetCanonical) {
      return { canonicalUrl: targetCanonical, isDuplicate: true, existingIndex: i };
    }
  }

  return { canonicalUrl: targetCanonical, isDuplicate: false, existingIndex: -1 };
}
