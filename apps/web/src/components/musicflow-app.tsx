'use client';

import * as React from 'react';
import {
  detectPlatformQuick,
  parseMediaLink,
  sanitizeFilename,
  type AvailableFormatOption,
  type BitrateKbps,
  type CollectionResult,
  type ConversionJob,
  type ConversionJobRequest,
  type MediaItem,
  type PlaylistProgressEvent,
  type SpotifyAuthStatus,
  type UploadMetadata,
} from '@musicflow/shared';
import {
  AlertCircle,
  ClipboardPaste,
  Disc3,
  Download,
  FileAudio,
  Link2,
  Loader2,
  Upload,
  XCircle,
  Youtube,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { CollectionView, type ActiveZipBatchState } from './collection-view';
import { Header } from './header';
import { JobManager, type HistoryRecord } from './job-manager';
import { MediaResultCard } from './media-result-card';
import { ToastStack, type ToastMessage, type ToastType } from './notifications';
import { ServerSettingsDialog } from './server-settings-dialog';
import { UploadConverter } from './upload-converter';
import {
  clearSpotifySession,
  clientFetch,
  getDownloadUrl,
  getEffectiveWorkerUrl,
  getEventSourceUrl,
  getSpotifySessionId,
  isGitHubPagesHost,
  saveSpotifySessionId,
  testWorkerConnection,
} from '@/lib/api-client';

const HISTORY_STORAGE_KEY = 'musicflow-conversion-history-v2';
const ACTIVE_BATCH_STORAGE_KEY = 'musicflow-active-zip-batch-v1';

export function MusicFlowApp() {
  const [linkInput, setLinkInput] = React.useState('');
  const [analyzing, setAnalyzing] = React.useState(false);
  const [loadingProgress, setLoadingProgress] = React.useState<{
    loaded: number;
    total: number;
    stage: string;
  } | null>(null);
  const [analysisError, setAnalysisError] = React.useState<string | null>(null);
  const [collection, setCollection] = React.useState<CollectionResult | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [itemJobs, setItemJobs] = React.useState<Record<string, ConversionJob>>({});
  const [formatJobs, setFormatJobs] = React.useState<Record<string, ConversionJob>>({});
  const [jobs, setJobs] = React.useState<ConversionJob[]>([]);
  const [history, setHistory] = React.useState<HistoryRecord[]>([]);
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);
  const [showUploadDrawer, setShowUploadDrawer] = React.useState(false);
  const [showServerSettings, setShowServerSettings] = React.useState(false);
  const [serverConnected, setServerConnected] = React.useState(false);
  const [spotifyAuth, setSpotifyAuth] = React.useState<SpotifyAuthStatus | null>(null);
  const [zipBatchTarget, setZipBatchTarget] = React.useState<{
    id: string;
    title: string;
    jobIds: string[];
    status: 'running' | 'downloading_zip' | 'completed' | 'cancelled';
  } | null>(null);

  const eventSourcesRef = React.useRef<Map<string, EventSource>>(new Map());
  const analyzeStreamRef = React.useRef<EventSource | null>(null);
  const autoDownloadedIdsRef = React.useRef<Set<string>>(new Set());
  const autoZipTriggeredRef = React.useRef<Set<string>>(new Set());
  const jobFormatKeyRef = React.useRef<Map<string, string>>(new Map());
  const jobItemKeyRef = React.useRef<Map<string, string>>(new Map());
  const lastToastKeyRef = React.useRef<{ key: string; at: number } | null>(null);

  const notify = React.useCallback((type: ToastType, title: string, description?: string) => {
    const dedupeKey = `${type}:${title}:${description ?? ''}`;
    const now = Date.now();
    if (
      lastToastKeyRef.current &&
      lastToastKeyRef.current.key === dedupeKey &&
      now - lastToastKeyRef.current.at < 2500
    ) {
      return;
    }
    lastToastKeyRef.current = { key: dedupeKey, at: now };

    const id = `${now}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-3), { id, type, title, description }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const checkServerStatus = React.useCallback(async () => {
    const workerUrl = getEffectiveWorkerUrl();
    if (workerUrl) {
      const res = await testWorkerConnection();
      setServerConnected(res.ok);
    } else if (typeof window !== 'undefined' && !window.location.hostname.includes('github.io')) {
      setServerConnected(true);
    } else {
      setServerConnected(false);
    }
  }, []);

  const loadSpotifyStatus = React.useCallback((specificSessionId?: string) => {
    const sid = specificSessionId || getSpotifySessionId();
    const query = sid ? `?sessionId=${encodeURIComponent(sid)}` : '';
    clientFetch(`/auth/spotify/status${query}`)
      .then((r) => r.json())
      .then((data: SpotifyAuthStatus) => setSpotifyAuth(data))
      .catch(() => {});
  }, []);

  const handleSpotifyLogin = React.useCallback(async () => {
    const workerUrl = getEffectiveWorkerUrl();
    if (!workerUrl && isGitHubPagesHost()) {
      setShowServerSettings(true);
      notify(
        'info',
        'Configuração do Servidor',
        'Conecte o MusicFlow ao seu Worker (local ou nuvem) para autenticar no Spotify.',
      );
      return;
    }

    try {
      const frontendUrl = window.location.origin + window.location.pathname;
      const res = await clientFetch(
        `/auth/spotify/login?returnTo=${encodeURIComponent(
          window.location.pathname,
        )}&frontendUrl=${encodeURIComponent(frontendUrl)}`,
      );
      const data = await res.json();
      if (res.ok && data.authorizeUrl) {
        window.location.href = data.authorizeUrl;
      } else {
        notify('error', 'Login Spotify', data.error || 'Não foi possível gerar URL de login.');
      }
    } catch {
      notify(
        'error',
        'Login Spotify',
        'Erro de conexão com o Worker. Verifique se o servidor está ativo nas configurações.',
      );
      setShowServerSettings(true);
    }
  }, [notify]);

  const handleSpotifyLogout = React.useCallback(async () => {
    try {
      await clientFetch('/auth/spotify/logout', { method: 'POST' });
    } catch {
      // Ignore
    } finally {
      clearSpotifySession();
      setSpotifyAuth((prev) =>
        prev ? { ...prev, authenticated: false, tokenValid: false, user: undefined } : null,
      );
      notify('info', 'Desconectado do Spotify');
    }
  }, [notify]);

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as HistoryRecord[];
        if (Array.isArray(parsed)) setHistory(parsed);
      }
    } catch {
      // Ignore malformed localStorage
    }

    try {
      const savedBatch = window.localStorage.getItem(ACTIVE_BATCH_STORAGE_KEY);
      if (savedBatch) {
        const parsed = JSON.parse(savedBatch);
        if (parsed?.jobIds?.length > 0 && parsed?.status === 'running') {
          setZipBatchTarget(parsed);
        }
      }
    } catch {
      // Ignore
    }

    const params = new URLSearchParams(window.location.search);
    const spHandoff = params.get('spotifyHandoff') || params.get('handoff');
    if (spHandoff) {
      clientFetch('/auth/spotify/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoff: spHandoff }),
      })
        .then((r) => r.json())
        .then((data: { sessionId?: string; error?: string }) => {
          if (data.sessionId) {
            saveSpotifySessionId(data.sessionId);
            notify('success', 'Spotify conectado', 'Sessão persistente ativa com sucesso!');
            loadSpotifyStatus(data.sessionId);
          } else {
            notify('error', 'Falha no login Spotify', data.error || 'Sessão expirada.');
          }
        })
        .catch(() => {
          notify('error', 'Falha no login Spotify', 'Erro de rede ao validar sessão.');
        })
        .finally(() => {
          window.history.replaceState({}, '', window.location.pathname);
        });
    } else {
      loadSpotifyStatus();
    }

    const spError = params.get('spotifyError');
    if (spError) {
      notify('error', 'Autenticação Spotify', spError);
      window.history.replaceState({}, '', window.location.pathname);
    }

    checkServerStatus();

    const sources = eventSourcesRef.current;
    return () => {
      analyzeStreamRef.current?.close();
      for (const es of sources.values()) {
        es.close();
      }
      sources.clear();
    };
  }, [loadSpotifyStatus, notify]);

  React.useEffect(() => {
    try {
      if (
        zipBatchTarget &&
        (zipBatchTarget.status === 'running' || zipBatchTarget.status === 'downloading_zip')
      ) {
        window.localStorage.setItem(ACTIVE_BATCH_STORAGE_KEY, JSON.stringify(zipBatchTarget));
      } else {
        window.localStorage.removeItem(ACTIVE_BATCH_STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }, [zipBatchTarget]);

  const triggerBrowserDownload = React.useCallback((job: ConversionJob) => {
    if (autoDownloadedIdsRef.current.has(job.id)) return;
    autoDownloadedIdsRef.current.add(job.id);

    const downloadUrl = getDownloadUrl(`/jobs/${encodeURIComponent(job.id)}/download`);

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.setAttribute('download', job.outputFilename || `${job.metadata.title}.${job.outputFormat}`);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
    }, 10_000);
  }, []);

  const recordHistory = React.useCallback((job: ConversionJob) => {
    setHistory((prev) => {
      if (prev.some((h) => h.id === job.id)) return prev;
      const entry: HistoryRecord = {
        id: job.id,
        title: job.metadata.title,
        artist: job.metadata.artist,
        qualityLabel: job.qualityLabel,
        outputFormat: job.outputFormat,
        status: job.status,
        outputSizeBytes: job.outputSizeBytes,
        finishedAt: job.updatedAt,
      };
      const next = [entry, ...prev].slice(0, 40);
      try {
        window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage quota errors
      }
      return next;
    });
  }, []);

  const upsertJob = React.useCallback(
    (updated: ConversionJob, autoDownloadOnComplete: boolean) => {
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === updated.id);
        if (idx === -1) return [updated, ...prev];
        const copy = [...prev];
        copy[idx] = updated;
        return copy;
      });

      const formatKey = jobFormatKeyRef.current.get(updated.id);
      if (formatKey) {
        setFormatJobs((prev) => ({ ...prev, [formatKey]: updated }));
      }

      const itemKey = jobItemKeyRef.current.get(updated.id);
      if (itemKey) {
        setItemJobs((prev) => ({ ...prev, [itemKey]: updated }));
      }

      if (updated.status === 'completed') {
        recordHistory(updated);
        if (autoDownloadOnComplete) {
          triggerBrowserDownload(updated);
        }
        notify('success', 'Download pronto', updated.outputFilename || updated.metadata.title);
      } else if (updated.status === 'failed') {
        notify('error', 'Não foi possível concluir', updated.error || updated.metadata.title);
      }
    },
    [notify, recordHistory, triggerBrowserDownload],
  );

  const watchJobProgress = React.useCallback(
    (jobId: string, autoDownloadOnComplete: boolean) => {
      if (eventSourcesRef.current.has(jobId)) return;

      const es = new EventSource(
        getEventSourceUrl(`/jobs/${encodeURIComponent(jobId)}/events`),
      );
      eventSourcesRef.current.set(jobId, es);

      es.onmessage = (event) => {
        try {
          const job = JSON.parse(event.data) as ConversionJob;
          upsertJob(job, autoDownloadOnComplete);
          if (['completed', 'failed', 'cancelled'].includes(job.status)) {
            es.close();
            eventSourcesRef.current.delete(jobId);
          }
        } catch {
          // Ignore malformed frame
        }
      };

      es.onerror = () => {
        es.close();
        eventSourcesRef.current.delete(jobId);
      };
    },
    [upsertJob],
  );

  const detectedParsed = React.useMemo(() => parseMediaLink(linkInput), [linkInput]);
  const detectedPlatform = React.useMemo(() => detectPlatformQuick(linkInput), [linkInput]);

  const cancelAnalysis = () => {
    analyzeStreamRef.current?.close();
    analyzeStreamRef.current = null;
    setAnalyzing(false);
    setLoadingProgress(null);
  };

  const analyzeUrl = async (rawUrl: string) => {
    setAnalysisError(null);
    const parsed = parseMediaLink(rawUrl);
    if (!parsed.isValid) {
      setAnalysisError(parsed.error || 'Cole um link válido do YouTube, YouTube Music ou Spotify.');
      return;
    }

    const workerUrl = getEffectiveWorkerUrl();
    if (!workerUrl && isGitHubPagesHost()) {
      setShowServerSettings(true);
      notify(
        'info',
        'Configuração do Servidor',
        'Para processar links no GitHub Pages, conecte o site ao seu Worker.',
      );
      return;
    }

    cancelAnalysis();
    setAnalyzing(true);
    setLoadingProgress({ loaded: 0, total: 0, stage: 'Analisando link...' });

    // Use real-time SSE stream for Spotify playlists/albums to show "50 de 213..."
    if (parsed.platform === 'spotify') {
      await new Promise<void>((resolve) => {
        const es = new EventSource(
          getEventSourceUrl('/analyze/stream', { url: rawUrl.trim() }),
        );
        analyzeStreamRef.current = es;

        es.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data) as PlaylistProgressEvent;
            if (payload.type === 'progress') {
              setLoadingProgress({
                loaded: payload.loaded,
                total: payload.total,
                stage: payload.stage,
              });
            } else if (payload.type === 'complete' && payload.collection) {
              setCollection(payload.collection);
              setSelectedIds(new Set(payload.collection.items.map((i) => i.id)));
              es.close();
              analyzeStreamRef.current = null;
              setAnalyzing(false);
              setLoadingProgress(null);
              resolve();
            } else if (payload.type === 'error') {
              setAnalysisError(payload.error || 'Erro ao consultar Spotify.');
              notify('error', 'Falha no Spotify', payload.error || 'Erro ao consultar Spotify.');
              es.close();
              analyzeStreamRef.current = null;
              setAnalyzing(false);
              setLoadingProgress(null);
              resolve();
            }
          } catch {
            // ignore malformed frame
          }
        };

        es.onerror = () => {
          es.close();
          analyzeStreamRef.current = null;
          setAnalyzing(false);
          setLoadingProgress(null);
          setAnalysisError('Conexão interrompida ao consultar Spotify.');
          resolve();
        };
      });
      return;
    }

    try {
      const res = await clientFetch('/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rawUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Não foi possível analisar este link.');
      }

      const result = data as CollectionResult;
      setCollection(result);
      setSelectedIds(new Set(result.items.map((i) => i.id)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao analisar o link.';
      setAnalysisError(msg);
      notify('error', 'Falha ao analisar link', msg);
    } finally {
      setAnalyzing(false);
      setLoadingProgress(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await analyzeUrl(linkInput);
  };

  const handlePasteClipboard = async () => {
    try {
      if (!navigator.clipboard?.readText) {
        notify('warning', 'Acesso à área de transferência indisponível', 'Cole usando Ctrl+V.');
        return;
      }
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setLinkInput(text.trim());
        setAnalysisError(null);
      } else {
        notify('info', 'Área de transferência vazia');
      }
    } catch {
      notify('warning', 'Permissão negada', 'Use Ctrl+V para colar o link.');
    }
  };

  const startJob = async (
    req: ConversionJobRequest,
    options: { formatKey?: string; itemId?: string; autoDownload: boolean },
  ) => {
    const res = await clientFetch('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Não foi possível iniciar o download.');
    }
    const created = data as ConversionJob;
    if (options.formatKey) jobFormatKeyRef.current.set(created.id, options.formatKey);
    if (options.itemId) jobItemKeyRef.current.set(created.id, options.itemId);

    upsertJob(created, options.autoDownload);
    watchJobProgress(created.id, options.autoDownload);
  };

  const handleDownloadSingleFormat = async (
    item: MediaItem,
    fmt: AvailableFormatOption,
    userConfirmed: boolean,
  ) => {
    const formatKey = `${item.id}:${fmt.id}`;
    const isSpotifyLookup = item.platform === 'spotify' && !item.uploadId;
    try {
      await startJob(
        {
          sourceType: item.uploadId
            ? 'upload'
            : isSpotifyLookup
              ? 'spotify_track'
              : item.platform === 'youtube'
                ? 'youtube'
                : 'authorized_url',
          outputFormat: fmt.format,
          youtubeVideoId: item.platform === 'youtube' ? item.externalId : undefined,
          searchQuery: isSpotifyLookup ? `${item.artist} - ${item.title}` : undefined,
          uploadId: item.uploadId,
          authorizedAudioUrl: item.authorizedAudioUrl,
          videoItag: fmt.videoItag,
          audioItag: fmt.audioItag,
          qualityLabel: fmt.qualityLabel,
          userConfirmedAuthorization: userConfirmed,
          bitrate: fmt.bitrateKbps ?? 192,
          durationHintSeconds: item.durationSeconds,
          metadata: {
            title: item.title,
            artist: item.artist,
            album: item.album,
            trackNumber: item.trackNumber,
            coverUrl: item.coverUrl,
          },
        },
        { formatKey, itemId: item.id, autoDownload: true },
      );
    } catch (err) {
      notify(
        'error',
        'Erro ao iniciar download',
        err instanceof Error ? err.message : 'Tente novamente.',
      );
    }
  };

  const handleAttachUploadToItem = (itemId: string, uploadMeta: UploadMetadata) => {
    setCollection((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((item) =>
          item.id === itemId
            ? {
                ...item,
                uploadId: uploadMeta.uploadId,
                sourceFileName: uploadMeta.originalName,
                sourceOrigin: 'user_upload',
                durationSeconds: item.durationSeconds ?? uploadMeta.durationSeconds,
                downloadEligible: true,
                eligibilityReason: 'Áudio local vinculado e pronto para gerar MP3.',
              }
            : item,
        ),
      };
    });
  };

  const handleImportTrackList = (importedItems: MediaItem[], importedTitle?: string) => {
    setCollection((prev) => ({
      platform: 'spotify',
      resourceType: 'playlist',
      canonicalUrl: prev?.canonicalUrl || 'https://open.spotify.com/',
      title: importedTitle || prev?.title || 'Lista importada',
      subtitle: prev?.subtitle || 'Lista importada pelo usuário',
      coverUrl: prev?.coverUrl,
      totalTracks: importedItems.length,
      knownTotalTracks: importedItems.length,
      loadedTracks: importedItems.length,
      accessStatus: 'full',
      apiMode: 'direct_source',
      legalNotice:
        'Lista importada localmente. Vincule os arquivos de áudio correspondentes para converter em MP3 com tags ID3 e gerar ZIP.',
      items: importedItems,
    }));
    setSelectedIds(new Set(importedItems.map((i) => i.id)));
  };

  const handleDownloadSingleTrackMp3 = async (item: MediaItem, bitrate: BitrateKbps) => {
    const isSpotifyLookup = item.platform === 'spotify' && !item.uploadId;
    try {
      await startJob(
        {
          sourceType: item.uploadId
            ? 'upload'
            : isSpotifyLookup
              ? 'spotify_track'
              : item.platform === 'youtube'
                ? 'youtube'
                : 'authorized_url',
          outputFormat: 'mp3',
          uploadId: item.uploadId,
          youtubeVideoId: item.platform === 'youtube' && !item.uploadId ? item.externalId : undefined,
          searchQuery: isSpotifyLookup ? `${item.artist} - ${item.title}` : undefined,
          authorizedAudioUrl: item.authorizedAudioUrl,
          qualityLabel: `${bitrate} kbps`,
          userConfirmedAuthorization: true,
          bitrate,
          durationHintSeconds: item.durationSeconds,
          metadata: {
            title: item.title,
            artist: item.artist,
            album: item.album,
            trackNumber: item.trackNumber,
            coverUrl: item.coverUrl,
          },
        },
        { itemId: item.id, autoDownload: true },
      );
    } catch (err) {
      notify(
        'error',
        `Erro em "${item.title}"`,
        err instanceof Error ? err.message : 'Falha ao iniciar download.',
      );
    }
  };

  const handleDownloadZip = React.useCallback(
    async (jobIds: string[], zipName?: string) => {
      if (jobIds.length === 0) return;
      try {
        const res = await clientFetch('/jobs/zip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobIds, zipName }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Falha ao gerar ZIP.' }));
          throw new Error(err.error);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${sanitizeFilename(zipName || 'musicflow-playlist', 'musicflow-playlist')}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        notify('success', 'ZIP baixado!', `${jobIds.length} música(s) incluída(s) no ZIP.`);
      } catch (err) {
        notify(
          'error',
          'Erro ao baixar ZIP',
          err instanceof Error ? err.message : 'Tente novamente.',
        );
      }
    },
    [notify],
  );

  // Single lightweight batch poller (prevents HTTP/1.1 6-socket EventSource exhaustion on 200+ track playlists)
  React.useEffect(() => {
    const hasActiveBatch = zipBatchTarget?.status === 'running';
    if (!hasActiveBatch) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await clientFetch('/jobs', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { jobs: ConversionJob[] };
        if (cancelled || !Array.isArray(data.jobs)) return;

        const byId = new Map<string, ConversionJob>();
        for (const j of data.jobs) {
          byId.set(j.id, j);
          if (j.status === 'completed') {
            recordHistory(j);
          }
        }

        setJobs((prev) => {
          const merged = new Map(prev.map((j) => [j.id, j]));
          for (const j of data.jobs) merged.set(j.id, j);
          return Array.from(merged.values()).sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          );
        });

        setItemJobs((prev) => {
          const next = { ...prev };
          for (const [jobId, itemKey] of jobItemKeyRef.current.entries()) {
            const updated = byId.get(jobId);
            if (updated) next[itemKey] = updated;
          }
          return next;
        });

        if (zipBatchTarget && zipBatchTarget.status === 'running') {
          const tracked = zipBatchTarget.jobIds
            .map((id) => byId.get(id))
            .filter((j): j is ConversionJob => Boolean(j));

          if (tracked.length === zipBatchTarget.jobIds.length) {
            const allFinished = tracked.every((j) =>
              ['completed', 'failed', 'cancelled'].includes(j.status),
            );
            if (allFinished && !autoZipTriggeredRef.current.has(zipBatchTarget.id)) {
              autoZipTriggeredRef.current.add(zipBatchTarget.id);
              const completedIds = tracked
                .filter((j) => j.status === 'completed')
                .map((j) => j.id);

              if (completedIds.length > 0) {
                setZipBatchTarget((prev) =>
                  prev ? { ...prev, status: 'downloading_zip' } : null,
                );
                await handleDownloadZip(completedIds, zipBatchTarget.title);
              }
              setZipBatchTarget((prev) =>
                prev ? { ...prev, status: 'completed' } : null,
              );
            }
          }
        }
      } catch {
        // Ignore transient poll error
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1200);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [handleDownloadZip, recordHistory, zipBatchTarget]);

  const activeZipBatch: ActiveZipBatchState | null = React.useMemo(() => {
    if (!zipBatchTarget) return null;
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const tracked = zipBatchTarget.jobIds.map((id) => byId.get(id));
    const completedIds = tracked
      .filter((j): j is ConversionJob => Boolean(j && j.status === 'completed'))
      .map((j) => j.id);
    const failedCount = tracked.filter(
      (j) => j && (j.status === 'failed' || j.status === 'cancelled'),
    ).length;
    const activeCount = Math.max(0, zipBatchTarget.jobIds.length - completedIds.length - failedCount);
    const sumProgress = tracked.reduce((acc, j) => {
      if (!j) return acc;
      if (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') return acc + 100;
      return acc + j.progress;
    }, 0);
    const overallProgress =
      zipBatchTarget.jobIds.length > 0
        ? Math.round(sumProgress / zipBatchTarget.jobIds.length)
        : 0;

    return {
      title: zipBatchTarget.title,
      totalCount: zipBatchTarget.jobIds.length,
      completedIds,
      failedCount,
      activeCount,
      overallProgress,
      status: zipBatchTarget.status,
    };
  }, [jobs, zipBatchTarget]);

  const handleStartAutoZipBatch = async (
    items: MediaItem[],
    bitrate: BitrateKbps,
    zipName: string,
  ) => {
    if (items.length === 0) return;

    const alreadyCompletedJobIds: string[] = [];
    const itemsToEnqueue: MediaItem[] = [];

    for (const item of items) {
      const existing = itemJobs[item.id];
      if (existing && existing.status === 'completed' && existing.bitrate === bitrate) {
        alreadyCompletedJobIds.push(existing.id);
      } else {
        itemsToEnqueue.push(item);
      }
    }

    // If every selected track is already converted, download the ZIP immediately!
    if (itemsToEnqueue.length === 0 && alreadyCompletedJobIds.length > 0) {
      await handleDownloadZip(alreadyCompletedJobIds, zipName);
      return;
    }

    try {
      const batchRequests: ConversionJobRequest[] = itemsToEnqueue.map((item) => {
        const isSpotifyLookup = item.platform === 'spotify' && !item.uploadId;
        return {
          sourceType: item.uploadId
            ? 'upload'
            : isSpotifyLookup
              ? 'spotify_track'
              : item.platform === 'youtube'
                ? 'youtube'
                : 'authorized_url',
          outputFormat: 'mp3',
          uploadId: item.uploadId,
          youtubeVideoId: item.platform === 'youtube' && !item.uploadId ? item.externalId : undefined,
          searchQuery: isSpotifyLookup ? `${item.artist} - ${item.title}` : undefined,
          authorizedAudioUrl: item.authorizedAudioUrl,
          qualityLabel: `${bitrate} kbps`,
          userConfirmedAuthorization: true,
          bitrate,
          durationHintSeconds: item.durationSeconds,
          metadata: {
            title: item.title,
            artist: item.artist,
            album: item.album,
            trackNumber: item.trackNumber,
            coverUrl: item.coverUrl,
          },
        };
      });

      const res = await clientFetch('/jobs/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobs: batchRequests }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao iniciar lote do ZIP.');
      }

      const createdJobs = (data as { jobs: ConversionJob[] }).jobs;
      createdJobs.forEach((created, idx) => {
        const targetItem = itemsToEnqueue[idx];
        if (targetItem) {
          jobItemKeyRef.current.set(created.id, targetItem.id);
        }
      });

      setJobs((prev) => [...createdJobs, ...prev]);
      setItemJobs((prev) => {
        const next = { ...prev };
        createdJobs.forEach((created, idx) => {
          const targetItem = itemsToEnqueue[idx];
          if (targetItem) next[targetItem.id] = created;
        });
        return next;
      });

      const allBatchJobIds = [...alreadyCompletedJobIds, ...createdJobs.map((j) => j.id)];
      setZipBatchTarget({
        id: `batch-${Date.now()}`,
        title: zipName,
        jobIds: allBatchJobIds,
        status: 'running',
      });

      notify(
        'info',
        'Preparando ZIP automático',
        `Convertendo ${itemsToEnqueue.length} música(s). O ZIP baixará sozinho assim que terminar!`,
      );
    } catch (err) {
      notify(
        'error',
        'Erro ao iniciar ZIP',
        err instanceof Error ? err.message : 'Tente novamente.',
      );
    }
  };

  const handleCancelAutoZipBatch = async () => {
    if (!zipBatchTarget) return;
    const ids = zipBatchTarget.jobIds;
    setZipBatchTarget((prev) => (prev ? { ...prev, status: 'cancelled' } : null));
    try {
      await clientFetch('/jobs/cancel-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds: ids }),
      });
      notify('info', 'Lote ZIP cancelado');
    } catch {
      notify('error', 'Erro ao cancelar lote');
    }
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      const res = await clientFetch(`/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        upsertJob(data as ConversionJob, false);
        notify('info', 'Download cancelado');
      }
    } catch {
      notify('error', 'Não foi possível cancelar');
    }
  };

  const handleRetryJob = async (jobId: string) => {
    try {
      const res = await clientFetch(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const job = data as ConversionJob;
        upsertJob(job, false);
        watchJobProgress(job.id, false);
        notify('info', 'Tarefa reprocessada');
      }
    } catch {
      notify('error', 'Não foi possível reprocessar');
    }
  };

  const isSingleMediaWithFormats =
    collection &&
    collection.items.length === 1 &&
    (collection.items[0]?.availableFormats?.length ?? 0) > 0;

  const platformBadgeLabel =
    detectedPlatform === 'spotify'
      ? 'Spotify'
      : detectedPlatform === 'youtube'
        ? detectedParsed.resourceType === 'shorts'
          ? 'Shorts'
          : detectedParsed.resourceType?.startsWith('music')
            ? 'YouTube Music'
            : 'YouTube'
        : detectedPlatform === 'authorized_url'
          ? 'Link direto'
          : null;

  return (
    <div className="min-h-screen hero-glow">
      <Header
        showUploadDrawer={showUploadDrawer}
        onToggleUploadDrawer={() => setShowUploadDrawer((v) => !v)}
        spotifyAuth={spotifyAuth}
        onSpotifyLogin={handleSpotifyLogin}
        onSpotifyLogout={handleSpotifyLogout}
        serverConnected={serverConnected}
        onOpenServerSettings={() => setShowServerSettings(true)}
      />

      {isGitHubPagesHost() && !serverConnected && (
        <div className="bg-gradient-to-r from-emerald-950/80 via-slate-900 to-purple-950/70 border-b border-emerald-500/20 px-4 py-2 text-xs text-emerald-200">
          <div className="mx-auto max-w-5xl flex flex-wrap items-center justify-between gap-2">
            <span>
              💡 <strong>Modo GitHub Pages:</strong> Conecte o frontend ao seu Worker (local no PC ou na nuvem) para realizar conversões e login do Spotify.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowServerSettings(true)}
              className="h-6 text-[11px] shrink-0 border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
            >
              Conectar Servidor
            </Button>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6 sm:py-12">
        {/* YTSave-style Centered Hero */}
        <section className="mx-auto max-w-3xl text-center space-y-5">
          <h1 className="bg-gradient-to-r from-[var(--text-primary)] via-emerald-300 to-purple-300 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent sm:text-5xl">
            MusicFlow Downloader
          </h1>

          <p className="mx-auto max-w-xl text-sm text-[var(--text-secondary)] sm:text-base">
            Baixe músicas e vídeos autorizados do YouTube, YouTube Music e organize playlists do Spotify em MP3 ou MP4.
          </p>

          {/* Non-overlapping Flex URL Bar */}
          <Card className="border-emerald-500/30 shadow-2xl shadow-emerald-950/20">
            <CardContent className="p-2.5 sm:p-3.5 space-y-2.5">
              <form onSubmit={handleSubmit} className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                <div className="flex h-12 flex-1 min-w-0 items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-muted)] px-3 focus-within:ring-2 focus-within:ring-emerald-500/60 transition-all">
                  <Link2
                    className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
                    aria-hidden="true"
                  />
                  <input
                    value={linkInput}
                    onChange={(e) => {
                      setLinkInput(e.target.value);
                      if (analysisError) setAnalysisError(null);
                    }}
                    placeholder="Cole o link do YouTube, YouTube Music ou Spotify..."
                    aria-label="Cole o link do YouTube, YouTube Music ou Spotify"
                    className="h-full flex-1 min-w-0 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none sm:text-base"
                  />

                  {platformBadgeLabel && (
                    <Badge
                      variant={
                        detectedPlatform === 'spotify'
                          ? 'spotify'
                          : detectedPlatform === 'youtube'
                            ? 'youtube'
                            : 'success'
                      }
                      className="hidden sm:inline-flex shrink-0"
                    >
                      {detectedPlatform === 'spotify' ? (
                        <Disc3 className="h-3 w-3 shrink-0" aria-hidden="true" />
                      ) : detectedPlatform === 'youtube' ? (
                        <Youtube className="h-3 w-3 shrink-0" aria-hidden="true" />
                      ) : (
                        <FileAudio className="h-3 w-3 shrink-0" aria-hidden="true" />
                      )}
                      {platformBadgeLabel}
                    </Badge>
                  )}

                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={handlePasteClipboard}
                    className="h-8 shrink-0 px-2.5 text-xs"
                  >
                    <ClipboardPaste className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Colar
                  </Button>
                </div>

                <Button
                  type="submit"
                  size="lg"
                  variant="emerald"
                  disabled={analyzing}
                  className="h-12 shrink-0 px-7 text-base font-semibold"
                >
                  {analyzing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
                      Analisando...
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                      Baixar
                    </>
                  )}
                </Button>
              </form>

              {analyzing && loadingProgress && (
                <div className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-muted)]/60 p-3 text-left">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-emerald-400">{loadingProgress.stage}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={cancelAnalysis}
                      className="h-6 px-2 text-xs text-red-400"
                    >
                      <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      Cancelar
                    </Button>
                  </div>
                  {loadingProgress.total > 0 && (
                    <Progress
                      value={Math.round((loadingProgress.loaded / loadingProgress.total) * 100)}
                    />
                  )}
                </div>
              )}

              {analysisError && (
                <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-left text-xs text-red-300">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{analysisError}</span>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-[var(--text-secondary)]">
            <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1">
              YouTube &amp; Shorts
            </span>
            <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1">
              YouTube Music
            </span>
            <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1">
              Playlists
            </span>
            <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1">
              Spotify (listas e tags)
            </span>
          </div>
        </section>

        {/* Result Panel */}
        {isSingleMediaWithFormats && collection.items[0] && (
          <MediaResultCard
            item={collection.items[0]}
            formatJobs={formatJobs}
            onDownloadFormat={handleDownloadSingleFormat}
            onCancelJob={handleCancelJob}
          />
        )}

        {collection && !isSingleMediaWithFormats && (
          <CollectionView
            collection={collection}
            selectedIds={selectedIds}
            onToggleSelect={(id) =>
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onSelectAllVisible={(visibleIds) => setSelectedIds(new Set(visibleIds))}
            onClearAllSelection={() => setSelectedIds(new Set())}
            onAttachFileToItem={handleAttachUploadToItem}
            onImportTrackList={handleImportTrackList}
            onStartAutoZipBatch={handleStartAutoZipBatch}
            onCancelAutoZipBatch={handleCancelAutoZipBatch}
            activeZipBatch={activeZipBatch}
            onDownloadSingleTrackMp3={handleDownloadSingleTrackMp3}
            onInspectSingleItem={async (item) => {
              setLinkInput(item.canonicalUrl);
              await analyzeUrl(item.canonicalUrl);
            }}
            itemJobs={itemJobs}
            onDownloadZip={handleDownloadZip}
            onNotify={notify}
          />
        )}

        {/* Active downloads & recent history */}
        <JobManager
          jobs={jobs}
          history={history}
          onCancelJob={handleCancelJob}
          onRetryJob={handleRetryJob}
          onDownloadZip={handleDownloadZip}
          onClearHistory={() => {
            setHistory([]);
            window.localStorage.removeItem(HISTORY_STORAGE_KEY);
            notify('info', 'Histórico limpo');
          }}
        />

        {/* Secondary Local File Converter */}
        <section className="pt-2 text-center">
          {!showUploadDrawer ? (
            <button
              type="button"
              onClick={() => setShowUploadDrawer(true)}
              className="inline-flex items-center gap-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline-offset-4 hover:underline cursor-pointer"
            >
              <Upload className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Tem um arquivo no computador? Converter áudio ou vídeo local para MP3
            </button>
          ) : (
            <div className="text-left space-y-3">
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowUploadDrawer(false)}
                >
                  Ocultar conversor local
                </Button>
              </div>
              <UploadConverter
                onStartConversion={async (req) => {
                  try {
                    await startJob(req, { autoDownload: true });
                    notify('info', 'Conversão iniciada', 'O download começará ao finalizar.');
                  } catch (err) {
                    notify(
                      'error',
                      'Falha ao converter arquivo',
                      err instanceof Error ? err.message : 'Tente novamente.',
                    );
                  }
                }}
                onNotify={notify}
              />
            </div>
          )}
        </section>
      </main>

      <ServerSettingsDialog
        isOpen={showServerSettings}
        onClose={() => setShowServerSettings(false)}
        onSaved={() => {
          checkServerStatus();
          loadSpotifyStatus();
        }}
      />

      <ToastStack
        toasts={toasts}
        onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))}
      />
    </div>
  );
}
