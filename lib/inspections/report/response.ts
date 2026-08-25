import 'server-only'

import { toWinAnsi } from './text'
import type { InspectionReport } from './model'

// Turning a rendered report into an HTTP response, once rather than three
// times. Three routes serve this document — PM single, PM history, owner — and
// what differs between them is authorization, not packaging.

/**
 * `attachment`, always, and the filename is sanitized.
 *
 * A property name is free text and goes into a header. `"` closes the quoted
 * string, `;` starts a new header parameter, and CR/LF splits the response —
 * so the sanitizer is not cosmetics, it is the only thing between a PM naming a
 * property `x"; filename="passwd` and a header the browser reads differently
 * than intended. Anything outside a conservative allowlist becomes a hyphen.
 *
 * `inline` was considered and rejected: a PDF rendered in the browser tab is
 * pleasant and this is a record someone is meant to keep, so the default should
 * put a file on their disk.
 */
export function reportResponse(pdf: Uint8Array, filename: string): Response {
  const buffer = Buffer.from(pdf)
  return new Response(buffer, {
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${safeFilename(filename)}"`,
      'Content-Length':      String(buffer.byteLength),
      // A report is a point-in-time document whose remediation column is a live
      // join — see §"The one place immutability is subtle". A cached copy would
      // hand back yesterday's statuses under today's generated-at stamp, which
      // is the one difference the stamp exists to make explainable.
      'Cache-Control':       'private, no-store',
    },
  })
}

/** Conservative by design: letters, digits, hyphen, underscore and dot only. */
export function safeFilename(input: string): string {
  const collapsed = toWinAnsi(input)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  // A name that sanitized away entirely still needs to be a filename.
  return (collapsed || 'inspection-report').slice(0, 120)
}

/**
 * The download's name, from what a reader would look for it by.
 *
 * Property first, because a PM's downloads folder sorts by name and the useful
 * grouping is by house rather than by date. The date is the COMPLETION date,
 * which is what the record is filed under everywhere else.
 */
export function reportFilename(report: InspectionReport): string {
  const property = safeFilename(report.propertyName)

  if (report.inspections.length === 1) {
    const one = report.inspections[0]!
    return `${property}-${safeFilename(one.formLabel)}-${one.completedAt.slice(0, 10)}.pdf`
  }
  return `${property}-inspection-history-${new Date(report.generatedAt).toISOString().slice(0, 10)}.pdf`
}

/**
 * Whether the caller asked to omit photographs.
 *
 * PM-facing only, and it can only ever narrow. `?photos=0` exists so a PM can
 * produce the same document an owner would get — the copy they would forward
 * to one — without having to describe which pages to remove. There is no
 * inverse: no parameter turns photographs ON, because the owner route never
 * passes anything but `false`.
 */
export function photosRequested(url: URL): boolean {
  const raw = url.searchParams.get('photos')
  return !(raw === '0' || raw === 'false')
}
