'use client';

import * as React from 'react';
import type { ConversionJob, HostedZipResult, JobStatus } from '@musicflow/shared';
import {
  Archive,
  CheckCircle2,
  Clock,
  CloudUpload,
  Download,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatBytes } from '@/lib/format';
import { getJobDownloadUrl } from '@/lib/api-client';
import { HostedZipBanner } from './hosted-zip-banner';

export interface HistoryRecord {
  id: string;
  title: string;
  artist: string;
  qualityLabel: string;
  outputFormat: string;
  status: JobStatus;
  outputSizeBytes?: number;
  finishedAt: string;
}

interface JobManagerProps {
  jobs: ConversionJob[];
  history: HistoryRecord[];
  onCancelJob: (jobId: string) => Promise<void>;
  onRetryJob: (jobId: string) => Promise<void>;
  onDownloadZip: (jobIds: string[]) => Promise<void>;
  uploadingZip?: boolean;
  onUploadZipToCloud?: (jobIds: string[]) => Promise<void>;
  hostedZip?: HostedZipResult | null;
  onLinkCopied?: () => void;
  onClearHistory: () => void;
}

const STATUS_BADGE_MAP: Record<
  JobStatus,
  { label: string; variant: 'neutral' | 'spotify' | 'youtube' | 'success' | 'warning' | 'danger' }
> = {
  queued: { label: 'Pendente', variant: 'neutral' },
  downloading: { label: 'Processando', variant: 'youtube' },
  converting: { label: 'Convertendo', variant: 'youtube' },
  tagging: { label: 'Convertendo', variant: 'youtube' },
  retrying: { label: 'Tentando novamente', variant: 'warning' },
  completed: { label: 'Concluído', variant: 'success' },
  failed: { label: 'Falhou', variant: 'danger' },
  cancelled: { label: 'Cancelado', variant: 'neutral' },
};

export function JobManager({
  jobs,
  history,
  onCancelJob,
  onRetryJob,
  onDownloadZip,
  uploadingZip = false,
  onUploadZipToCloud,
  hostedZip,
  onLinkCopied,
  onClearHistory,
}: JobManagerProps) {
  if (jobs.length === 0 && history.length === 0) {
    return null;
  }

  const completedJobs = jobs.filter((j) => j.status === 'completed');
  const activeCount = jobs.filter((j) =>
    ['queued', 'downloading', 'converting', 'tagging', 'retrying'].includes(j.status),
  ).length;
  const failedCount = jobs.filter((j) => j.status === 'failed').length;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {jobs.length > 0 && (
        <Card className={history.length > 0 ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Loader2 className="h-4 w-4 text-emerald-400 shrink-0" aria-hidden="true" />
                Fila de Downloads
              </CardTitle>
              <CardDescription className="text-xs">
                {completedJobs.length} concluído(s) • {activeCount} em processamento • {failedCount} falha(s)
              </CardDescription>
            </div>

            {completedJobs.length >= 1 && (
              <div className="flex flex-wrap items-center gap-2">
                {completedJobs.length > 1 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="emerald"
                    onClick={() => onDownloadZip(completedJobs.map((j) => j.id))}
                  >
                    <Archive className="h-4 w-4 shrink-0" aria-hidden="true" />
                    Baixar tudo em ZIP ({completedJobs.length})
                  </Button>
                )}

                {onUploadZipToCloud && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={uploadingZip}
                    onClick={() => void onUploadZipToCloud(completedJobs.map((j) => j.id))}
                  >
                    {uploadingZip ? (
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
                    ) : (
                      <CloudUpload className="h-4 w-4 text-purple-400 shrink-0" aria-hidden="true" />
                    )}
                    {uploadingZip ? 'Enviando...' : `Upar ZIP Catbox (${completedJobs.length})`}
                  </Button>
                )}
              </div>
            )}
          </CardHeader>

          <CardContent className="space-y-3">
            {hostedZip && <HostedZipBanner hostedZip={hostedZip} onCopied={onLinkCopied} />}
            {jobs.map((job) => {
              const badge = STATUS_BADGE_MAP[job.status];
              const isActive = ['queued', 'downloading', 'converting', 'tagging', 'retrying'].includes(
                job.status,
              );
              const canRetry = job.status === 'failed' || job.status === 'cancelled';

              return (
                <div
                  key={job.id}
                  className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-muted)]/50 p-3.5 space-y-2"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p
                          dir="auto"
                          style={{ unicodeBidi: 'plaintext' }}
                          className="truncate text-sm font-medium"
                        >
                          {job.metadata.artist} — {job.metadata.title}
                        </p>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        <Badge variant="neutral">
                          {job.outputFormat.toUpperCase()} • {job.qualityLabel}
                        </Badge>
                        {job.attempt > 1 && (
                          <Badge variant="warning">
                            <RefreshCw className="h-3 w-3 shrink-0" aria-hidden="true" />
                            Tentativa {job.attempt}/{job.maxAttempts}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-[var(--text-secondary)]">
                        {job.stageLabel} • {job.progress}%
                        {job.outputSizeBytes ? ` • ${formatBytes(job.outputSizeBytes)}` : ''}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {isActive && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => onCancelJob(job.id)}
                        >
                          <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" aria-hidden="true" />
                          Cancelar
                        </Button>
                      )}
                      {canRetry && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => onRetryJob(job.id)}
                        >
                          <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          Reprocessar
                        </Button>
                      )}
                      {job.status === 'completed' && (
                        <a
                          href={getJobDownloadUrl(job.id, job.downloadTicket)}
                          target="_blank"
                          rel="noopener noreferrer"
                          download
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-500 transition-colors"
                        >
                          <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          Baixar {job.outputFormat.toUpperCase()}
                        </a>
                      )}
                    </div>
                  </div>

                  <Progress value={job.progress} />

                  {job.error && (
                    <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300">
                      {job.error}
                    </p>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {history.length > 0 && (
        <Card className={jobs.length === 0 ? 'lg:col-span-3' : ''}>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4 text-emerald-400 shrink-0" aria-hidden="true" />
                Histórico
              </CardTitle>
              <CardDescription className="text-xs">Downloads recentes neste navegador</CardDescription>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={onClearHistory}>
              <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Limpar
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {history.slice(0, 8).map((item) => (
              <div
                key={`${item.id}-${item.finishedAt}`}
                className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-muted)]/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <p dir="auto" style={{ unicodeBidi: 'plaintext' }} className="truncate text-xs font-medium">
                    {item.title}
                  </p>
                  <p dir="auto" style={{ unicodeBidi: 'plaintext' }} className="truncate text-[11px] text-[var(--text-secondary)]">
                    {item.artist} • {item.outputFormat.toUpperCase()} {item.qualityLabel}
                    {item.outputSizeBytes ? ` • ${formatBytes(item.outputSizeBytes)}` : ''}
                  </p>
                </div>
                {item.status === 'completed' ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
                ) : (
                  <Clock className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
