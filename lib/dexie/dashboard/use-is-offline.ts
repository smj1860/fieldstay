'use client'

// lib/dexie/dashboard/use-is-offline.ts
//
// "Is this tablet offline right now?", for the surfaces that have to answer it
// differently rather than merely more slowly.
//
// ─────────────────────────────────────────────────────────────────────────────
// STARTS false, ALWAYS
//
// Not `navigator.onLine`. The server renders this component too, where there is
// no navigator, and seeding from it on the client would make the first client
// render disagree with the server's HTML — a hydration mismatch React resolves
// by throwing the markup away. So the first paint always claims online and the
// effect corrects it, which is also the right default on its own terms: an
// online form rendered for one frame to a genuinely offline PM costs a
// corrected render, whereas an offline form shown to an online one silently
// diverts their work into a queue they never asked for.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT navigator.onLine ACTUALLY MEANS
//
// `false` is trustworthy: the browser has no network interface at all. `true`
// means only that an interface exists — a hotel wifi that resolves nothing
// still reports true. So this is a signal for choosing a UI path, never a
// guarantee a request will succeed, and every path it selects still has to
// survive being wrong. The outbox is what makes that safe: a create queued
// while "online" is sent immediately and one queued while "offline" waits, and
// neither loses the work if the guess was backwards.

import { useEffect, useState } from 'react'

export function useIsOffline(): boolean {
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    const sync = () => { setOffline(globalThis.navigator?.onLine === false) }

    // Once on mount, because the events only fire on a CHANGE — a tab opened
    // while already offline would otherwise never hear one.
    sync()
    globalThis.addEventListener?.('online', sync)
    globalThis.addEventListener?.('offline', sync)
    return () => {
      globalThis.removeEventListener?.('online', sync)
      globalThis.removeEventListener?.('offline', sync)
    }
  }, [])

  return offline
}
