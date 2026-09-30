'use client'

import { useEffect, useState } from 'react'

import { searchEntitiesAction } from '@/app/actions/search'
import { MIN_TERM_LENGTH, type EntitySearchResult } from '@/lib/search/entity-search-types'

/** Keystrokes settle for this long before a request goes out. */
const DEBOUNCE_MS = 250

export interface EntitySearchState {
  results: EntitySearchResult[]
  loading: boolean
  /** User-safe message. Non-null means the section renders an error, not "no matches". */
  error:   string | null
}

/** What came back, and the term it came back FOR. */
interface Answer {
  term:    string
  results: EntitySearchResult[]
  error:   string | null
}

const NO_ANSWER: Answer = { term: '', results: [], error: null }

/**
 * Debounced portfolio search for the command palette.
 *
 * THE STALENESS GUARD IS THE TERM ITSELF, which is why there is no generation
 * counter here and no state reset when the term changes. Typing races itself:
 * "wat" and "war" go out in that order and nothing makes them come back in
 * it, so a response has to prove it answers the CURRENT question rather than
 * merely being the most recent to arrive. Stamping each answer with its own
 * term and comparing on read does that, and it also removes the reset —
 * `loading` and the empty result set are DERIVED from "no answer for this
 * term yet" instead of being written by the effect. Same purpose as
 * refreshChecklistSubscription's generation token in lib/dexie/context.tsx,
 * with the term standing in for the counter.
 *
 * That shape is also what keeps this hook clear of
 * `react-hooks/set-state-in-effect`: every setState here happens in a
 * callback after an await, never synchronously in the effect body.
 *
 * `MIN_TERM_LENGTH` is checked here as well as inside the action. The action
 * is the authority (it is what a caller can reach); this copy is what stops a
 * one-character term from spending a round trip to be told so.
 */
export function useEntitySearch(term: string, enabled: boolean): EntitySearchState {
  const [answer, setAnswer] = useState<Answer>(NO_ANSWER)

  const trimmed    = term.trim()
  const searchable = enabled && trimmed.length >= MIN_TERM_LENGTH

  useEffect(() => {
    if (!searchable) return

    let active = true

    const timer = setTimeout(() => {
      searchEntitiesAction(trimmed)
        .then((res) => {
          if (!active) return
          setAnswer(res.success
            ? { term: trimmed, results: res.results, error: null }
            : { term: trimmed, results: [],          error: res.error })
        })
        .catch(() => {
          if (!active) return
          setAnswer({ term: trimmed, results: [], error: 'Search is unavailable right now.' })
        })
    }, DEBOUNCE_MS)

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [trimmed, searchable])

  // An answer for a different term is not this term's answer, so it neither
  // renders nor counts as "done loading".
  const current = searchable && answer.term === trimmed

  return {
    results: current ? answer.results : [],
    error:   current ? answer.error   : null,
    loading: searchable && !current,
  }
}
