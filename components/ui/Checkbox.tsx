import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Checkbox = forwardRef<HTMLInputElement, Readonly<InputHTMLAttributes<HTMLInputElement>>>(
  function Checkbox({ className = '', ...props }, ref) {
    return (
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          'w-4 h-4 rounded border-themed cursor-pointer',
          'focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]',
          className
        )}
        style={{ accentColor: 'var(--accent-gold)' }}
        {...props}
      />
    )
  }
)
