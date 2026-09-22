import { requirePlatformAdmin } from '@/lib/auth'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { Card } from '@/components/ui/Card'
import { ProspectsClient } from './prospects-client'
import {
  PROSPECT_STATUSES,
  CONTACT_EMAIL_STATUSES,
  type ProspectRow,
  type ProspectStatus,
  type ProspectContactEmailStatus,
} from './constants'

const SELECT_COLUMNS = `
  id, company, domain, website, city, state, market, portfolio_size,
  pms, pms_note, score_a, score_b, track, bucket,
  contact_name, contact_title, email, email_is_generic, email_status, phone, linkedin_url,
  status, status_note, notes, last_touch_at, next_action_at,
  comparent_url, last_crawled_at, crawl_status
`

/** The row as the database hands it back — status is a plain text column. */
type DbProspectRow = Omit<ProspectRow, 'status' | 'email_is_generic' | 'email_status'> & {
  status:           string
  email_is_generic: boolean | null
  email_status:     string
}

/**
 * A CHECK constraint keeps status inside the union, but the generated types
 * see a text column. Narrow it here rather than casting in the client, and
 * fall back to 'new' for a value written before a stage was renamed — an
 * unknown string would otherwise leave the row's dropdown blank and make a
 * real account look unworked.
 */
function narrowStatus(value: string): ProspectStatus {
  return (PROSPECT_STATUSES as readonly string[]).includes(value)
    ? (value as ProspectStatus)
    : 'new'
}

/** Same narrowing as status: a CHECK constraint guards it, the types see text. */
function narrowEmailStatus(value: string): ProspectContactEmailStatus {
  return (CONTACT_EMAIL_STATUSES as readonly string[]).includes(value)
    ? (value as ProspectContactEmailStatus)
    : 'unknown'
}

export default async function ProspectsPage() {
  const { supabase } = await requirePlatformAdmin()

  // Paginated, like the inventory catalog page: the list is a few thousand
  // rows today and grows with every crawl, and PostgREST caps a single select
  // at 1000 — without this the table would silently stop at the cap and the
  // missing rows would look like bad data rather than a truncated fetch.
  const rows = await fetchAllRows<DbProspectRow>(
    (from, to) => supabase
      .from('prospect_accounts')
      .select(SELECT_COLUMNS)
      .order('score_a', { ascending: false, nullsFirst: false })
      .order('company')
      .range(from, to),
    { label: 'admin.prospects' },
  )

  const initialRows: ProspectRow[] = rows.map((r) => ({
    ...r,
    status:           narrowStatus(r.status),
    email_is_generic: r.email_is_generic ?? false,
    email_status:     narrowEmailStatus(r.email_status),
  }))

  return (
    <Card>
      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Prospecting Funnel
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
        The outbound account list. Search and filter to build a working set,
        edit contact details in place, and move accounts through the funnel.
        Scores, track and bucket are written by the offline scorer and are
        read-only here.
      </p>
      <ProspectsClient initialRows={initialRows} />
    </Card>
  )
}
