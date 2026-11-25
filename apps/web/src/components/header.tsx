'use client';

import * as React from 'react';
import type { SpotifyAuthStatus } from '@musicflow/shared';
import { Activity, AudioWaveform, LogIn, LogOut, Moon, Server, Sun, Upload } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTheme } from './theme-provider';

interface HeaderProps {
  showUploadDrawer: boolean;
  onToggleUploadDrawer: () => void;
  spotifyAuth: SpotifyAuthStatus | null;
  onSpotifyLogin: () => Promise<void>;
  onSpotifyLogout: () => Promise<void>;
  serverConnected?: boolean;
  onOpenServerSettings?: () => void;
}

export function Header({
  showUploadDrawer,
  onToggleUploadDrawer,
  spotifyAuth,
  onSpotifyLogin,
  onSpotifyLogout,
  serverConnected,
  onOpenServerSettings,
}: HeaderProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] backdrop-blur-xl bg-[var(--bg-primary)]/90">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-purple-600 text-white shadow-md shadow-emerald-500/20">
            <AudioWaveform className="h-5 w-5 shrink-0" aria-hidden="true" />
          </div>
          <span className="text-base font-bold tracking-tight">MusicFlow Downloader</span>
        </Link>

        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {spotifyAuth?.authenticated ? (
            <div className="flex items-center gap-1.5">
              <Badge variant="spotify" className="max-w-[160px] truncate">
                {spotifyAuth.user?.displayName || 'Spotify conectado'}
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void onSpotifyLogout()}
                aria-label="Sair do Spotify"
                title="Desconectar Spotify"
                className="h-8 px-2 text-xs"
              >
                <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline">Sair</span>
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onSpotifyLogin()}
              className="h-8 border-emerald-500/35 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 transition-colors"
            >
              <LogIn className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Conectar Spotify</span>
              <span className="sm:hidden">Spotify</span>
            </Button>
          )}

          {onOpenServerSettings && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onOpenServerSettings}
              className="h-8 text-xs relative px-2 sm:px-2.5"
              title="Configurações do Servidor (Worker)"
              aria-label="Configurações do Servidor Worker"
            >
              <Server className="h-3.5 w-3.5 shrink-0 mr-1 sm:mr-1.5" />
              <span className="hidden sm:inline">Servidor</span>
              <span
                className={`inline-block h-2 w-2 rounded-full ml-1 sm:ml-1.5 ${
                  serverConnected ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : 'bg-amber-400'
                }`}
                aria-hidden="true"
              />
            </Button>
          )}

          <Button
            type="button"
            variant={showUploadDrawer ? 'secondary' : 'ghost'}
            size="sm"
            onClick={onToggleUploadDrawer}
            className="h-8 text-xs"
          >
            <Upload className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="hidden md:inline">Arquivo local</span>
          </Button>

          <Link
            href="/admin/diagnostics"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-white/5 hover:text-[var(--text-primary)] transition-colors"
            aria-label="Painel de diagnóstico"
            title="Diagnóstico"
          >
            <Activity className="h-4 w-4 shrink-0" aria-hidden="true" />
          </Link>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'}
            title={theme === 'dark' ? 'Modo claro' : 'Modo escuro'}
            className="h-8 w-8"
          >
            {theme === 'dark' ? (
              <Sun className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
    </header>
  );
}
