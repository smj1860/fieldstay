'use client'

import { useState, useId } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import type { FaqCategory, FaqItem } from '@/lib/faq-content'
import { FAQ_FLAT } from '@/lib/faq-content'

interface Props {
  categories: FaqCategory[]
}

export function FaqAccordion({ categories }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [query,  setQuery]  = useState('')
  const uid = useId()

  const trimmed = query.trim().toLowerCase()

  const searchResults = trimmed
    ? FAQ_FLAT.filter(
        (item) =>
          item.question.toLowerCase().includes(trimmed) ||
          item.answer.toLowerCase().includes(trimmed)
      )
    : []

  const toggle = (id: string) =>
    setOpenId((prev) => (prev === id ? null : id))

  const clearSearch = () => {
    setQuery('')
    setOpenId(null)
  }

  return (
    <div>
      {/* Search */}
      <div className="relative mb-8">
        <Search
          className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
          style={{ color: 'var(--text-muted)' }}
        />
        <input
          type="search"
          placeholder="Search questions…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpenId(null) }}
          className="w-full pl-10 pr-10 py-3 rounded-xl text-sm outline-none"
          style={{
            background: 'var(--bg-card)',
            border:     '1px solid var(--border)',
            color:      'var(--text-primary)',
          }}
        />
        {query && (
          <button
            onClick={clearSearch}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1 rounded
                       transition-opacity hover:opacity-70"
            style={{ color: 'var(--text-muted)' }}
            aria-label="Clear search"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Search results */}
      {trimmed && (
        <div className="mb-8">
          {searchResults.length === 0 ? (
            <div
              className="text-center py-14"
              style={{ color: 'var(--text-muted)' }}
            >
              <p className="text-sm">No results for &ldquo;{query}&rdquo;</p>
              <p className="text-xs mt-1.5">
                Try different keywords or{' '}
                <a
                  href="mailto:support@fieldstay.app"
                  className="underline underline-offset-2"
                  style={{ color: 'var(--accent-gold)' }}
                >
                  email us directly
                </a>
                .
              </p>
            </div>
          ) : (
            <>
              <p
                className="text-xs font-medium mb-3"
                style={{ color: 'var(--text-muted)' }}
              >
                {searchResults.length} result
                {searchResults.length !== 1 ? 's' : ''}
              </p>
              <AccordionGroup
                items={searchResults}
                openId={openId}
                toggle={toggle}
                uid={uid}
              />
            </>
          )}
        </div>
      )}

      {/* Categorized list — hidden while a search query is active */}
      {!trimmed && (
        <div className="space-y-8">
          {categories.map((cat) => (
            <div key={cat.id}>
              <h2
                className="text-xs font-semibold uppercase tracking-widest mb-3 px-1"
                style={{ color: 'var(--text-muted)' }}
              >
                {cat.label}
              </h2>
              <AccordionGroup
                items={cat.items}
                openId={openId}
                toggle={toggle}
                uid={uid}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Shared accordion renderer ──────────────────────────────────────────────

function AccordionGroup({
  items,
  openId,
  toggle,
  uid,
}: Readonly<{
  items:  FaqItem[]
  openId: string | null
  toggle: (id: string) => void
  uid:    string
}>) {
  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: 'var(--bg-card)',
        border:     '1px solid var(--border)',
      }}
    >
      {items.map((item, idx) => {
        const isOpen = openId === item.id
        const btnId  = `${uid}-btn-${item.id}`
        const bodyId = `${uid}-body-${item.id}`
        const isLast = idx === items.length - 1

        return (
          <div
            key={item.id}
            style={isLast ? undefined : { borderBottom: '1px solid var(--border)' }}
          >
            <button
              id={btnId}
              aria-expanded={isOpen}
              aria-controls={bodyId}
              onClick={() => toggle(item.id)}
              className="w-full flex items-start justify-between gap-4 px-5 py-4
                         text-left transition-colors"
              style={{
                color:      'var(--text-primary)',
                background: isOpen ? 'var(--bg-raised)' : 'transparent',
              }}
            >
              <span className="text-sm font-medium leading-snug pt-px">
                {item.question}
              </span>
              <ChevronDown
                className="w-4 h-4 flex-shrink-0 mt-0.5 transition-transform duration-200"
                style={{
                  color:     'var(--text-muted)',
                  transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              />
            </button>

            <div
              id={bodyId}
              role="region"
              aria-labelledby={btnId}
              hidden={!isOpen}
            >
              <p
                className="px-5 pb-5 text-sm leading-relaxed"
                style={{ color: 'var(--text-muted)' }}
              >
                {item.answer}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
