'use client'

import { useRouter } from 'next/navigation'
import { Tabs, type TabItem } from '@/components/ui/Tabs'

export type FunnelView = 'accounts' | 'agents'

const TABS: TabItem<FunnelView>[] = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'agents',   label: 'Agent Teams' },
]

/** The view lives in the URL, so a refresh or a shared link lands on the same tab. */
export function FunnelTabs({ active }: Readonly<{ active: FunnelView }>) {
  const router = useRouter()
  return (
    <Tabs
      tabs={TABS}
      active={active}
      className="mb-6"
      onChange={(view) => router.push(view === 'accounts' ? '/admin/prospects' : '/admin/prospects?view=agents')}
    />
  )
}
