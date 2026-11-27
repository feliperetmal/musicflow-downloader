import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionView } from '@/components/collection-view';
import { MediaResultCard } from '@/components/media-result-card';
import { MusicFlowApp } from '@/components/musicflow-app';
import { formatBytes, formatDuration } from '@/lib/format';
import type { CollectionResult, MediaItem } from '@musicflow/shared';

afterEach(cleanup);

describe('Web helpers & YTSave-style MusicFlowApp UI', () => {
  it('formats durations and byte sizes accurately', () => {
    expect(formatDuration(215)).toBe('3:35');
    expect(formatDuration(3665)).toBe('1:01:05');
    expect(formatDuration(undefined)).toBe('--:--');

    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });

  it('renders YTSave-style centered URL input, Colar and Baixar buttons without technical jargon or server config UI', () => {
    render(<MusicFlowApp />);

    expect(screen.getByRole('heading', { name: 'MusicFlow Downloader' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Cole o link do YouTube, YouTube Music ou Spotify...')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Colar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Baixar' })).toBeTruthy();
    expect(screen.queryByText(/Worker FFmpeg/i)).toBeNull();
    expect(screen.queryByText(/Configuração do Servidor/i)).toBeNull();
    expect(screen.queryByText(/Chave Secreta/i)).toBeNull();
    expect(screen.queryByText(/Localhost/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Servidor/i })).toBeNull();
  });

  it('renders only real available formats in MediaResultCard and no fake buttons when unavailable', () => {
    const unavailableItem: MediaItem = {
      id: 'youtube:bad12345678',
      platform: 'youtube',
      resourceType: 'video',
      externalId: 'bad12345678',
      canonicalUrl: 'https://www.youtube.com/watch?v=bad12345678',
      title: 'Vídeo Privado',
      artist: 'Canal',
      downloadEligible: false,
      eligibilityReason: 'Este vídeo é privado e não pode ser baixado.',
      availableFormats: [],
    };

    const { rerender } = render(
      <MediaResultCard
        item={unavailableItem}
        formatJobs={{}}
        onDownloadFormat={async () => {}}
        onCancelJob={async () => {}}
      />,
    );

    expect(screen.getByText('Download direto indisponível')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Baixar' })).toBeNull();

    const availableItem: MediaItem = {
      ...unavailableItem,
      id: 'youtube:good1234567',
      title: 'Creative Commons Track',
      licenseType: 'creative_commons',
      downloadEligible: true,
      requiresAuthorizationConfirmation: false,
      availableFormats: [
        {
          id: 'mp3-128',
          format: 'mp3',
          qualityLabel: '128 kbps',
          bitrateKbps: 128,
          containerLabel: 'MP3',
        },
        {
          id: 'mp4-720p',
          format: 'mp4',
          qualityLabel: '720p',
          resolution: '720p',
          containerLabel: 'MP4',
        },
      ],
    };

    rerender(
      <MediaResultCard
        item={availableItem}
        formatJobs={{}}
        onDownloadFormat={async () => {}}
        onCancelJob={async () => {}}
      />,
    );

    expect(screen.getByText('128 kbps')).toBeTruthy();
    expect(screen.getByText('720p')).toBeTruthy();
    expect(screen.queryByText('4K (2160p)')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Baixar' }).length).toBe(2);
  });

  it('renders Spotify playlist with Hebrew RTL support, pagination and search filter', () => {
    const items: MediaItem[] = Array.from({ length: 65 }, (_, i) => ({
      id: `sp:${i + 1}`,
      platform: 'spotify',
      resourceType: 'track',
      externalId: `${i + 1}`,
      canonicalUrl: `https://open.spotify.com/track/${i + 1}`,
      title: i === 0 ? 'שלום עולם' : `Song ${i + 1}`,
      artist: i === 0 ? 'Omer Adam' : `Artist ${i + 1}`,
      trackNumber: i + 1,
      durationSeconds: 180,
      downloadEligible: false,
      eligibilityReason: 'Sem fonte',
    }));

    const collection: CollectionResult = {
      platform: 'spotify',
      resourceType: 'playlist',
      canonicalUrl: 'https://open.spotify.com/playlist/7FJDxus9eWaKJHXvYmtlqb',
      title: 'Minha Playlist Mix',
      ownerName: 'Pedro',
      totalTracks: 65,
      knownTotalTracks: 65,
      loadedTracks: 65,
      totalDurationSeconds: 65 * 180,
      accessStatus: 'full',
      apiMode: 'official_api',
      legalNotice: 'Aviso legal',
      items,
    };

    render(
      <CollectionView
        collection={collection}
        selectedIds={new Set()}
        onToggleSelect={() => {}}
        onSelectAllVisible={() => {}}
        onClearAllSelection={() => {}}
        onAttachFileToItem={() => {}}
        onImportTrackList={() => {}}
        onStartAutoZipBatch={async () => {}}
        onInspectSingleItem={async () => {}}
        itemJobs={{}}
        onDownloadZip={async () => {}}
        autoUploadZip={true}
        onToggleAutoUploadZip={() => {}}
        hostedZip={{
          url: 'https://files.catbox.moe/sample123.zip',
          provider: 'catbox',
          fileName: 'Minha Playlist Mix.zip',
          sizeBytes: 2048000,
          fileCount: 2,
          expiresIn: 'Permanente (Catbox.moe)',
          copiedToClipboard: true,
        }}
        onNotify={() => {}}
      />,
    );

    const hebrewEl = screen.getByText('שלום עולם');
    expect(hebrewEl.getAttribute('dir')).toBe('auto');
    expect(screen.getByText('Página 1 de 2 (65 faixas)')).toBeTruthy();
    expect(screen.getByText('Auto-upar ZIP (Catbox)')).toBeTruthy();
    expect(screen.getByText('https://files.catbox.moe/sample123.zip')).toBeTruthy();

    // Filter by artist
    const searchInput = screen.getByPlaceholderText('Pesquisar por música ou artista...');
    fireEvent.change(searchInput, { target: { value: 'Omer Adam' } });
    expect(screen.getByText('שלום עולם')).toBeTruthy();
    expect(screen.queryByText('Song 2')).toBeNull();
  });
});
