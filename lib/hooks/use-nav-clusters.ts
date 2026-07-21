'use client'

import { useSyncExternalStore } from 'react'
import type { NavItem } from '@/lib/navigation'

const CLUSTER_STORAGE_KEY = 'fs-nav-clusters'

// Same useSyncExternalStore + module-level-listeners pattern as
// lib/hooks/use-theme.ts — the correct way to sync a localStorage-backed
// preference into render without a hydration mismatch (React uses
// getServerSnapshot during SSR and the initial client render, then swaps to
// the real client snapshot post-hydration) or an effect+setState cascade.
const clusterListeners = new Set<() => void>()
let clusterSnapshot: Record<string, boolean> = readClusterStateFromStorage()

function readClusterStateFromStorage(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = globalThis.localStorage.getItem(CLUSTER_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function getClusterSnapshot(): Record<string, boolean> {
  return clusterSnapshot
}

function getClusterServerSnapshot(): Record<string, boolean> {
  return {}
}

function subscribeToClusters(onChange: () => void): () => void {
  clusterListeners.add(onChange)
  return () => clusterListeners.delete(onChange)
}

function writeClusterState(next: Record<string, boolean>) {
  clusterSnapshot = next
  try {
    globalThis.localStorage.setItem(CLUSTER_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // localStorage unavailable — collapse preference just won't persist
  }
  clusterListeners.forEach((l) => l())
}

// Per-category expand/collapse state for the dashboard sidebar's management
// nav clusters, persisted to localStorage. Extracted from DashboardShell's
// DashboardSidebar.
export function useNavClusters(mgmtNav: NavItem[], pathname: string) {
  // getServerSnapshot ({}) covers SSR and the initial client render so
  // there's no hydration mismatch; useSyncExternalStore swaps to the real
  // localStorage-backed snapshot right after. isClusterExpanded's `?? true`
  // fallback keeps everything expanded until then, which is also the
  // correct default for a first-ever visit.
  const expandedClusters = useSyncExternalStore(
    subscribeToClusters, getClusterSnapshot, getClusterServerSnapshot
  )

  function isClusterExpanded(category: string): boolean {
    const hasActiveItem = mgmtNav.some(
      (item) => item.category === category && (pathname === item.href || pathname.startsWith(item.href + '/'))
    )
    if (hasActiveItem) return true
    return expandedClusters[category] ?? true
  }

  function toggleCluster(category: string) {
    const next = { ...expandedClusters, [category]: !isClusterExpanded(category) }
    writeClusterState(next)
  }

  return { isClusterExpanded, toggleCluster }
}
