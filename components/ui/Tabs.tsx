'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface TabItem<T extends string = string> {
  id:    T
  label: string
  icon?: ReactNode
}

interface TabsProps<T extends string> {
  tabs:       TabItem<T>[]
  active:     T
  onChange:   (id: T) => void
  className?: string
}

export function Tabs<T extends string>({
  tabs, active, onChange, className,
}: Readonly<TabsProps<T>>) {
  return (
    <div role="tablist" className={cn('flex items-center gap-1 border-b border-themed', className)}>
      {tabs.map((tab) => {
        const isActive = tab.id === active
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium',
              'border-b-2 -mb-px transition-colors rounded-t',
              'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent-gold)]',
              isActive
                ? 'text-[var(--accent-gold)]'
                : 'border-transparent text-muted-themed hover:text-secondary-themed'
            )}
            style={isActive ? { borderColor: 'var(--accent-gold)' } : undefined}
          >
            {tab.icon}
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
