'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastMessage {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const Icon =
          toast.type === 'success'
            ? CheckCircle2
            : toast.type === 'warning'
              ? AlertTriangle
              : toast.type === 'error'
                ? XCircle
                : Info;

        return (
          <div
            key={toast.id}
            className={cn(
              'glass-panel flex items-start gap-3 rounded-xl p-3.5 shadow-xl transition-all duration-200',
              toast.type === 'success' && 'border-emerald-500/40',
              toast.type === 'warning' && 'border-amber-500/40',
              toast.type === 'error' && 'border-red-500/40',
              toast.type === 'info' && 'border-purple-500/40',
            )}
          >
            <Icon
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0',
                toast.type === 'success' && 'text-emerald-400',
                toast.type === 'warning' && 'text-amber-400',
                toast.type === 'error' && 'text-red-400',
                toast.type === 'info' && 'text-purple-400',
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{toast.title}</p>
              {toast.description && (
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{toast.description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="rounded-md p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              aria-label="Fechar notificação"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
