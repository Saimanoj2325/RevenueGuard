'use client';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

type Variant = 'ink' | 'green' | 'ghost';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'ink', size = 'md', busy, className, children, disabled, ...rest }, ref) {
  return (
    <button ref={ref} className={clsx(variant === 'ink' ? 'btn' : variant === 'green' ? 'btn-green' : 'btn-ghost', size === 'sm' && 'btn-sm', className)} disabled={disabled || busy} {...rest}>
      {busy && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
});
