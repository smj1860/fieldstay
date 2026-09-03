/**
 * CPA Export PDF — GET /api/assets/cpa-export?tax_year=2025
 *
 * Generates a depreciation schedule PDF (IRS Pub. 946 format)
 * using pdf-lib. Groups entries by property, then by asset.
 * Includes cover page with disclaimer.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { requireOrgMember }   from '@/lib/auth'
import { dataExportLimiter, checkLimit } from '@/lib/rate-limit'
import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib'
import { MACRS_LABELS } from '@/lib/assets/depreciation'
import { assetServiceBasis, formatBasisDate, ESTIMATED_DATE_MARKER } from '@/lib/assets/age-basis'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { unwrap } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'
import type { MacrsClass } from '@/types/database'

// ── Layout constants ──────────────────────────────���───────────────────────────

const W  = 792  // Letter landscape width (pts)
const H  = 612  // Letter landscape height
const ML = 48   // margin left
const MR = 48   // margin right
const MT = 48   // margin top
const MB = 40   // margin bottom
const CW = W - ML - MR  // content width

/**
 * Ceiling on rows in one export — see the comment at the fetch below for why
 * this route needs one at all. One row per active asset per tax year, so this
 * is roughly two orders of magnitude above the largest plausible tenant.
 */
const CPA_EXPORT_MAX_ENTRIES = 20_000


const GRAY_DARK  = rgb(0.15, 0.18, 0.25)
const GRAY_MED   = rgb(0.35, 0.40, 0.50)
const GRAY_LIGHT = rgb(0.65, 0.70, 0.78)
const GOLD       = rgb(0.98, 0.82, 0.07)
const WHITE      = rgb(1, 1, 1)
const ROW_BG     = rgb(0.96, 0.97, 0.99)

// Column widths (total = CW)
const COLS = {
  name:   220,
  placed: 70,
  macrs:  90,
  basis:  75,
  prior:  75,
  current: 80,
  ending:  80,
}

function fmt$(n: number) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** The asset columns the service-date resolution needs, as they arrive joined. */
type JoinedLedgerAsset = {
  placed_in_service_date: string | null
  installation_date:      string | null
  manufacture_date:       string | null
} | null

/**
 * The in-service date to print, marked when it was inferred from the nameplate
 * manufacture year — see lib/assets/age-basis.ts. Printing
 * placed_in_service_date alone showed "—" next to a real depreciation figure
 * for exactly the assets whose basis came from a fallback.
 */
function serviceDateText(asset: JoinedLedgerAsset): string {
  return formatBasisDate(asset ? assetServiceBasis(asset) : null)
}

/**
 * Whether ANY row rests on an inferred date, which is what decides if the
 * closing note is rendered at all. Computed over the whole set up front rather
 * than accumulated inside the per-property/per-row loops — those are already
 * at the complexity ceiling, and a flag mutated three levels deep is harder to
 * follow than one derived here.
 */
function hasEstimatedServiceDate(rows: Array<{ property_assets: unknown }>): boolean {
  for (const row of rows) {
    const asset = unwrapJoin(row.property_assets) as JoinedLedgerAsset
    if (asset && assetServiceBasis(asset)?.estimated) return true
  }
  return false
}

/**
 * A closing page explaining the `*` on an in-service date, appended only when
 * at least one row carries one — a fully-documented schedule gets no extra
 * caveat.
 *
 * A CPA has to be able to tell which dates were recorded and which FieldStay
 * inferred from a nameplate photo — see lib/assets/age-basis.ts. The
 * needs-it-at-all test lives here rather than at the call site so the handler,
 * which is already at the cognitive-complexity ceiling, gains no branch.
 */
function drawEstimatedDateNote(
  doc:      PDFDocument,
  font:     PDFFont,
  boldFont: PDFFont,
  rows:     Array<{ property_assets: unknown }>,
): void {
  if (!hasEstimatedServiceDate(rows)) return

  const page = doc.addPage([W, H])
  page.drawText('Note on estimated in-service dates', {
    x: ML, y: H - MT, size: 12, font: boldFont, color: GRAY_DARK,
  })

  const lines = [
    `A date marked ${ESTIMATED_DATE_MARKER} was estimated from the equipment nameplate's manufacture year,`,
    'because no installation or placed-in-service date was recorded for that asset.',
    'Manufacture precedes installation, so an estimated date is at or before the true',
    'in-service date and the resulting deduction begins no later than it should.',
    '',
    'Confirm each marked asset with your client and record the actual placed-in-service',
    'date in FieldStay; a recorded date takes precedence and the schedule regenerates from it.',
  ]

  let y = H - MT - 26
  for (const line of lines) {
    page.drawText(line, { x: ML, y, size: 9, font, color: GRAY_MED })
    y -= 14
  }
}

function drawTableHeader(page: ReturnType<PDFDocument['addPage']>, y: number, boldFont: PDFFont, doc: PDFDocument) {
  void doc
  const headers = [
    { label: 'Asset',              w: COLS.name    },
    { label: 'In Service',         w: COLS.placed  },
    { label: 'MACRS Class',        w: COLS.macrs   },
    { label: 'Cost Basis',         w: COLS.basis   },
    { label: 'Prior Cumul.',       w: COLS.prior   },
    { label: 'Current Year Depr.', w: COLS.current },
    { label: 'Ending Basis',       w: COLS.ending  },
  ]

  // Header background
  page.drawRectangle({ x: ML, y: y - 18, width: CW, height: 18, color: GRAY_DARK })

  let x = ML + 6
  for (const { label, w } of headers) {
    page.drawText(label, {
      x, y: y - 13,
      size: 7,
      font: boldFont,
      color: WHITE,
    })
    x += w
  }

  return y - 18
}


/** One depreciation row as it arrives from the ledger query. */
interface LedgerEntry {
  macrs_class:                   string
  cost_basis:                    number
  prior_cumulative_depreciation: number
  current_year_depreciation:     number
  ending_adjusted_basis:         number
  property_assets:               unknown
}

interface PropertyGroup {
  propertyName: string
  rows:         LedgerEntry[]
}

/** Groups the ledger by property name, preserving the query's asset ordering. */
function groupEntriesByProperty(entries: LedgerEntry[]): PropertyGroup[] {
  const byProperty = new Map<string, PropertyGroup>()

  for (const entry of entries) {
    const asset    = unwrapJoin(entry.property_assets) as { properties?: unknown } | null
    const propName = (unwrapJoin(asset?.properties) as { name?: string } | null)?.name ?? 'Unknown Property'

    const group = byProperty.get(propName)
    if (group) group.rows.push(entry)
    else byProperty.set(propName, { propertyName: propName, rows: [entry] })
  }

  return [...byProperty.values()]
}

/** Cover page: title block, disclaimer, and the four summary stat tiles. */
function drawCoverPage(
  doc: PDFDocument,
  { font, boldFont, orgName, taxYear, entries }: {
    font:     PDFFont
    boldFont: PDFFont
    orgName:  string
    taxYear:  number
    entries:  LedgerEntry[]
  },
): void {
  const cover = doc.addPage([W, H])

  cover.drawRectangle({ x: 0, y: H - 120, width: W, height: 120, color: GRAY_DARK })
  cover.drawText('DEPRECIATION SCHEDULE', { x: ML, y: H - 55, size: 22, font: boldFont, color: GOLD })
  cover.drawText(`Tax Year ${taxYear}`, { x: ML, y: H - 80, size: 14, font, color: WHITE })
  cover.drawText(orgName, { x: ML, y: H - 100, size: 11, font, color: GRAY_LIGHT })

  cover.drawText('Prepared for use with IRS Publication 946', { x: ML, y: H - 150, size: 10, font, color: GRAY_MED })
  const generated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  cover.drawText(`Generated: ${generated}`, { x: ML, y: H - 168, size: 9, font, color: GRAY_MED })

  const disclaimer = [
    'DISCLAIMER: This report is for informational purposes only. Review all depreciation',
    'calculations with your CPA before filing. FieldStay does not provide tax advice.',
    'All figures use IRS Publication 946 MACRS rates with the half-year convention.',
  ]
  let dy = H - 220
  for (const line of disclaimer) {
    cover.drawText(line, { x: ML, y: dy, size: 9, font, color: GRAY_MED })
    dy -= 14
  }

  const totalCurrentDepr = entries.reduce((sum, e) => sum + e.current_year_depreciation, 0)
  const totalBasis       = entries.reduce((sum, e) => sum + e.cost_basis, 0)
  const totalEndingBasis = entries.reduce((sum, e) => sum + e.ending_adjusted_basis, 0)

  const stats = [
    { label: 'Total Assets',            value: String(entries.length) },
    { label: 'Total Cost Basis',        value: fmt$(totalBasis) },
    { label: `${taxYear} Depreciation`, value: fmt$(totalCurrentDepr) },
    { label: 'Total Ending Basis',      value: fmt$(totalEndingBasis) },
  ]

  let sx = ML
  for (const { label, value } of stats) {
    cover.drawRectangle({ x: sx, y: dy - 50, width: 160, height: 56, color: ROW_BG, borderColor: rgb(0.88, 0.90, 0.94), borderWidth: 1 })
    cover.drawText(value, { x: sx + 8, y: dy - 22, size: 14, font: boldFont, color: GRAY_DARK })
    cover.drawText(label, { x: sx + 8, y: dy - 36, size: 8,  font,           color: GRAY_MED })
    sx += 170
  }
}

/** One data row's seven cells, clipped to their column widths. */
function drawEntryRow(
  page:  ReturnType<PDFDocument['addPage']>,
  y:     number,
  entry: LedgerEntry,
  { font, boldFont, striped }: { font: PDFFont; boldFont: PDFFont; striped: boolean },
): void {
  page.drawRectangle({ x: ML, y: y - 18, width: CW, height: 18, color: striped ? ROW_BG : WHITE })

  const asset = unwrapJoin(entry.property_assets) as (JoinedLedgerAsset & { name?: string }) | null

  const cells = [
    { text: asset?.name ?? '—',                                     w: COLS.name,    bold: false },
    { text: serviceDateText(asset),                                 w: COLS.placed,  bold: false },
    { text: MACRS_LABELS[entry.macrs_class as MacrsClass] ?? String(entry.macrs_class), w: COLS.macrs, bold: false },
    { text: fmt$(entry.cost_basis),                                 w: COLS.basis,   bold: false },
    { text: fmt$(entry.prior_cumulative_depreciation),              w: COLS.prior,   bold: false },
    { text: fmt$(entry.current_year_depreciation),                  w: COLS.current, bold: true  },
    { text: fmt$(entry.ending_adjusted_basis),                      w: COLS.ending,  bold: false },
  ]

  let cx = ML + 6
  for (const cell of cells) {
    const maxChars = Math.floor(cell.w / 5)
    const text     = cell.text.length > maxChars ? cell.text.slice(0, maxChars - 1) + '…' : cell.text
    page.drawText(text, { x: cx, y: y - 14, size: 7.5, font: cell.bold ? boldFont : font, color: GRAY_DARK })
    cx += cell.w
  }
}

/** One property's table, spilling onto continuation pages. Returns its total. */
function drawPropertySection(
  doc: PDFDocument,
  { propertyName, rows }: PropertyGroup,
  { font, boldFont }: { font: PDFFont; boldFont: PDFFont },
): number {
  let page = doc.addPage([W, H])
  let y    = H - MT

  page.drawRectangle({ x: ML, y: y - 24, width: CW, height: 24, color: GRAY_DARK })
  page.drawText(propertyName, { x: ML + 8, y: y - 16, size: 11, font: boldFont, color: WHITE })
  y -= 24
  y = drawTableHeader(page, y, boldFont, doc)

  let rowIndex  = 0
  let propTotal = 0

  for (const entry of rows) {
    // Page break check — need ~20pts per row + ~40 footer
    if (y - 20 < MB + 40) {
      page = doc.addPage([W, H])
      y    = H - MT
      page.drawText(`${propertyName} (cont.)`, { x: ML, y: y - 14, size: 9, font, color: GRAY_MED })
      y -= 20
      y = drawTableHeader(page, y, boldFont, doc)
    }

    drawEntryRow(page, y, entry, { font, boldFont, striped: rowIndex % 2 === 1 })

    propTotal += entry.current_year_depreciation
    y         -= 18
    rowIndex++
  }

  page.drawRectangle({ x: ML, y: y - 18, width: CW, height: 18, color: GRAY_DARK })
  page.drawText(`${propertyName} Total`, { x: ML + 6, y: y - 13, size: 8, font: boldFont, color: WHITE })
  page.drawText(fmt$(propTotal), {
    x: ML + COLS.name + COLS.placed + COLS.macrs + COLS.basis + COLS.prior + 6,
    y: y - 13, size: 8, font: boldFont, color: GOLD,
  })

  return propTotal
}

/** Every property's data pages. Returns the grand total across all of them. */
function drawPropertyPages(
  doc: PDFDocument,
  { font, boldFont, byProperty }: { font: PDFFont; boldFont: PDFFont; byProperty: PropertyGroup[] },
): number {
  let grandTotal = 0
  for (const group of byProperty) {
    grandTotal += drawPropertySection(doc, group, { font, boldFont })
  }
  return grandTotal
}

export async function GET(req: Request) {
  // Auth
  const { user, membership } = await requireOrgMember()

  // L-2: an auth gate proves WHO, not HOW OFTEN. This renders a multi-page
  // PDF from a full depreciation-schedule query on every hit. Abuse limiter
  // → fails OPEN: a Redis outage must not block a PM's tax export.
  const rl = await checkLimit(dataExportLimiter, `cpa-export:${user.id}`, {
    onError: 'allow',
    site:    'route.assets.cpa-export.GET',
  })
  if (!rl.allowed) {
    return Response.json(
      { error: 'Export limit reached. Please try again later.' },
      { status: 429 }
    )
  }

  const supabase = createServiceClient({ authorizedBy: membership })

  const url     = new URL(req.url)
  const taxYear = Number.parseInt(url.searchParams.get('tax_year') ?? String(new Date().getFullYear() - 1), 10)

  // Load org name
  const orgRes = await supabase
    .from('organizations')
    .select('name')
    .eq('id', membership.org_id)
    .single()

  const org = unwrap(orgRes, { site: 'route.assets.cpa-export.GET', orgId: membership.org_id })

  // Load depreciation entries with asset + property names. Paginated: a tax
  // document silently missing rows past max_rows = 1000 is a correctness bug,
  // not a display truncation — every asset for the year must be on it.
  //
  // Explicitly bounded, because everything after this point is synchronous CPU
  // on the REQUEST path: several reduce passes, then pdf-lib draw calls per row
  // with page breaks, then one pdfDoc.save() that serialises the whole
  // document. There is no yield point in that chain, and this route has no
  // maxDuration entry in vercel.json, so it inherits the platform default.
  //
  // The bound is set from what an export actually is rather than from the
  // helper's 200k default: one row per active asset in the org for one tax
  // year (UNIQUE (asset_id, tax_year)). Production today is 160 active assets
  // across 27 properties — about 6 per property — and CLAUDE.md's target user
  // runs 10-50 properties, so a real export is a few hundred rows and the PDF
  // work is milliseconds. CPA_EXPORT_MAX_ENTRIES sits far above any plausible
  // org while still turning the pathological case into a clear, actionable
  // message instead of a request killed mid-serialisation with nothing to
  // explain it.
  //
  // If an org ever legitimately approaches this, the fix is not a bigger
  // number — it is moving generation off the request path onto an Inngest job
  // that writes to Storage and hands back a signed URL, the same shape the
  // org_milestones polling pattern already uses elsewhere.
  // Counted BEFORE anything is shipped over the wire: `head: true` returns the
  // count with no rows at all, so the guard costs one cheap round-trip rather
  // than draining every page and then discovering it was too many.
  const countRes = await supabase
    .from('asset_depreciation_entries')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', membership.org_id)
    .eq('tax_year', taxYear)

  if (countRes.error) {
    unwrap(countRes, { site: 'route.assets.cpa-export.count', orgId: membership.org_id })
  }

  if ((countRes.count ?? 0) > CPA_EXPORT_MAX_ENTRIES) {
    return Response.json(
      {
        error:
          `This export covers ${countRes.count!.toLocaleString()} depreciation entries, past the ` +
          `${CPA_EXPORT_MAX_ENTRIES.toLocaleString()} that can be generated in a single request. ` +
          'Contact support so this can be produced as a background job.',
      },
      { status: 413 },
    )
  }

  const entries = await fetchAllRows(
    (from, to) => supabase
      .from('asset_depreciation_entries')
      .select(`
        id, asset_id, tax_year, macrs_class,
        cost_basis, prior_cumulative_depreciation,
        current_year_depreciation, ending_adjusted_basis,
        depreciation_rate,
        property_assets (
          name, placed_in_service_date, installation_date, manufacture_date, property_id,
          properties ( name )
        )
      `)
      .eq('org_id', membership.org_id)
      .eq('tax_year', taxYear)
      .order('asset_id')
      .range(from, to),
    { label: 'cpa-export.entries', maxRows: CPA_EXPORT_MAX_ENTRIES },
  )

  if (!entries?.length) {
    return new Response(
      JSON.stringify({ error: `No depreciation entries for ${taxYear}. Generate the ledger first.` }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const byProperty = groupEntriesByProperty(entries)

  // ── Build PDF ───────────────────────────────────────────────────────────────

  const pdfDoc   = await PDFDocument.create()
  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  drawCoverPage(pdfDoc, { font, boldFont, orgName: org?.name ?? 'FieldStay', taxYear, entries })

  const grandTotal = drawPropertyPages(pdfDoc, { font, boldFont, byProperty })

  // Grand total on last page — append to last page
  const pages    = pdfDoc.getPages()
  const lastPage = pages[pages.length - 1]
  lastPage.drawRectangle({ x: ML, y: MB - 4, width: CW, height: 22, color: GRAY_DARK })
  lastPage.drawText('GRAND TOTAL — Current Year Depreciation', { x: ML + 8, y: MB + 5, size: 9, font: boldFont, color: WHITE })
  lastPage.drawText(fmt$(grandTotal), {
    x: W - MR - 120, y: MB + 5, size: 11, font: boldFont, color: GOLD,
  })

  drawEstimatedDateNote(pdfDoc, font, boldFont, entries)

  // ── Serialize ───────────────────────────────────────────────────────────────

  const pdfBytes = await pdfDoc.save()
  const buffer   = Buffer.from(pdfBytes)

  return new Response(buffer, {
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="depreciation-schedule-${taxYear}.pdf"`,
      'Content-Length':      String(buffer.byteLength),
    },
  })
}
