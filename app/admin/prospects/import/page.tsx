import Link from 'next/link'
import { requirePlatformAdmin } from '@/lib/auth'
import { Card } from '@/components/ui/Card'
import { ProspectImportClient } from './import-client'
import { IMPORT_LIST_COLUMNS, IMPORT_LIST_LIMIT } from './constants'
import type { ProspectImport } from '@/types/database'

/**
 * The page reads directly rather than calling listProspectImports().
 *
 * A Server Component that awaits a 'use server' action puts that action's
 * try/catch in the way of Next's own control-flow errors: the static-prerender
 * probe raises "Dynamic server usage" the moment cookies() is read, the catch
 * swallows it, and the page renders an error state at build time instead of
 * being marked dynamic. Same reason lib/auth.ts keeps redirect() out of its
 * cached context helper. The action still exists — the client calls it to
 * refresh the list after an import or an undo.
 */
export default async function ProspectImportPage() {
  const { supabase } = await requirePlatformAdmin()

  const { data, error } = await supabase
    .from('prospect_imports')
    .select(IMPORT_LIST_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(IMPORT_LIST_LIMIT)

  if (error) console.error('[ProspectImportPage]', error)

  return (
    <Card>
      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Import accounts
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
        Load a prospecting CSV into the funnel. Existing accounts are matched on
        domain first, then on company name plus city and state, and only their
        scorer-owned columns are refreshed — status, notes, next action and any
        contact you have already filled in are never overwritten. Check the plan
        before importing.{' '}
        <Link
          href="/admin/prospects"
          className="underline"
          style={{ color: 'var(--accent-gold)' }}
        >
          Back to the funnel
        </Link>
      </p>
      <ProspectImportClient initialImports={(data ?? []) as ProspectImport[]} />
    </Card>
  )
}
