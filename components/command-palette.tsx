'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from 'cmdk'
import { Search } from 'lucide-react'
import type { MemberRole } from '@/types/database'
import { getVisibleNavItems, type NavItem } from '@/lib/navigation'

const RECENT_KEY   = 'fs-recent-nav'
const MAX_RECENTS  = 5

function readRecents(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = globalThis.localStorage.getItem(RECENT_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function pushRecent(href: string) {
  if (typeof window === 'undefined') return
  try {
    const next = [href, ...readRecents().filter((h) => h !== href)].slice(0, MAX_RECENTS)
    globalThis.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // localStorage unavailable (private browsing etc.) — recents just won't persist
  }
}

interface CommandPaletteProps {
  role:             MemberRole
  repuguardActive?: boolean
  isStaff?:         boolean
}

export function CommandPalette({ role, repuguardActive = false, isStaff = false }: Readonly<CommandPaletteProps>) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  const items = getVisibleNavItems(role, { repuguardActive, isStaff })
  // Recomputed from localStorage each time the palette is open — a cheap,
  // synchronous read, so there's no need to mirror it into state via an
  // effect (which would just trigger an extra cascading render on open).
  const recentIds = open ? readRecents() : []

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleSelect = useCallback((item: NavItem) => {
    pushRecent(item.href)
    setOpen(false)
    router.push(item.href)
  }, [router])

  const recentItems = recentIds
    .map((href) => items.find((i) => i.href === href))
    .filter((i): i is NavItem => Boolean(i))

  const categories = Array.from(new Set(items.map((i) => i.category)))

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open command menu"
        className="flex items-center gap-2 h-8 px-3 rounded-lg text-xs font-medium
                   border-themed border transition-colors
                   text-muted-themed hover:text-primary-themed hover:bg-raised-themed
                   focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]
                   focus:ring-offset-1 focus:ring-offset-[var(--bg-card)]"
      >
        <Search className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden sm:inline text-[10px] px-1.5 py-0.5 rounded"
             style={{ background: 'var(--bg-raised)', color: 'var(--text-muted)' }}>
          ⌘K
        </kbd>
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        label="Command Menu"
        overlayClassName="fixed inset-0 z-[100] bg-black/40"
        contentClassName="fixed left-1/2 top-[15vh] -translate-x-1/2 z-[101] w-full max-w-lg mx-4
                           bg-card-themed border-themed border shadow-dark-lg rounded-2xl overflow-hidden"
      >
        <CommandInput
          placeholder="Search pages..."
          className="w-full px-4 py-3 text-sm bg-transparent border-b border-themed
                     text-primary-themed placeholder:text-muted-themed
                     focus:outline-none"
        />
        <CommandList className="max-h-80 overflow-y-auto p-2">
          <CommandEmpty className="py-6 text-center text-sm text-muted-themed">
            No matching pages.
          </CommandEmpty>

          {recentItems.length > 0 && (
            <CommandGroup heading="Recent" className="[&_[cmdk-group-heading]]:px-2
                          [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px]
                          [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase
                          [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-themed">
              {recentItems.map((item) => (
                <CommandItem
                  key={`recent-${item.id}`}
                  value={item.label}
                  keywords={item.keywords}
                  onSelect={() => handleSelect(item)}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm cursor-pointer
                             text-secondary-themed
                             data-[selected=true]:bg-raised-themed data-[selected=true]:text-primary-themed"
                >
                  <item.icon className="w-4 h-4 flex-shrink-0" />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {categories.map((category) => (
            <CommandGroup key={category} heading={category} className="[&_[cmdk-group-heading]]:px-2
                          [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px]
                          [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase
                          [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-themed">
              {items.filter((i) => i.category === category).map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.label}
                  keywords={item.keywords}
                  onSelect={() => handleSelect(item)}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm cursor-pointer
                             text-secondary-themed
                             data-[selected=true]:bg-raised-themed data-[selected=true]:text-primary-themed"
                >
                  <item.icon className="w-4 h-4 flex-shrink-0" />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  )
}
