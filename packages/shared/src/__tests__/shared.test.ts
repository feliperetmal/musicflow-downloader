import { describe, expect, it } from 'vitest';
import {
  buildContentDispositionAttachment,
  buildExportPayload,
  checkDuplicateLink,
  detectPlatformQuick,
  exportToCsv,
  exportToM3u,
  getBitrateHonestNote,
  isDisallowedHostLiteral,
  matchLocalFilesToTracks,
  normalizeTrackText,
  parseMediaLink,
  sanitizeAsciiFilename,
  sanitizeFilename,
} from '../index.js';
import type { MediaItem } from '../types.js';

describe('parseMediaLink & detectPlatformQuick', () => {
  it('parses Spotify track, album, playlist, intl links, URI and share shortlinks', () => {
    const track = parseMediaLink('https://open.spotify.com/intl-pt/track/4cOdK2wGLETKBW3PvgPWqT?si=abc123');
    expect(track.isValid).toBe(true);
    expect(track.platform).toBe('spotify');
    expect(track.resourceType).toBe('track');
    expect(track.id).toBe('4cOdK2wGLETKBW3PvgPWqT');
    expect(track.normalizedUrl).toBe('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');

    const album = parseMediaLink('spotify:album:1ATL5GLyefJaxhQzSPVrLX');
    expect(album.isValid).toBe(true);
    expect(album.resourceType).toBe('album');

    const playlist = parseMediaLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    expect(playlist.isValid).toBe(true);
    expect(playlist.resourceType).toBe('playlist');

    const share = parseMediaLink('https://spotify.link/XyZ123AbC');
    expect(share.isValid).toBe(true);
    expect(share.isShareShortlink).toBe(true);
  });

  it('parses YouTube video, youtu.be, Shorts, YouTube Music, and playlists', () => {
    const video = parseMediaLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
    expect(video.isValid).toBe(true);
    expect(video.platform).toBe('youtube');
    expect(video.resourceType).toBe('video');
    expect(video.id).toBe('dQw4w9WgXcQ');

    const shortUrl = parseMediaLink('https://youtu.be/dQw4w9WgXcQ');
    expect(shortUrl.isValid).toBe(true);
    expect(shortUrl.normalizedUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    const shorts = parseMediaLink('https://www.youtube.com/shorts/abcdefghijk');
    expect(shorts.isValid).toBe(true);
    expect(shorts.resourceType).toBe('shorts');

    const ytMusic = parseMediaLink('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890');
    expect(ytMusic.isValid).toBe(true);
    expect(ytMusic.resourceType).toBe('music_video');
    expect(ytMusic.playlistId).toBe('PL1234567890');

    const playlist = parseMediaLink('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI');
    expect(playlist.isValid).toBe(true);
    expect(playlist.resourceType).toBe('playlist');
  });

  it('detects duplicate links even with tracking parameters or different URL forms', () => {
    const dup = checkDuplicateLink('https://youtu.be/dQw4w9WgXcQ', [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
    ]);
    expect(dup.isDuplicate).toBe(true);
    expect(dup.existingIndex).toBe(0);
  });

  it('rejects non-http protocols and detects quick platform', () => {
    expect(parseMediaLink('javascript:alert(1)').isValid).toBe(false);
    expect(detectPlatformQuick('https://open.spotify.com/track/123')).toBe('spotify');
    expect(detectPlatformQuick('https://music.youtube.com/watch?v=abc')).toBe('youtube');
  });
});

describe('exporters & validation', () => {
  const sampleItems: MediaItem[] = [
    {
      id: '1',
      platform: 'spotify',
      resourceType: 'track',
      externalId: 'abc',
      canonicalUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      title: '=HYPERLINK("bad")',
      artist: 'Artista, "Teste"',
      album: 'Álbum Teste',
      durationSeconds: 215,
      downloadEligible: false,
      eligibilityReason: 'Requer fonte autorizada',
    },
  ];

  it('exports RFC-4180 CSV with formula neutralization and UTF-8 BOM', () => {
    const csv = exportToCsv(sampleItems);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"Artista, ""Teste"""');
  });

  it('exports M3U and JSON formats', () => {
    const m3u = exportToM3u(sampleItems);
    expect(m3u).toContain('#EXTM3U');
    expect(m3u).toContain('#EXTINF:215,Artista, "Teste" - =HYPERLINK("bad")');

    const json = buildExportPayload('json', sampleItems);
    expect(json.mimeType).toContain('application/json');
    expect(JSON.parse(json.content).totalItems).toBe(1);
  });

  it('blocks private/loopback literals and gives honest bitrate note', () => {
    expect(isDisallowedHostLiteral('127.0.0.1')).toBe(true);
    expect(isDisallowedHostLiteral('169.254.169.254')).toBe(true);
    expect(isDisallowedHostLiteral('localhost')).toBe(true);
    expect(isDisallowedHostLiteral('10.0.0.5')).toBe(true);
    expect(isDisallowedHostLiteral('cdn.example.com')).toBe(false);

    expect(sanitizeAsciiFilename('Música: Teste / 2026?')).toBe('Musica_ Teste _ 2026_');
    expect(sanitizeFilename('Onde eu Clico - 🚨 Gemini!')).toBe('Onde eu Clico - 🚨 Gemini!');
    const disp = buildContentDispositionAttachment('Onde eu Clico - 🚨 Gemini 4 Carbon!.mp3');
    expect(disp).toContain('filename="Onde eu Clico - Gemini 4 Carbon!.mp3"');
    expect(disp).toContain("filename*=UTF-8''");
    expect([...disp].every((ch) => ch.charCodeAt(0) <= 0x7e)).toBe(true);
    expect(getBitrateHonestNote(320, 128)).toContain('não recupera');
  });

  it('preserves Hebrew & English text and matches local audio files reliably', () => {
    expect(normalizeTrackText('שלום עולם - Live.flac')).toBe('שלום עולם live');

    const playlistItems: MediaItem[] = [
      {
        id: 'sp:1',
        platform: 'spotify',
        resourceType: 'track',
        externalId: '1',
        canonicalUrl: 'https://open.spotify.com/track/1',
        title: 'שלום עולם',
        artist: 'Omer Adam',
        durationSeconds: 200,
        downloadEligible: false,
        eligibilityReason: 'DRM',
      },
      {
        id: 'sp:2',
        platform: 'spotify',
        resourceType: 'track',
        externalId: '2',
        canonicalUrl: 'https://open.spotify.com/track/2',
        title: 'Midnight Echo',
        artist: 'Luna',
        durationSeconds: 180,
        downloadEligible: false,
        eligibilityReason: 'DRM',
      },
    ];

    const matches = matchLocalFilesToTracks(playlistItems, [
      { uploadId: 'u-1', originalName: 'Omer Adam - שלום עולם.flac', durationSeconds: 201 },
      { uploadId: 'u-2', originalName: 'Midnight Echo.wav', durationSeconds: 45 }, // duration mismatch!
    ]);

    expect(matches).toHaveLength(1);
    expect(matches[0].itemId).toBe('sp:1');
    expect(matches[0].uploadId).toBe('u-1');
  });
});
