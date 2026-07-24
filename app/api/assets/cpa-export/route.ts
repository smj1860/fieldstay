/**
 * CPA Export PDF — GET /api/assets/cpa-export?tax_year=2025
 *
 * Generates a depreciation schedule PDF (IRS Pub. 946 format)
 * using pdf-lib. Groups entries by property, then by asset.
 * Includes cover page with disclaimer.
 */

import { createServiceClient } from '@/lib/supabase/server'
import { requireOrgMember }   from '@/lib/auth'
import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib'
import { MACRS_LABELS } from '@/lib/assets/depreciation'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type { MacrsClass } from '@/types/database'

// ── Layout constants ──────────────────────────────���───────────────────────────

const W  = 792  // Letter landscape width (pts)
const H  = 612  // Letter landscape height
const ML = 48   // margin left
const MR = 48   // margin right
const MT = 48   // margin top
const MB = 40   // margin bottom
const CW = W - ML - MR  // content width

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

export async function GET(req: Request) {
  // Auth
  const { membership } = await requireOrgMember()
  const supabase = createServiceClient()

  const url     = new URL(req.url)
  const taxYear = parseInt(url.searchParams.get('tax_year') ?? String(new Date().getFullYear() - 1), 10)

  // Load org name
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', membership.org_id)
    .single()

  // Load depreciation entries with asset + property names
  const { data: entries } = await supabase
    .from('asset_depreciation_entries')
    .select(`
      id, asset_id, tax_year, macrs_class,
      cost_basis, prior_cumulative_depreciation,
      current_year_depreciation, ending_adjusted_basis,
      depreciation_rate,
      property_assets (
        name, placed_in_service_date, property_id,
        properties ( name )
      )
    `)
    .eq('org_id', membership.org_id)
    .eq('tax_year', taxYear)
    .order('asset_id')

  if (!entries?.length) {
    return new Response(
      JSON.stringify({ error: `No depreciation entries for ${taxYear}. Generate the ledger first.` }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // Group by property
  const byProperty: Record<string, {
    propertyName: string
    rows: typeof entries
  }> = {}

  for (const e of entries) {
    const asset = unwrapJoin(e.property_assets)
    const propName = unwrapJoin(asset?.properties)?.name ?? 'Unknown Property'
    const propKey  = propName

    if (!byProperty[propKey]) byProperty[propKey] = { propertyName: propName, rows: [] }
    byProperty[propKey].rows.push(e)
  }

  // ── Build PDF ───────────────────────────────────────────────────────────────

  const pdfDoc   = await PDFDocument.create()
  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  // ── Cover Page ──────────────────────────────────────────────────────────────

  const cover = pdfDoc.addPage([W, H])

  cover.drawRectangle({ x: 0, y: H - 120, width: W, height: 120, color: GRAY_DARK })
  cover.drawText('DEPRECIATION SCHEDULE', { x: ML, y: H - 55, size: 22, font: boldFont, color: GOLD })
  cover.drawText(`Tax Year ${taxYear}`, { x: ML, y: H - 80, size: 14, font, color: WHITE })
  cover.drawText(org?.name ?? 'FieldStay', { x: ML, y: H - 100, size: 11, font, color: GRAY_LIGHT })

  cover.drawText('Prepared for use with IRS Publication 946', { x: ML, y: H - 150, size: 10, font, color: GRAY_MED })
  cover.drawText(`Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, {
    x: ML, y: H - 168, size: 9, font, color: GRAY_MED,
  })

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

  // Summary stats
  const totalCurrentDepr = entries.reduce((s: number, e) => s + (e.current_year_depreciation as number), 0)
  const totalBasis       = entries.reduce((s: number, e) => s + (e.cost_basis as number), 0)
  const totalEndingBasis = entries.reduce((s: number, e) => s + (e.ending_adjusted_basis as number), 0)

  const stats = [
    { label: 'Total Assets',             value: String(entries.length) },
    { label: 'Total Cost Basis',          value: fmt$(totalBasis) },
    { label: `${taxYear} Depreciation`,   value: fmt$(totalCurrentDepr) },
    { label: 'Total Ending Basis',        value: fmt$(totalEndingBasis) },
  ]

  let sx = ML
  for (const { label, value } of stats) {
    cover.drawRectangle({ x: sx, y: dy - 50, width: 160, height: 56, color: ROW_BG, borderColor: rgb(0.88, 0.90, 0.94), borderWidth: 1 })
    cover.drawText(value, { x: sx + 8, y: dy - 22, size: 14, font: boldFont, color: GRAY_DARK })
    cover.drawText(label, { x: sx + 8, y: dy - 36, size: 8,  font,           color: GRAY_MED })
    sx += 170
  }

  // ── Data Pages (by property) ─────────────────────────────────────────────────

  let grandTotal = 0

  for (const { propertyName, rows } of Object.values(byProperty)) {
    let page = pdfDoc.addPage([W, H])
    let y    = H - MT

    // Property header
    page.drawRectangle({ x: ML, y: y - 24, width: CW, height: 24, color: GRAY_DARK })
    page.drawText(propertyName, { x: ML + 8, y: y - 16, size: 11, font: boldFont, color: WHITE })
    y -= 24

    // Table header
    y = drawTableHeader(page, y, boldFont as never, pdfDoc)

    // Rows
    let rowIndex    = 0
    let propTotal   = 0

    for (const entry of rows) {
      // Page break check — need ~20pts per row + ~40 footer
      if (y - 20 < MB + 40) {
        page = pdfDoc.addPage([W, H])
        y    = H - MT
        page.drawText(`${propertyName} (cont.)`, { x: ML, y: y - 14, size: 9, font, color: GRAY_MED })
        y -= 20
        y = drawTableHeader(page, y, boldFont as never, pdfDoc)
      }

      const rowY  = y - 14
      const rowBg = rowIndex % 2 === 1 ? ROW_BG : WHITE
      page.drawRectangle({ x: ML, y: y - 18, width: CW, height: 18, color: rowBg })

      const asset = unwrapJoin(entry.property_assets)
      const assetName   = asset?.name ?? '—'
      const placedDate  = asset?.placed_in_service_date?.slice(0, 10) ?? '—'
      const macrsLabel  = MACRS_LABELS[entry.macrs_class as MacrsClass] ?? String(entry.macrs_class)

      const cells = [
        { text: assetName,                   w: COLS.name,    bold: false },
        { text: placedDate,                  w: COLS.placed,  bold: false },
        { text: macrsLabel,                  w: COLS.macrs,   bold: false },
        { text: fmt$(entry.cost_basis as number),                    w: COLS.basis,   bold: false },
        { text: fmt$(entry.prior_cumulative_depreciation as number), w: COLS.prior,   bold: false },
        { text: fmt$(entry.current_year_depreciation as number),     w: COLS.current, bold: true  },
        { text: fmt$(entry.ending_adjusted_basis as number),         w: COLS.ending,  bold: false },
      ]

      let cx = ML + 6
      for (const cell of cells) {
        // Clip long text
        let text = cell.text
        const maxChars = Math.floor(cell.w / 5)
        if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '…'

        page.drawText(text, {
          x: cx, y: rowY,
          size: 7.5,
          font: cell.bold ? boldFont : font,
          color: GRAY_DARK,
        })
        cx += cell.w
      }

      propTotal += entry.current_year_depreciation as number
      y         -= 18
      rowIndex++
    }

    // Property total row
    page.drawRectangle({ x: ML, y: y - 18, width: CW, height: 18, color: GRAY_DARK })
    page.drawText(`${propertyName} Total`, { x: ML + 6, y: y - 13, size: 8, font: boldFont, color: WHITE })
    page.drawText(fmt$(propTotal), {
      x: ML + COLS.name + COLS.placed + COLS.macrs + COLS.basis + COLS.prior + 6,
      y: y - 13, size: 8, font: boldFont, color: GOLD,
    })
    y -= 18

    grandTotal += propTotal
  }

  // Grand total on last page — append to last page
  const pages    = pdfDoc.getPages()
  const lastPage = pages[pages.length - 1]
  lastPage.drawRectangle({ x: ML, y: MB - 4, width: CW, height: 22, color: GRAY_DARK })
  lastPage.drawText('GRAND TOTAL — Current Year Depreciation', { x: ML + 8, y: MB + 5, size: 9, font: boldFont, color: WHITE })
  lastPage.drawText(fmt$(grandTotal), {
    x: W - MR - 120, y: MB + 5, size: 11, font: boldFont, color: GOLD,
  })

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
