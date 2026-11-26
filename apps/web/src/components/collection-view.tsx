'use client';

import * as React from 'react';
import {
  buildExportPayload,
  matchLocalFilesToTracks,
  sanitizeFilename,
  type BitrateKbps,
  type CollectionResult,
  type ConversionJob,
  type ExportFormat,
  type MediaItem,
  type UploadMetadata,
} from '@musicflow/shared';
import {
  Archive,
  CheckCircle2,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileAudio,
  FileSpreadsheet,
  FileUp,
  FolderUp,
  Info,
  Loader2,
  LogIn,
  Music2,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { formatDuration } from '@/lib/format';
import { getJobDownloadUrl } from '@/lib/api-client';
import type { ToastType } from './notifications';

export interface ActiveZipBatchState {
  title: string;
  totalCount: number;
  completedIds: string[];
  failedCount: number;
  activeCount: number;
  overallProgress: number;
  status: 'running' | 'downloading_zip' | 'completed' | 'cancelled';
}

interface CollectionViewProps {
  collection: CollectionResult;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAllVisible: (visibleIds: string[]) => void;
  onClearAllSelection: () => void;
  onAttachFileToItem: (itemId: string, upload: UploadMetadata) => void;
  onImportTrackList: (items: MediaItem[], title?: string) => void;
  onStartAutoZipBatch: (items: MediaItem[], bitrate: BitrateKbps, zipName: string) => Promise<void>;
  onCancelAutoZipBatch?: () => Promise<void>;
  activeZipBatch?: ActiveZipBatchState | null;
  onDownloadSingleTrackMp3?: (item: MediaItem, bitrate: BitrateKbps) => Promise<void>;
  onInspectSingleItem: (item: MediaItem) => Promise<void>;
  itemJobs: Record<string, ConversionJob>;
  onDownloadZip: (jobIds: string[], zipName?: string) => Promise<void>;
  onSpotifyLogin?: () => Promise<void>;
  onNotify: (type: ToastType, title: string, description?: string) => void;
}

const PAGE_SIZE = 50;

export function CollectionView({
  collection,
  selectedIds,
  onToggleSelect,
  onSelectAllVisible,
  onClearAllSelection,
  onAttachFileToItem,
  onImportTrackList,
  onStartAutoZipBatch,
  onCancelAutoZipBatch,
  activeZipBatch,
  onDownloadSingleTrackMp3,
  onInspectSingleItem,
  itemJobs,
  onDownloadZip,
  onSpotifyLogin,
  onNotify,
}: CollectionViewProps) {
  const [search, setSearch] = React.useState('');
  const [filterMode, setFilterMode] = React.useState<'all' | 'eligible' | 'unavailable'>('all');
  const [sortBy, setSortBy] = React.useState<'original' | 'title' | 'artist' | 'duration'>('original');
  const [page, setPage] = React.useState(1);
  const [bitrate, setBitrate] = React.useState<BitrateKbps>(192);
  const [convertingBatch, setConvertingBatch] = React.useState(false);
  const [matchingFiles, setMatchingFiles] = React.useState(false);
  const [inspectingId, setInspectingId] = React.useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = React.useState(false);

  React.useEffect(() => {
    setPage(1);
  }, [search, filterMode, sortBy, collection.canonicalUrl]);

  const filteredItems = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = collection.items.filter((item) => {
      if (filterMode === 'eligible' && !item.downloadEligible) return false;
      if (filterMode === 'unavailable' && item.downloadEligible) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.artist.toLowerCase().includes(q) ||
        (item.album ?? '').toLowerCase().includes(q)
      );
    });

    if (sortBy === 'original') return list;

    return [...list].sort((a, b) => {
      if (sortBy === 'title') return a.title.localeCompare(b.title);
      if (sortBy === 'artist') return a.artist.localeCompare(b.artist);
      return (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0);
    });
  }, [collection.items, filterMode, search, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedItems = React.useMemo(
    () => filteredItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredItems, safePage],
  );

  const visibleIds = filteredItems.map((i) => i.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  const selectedItems = collection.items.filter((i) => selectedIds.has(i.id));
  const eligibleSelected = selectedItems.filter((i) => i.downloadEligible);
  const totalEligible = collection.items.filter((i) => i.downloadEligible).length;

  const handleExport = (format: ExportFormat) => {
    const targetItems = selectedItems.length > 0 ? selectedItems : filteredItems;
    if (targetItems.length === 0) {
      onNotify('warning', 'Nenhuma faixa para exportar', 'Carregue faixas ou ajuste o filtro.');
      return;
    }

    const payload = buildExportPayload(format, targetItems, {
      title: collection.title,
      platform: collection.platform,
      resourceType: collection.resourceType,
      canonicalUrl: collection.canonicalUrl,
    });

    const blob = new Blob([payload.content], { type: payload.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(collection.title)}.${payload.extension}`;
    a.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);

    onNotify(
      'success',
      `Lista exportada em ${format.toUpperCase()}`,
      `${targetItems.length} ${targetItems.length === 1 ? 'faixa exportada' : 'faixas exportadas'}.`,
    );
  };

  const handleSingleFileUpload = async (itemId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/uploads', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao enviar áudio.');
    onAttachFileToItem(itemId, data as UploadMetadata);
    onNotify('success', 'Áudio vinculado', `${file.name} pronto para MP3 e ZIP.`);
  };

  const handleBatchMatchUpload = async (fileList: FileList) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setMatchingFiles(true);
    try {
      const uploaded: UploadMetadata[] = [];
      for (const file of files.slice(0, 50)) {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/uploads', { method: 'POST', body: formData });
        if (res.ok) {
          uploaded.push((await res.json()) as UploadMetadata);
        }
      }

      const matches = matchLocalFilesToTracks(collection.items, uploaded);
      for (const m of matches) {
        const meta = uploaded.find((u) => u.uploadId === m.uploadId);
        if (meta) onAttachFileToItem(m.itemId, meta);
      }

      if (matches.length > 0) {
        onNotify(
          'success',
          `${matches.length} música(s) associada(s)`,
          `${uploaded.length} arquivo(s) analisado(s) com correspondência verificada.`,
        );
      } else {
        onNotify(
          'warning',
          'Nenhuma correspondência confiável',
          'Renomeie os arquivos com "Artista - Música" ou vincule manualmente por faixa.',
        );
      }
    } finally {
      setMatchingFiles(false);
    }
  };

  const handleImportCsvOrM3u = async (file: File) => {
    const text = await file.text();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const imported: MediaItem[] = [];

    if (file.name.toLowerCase().endsWith('.m3u') || file.name.toLowerCase().endsWith('.m3u8')) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXTINF:')) {
          const commaIdx = lines[i].indexOf(',');
          const label = commaIdx !== -1 ? lines[i].slice(commaIdx + 1) : `Faixa ${imported.length + 1}`;
          const [artist, ...titleParts] = label.split(' - ');
          const title = titleParts.length > 0 ? titleParts.join(' - ') : label;
          imported.push({
            id: `imported:${imported.length + 1}:${title}`,
            platform: 'spotify',
            resourceType: 'track',
            externalId: `imported-${imported.length + 1}`,
            canonicalUrl: collection.canonicalUrl,
            title: title.trim(),
            artist: titleParts.length > 0 ? artist.trim() : 'Artista',
            trackNumber: imported.length + 1,
            sourceOrigin: 'none',
            downloadEligible: false,
            eligibilityReason: 'Faixa importada de M3U — vincule arquivo de áudio próprio.',
          });
        }
      }
    } else {
      // CSV import (skip header row)
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map((c) => c.replace(/^"|"$/g, '').trim());
        if (!cols[0]) continue;
        imported.push({
          id: `imported:${i}:${cols[0]}`,
          platform: 'spotify',
          resourceType: 'track',
          externalId: `imported-${i}`,
          canonicalUrl: collection.canonicalUrl,
          title: cols[0],
          artist: cols[1] || 'Artista',
          album: cols[2] || undefined,
          durationSeconds: cols[3] ? Number.parseInt(cols[3], 10) || undefined : undefined,
          trackNumber: imported.length + 1,
          sourceOrigin: 'none',
          downloadEligible: false,
          eligibilityReason: 'Faixa importada de CSV — vincule arquivo de áudio próprio.',
        });
      }
    }

    if (imported.length === 0) {
      onNotify('error', 'Lista vazia', 'Nenhuma faixa reconhecida no arquivo CSV/M3U.');
      return;
    }

    onImportTrackList(imported, file.name.replace(/\.[^.]+$/, ''));
    onNotify('success', 'Lista importada', `${imported.length} faixas carregadas.`);
  };

  const handleAutoZipClick = async () => {
    if (eligibleSelected.length === 0) {
      onNotify(
        'info',
        'Nenhuma faixa selecionada',
        'Selecione pelo menos uma música na lista para gerar o ZIP.',
      );
      return;
    }
    setConvertingBatch(true);
    try {
      await onStartAutoZipBatch(eligibleSelected, bitrate, collection.title);
    } finally {
      setConvertingBatch(false);
    }
  };

  const isRestrictedOrPartial =
    collection.accessStatus === 'restricted' ||
    collection.accessStatus === 'auth_required' ||
    collection.accessStatus === 'partial';

  return (
    <Card className="overflow-hidden border-purple-500/25 shadow-xl">
      {/* Playlist / Album Header (SpotiSaver-inspired) */}
      <CardHeader className="border-b border-[var(--border-subtle)] bg-gradient-to-r from-purple-950/25 via-transparent to-emerald-950/20">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          {collection.coverUrl ? (
            <img
              src={collection.coverUrl}
              alt={collection.title}
              className="h-28 w-28 sm:h-32 sm:w-32 shrink-0 rounded-2xl object-cover shadow-xl border border-[var(--border-subtle)]"
            />
          ) : (
            <div className="flex h-28 w-28 sm:h-32 sm:w-32 shrink-0 items-center justify-center rounded-2xl bg-[var(--bg-muted)] border border-[var(--border-subtle)]">
              <Music2 className="h-11 w-11 text-purple-400 shrink-0" aria-hidden="true" />
            </div>
          )}

          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={collection.platform === 'spotify' ? 'spotify' : 'youtube'}>
                {collection.platform === 'spotify' ? 'Spotify' : 'YouTube'}
              </Badge>
              <Badge variant="neutral">
                {collection.knownTotalTracks ?? collection.totalTracks}{' '}
                {(collection.knownTotalTracks ?? collection.totalTracks) === 1 ? 'faixa' : 'faixas'}
              </Badge>
              {typeof collection.totalDurationSeconds === 'number' &&
                collection.totalDurationSeconds > 0 && (
                  <Badge variant="neutral">
                    <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                    {formatDuration(collection.totalDurationSeconds)}
                  </Badge>
                )}
              {collection.platform === 'spotify' && (
                <Badge variant={totalEligible > 0 ? 'success' : 'neutral'}>
                  {totalEligible} disponíveis para download
                </Badge>
              )}
            </div>

            <CardTitle
              dir="auto"
              style={{ unicodeBidi: 'plaintext' }}
              className="text-xl sm:text-2xl font-bold leading-tight"
            >
              {collection.title}
            </CardTitle>

            {collection.subtitle && (
              <CardDescription dir="auto" style={{ unicodeBidi: 'plaintext' }}>
                {collection.ownerName ? `Por ${collection.ownerName}` : collection.subtitle}
              </CardDescription>
            )}

            {collection.description && (
              <p
                dir="auto"
                style={{ unicodeBidi: 'plaintext' }}
                className="line-clamp-2 text-xs text-[var(--text-secondary)]"
              >
                {collection.description}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <a
                href={collection.canonicalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 text-xs font-medium hover:border-emerald-500/40 transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                Abrir no {collection.platform === 'spotify' ? 'Spotify' : 'YouTube'}
              </a>

              {collection.requiresSpotifyLogin && onSpotifyLogin && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void onSpotifyLogin()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-500 transition-colors"
                >
                  <LogIn className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Conectar com Spotify
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Restriction / Access State Banner */}
        {isRestrictedOrPartial && collection.restrictionReason && (
          <div className="mt-4 space-y-3 rounded-xl border border-amber-500/35 bg-amber-500/10 p-3.5 text-xs">
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
              <div className="space-y-1">
                <p className="font-semibold text-amber-300">
                  {collection.accessStatus === 'auth_required'
                    ? 'Autenticação Spotify necessária'
                    : collection.accessStatus === 'partial'
                      ? `Carregamento parcial: ${collection.loadedTracks ?? collection.items.length} de ${collection.knownTotalTracks ?? collection.totalTracks} faixas`
                      : `Acesso restrito pela plataforma (${collection.knownTotalTracks ?? 0} faixas conhecidas, ${collection.loadedTracks ?? 0} obtidas)`}
                </p>
                <p className="leading-relaxed text-[var(--text-secondary)]">
                  {collection.restrictionReason}
                </p>
              </div>
            </div>

            {collection.platform === 'spotify' && (
              <div className="flex flex-wrap items-center gap-2 pl-6">
                <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 text-xs font-medium hover:border-purple-500/50">
                  <FileUp className="h-3.5 w-3.5 text-purple-400 shrink-0" aria-hidden="true" />
                  Importar lista CSV ou M3U
                  <input
                    type="file"
                    accept=".csv,.m3u,.m3u8"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) void handleImportCsvOrM3u(f);
                    }}
                  />
                </label>
              </div>
            )}
          </div>
        )}

        {!isRestrictedOrPartial && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-purple-500/20 bg-purple-500/10 p-3 text-xs leading-relaxed text-[var(--text-primary)]">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-purple-400" aria-hidden="true" />
            <p>{collection.legalNotice}</p>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4 pt-5">
        {/* Search, Filter & Sort */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-secondary)] shrink-0"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pesquisar por música ou artista..."
              aria-label="Pesquisar na playlist"
              className="pl-10"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(['all', 'eligible', 'unavailable'] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant={filterMode === mode ? 'default' : 'secondary'}
                onClick={() => setFilterMode(mode)}
              >
                {mode === 'all'
                  ? `Todas (${collection.items.length})`
                  : mode === 'eligible'
                    ? `Disponíveis (${totalEligible})`
                    : `Indisponíveis (${collection.items.length - totalEligible})`}
              </Button>
            ))}

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              aria-label="Ordenar faixas"
              className="h-8 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-muted)] px-2.5 text-xs text-[var(--text-primary)] cursor-pointer"
            >
              <option value="original" className="bg-zinc-900 text-zinc-100">Ordem original</option>
              <option value="title" className="bg-zinc-900 text-zinc-100">Nome (A-Z)</option>
              <option value="artist" className="bg-zinc-900 text-zinc-100">Artista (A-Z)</option>
              <option value="duration" className="bg-zinc-900 text-zinc-100">Duração</option>
            </select>
          </div>
        </div>

        {/* Action Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-muted)]/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={visibleIds.length === 0}
              onClick={() =>
                allVisibleSelected ? onClearAllSelection() : onSelectAllVisible(visibleIds)
              }
            >
              {allVisibleSelected ? (
                <CheckSquare className="h-4 w-4 text-emerald-400 shrink-0" aria-hidden="true" />
              ) : (
                <Square className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              {allVisibleSelected ? 'Desmarcar todas' : 'Selecionar todas'}
            </Button>

            {collection.platform === 'spotify' && collection.items.length > 0 && (
              <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-purple-500/35 bg-purple-500/10 px-2.5 text-xs font-medium text-purple-300 hover:bg-purple-500/20 transition-colors">
                <FolderUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {matchingFiles ? 'Associando...' : 'Vincular áudios locais'}
                <input
                  type="file"
                  multiple
                  accept=".mp4,.wav,.flac,.m4a,.ogg,.aac,.webm,.mp3"
                  className="hidden"
                  disabled={matchingFiles}
                  onChange={(e) => {
                    if (e.target.files) void handleBatchMatchUpload(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
            )}

            <div className="relative">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={filteredItems.length === 0}
                onClick={() => setShowExportMenu((v) => !v)}
              >
                <FileSpreadsheet className="h-4 w-4 text-purple-400 shrink-0" aria-hidden="true" />
                Exportar
              </Button>
              {showExportMenu && (
                <div className="glass-panel absolute left-0 top-10 z-20 flex w-44 flex-col gap-1 rounded-xl p-1.5 shadow-xl">
                  <button
                    type="button"
                    onClick={() => handleExport('csv')}
                    className="rounded-lg px-3 py-1.5 text-left text-xs hover:bg-purple-500/15 cursor-pointer"
                  >
                    Exportar CSV (Excel)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExport('json')}
                    className="rounded-lg px-3 py-1.5 text-left text-xs hover:bg-purple-500/15 cursor-pointer"
                  >
                    Exportar JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExport('m3u')}
                    className="rounded-lg px-3 py-1.5 text-left text-xs hover:bg-purple-500/15 cursor-pointer"
                  >
                    Exportar M3U
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1">
              <span className="text-xs text-[var(--text-secondary)]">MP3:</span>
              <select
                value={bitrate}
                onChange={(e) => setBitrate(Number(e.target.value) as BitrateKbps)}
                aria-label="Qualidade MP3 em lote"
                className="bg-transparent text-xs font-medium text-[var(--text-primary)] focus:outline-none cursor-pointer"
              >
                <option value={128} className="bg-zinc-900 text-zinc-100">128 kbps</option>
                <option value={192} className="bg-zinc-900 text-zinc-100">192 kbps</option>
                <option value={320} className="bg-zinc-900 text-zinc-100">320 kbps</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="emerald"
              disabled={
                eligibleSelected.length === 0 ||
                convertingBatch ||
                activeZipBatch?.status === 'running' ||
                activeZipBatch?.status === 'downloading_zip'
              }
              onClick={handleAutoZipClick}
            >
              {convertingBatch || activeZipBatch?.status === 'running' || activeZipBatch?.status === 'downloading_zip' ? (
                <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
              ) : (
                <Archive className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              {activeZipBatch?.status === 'running'
                ? `Preparando ZIP (${activeZipBatch.completedIds.length}/${activeZipBatch.totalCount})`
                : activeZipBatch?.status === 'downloading_zip'
                  ? 'Compactando ZIP...'
                  : `Baixar ZIP (${eligibleSelected.length})`}
            </Button>
          </div>
        </div>

        {/* Live Automatic ZIP Progress Banner */}
        {activeZipBatch && activeZipBatch.status !== 'cancelled' && (
          <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-4 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs sm:text-sm font-medium text-emerald-300">
                {activeZipBatch.status === 'completed' ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin shrink-0 text-emerald-400" aria-hidden="true" />
                )}
                <span>
                  {activeZipBatch.status === 'completed'
                    ? `ZIP pronto! ${activeZipBatch.completedIds.length} música(s) baixada(s) automaticamente.`
                    : activeZipBatch.status === 'downloading_zip'
                      ? `Compactando e iniciando download do ZIP (${activeZipBatch.completedIds.length} músicas)...`
                      : `Baixando e convertendo automaticamente: ${activeZipBatch.completedIds.length} de ${activeZipBatch.totalCount} prontas — o ZIP baixará sozinho ao terminar!`}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {activeZipBatch.status === 'running' && activeZipBatch.completedIds.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void onDownloadZip(activeZipBatch.completedIds, collection.title)}
                  >
                    <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Baixar parcial ({activeZipBatch.completedIds.length})
                  </Button>
                )}

                {activeZipBatch.status === 'completed' && activeZipBatch.completedIds.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="emerald"
                    onClick={() => void onDownloadZip(activeZipBatch.completedIds, collection.title)}
                  >
                    <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Baixar ZIP novamente ({activeZipBatch.completedIds.length})
                  </Button>
                )}

                {activeZipBatch.status === 'running' && onCancelAutoZipBatch && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void onCancelAutoZipBatch()}
                  >
                    <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" aria-hidden="true" />
                    Cancelar lote
                  </Button>
                )}
              </div>
            </div>

            <Progress value={activeZipBatch.overallProgress} />
          </div>
        )}

        {/* Paginated Track List (handles 200+ / 1000+ tracks smoothly) */}
        <div className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)] overflow-hidden">
          {pagedItems.length === 0 ? (
            <div className="p-8 text-center text-sm text-[var(--text-secondary)]">
              {collection.items.length === 0
                ? 'Nenhuma faixa carregada para esta playlist.'
                : 'Nenhuma faixa corresponde ao filtro atual.'}
            </div>
          ) : (
            pagedItems.map((item, idx) => {
              const checked = selectedIds.has(item.id);
              const job = itemJobs[item.id];
              const isInspecting = inspectingId === item.id;
              const displayIndex = item.trackNumber ?? (safePage - 1) * PAGE_SIZE + idx + 1;

              return (
                <div
                  key={item.id}
                  className="flex flex-col gap-3 p-3.5 transition-colors hover:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleSelect(item.id)}
                      aria-label={`Selecionar ${item.title}`}
                      className="h-4 w-4 shrink-0 accent-emerald-500 cursor-pointer"
                    />

                    <span className="hidden w-7 text-center text-xs tabular-nums text-[var(--text-secondary)] sm:inline">
                      {displayIndex}
                    </span>

                    {item.coverUrl ? (
                      <img
                        src={item.coverUrl}
                        alt={item.title}
                        loading="lazy"
                        className="h-11 w-11 shrink-0 rounded-lg object-cover border border-[var(--border-subtle)]"
                      />
                    ) : (
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-muted)]">
                        <FileAudio className="h-5 w-5 text-purple-400 shrink-0" aria-hidden="true" />
                      </div>
                    )}

                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p
                        dir="auto"
                        style={{ unicodeBidi: 'plaintext' }}
                        className="truncate text-sm font-medium"
                      >
                        {item.title}
                      </p>
                      <p
                        dir="auto"
                        style={{ unicodeBidi: 'plaintext' }}
                        className="truncate text-xs text-[var(--text-secondary)]"
                      >
                        {item.artist}
                        {item.durationSeconds ? ` • ${formatDuration(item.durationSeconds)}` : ''}
                        {item.sourceFileName ? ` • Origem: ${item.sourceFileName}` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pl-7 sm:pl-0">
                    {item.downloadEligible &&
                      !job &&
                      onDownloadSingleTrackMp3 && (
                        <Button
                          type="button"
                          size="sm"
                          variant="emerald"
                          onClick={() => void onDownloadSingleTrackMp3(item, bitrate)}
                        >
                          <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          Baixar MP3
                        </Button>
                      )}

                    {item.platform === 'youtube' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isInspecting}
                        onClick={async () => {
                          setInspectingId(item.id);
                          try {
                            await onInspectSingleItem(item);
                          } finally {
                            setInspectingId(null);
                          }
                        }}
                      >
                        {isInspecting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden="true" />
                        ) : (
                          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        )}
                        MP4 / Formatos
                      </Button>
                    )}

                    {job && ['queued', 'downloading', 'converting', 'tagging', 'retrying'].includes(job.status) && (
                      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden="true" />
                        {job.progress}%
                      </span>
                    )}

                    {job?.status === 'completed' && (
                      <a
                        href={getJobDownloadUrl(job.id, job.downloadTicket)}
                        target="_blank"
                        rel="noopener noreferrer"
                        download
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-500 transition-colors"
                      >
                        <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        Baixar novamente
                      </a>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-2 text-xs text-[var(--text-secondary)]">
            <span>
              Página {safePage} de {totalPages} ({filteredItems.length} faixas)
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
                Anterior
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Próxima
                <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
