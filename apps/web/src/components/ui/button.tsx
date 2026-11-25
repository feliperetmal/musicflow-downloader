import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        default:
          'bg-gradient-to-r from-purple-600 to-violet-600 text-white shadow-lg shadow-purple-500/20 hover:from-purple-500 hover:to-violet-500',
        emerald:
          'bg-gradient-to-r from-emerald-600 to-green-600 text-white shadow-lg shadow-emerald-500/20 hover:from-emerald-500 hover:to-green-500',
        outline:
          'border border-[var(--border-subtle)] bg-transparent text-[var(--text-primary)] hover:bg-purple-500/10 hover:border-purple-500/40',
        secondary:
          'bg-[var(--bg-muted)] text-[var(--text-primary)] hover:opacity-90 border border-[var(--border-subtle)]',
        ghost: 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/5',
        destructive: 'bg-red-600/90 text-white hover:bg-red-500',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-12 rounded-xl px-6 text-base',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  ),
);
Button.displayName = 'Button';
