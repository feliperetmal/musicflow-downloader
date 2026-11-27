'use client';

import * as React from 'react';
import type { HostedZipResult } from '@musicflow/shared';
import { Check, CloudUpload, Copy, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatBytes, copyTextToClipboard } from '@/lib/format';

interface HostedZipBannerProps {
  hostedZip: HostedZipResult;
  onCopied?: (url: string) => void;
}

export function HostedZipBanner({ hostedZip, onCopied }: HostedZipBannerProps) {
  const [justCopied, setJustCopied] = React.useState(Boolean(hostedZip.copiedToClipboard));

  React.useEffect(() => {
    setJustCopied(Boolean(hostedZip.copiedToClipboard));
  }, [hostedZip.url, hostedZip.copiedToClipboard]);

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(hostedZip.url);
    if (ok) {
      setJustCopied(true);
      onCopied?.(hostedZip.url);
    }
  };

  return (
    <div className="rounded-xl border border-purple-500/35 bg-purple-500/10 p-3.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-purple-200">
          <CloudUpload className="h-4 w-4 shrink-0 text-purple-400" aria-hidden="true" />
          <span>Link público do ZIP pronto ({hostedZip.fileCount} músicas • {formatBytes(hostedZip.sizeBytes)})</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant="neutral">{hostedZip.expiresIn}</Badge>
          {justCopied && (
            <Badge variant="success">
              <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
              Copiado
            </Badge>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={hostedZip.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-muted)]/80 px-2.5 py-1.5 font-mono text-xs text-emerald-300 hover:underline"
        >
          {hostedZip.url}
        </a>

        <Button
          type="button"
          size="sm"
          variant={justCopied ? 'secondary' : 'emerald'}
          onClick={() => void handleCopy()}
        >
          {justCopied ? (
            <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          {justCopied ? 'Copiado!' : 'Copiar link'}
        </Button>

        <a
          href={hostedZip.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 text-xs font-medium hover:border-purple-400/50 transition-colors"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Abrir
        </a>
      </div>
    </div>
  );
}
