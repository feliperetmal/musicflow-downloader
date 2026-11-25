'use client';

import * as React from 'react';
import { CheckCircle2, Server, Shield, Sparkles, Wifi, WifiOff, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  clearWorkerConfig,
  getStoredWorkerConfig,
  isGitHubPagesHost,
  setWorkerConfig,
  testWorkerConnection,
} from '@/lib/api-client';

interface ServerSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function ServerSettingsDialog({ isOpen, onClose, onSaved }: ServerSettingsDialogProps) {
  const [workerUrl, setWorkerUrl] = React.useState('');
  const [workerSecret, setWorkerSecret] = React.useState('');
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{
    ok: boolean;
    version?: string;
    error?: string;
  } | null>(null);

  React.useEffect(() => {
    if (isOpen) {
      const stored = getStoredWorkerConfig();
      setWorkerUrl(stored.url);
      setWorkerSecret(stored.secret);
      setTestResult(null);

      // Auto-test if already configured
      if (stored.url) {
        setTesting(true);
        testWorkerConnection(stored.url, stored.secret).then((res) => {
          setTestResult(res);
          setTesting(false);
        });
      }
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testWorkerConnection(workerUrl, workerSecret);
      setTestResult(res);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    setWorkerConfig(workerUrl, workerSecret);
    onSaved();
    onClose();
  };

  const handleClear = () => {
    clearWorkerConfig();
    setWorkerUrl('');
    setWorkerSecret('');
    setTestResult(null);
    onSaved();
  };

  const setLocalhost = () => {
    setWorkerUrl('http://localhost:4000');
    setWorkerSecret('musicflow-local-dev-secret-2026');
    setTestResult(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in">
      <div className="w-full max-w-lg rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-6 shadow-2xl relative text-[var(--text-primary)]">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-white/5 hover:text-[var(--text-primary)] transition-colors"
          aria-label="Fechar"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <Server className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold">Configuração do Servidor (Worker)</h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Conexão com o backend Node.js (FFmpeg, conversão e login Spotify)
            </p>
          </div>
        </div>

        {isGitHubPagesHost() && (
          <div className="mb-4 rounded-xl border border-sky-500/20 bg-sky-500/10 p-3 text-xs text-sky-300">
            <strong>🌐 Modo GitHub Pages:</strong> O site estático precisa do endereço do seu Worker para baixar músicas e autenticar no Spotify. Se o worker estiver rodando no seu computador, clique no botão <strong>Localhost (4000)</strong> abaixo.
          </div>
        )}

        <div className="space-y-4 text-sm">
          <div>
            <label className="block text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-1.5">
              URL do Servidor Worker
            </label>
            <Input
              value={workerUrl}
              onChange={(e) => {
                setWorkerUrl(e.target.value);
                setTestResult(null);
              }}
              placeholder="ex: http://localhost:4000 ou https://seu-worker.onrender.com"
              className="font-mono text-xs"
            />
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={setLocalhost}
                className="h-7 text-xs border-[var(--border-subtle)]"
              >
                <Sparkles className="h-3.5 w-3.5 mr-1 text-emerald-400" />
                Usar Localhost (4000)
              </Button>
              {workerUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClear}
                  className="h-7 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
                >
                  Limpar
                </Button>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-1.5">
              Chave Secreta do Worker (Opcional)
            </label>
            <div className="relative">
              <Input
                type="password"
                value={workerSecret}
                onChange={(e) => {
                  setWorkerSecret(e.target.value);
                  setTestResult(null);
                }}
                placeholder="ex: musicflow-local-dev-secret-2026"
                className="font-mono text-xs pr-8"
              />
              <Shield className="absolute right-2.5 top-2.5 h-4 w-4 text-[var(--text-secondary)] pointer-events-none" />
            </div>
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
              Necessário se a variável WORKER_API_SECRET estiver configurada no servidor.
            </p>
          </div>

          {testResult && (
            <div
              className={`rounded-xl border p-3 text-xs flex items-center gap-2.5 ${
                testResult.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
              }`}
            >
              {testResult.ok ? (
                <>
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                  <div>
                    <strong>Servidor Online!</strong> Conectado com sucesso (v{testResult.version || '3.0.0'}).
                  </div>
                </>
              ) : (
                <>
                  <WifiOff className="h-4 w-4 shrink-0 text-rose-400" />
                  <div>
                    <strong>Falha na conexão:</strong> {testResult.error || 'Servidor inacessível.'}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="pt-2 flex items-center justify-between border-t border-[var(--border-subtle)] gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={testing || !workerUrl}
              className="text-xs h-9"
            >
              {testing ? 'Testando...' : 'Testar Conexão'}
            </Button>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="text-xs h-9"
              >
                Cancelar
              </Button>
              <Button
                type="button"
                variant="emerald"
                size="sm"
                onClick={handleSave}
                className="text-xs h-9 bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
              >
                Salvar e Conectar
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
