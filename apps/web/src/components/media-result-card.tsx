'use client';

import * as React from 'react';
import type { AvailableFormatOption, ConversionJob, MediaItem } from '@musicflow/shared';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Film,
  Loader2,
  Music,
  ShieldAlert,
  User,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatBytes, formatDuration } from '@/lib/format';
import { getDownloadUrl } from '@/lib/api-client';

interface MediaResultCardProps {
  item: MediaItem;
  formatJobs: Record<string, ConversionJob>;
  onDownloadFormat: (
    item: MediaItem,
    formatOption: AvailableFormatOption,
    userConfirmed: boolean,
  ) => Promise<void>;
  onCancelJob: (jobId: string) => Promise<void>;
}

export function MediaResultCard({
  item,
  formatJobs,
  onDownloadFormat,
  onCancelJob,
}: MediaResultCardProps) {
  const formats = item.availableFormats ?? [];
  const audioFormats = formats.filter((f) => f.format === 'mp3');
  const videoFormats = formats.filter((f) => f.format === 'mp4');

  const triggerDownload = async (fmt: AvailableFormatOption) => {
    await onDownloadFormat(item, fmt, true);
  };

  return (
    <Card className="overflow-hidden border-emerald-500/20 shadow-xl">
      <CardContent className="p-4 sm:p-6">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-[280px_minmax(0,1fr)] md:gap-6">
          {/* Preview Column */}
          <div className="min-w-0 space-y-3">
            <div className="relative overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-black/40 aspect-video">
              {item.coverUrl ? (
                <img
                  src={item.coverUrl}
                  alt={item.title}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Music className="h-10 w-10 text-emerald-400" aria-hidden="true" />
                </div>
              )}
              {item.durationSeconds && (
                <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md bg-black/80 px-2 py-0.5 text-xs font-medium text-white">
                  <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                  {formatDuration(item.durationSeconds)}
                </span>
              )}
            </div>

            <div className="space-y-1.5">
              <h2 className="text-base font-semibold leading-snug">{item.title}</h2>
              <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                <User className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{item.channelName || item.artist}</span>
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Badge variant={item.licenseType === 'creative_commons' ? 'success' : 'neutral'}>
                  {item.licenseType === 'creative_commons'
                    ? 'Creative Commons'
                    : item.licenseNote || 'Mídia identificada'}
                </Badge>
              </div>
            </div>
          </div>

          {/* Formats Column */}
          <div className="min-w-0 space-y-4">
            {!item.downloadEligible ? (
              <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
                <div className="space-y-1">
                  <p className="font-medium text-amber-300">Download direto indisponível</p>
                  <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                    {item.eligibilityReason}
                  </p>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
                  <table className="w-full text-left text-xs sm:text-sm">
                    <thead className="bg-[var(--bg-muted)]/80 text-[11px] sm:text-xs uppercase text-[var(--text-secondary)]">
                      <tr>
                        <th className="px-3 py-2.5 sm:px-4 font-medium">Formato</th>
                        <th className="px-3 py-2.5 sm:px-4 font-medium">Qualidade</th>
                        <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Tamanho</th>
                        <th className="px-3 py-2.5 sm:px-4 text-right font-medium">Ação</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-subtle)]">
                      {[...audioFormats, ...videoFormats].map((fmt) => {
                        const jobKey = `${item.id}:${fmt.id}`;
                        const job = formatJobs[jobKey];
                        const isActive =
                          job &&
                          ['queued', 'downloading', 'converting', 'tagging', 'retrying'].includes(
                            job.status,
                          );

                        return (
                          <React.Fragment key={fmt.id}>
                            <tr className="hover:bg-white/[0.02] transition-colors">
                              <td className="px-3 py-2.5 sm:px-4 sm:py-3 font-medium">
                                <span className="inline-flex items-center gap-1.5">
                                  {fmt.format === 'mp3' ? (
                                    <Music className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
                                  ) : (
                                    <Film className="h-4 w-4 shrink-0 text-purple-400" aria-hidden="true" />
                                  )}
                                  {fmt.containerLabel}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 sm:px-4 sm:py-3">
                                <div className="flex flex-col">
                                  <span>{fmt.qualityLabel}</span>
                                  {fmt.note && (
                                    <span className="text-[11px] text-[var(--text-secondary)]">
                                      {fmt.note}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="hidden px-4 py-3 text-xs text-[var(--text-secondary)] sm:table-cell">
                                {fmt.estimatedSizeBytes ? `~${formatBytes(fmt.estimatedSizeBytes)}` : '—'}
                              </td>
                              <td className="px-3 py-2.5 sm:px-4 sm:py-3 text-right">
                                {isActive ? (
                                  <div className="inline-flex items-center gap-2">
                                    <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                                      <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden="true" />
                                      {job.progress}%
                                    </span>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => onCancelJob(job.id)}
                                      aria-label="Cancelar download"
                                    >
                                      <XCircle className="h-4 w-4 text-red-400 shrink-0" aria-hidden="true" />
                                    </Button>
                                  </div>
                                ) : job?.status === 'completed' ? (
                                  <a
                                    href={getDownloadUrl(`/jobs/${encodeURIComponent(job.id)}/download`)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    download
                                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-500 transition-colors"
                                  >
                                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    Baixar novamente
                                  </a>
                                ) : (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="emerald"
                                    onClick={() => void triggerDownload(fmt)}
                                  >
                                    <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    Baixar
                                  </Button>
                                )}
                              </td>
                            </tr>
                            {(isActive || job?.status === 'failed') && (
                              <tr className="bg-[var(--bg-muted)]/35">
                                <td colSpan={4} className="px-4 py-2">
                                  {isActive && (
                                    <div className="space-y-1">
                                      <div className="flex justify-between text-[11px] text-[var(--text-secondary)]">
                                        <span>{job.stageLabel}</span>
                                        <span>{job.progress}%</span>
                                      </div>
                                      <Progress value={job.progress} />
                                    </div>
                                  )}
                                  {job?.status === 'failed' && (
                                    <div className="flex items-center gap-1.5 text-xs text-red-400">
                                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                      <span>{job.error || 'Erro ao processar arquivo.'}</span>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
