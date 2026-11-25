import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-11 w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-muted)] px-3.5 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/70 disabled:cursor-not-allowed disabled:opacity-50 transition-all',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
