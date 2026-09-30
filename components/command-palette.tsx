'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from 'cmdk'
import { Search, Wrench, Building2, Briefcase, type LucideIcon } from 'lucide-react'
import type { MemberRole } from '@/types/database'
import { getVisibleNavItems, type NavItem } from '@/lib/navigation'
import { useEntitySearch } from '@/lib/hooks/use-entity-search'
import {
  MIN_TERM_LENGTH,
  type EntitySearchResult,
  type SearchResultKind,
} from '@/lib/search/entity-search-types'

const RECENT_KEY   = 'fs-recent-nav'
const MAX_RECENTS  = 5

// Shared by every group heading. Extracted because it was already duplicated
// twice before entity results added three more.
const GROUP_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 ' +
  '[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold ' +
  '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide ' +
  '[&_[cmdk-group-heading]]:text-muted-themed'

const ITEM_CLASS =
  'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm cursor-pointer text-secondary-themed ' +
  'data-[selected=true]:bg-raised-themed data-[selected=true]:text-primary-themed'

/** Heading and icon per result kind. Order here is the order they render in. */
const KIND_META: ReadonlyArray<{ kind: SearchResultKind; heading: string; icon: LucideIcon }> = [
  { kind: 'work_order', heading: 'Work Orders', icon: Wrench },
  { kind: 'property',   heading: 'Properties',  icon: Building2 },
  { kind: 'vendor',     heading: 'Vendors',     icon: Briefcase },
]

function readRecents(): string[] {
  if (typeof globalThis.window === 'undefined') return []
  try {
    const raw = globalThis.localStorage.getItem(RECENT_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function pushRecent(href: string) {
  if (typeof globalThis.window === 'undefined') return
  try {
    const next = [href, ...readRecents().filter((h) => h !== href)].slice(0, MAX_RECENTS)
    globalThis.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // localStorage unavailable (private browsing etc.) — recents just won't persist
  }
}

interface EntityResultsProps {
  results: EntitySearchResult[]
  /**
   * The live search term, passed to every item as a cmdk keyword.
   *
   * cmdk fuzzy-matches items against their `value`, which is what makes the
   * nav list filter as you type. A server-side result is ALREADY the answer
   * to this term, so it must not be filtered again: "wh" matching a work
   * order titled "Replace water heater" through a `description` match is a
   * correct hit that cmdk's own scorer would throw away. Handing it the term
   * as a keyword guarantees the item stays visible without turning cmdk's
   * filtering off for the nav items that still need it.
   */
  term:     string
  onSelect: (result: EntitySearchResult) => void
}

function EntityResults({ results, term, onSelect }: Readonly<EntityResultsProps>) {
  return (
    <>
      {KIND_META.map(({ kind, heading, icon: Icon }) => {
        const forKind = results.filter((r) => r.kind === kind)
        if (forKind.length === 0) return null

        return (
          <CommandGroup key={kind} heading={heading} className={GROUP_CLASS}>
            {forKind.map((result) => (
              <CommandItem
                key={`${kind}-${result.id}`}
                value={`${result.label} ${result.id}`}
                keywords={[term]}
                onSelect={() => onSelect(result)}
                className={ITEM_CLASS}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate">{result.label}</span>
                  {result.subtitle !== null && (
                    <span className="block truncate text-xs text-muted-themed">
                      {result.subtitle}
                    </span>
                  )}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )
      })}
    </>
  )
}

interface CommandPaletteProps {
  role:             MemberRole
  isStaff?:         boolean
}

export function CommandPalette({ role, isStaff = false }: Readonly<CommandPaletteProps>) {
  const router = useRouter()
  const [open,  setOpen]  = useState(false)
  const [query, setQuery] = useState('')

  const items = getVisibleNavItems(role, { isStaff })
  // Recomputed from localStorage each time the palette is open — a cheap,
  // synchronous read, so there's no need to mirror it into state via an
  // effect (which would just trigger an extra cascading render on open).
  const recentIds = open ? readRecents() : []

  // Only runs while the palette is open, so a stale term cannot keep firing
  // requests behind a closed dialog.
  const search = useEntitySearch(query, open)

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

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    // Closing resets the term, so reopening is a fresh search rather than
    // last time's results under a cursor the user has to clear first.
    if (!next) setQuery('')
  }, [])

  const handleSelect = useCallback((item: NavItem) => {
    pushRecent(item.href)
    handleOpenChange(false)
    router.push(item.href)
  }, [router, handleOpenChange])

  // Entity results are deliberately NOT pushed into recents: that list maps
  // hrefs back onto nav items, and a work-order URL has no nav item to be.
  const handleSelectResult = useCallback((result: EntitySearchResult) => {
    handleOpenChange(false)
    router.push(result.href)
  }, [router, handleOpenChange])

  const recentItems = recentIds
    .map((href) => items.find((i) => i.href === href))
    .filter((i): i is NavItem => Boolean(i))

  const categories = Array.from(new Set(items.map((i) => i.category)))
  const searching  = query.trim().length >= MIN_TERM_LENGTH

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
        onOpenChange={handleOpenChange}
        label="Command Menu"
        overlayClassName="fixed inset-0 z-[100] bg-black/40"
        contentClassName="fixed left-1/2 top-[15vh] -translate-x-1/2 z-[101] w-full max-w-lg mx-4
                           bg-card-themed border-themed border shadow-dark-lg rounded-2xl overflow-hidden"
      >
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search work orders, properties, vendors, and pages..."
          className="w-full px-4 py-3 text-sm bg-transparent border-b border-themed
                     text-primary-themed placeholder:text-muted-themed
                     focus:outline-none"
        />
        <CommandList className="max-h-80 overflow-y-auto p-2">
          <CommandEmpty className="py-6 text-center text-sm text-muted-themed">
            {searching ? 'No matches.' : 'No matching pages.'}
          </CommandEmpty>

          {/* A failed search states so. An empty palette is the easiest place
              in the app to read an outage as an answer. */}
          {search.error !== null && (
            <p className="px-3 py-2 text-xs" style={{ color: 'var(--accent-red)' }}>
              {search.error}
            </p>
          )}

          {search.loading && search.results.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-themed">Searching your portfolio...</p>
          )}

          <EntityResults results={search.results} term={query} onSelect={handleSelectResult} />

          {recentItems.length > 0 && (
            <CommandGroup heading="Recent" className={GROUP_CLASS}>
              {recentItems.map((item) => (
                <CommandItem
                  key={`recent-${item.id}`}
                  value={item.label}
                  keywords={item.keywords}
                  onSelect={() => handleSelect(item)}
                  className={ITEM_CLASS}
                >
                  <item.icon className="w-4 h-4 flex-shrink-0" />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {categories.map((category) => (
            <CommandGroup key={category} heading={category} className={GROUP_CLASS}>
              {items.filter((i) => i.category === category).map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.label}
                  keywords={item.keywords}
                  onSelect={() => handleSelect(item)}
                  className={ITEM_CLASS}
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
