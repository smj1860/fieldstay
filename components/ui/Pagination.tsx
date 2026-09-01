import Link from 'next/link'

interface PaginationProps {
  page:    number
  hasMore: boolean
  /** Builds the href for a given page number, e.g. `(p) => \`/settings/audit?page=${p}\`` */
  hrefFor: (page: number) => string
}

/**
 * Previous/Page N/Next footer for a server-rendered, offset-paginated table.
 * Shared by ../../app/(dashboard)/settings/audit/page.tsx and
 * .../settings/sync-incidents/page.tsx, which had carried byte-identical
 * copies of this block (SonarCloud flagged the duplication on PR #704).
 */
export function Pagination({ page, hasMore, hrefFor }: Readonly<PaginationProps>) {
  if (page <= 1 && !hasMore) return null

  return (
    <div
      className="flex items-center justify-between px-4 py-3"
      style={{ borderTop: '1px solid var(--border)' }}
    >
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
          ← Previous
        </Link>
      ) : <span />}
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Page {page}</span>
      {hasMore ? (
        <Link href={hrefFor(page + 1)} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
          Next →
        </Link>
      ) : <span />}
    </div>
  )
}
