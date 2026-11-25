import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors',
  {
    variants: {
      variant: {
        neutral: 'border-[var(--border-subtle)] bg-[var(--bg-muted)] text-[var(--text-secondary)]',
        spotify: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
        youtube: 'border-purple-500/30 bg-purple-500/15 text-purple-300',
        success: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400',
        warning: 'border-amber-500/35 bg-amber-500/15 text-amber-300',
        danger: 'border-red-500/35 bg-red-500/15 text-red-400',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
