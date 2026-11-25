'use client';

import * as React from 'react';
import type { DiagnosticsSnapshot } from '@musicflow/shared';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Cpu,
  Disc3,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Youtube,
} from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { clientFetch } from '@/lib/api-client';

export default function AdminDiagnosticsPage() {
  const [data, setData] = React.useState<DiagnosticsSnapshot | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [needsSecret, setNeedsSecret] = React.useState(false);
  const [adminSecret, setAdminSecret] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const loadDiagnostics = React.useCallback(async (secretOverride?: string) => {
    setLoading(true);
    setError(null);
    try {
      const headers: Record<string, string> = {};
      const key = secretOverride ?? adminSecret;
      if (key) headers['x-admin-secret'] = key;

      const res = await clientFetch('/admin/diagnostics', { headers, cache: 'no-store' });
      if (res.status === 401) {
        setNeedsSecret(true);
        setData(null);
        return;
      }
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Falha ao obter diagnóstico.');
      }
      setNeedsSecret(false);
      setData(json as DiagnosticsSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido.');
    } finally {
      setLoading(false);
    }
  }, [adminSecret]);

  React.useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  return (
    <div className="min-h-screen hero-glow px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 text-xs font-medium hover:border-emerald-500/40"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
              Voltar
            </Link>
            <div>
              <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
                <Activity className="h-5 w-5 text-emerald-400 shrink-0" aria-hidden="true" />
                Painel de Diagnóstico
              </h1>
              <p className="text-xs text-[var(--text-secondary)]">
                Estado operacional das integrações, worker e filas (sem exposição de credenciais)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {data && <Badge variant="neutral">v{data.appVersion}</Badge>}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void loadDiagnostics()}
              disabled={loading}
            >
              <RefreshCw className={`h-3.5 w-3.5 shrink-0 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              Atualizar
            </Button>
          </div>
        </div>

        {needsSecret && (
          <Card className="border-amber-500/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="h-4 w-4 text-amber-400 shrink-0" aria-hidden="true" />
                Acesso protegido
              </CardTitle>
              <CardDescription>
                Informe a chave administrativa (ADMIN_DIAGNOSTICS_SECRET) para visualizar os diagnósticos.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadDiagnostics(adminSecret);
                }}
                className="flex flex-col gap-2 sm:flex-row"
              >
                <Input
                  type="password"
                  value={adminSecret}
                  onChange={(e) => setAdminSecret(e.target.value)}
                  placeholder="Chave administrativa..."
                />
                <Button type="submit" variant="emerald">
                  Desbloquear
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {error && (
          <Card className="border-red-500/30 bg-red-500/10">
            <CardContent className="flex items-center gap-2 p-4 text-sm text-red-300">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              {/* Spotify */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Disc3 className="h-4 w-4 text-emerald-400 shrink-0" aria-hidden="true" />
                    Spotify Web API
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">Client ID configurado:</span>
                    <Badge variant={data.spotify.clientConfigured ? 'success' : 'danger'}>
                      {data.spotify.clientConfigured ? 'Sim' : 'Não'}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">Client Secret (servidor):</span>
                    <Badge variant={data.spotify.hasClientSecret ? 'success' : 'warning'}>
                      {data.spotify.hasClientSecret ? 'Configurado' : 'Pendente'}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">Login do usuário (PKCE):</span>
                    <Badge variant={data.spotify.userAuthenticated ? 'success' : 'neutral'}>
                      {data.spotify.userAuthenticated ? 'Autenticado' : 'Não conectado'}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">Token válido:</span>
                    <span>{data.spotify.userTokenValid ? 'Sim' : 'Não'}</span>
                  </div>
                  {data.spotify.userTokenExpiresAt && (
                    <div className="flex justify-between">
                      <span className="text-[var(--text-secondary)]">Expira em:</span>
                      <span>{new Date(data.spotify.userTokenExpiresAt).toLocaleTimeString('pt-BR')}</span>
                    </div>
                  )}
                  <div className="pt-1">
                    <span className="text-[var(--text-secondary)] block mb-1">Redirect URI:</span>
                    <code className="block rounded bg-[var(--bg-muted)] px-2 py-1 text-[11px] break-all">
                      {data.spotify.redirectUri}
                    </code>
                  </div>
                  <div className="pt-1">
                    <span className="text-[var(--text-secondary)] block mb-1">Permissões (scopes):</span>
                    <div className="flex flex-wrap gap-1">
                      {data.spotify.grantedScopes.map((s) => (
                        <Badge key={s} variant="neutral">{s}</Badge>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Worker & FFmpeg */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Cpu className="h-4 w-4 text-purple-400 shrink-0" aria-hidden="true" />
                    Worker &amp; FFmpeg
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">Status geral:</span>
                    <Badge variant={data.workerStatus === 'ok' ? 'success' : 'warning'}>
                      {data.workerStatus === 'ok' ? 'Saudável' : 'Degradado'}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">FFmpeg / FFprobe:</span>
                    <span>
                      {data.ffmpeg.available && data.ffmpeg.ffprobeAvailable ? 'Disponíveis' : 'Ausente'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">Concorrência / Threads:</span>
                    <span>
                      {data.ffmpeg.concurrency} workers / {data.ffmpeg.threads} threads
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">Latência média Spotify:</span>
                    <span>
                      {data.averageLatencyMs.spotifyApi !== undefined
                        ? `${data.averageLatencyMs.spotifyApi} ms`
                        : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">Latência média YouTube:</span>
                    <span>
                      {data.averageLatencyMs.youtubeProbe !== undefined
                        ? `${data.averageLatencyMs.youtubeProbe} ms`
                        : '—'}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* Queues & YouTube */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Youtube className="h-4 w-4 text-purple-400 shrink-0" aria-hidden="true" />
                    Filas &amp; YouTube
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">YouTube Data API v3 Key:</span>
                    <Badge variant={data.youtube.officialApiKeyConfigured ? 'success' : 'neutral'}>
                      {data.youtube.officialApiKeyConfigured ? 'Configurada' : 'Modo padrão'}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">Extrator yt-dlp + Node JS:</span>
                    <Badge variant={data.youtube.ytDlpAvailable ? 'success' : 'warning'}>
                      {data.youtube.ytDlpAvailable
                        ? `Ativo (${data.youtube.ytDlpVersion || 'ok'})`
                        : 'Fallback'}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-2 text-center">
                    <div className="rounded-lg bg-[var(--bg-muted)] p-2">
                      <p className="text-base font-bold">{data.queues.pending}</p>
                      <p className="text-[10px] text-[var(--text-secondary)]">Pendentes</p>
                    </div>
                    <div className="rounded-lg bg-[var(--bg-muted)] p-2">
                      <p className="text-base font-bold text-purple-400">
                        {data.queues.processing + data.queues.converting}
                      </p>
                      <p className="text-[10px] text-[var(--text-secondary)]">Em curso</p>
                    </div>
                    <div className="rounded-lg bg-[var(--bg-muted)] p-2">
                      <p className="text-base font-bold text-emerald-400">{data.queues.completed}</p>
                      <p className="text-[10px] text-[var(--text-secondary)]">Concluídos</p>
                    </div>
                  </div>
                  <div className="flex justify-between pt-1 text-[var(--text-secondary)]">
                    <span>Falhas: {data.queues.failed}</span>
                    <span>Cancelados: {data.queues.cancelled}</span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Known Limits & Recent HTTP Errors */}
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShieldCheck className="h-4 w-4 text-amber-400 shrink-0" aria-hidden="true" />
                    Limitações Conhecidas (Spotify Development Mode)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 text-xs text-[var(--text-secondary)]">
                    {data.spotify.knownLimits.map((lim) => (
                      <li key={lim} className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                        <span>{lim}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" aria-hidden="true" />
                    Erros HTTP Recentes ({data.recentHttpErrors.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="max-h-60 overflow-y-auto space-y-2 text-xs">
                  {data.recentHttpErrors.length === 0 ? (
                    <p className="text-[var(--text-secondary)]">Nenhum erro HTTP registrado recentemente.</p>
                  ) : (
                    data.recentHttpErrors.map((err, idx) => (
                      <div
                        key={`${err.timestamp}-${idx}`}
                        className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-muted)]/60 p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Badge variant={err.statusCode === 403 ? 'danger' : 'warning'}>
                            {err.source.toUpperCase()} {err.statusCode ? `HTTP ${err.statusCode}` : ''}
                          </Badge>
                          <span className="text-[10px] text-[var(--text-secondary)]">
                            {new Date(err.timestamp).toLocaleTimeString('pt-BR')}
                          </span>
                        </div>
                        <p className="mt-1 text-[var(--text-primary)]">{err.message}</p>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
