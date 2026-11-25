'use client';

import * as React from 'react';
import {
  ALLOWED_BITRATES,
  getBitrateHonestNote,
  type BitrateKbps,
  type ConversionJobRequest,
  type UploadMetadata,
} from '@musicflow/shared';
import { FileAudio, Info, Sparkles, UploadCloud } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatBytes, formatDuration } from '@/lib/format';
import { clientFetch } from '@/lib/api-client';
import type { ToastType } from './notifications';

interface UploadConverterProps {
  onStartConversion: (req: ConversionJobRequest) => Promise<void>;
  onNotify: (type: ToastType, title: string, description?: string) => void;
}

export function UploadConverter({ onStartConversion, onNotify }: UploadConverterProps) {
  const [dragActive, setDragActive] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [uploadMeta, setUploadMeta] = React.useState<UploadMetadata | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [isVideoFile, setIsVideoFile] = React.useState(false);

  const [title, setTitle] = React.useState('');
  const [artist, setArtist] = React.useState('');
  const [album, setAlbum] = React.useState('');
  const [coverUrl, setCoverUrl] = React.useState('');
  const [bitrate, setBitrate] = React.useState<BitrateKbps>(192);
  const [confirmed, setConfirmed] = React.useState(false);

  React.useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await clientFetch('/uploads', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao enviar arquivo.');
      }

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const localUrl = URL.createObjectURL(file);
      setPreviewUrl(localUrl);
      setIsVideoFile(file.type.startsWith('video/') || /\.(mp4|webm)$/i.test(file.name));

      const meta = data as UploadMetadata;
      setUploadMeta(meta);

      const baseName = file.name.replace(/\.[^.]+$/, '');
      const parts = baseName.split(' - ');
      if (parts.length >= 2) {
        setArtist(parts[0].trim());
        setTitle(parts.slice(1).join(' - ').trim());
      } else {
        setTitle(baseName);
        setArtist('Artista Independente');
      }

      onNotify(
        'success',
        'Arquivo validado e pronto',
        `${meta.originalName} (${formatDuration(meta.durationSeconds)})`,
      );
    } catch (err) {
      onNotify(
        'error',
        'Falha no upload',
        err instanceof Error ? err.message : 'Erro desconhecido.',
      );
    } finally {
      setUploading(false);
    }
  };

  const handleConvert = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadMeta) return;
    if (!confirmed) {
      onNotify('warning', 'Confirme a autorização', 'Marque a declaração de titularidade ou autorização.');
      return;
    }

    setSubmitting(true);
    try {
      await onStartConversion({
        sourceType: 'upload',
        uploadId: uploadMeta.uploadId,
        userConfirmedAuthorization: confirmed,
        bitrate,
        durationHintSeconds: uploadMeta.durationSeconds,
        metadata: {
          title: title.trim() || uploadMeta.originalName,
          artist: artist.trim() || 'Artista',
          album: album.trim() || undefined,
          coverUrl: coverUrl.trim() || undefined,
        },
      });
    } finally {
      setSubmitting(false);
    }
  };

  const bitrateHint = getBitrateHonestNote(bitrate, uploadMeta?.sourceBitrateKbps);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <FileAudio className="h-5 w-5 text-emerald-400" />
          Converter arquivo próprio ou licenciado para MP3
        </CardTitle>
        <CardDescription>
          Envie MP4, WAV, FLAC, M4A, OGG, AAC, WebM ou MP3 com pré-visualização e tags ID3 personalizadas — sem
          marca-d’água ou anúncios.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handleFile(file);
          }}
          className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-6 text-center transition-all cursor-pointer ${
            dragActive
              ? 'border-purple-400 bg-purple-500/10'
              : 'border-[var(--border-subtle)] bg-[var(--bg-muted)]/40 hover:border-purple-500/50'
          }`}
        >
          <UploadCloud className="h-8 w-8 text-purple-400" />
          <div className="text-sm font-medium">
            {uploading
              ? 'Validando assinatura e inspecionando áudio...'
              : 'Arraste seu arquivo aqui ou clique para selecionar'}
          </div>
          <p className="text-xs text-[var(--text-secondary)]">
            Formatos compatíveis: MP4, WAV, FLAC, M4A, OGG, AAC, WebM, MP3
          </p>
          <input
            type="file"
            accept=".mp4,.wav,.flac,.m4a,.ogg,.aac,.webm,.mp3"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleFile(file);
            }}
          />
        </label>

        {uploadMeta && (
          <form onSubmit={handleConvert} className="space-y-4">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-muted)]/60 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium truncate">{uploadMeta.originalName}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="neutral">{formatBytes(uploadMeta.sizeBytes)}</Badge>
                  <Badge variant="neutral">{formatDuration(uploadMeta.durationSeconds)}</Badge>
                  {uploadMeta.codec && <Badge variant="youtube">{uploadMeta.codec.toUpperCase()}</Badge>}
                  {uploadMeta.sourceBitrateKbps && (
                    <Badge variant="spotify">Fonte ~{uploadMeta.sourceBitrateKbps} kbps</Badge>
                  )}
                </div>
              </div>

              {previewUrl && (
                <div>
                  <p className="mb-1.5 text-xs text-[var(--text-secondary)]">
                    Pré-visualização do arquivo enviado:
                  </p>
                  {isVideoFile ? (
                    <video src={previewUrl} controls className="max-h-44 w-full rounded-lg bg-black" />
                  ) : (
                    <audio src={previewUrl} controls className="w-full" />
                  )}
                </div>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                  Título (ID3) *
                </label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                  Artista (ID3) *
                </label>
                <Input value={artist} onChange={(e) => setArtist(e.target.value)} required />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                  Álbum (opcional)
                </label>
                <Input value={album} onChange={(e) => setAlbum(e.target.value)} placeholder="Nome do álbum" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                  Qualidade MP3
                </label>
                <select
                  value={bitrate}
                  onChange={(e) => setBitrate(Number(e.target.value) as BitrateKbps)}
                  className="flex h-11 w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-muted)] px-3 text-sm text-[var(--text-primary)]"
                >
                  {ALLOWED_BITRATES.map((kbps) => (
                    <option key={kbps} value={kbps} className="bg-zinc-900 text-zinc-100">
                      {kbps} kbps
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                URL de capa (opcional, HTTPS)
              </label>
              <Input
                type="url"
                value={coverUrl}
                onChange={(e) => setCoverUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>

            <div className="flex items-start gap-2 rounded-xl border border-purple-500/20 bg-purple-500/10 p-3 text-xs">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-purple-400" />
              <span>{bitrateHint}</span>
            </div>

            <label className="flex items-start gap-2.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-emerald-500"
              />
              <span>
                Declaro que este arquivo é de minha autoria, livre de direitos ou possuo autorização expressa para
                conversão em MP3.
              </span>
            </label>

            <Button type="submit" variant="emerald" disabled={submitting} className="w-full sm:w-auto">
              <Sparkles className="h-4 w-4" />
              {submitting ? 'Enviando para fila...' : 'Converter para MP3'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
