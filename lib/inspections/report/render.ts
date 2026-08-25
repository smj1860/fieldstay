import 'server-only'

import {
  PDFDocument, StandardFonts, rgb,
  type PDFFont, type PDFImage, type PDFPage, type RGB,
} from 'pdf-lib'

import { toWinAnsi, wrapText, formatStamp } from './text'
import {
  actionsLine,
  attachmentLine,
  historyCapNote,
  metaRows,
  remediationLine,
  statusLabel,
  type Tone,
} from './content'
import type {
  InspectionReport,
  ReportInspection,
  ReportAnswer,
  ReportSection,
  ReportPhoto,
} from './model'

// The inspection report, drawn.
//
// Copies app/api/assets/cpa-export/route.ts's approach — pdf-lib, standard
// fonts, a hand-managed cursor — and differs from it in two ways that are not
// stylistic.
//
// PORTRAIT, because this is a document rather than a wide table.
//
// AND IT WRAPS RATHER THAN CLIPS. The CPA export truncates a cell at
// `width / 5` characters with an ellipsis, which is right for a column of asset
// names. The strings that overflow here are failure descriptions, and §5 makes
// those the work order's title precisely because the detail is what makes them
// actionable. See wrapText in ./text.ts.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE SIGN-OFF BLOCK MAY CLAIM
//
// §12.1 records two lines of the paper sign-off as RENDERING requirements
// rather than form items: the date, from `started_at`; and "Attached
// Documentation: Photo Log appended to report".
//
// The second is CONDITIONAL here, and it has to be. Photos are PM-only, so the
// owner's copy has no photo log — and a line asserting an appendix that is not
// there is a false statement on a document whose whole value is that it can be
// relied on. The owner's copy says where the photographs are instead.

// ── Geometry ─────────────────────────────────────────────────────────────────

const W  = 612   // Letter portrait
const H  = 792
const M  = 54    // margin
const CW = W - M * 2

const GRAY_DARK  = rgb(0.15, 0.18, 0.25)
const GRAY_MED   = rgb(0.35, 0.40, 0.50)
const GRAY_LIGHT = rgb(0.65, 0.70, 0.78)
const GOLD       = rgb(0.98, 0.82, 0.07)
const WHITE      = rgb(1, 1, 1)
const RED        = rgb(0.72, 0.18, 0.18)
const GREEN      = rgb(0.13, 0.45, 0.28)
const ROW_BG     = rgb(0.96, 0.97, 0.99)

/** Room a photo may take, before its caption. Page-height bound, not a guess. */
const PHOTO_MAX_W = CW
const PHOTO_MAX_H = 380

interface Cursor {
  pdf:  PDFDocument
  page: PDFPage
  y:    number
  font: PDFFont
  bold: PDFFont
  /**
   * Every photograph already embedded, keyed by answer id.
   *
   * Embedding is ASYNC (`embedJpg`/`embedPng` return promises) and the cursor
   * walk below is not. Rather than colour the whole draw tree async for one
   * call, every image is embedded up front — which also means a corrupt file is
   * discovered before a single page is drawn rather than halfway down one.
   */
  images: Map<string, PDFImage>
}

export async function renderInspectionReport(report: InspectionReport): Promise<Uint8Array> {
  const pdf  = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  const images = await embedPhotos(pdf, report)
  const cur: Cursor = { pdf, page: pdf.addPage([W, H]), y: H - M, font, bold, images }

  // A cover page only earns its place on a multi-walk history, where a reader
  // needs to know the span and the count before the first letterhead. On a
  // single inspection it would be a page restating the page after it.
  if (report.inspections.length > 1) {
    drawHistoryCover(cur, report)
    newPage(cur)
  }

  report.inspections.forEach((inspection, i) => {
    if (i > 0) newPage(cur)
    drawInspection(cur, report, inspection)
  })

  // LAST, because a footer says "page 3 of 11" and the total is not known until
  // every page exists.
  drawFooters(pdf, font, report)

  return pdf.save()
}

// ── Cover ────────────────────────────────────────────────────────────────────

function drawHistoryCover(cur: Cursor, report: InspectionReport): void {
  band(cur, 'PROPERTY INSPECTION HISTORY')

  cur.y -= 14
  heading(cur, report.propertyName, 18)
  const org = report.inspections[0]?.header?.org_name
  if (org) line(cur, org, 10, GRAY_MED)

  cur.y -= 10
  const dates = report.inspections.map((i) => i.completedAt).sort()
  line(cur, `${report.inspections.length} completed inspections`, 11, GRAY_DARK)
  line(cur, `${formatStamp(dates[0]!)} — ${formatStamp(dates[dates.length - 1]!)}`, 10, GRAY_MED)

  // A CAP THAT IS NOT STATED is an assertion of completeness. This document's
  // entire claim is that it is the whole record, so the one case where it is
  // not says so on its first page rather than in a comment.
  const capNote = historyCapNote(report)
  if (capNote) {
    cur.y -= 8
    paragraph(cur, capNote, 9, RED)
  }

  cur.y -= 14
  paragraph(cur,
    'Work order and purchase order statuses in this report are current as of the generation date '
    + 'below, not as of each inspection. The findings themselves are permanent and cannot be edited; '
    + 'their remediation status continues to change as the work is completed.', 9, GRAY_MED)

  cur.y -= 16
  heading(cur, 'Contents', 11)
  for (const inspection of report.inspections) {
    ensure(cur, 16)
    const label = `${formatStamp(inspection.completedAt)} — ${inspection.formLabel}`
    text(cur, label, M, cur.y, 9, cur.font, GRAY_DARK)
    const tally = `${inspection.passCount} passed, ${inspection.failCount} failed`
    textRight(cur, tally, W - M, cur.y, 9, cur.font, inspection.failCount > 0 ? RED : GREEN)
    cur.y -= 14
  }
}

// ── One inspection ───────────────────────────────────────────────────────────

function drawInspection(cur: Cursor, report: InspectionReport, ins: ReportInspection): void {
  band(cur, toWinAnsi(ins.formLabel).toUpperCase())

  cur.y -= 12
  heading(cur, ins.header?.property_name ?? report.propertyName, 15)
  if (ins.header?.property_address) line(cur, ins.header.property_address, 9, GRAY_MED)
  if (ins.header?.org_name)         line(cur, ins.header.org_name, 9, GRAY_MED)

  cur.y -= 10
  drawMeta(cur, ins)
  cur.y -= 10
  drawTally(cur, ins)

  for (const section of ins.sections) drawSection(cur, section)

  drawSignOff(cur, ins, report)
  if (report.photosIncluded) drawPhotoLog(cur, ins)
}

function drawMeta(cur: Cursor, ins: ReportInspection): void {
  // Every claim these rows make — including the device-clock qualification on
  // the inspection date — is decided in ./content.ts, where it is testable.
  for (const [label, value] of metaRows(ins)) {
    ensure(cur, 15)
    text(cur, label, M, cur.y, 8, cur.bold, GRAY_MED)
    text(cur, value, M + 110, cur.y, 9, cur.font, GRAY_DARK)
    cur.y -= 14
  }
}

/** A tone from ./content.ts, resolved to ink here so that file stays pure. */
function inkFor(tone: Tone): RGB {
  if (tone === 'good') return GREEN
  if (tone === 'bad')  return RED
  return GRAY_DARK
}

function drawTally(cur: Cursor, ins: ReportInspection): void {
  ensure(cur, 40)
  const facts = ins.sections.flatMap((s) => s.answers).filter((a) => a.isRecordOnly).length

  const chips: [string, string, RGB][] = [
    [String(ins.passCount), 'checks passed', GREEN],
    [String(ins.failCount), 'findings',      ins.failCount > 0 ? RED : GRAY_MED],
  ]
  if (facts > 0) chips.push([String(facts), 'facts recorded', GRAY_MED])

  let x = M
  for (const [value, label, color] of chips) {
    cur.page.drawRectangle({ x, y: cur.y - 30, width: 150, height: 36, color: ROW_BG })
    text(cur, value, x + 10, cur.y - 12, 15, cur.bold, color)
    text(cur, label, x + 10, cur.y - 25, 8, cur.font, GRAY_MED)
    x += 160
  }
  cur.y -= 44
}

function drawSection(cur: Cursor, section: ReportSection): void {
  // Keeps a heading with at least one answer under it. A section title stranded
  // alone at a page foot reads as a section with nothing in it.
  ensure(cur, 54)
  cur.page.drawRectangle({ x: M, y: cur.y - 16, width: CW, height: 18, color: GRAY_DARK })
  text(cur, toWinAnsi(section.name), M + 6, cur.y - 12, 9, cur.bold, WHITE)
  cur.y -= 26

  for (const answer of section.answers) drawAnswer(cur, answer)
  cur.y -= 6
}

function drawAnswer(cur: Cursor, answer: ReportAnswer): void {
  const promptLines = wrapText(answer.prompt, cur.font, 9, CW - 90)
  ensure(cur, promptLines.length * 12 + 16)

  const status = statusLabel(answer)
  const top = cur.y

  for (const l of promptLines) {
    text(cur, l, M + 8, cur.y, 9, cur.font, GRAY_DARK)
    cur.y -= 12
  }
  textRight(cur, status.label, W - M - 6, top, 9, cur.bold, inkFor(status.tone))

  drawAnswerDetail(cur, answer)
  cur.y -= 4
}

function drawAnswerDetail(cur: Cursor, answer: ReportAnswer): void {
  if (answer.note)     detail(cur, answer.note, GRAY_DARK)
  if (answer.naReason) detail(cur, `Not applicable: ${answer.naReason}`, GRAY_MED)

  const actions = actionsLine(answer)
  if (actions) detail(cur, actions, GRAY_MED)

  const remediation = remediationLine(answer)
  if (remediation) detail(cur, remediation, GRAY_MED)

  // A REQUIRED PHOTO THAT DOES NOT EXIST is recorded, not omitted. The reason
  // is free text specifically so it cannot be tapped through, and dropping it
  // from the report would turn a documented gap back into an undocumented one.
  if (answer.photoUnavailableReason) {
    detail(cur, `Photo not available: ${answer.photoUnavailableReason}`, GRAY_MED)
  }
}


function detail(cur: Cursor, body: string, color: RGB): void {
  for (const l of wrapText(body, cur.font, 8, CW - 40)) {
    ensure(cur, 11)
    text(cur, l, M + 22, cur.y, 8, cur.font, color)
    cur.y -= 10
  }
}

// ── Sign-off ─────────────────────────────────────────────────────────────────

/**
 * §12.1's two rendering requirements, plus an attribution the owner's copy
 * would otherwise lose.
 *
 * The certification text and the signature are FORM ITEMS (§12.1 items 41 and
 * 42) and have already been drawn in their own section above. What is added
 * here is what the paper block carried and the form does not ask: the date, and
 * where the photographs are.
 *
 * The signature is a photo, so it lives in the photo log — which the owner's
 * copy does not have. "Signed by" therefore prints the inspector's name in
 * both copies, so the owner's document is still an ATTRIBUTED, DATED
 * attestation rather than an unsigned one.
 */
function drawSignOff(cur: Cursor, ins: ReportInspection, report: InspectionReport): void {
  // `photosOnFile` is what the walk HAS; `embedded` is what reached a page.
  // They differ for the owner's copy (no bytes fetched) and for a photograph
  // that would not download or parse.
  const embedded = photosOf(ins).filter((e) => cur.images.has(e.answer.id)).length
  ensure(cur, 96)

  cur.page.drawRectangle({ x: M, y: cur.y - 18, width: CW, height: 20, color: GRAY_DARK })
  text(cur, 'INSPECTOR SIGN-OFF & VERIFICATION', M + 6, cur.y - 13, 9, cur.bold, GOLD)
  cur.y -= 30

  text(cur, 'Date of inspection', M, cur.y, 8, cur.bold, GRAY_MED)
  text(cur, formatStamp(ins.startedAt), M + 130, cur.y, 9, cur.font, GRAY_DARK)
  cur.y -= 14

  text(cur, 'Signed by', M, cur.y, 8, cur.bold, GRAY_MED)
  text(cur, ins.inspectorName ?? 'Not recorded', M + 130, cur.y, 9, cur.font, GRAY_DARK)
  cur.y -= 14

  text(cur, 'Attached documentation', M, cur.y, 8, cur.bold, GRAY_MED)
  text(cur, attachmentLine(report.photosIncluded, ins.photosOnFile, embedded),
    M + 130, cur.y, 9, cur.font, GRAY_DARK)
  cur.y -= 18
}


// ── Photo log ────────────────────────────────────────────────────────────────

function photosOf(ins: ReportInspection): { answer: ReportAnswer; photo: ReportPhoto }[] {
  return ins.sections
    .flatMap((s) => s.answers)
    .filter((a): a is ReportAnswer & { photo: ReportPhoto } => a.photo !== null)
    .map((a) => ({ answer: a, photo: a.photo }))
}

function drawPhotoLog(cur: Cursor, ins: ReportInspection): void {
  const photos = photosOf(ins)
  if (photos.length === 0) return

  newPage(cur)
  band(cur, 'PHOTO LOG')
  cur.y -= 12
  line(cur, `${ins.formLabel} — ${formatStamp(ins.completedAt)}`, 9, GRAY_MED)
  cur.y -= 8

  photos.forEach((entry, i) => drawPhotoEntry(cur, entry, i + 1))
}

function drawPhotoEntry(
  cur:   Cursor,
  entry: { answer: ReportAnswer; photo: ReportPhoto },
  index: number,
): void {
  const caption = wrapText(`${index}. ${entry.answer.prompt}`, cur.font, 8, CW)
  ensure(cur, caption.length * 10 + 40)

  for (const l of caption) {
    text(cur, l, M, cur.y, 8, cur.bold, GRAY_DARK)
    cur.y -= 10
  }

  const image = cur.images.get(entry.answer.id)
  if (!image) {
    // A photograph that will not embed is NAMED rather than dropped. The object
    // exists in the bucket; saying so lets someone retrieve it, where a silent
    // omission reads as no photo having been taken.
    text(cur, `[Image could not be embedded — ${toWinAnsi(entry.photo.path)}]`,
      M, cur.y, 8, cur.font, GRAY_MED)
    cur.y -= 16
    return
  }

  const scale = Math.min(PHOTO_MAX_W / image.width, PHOTO_MAX_H / image.height, 1)
  const w = image.width * scale
  const h = image.height * scale

  ensure(cur, h + 12)
  cur.page.drawImage(image, { x: M, y: cur.y - h, width: w, height: h })
  cur.y -= h + 16
}

/**
 * Embeds every photograph up front, skipping any that will not parse.
 *
 * The magic-byte check in ./model.ts screens the format, and this is STILL
 * wrapped per photo: a truncated upload has a perfectly valid JPEG header and a
 * corrupt body, and pdf-lib's parse throws on it. Losing the whole export over
 * one damaged file — when the walk, the findings and the work orders are all
 * already correct — is the wrong trade. The log names what it could not embed.
 */
async function embedPhotos(
  pdf:    PDFDocument,
  report: InspectionReport,
): Promise<Map<string, PDFImage>> {
  const out = new Map<string, PDFImage>()
  if (!report.photosIncluded) return out

  for (const ins of report.inspections) {
    for (const { answer, photo } of photosOf(ins)) {
      try {
        if (photo.format === 'jpeg')     out.set(answer.id, await pdf.embedJpg(photo.bytes))
        else if (photo.format === 'png') out.set(answer.id, await pdf.embedPng(photo.bytes))
      } catch {
        // Named in the log by its absence from this map — see drawPhotoEntry.
      }
    }
  }
  return out
}

// ── Primitives ───────────────────────────────────────────────────────────────

function newPage(cur: Cursor): void {
  cur.page = cur.pdf.addPage([W, H])
  cur.y    = H - M
}

/** Breaks to a new page when `need` points would run into the footer. */
function ensure(cur: Cursor, need: number): void {
  if (cur.y - need < M + 24) newPage(cur)
}

function band(cur: Cursor, title: string): void {
  cur.page.drawRectangle({ x: 0, y: cur.y - 10, width: W, height: 44, color: GRAY_DARK })
  text(cur, toWinAnsi(title), M, cur.y + 8, 13, cur.bold, GOLD)
  cur.y -= 24
}

function heading(cur: Cursor, body: string, size: number): void {
  ensure(cur, size + 8)
  text(cur, toWinAnsi(body), M, cur.y, size, cur.bold, GRAY_DARK)
  cur.y -= size + 4
}

function line(cur: Cursor, body: string, size: number, color: RGB): void {
  ensure(cur, size + 6)
  text(cur, toWinAnsi(body), M, cur.y, size, cur.font, color)
  cur.y -= size + 3
}

function paragraph(cur: Cursor, body: string, size: number, color: RGB): void {
  for (const l of wrapText(body, cur.font, size, CW)) {
    ensure(cur, size + 4)
    text(cur, l, M, cur.y, size, cur.font, color)
    cur.y -= size + 3
  }
}

/** The ONLY place drawText is called, so every string passes through toWinAnsi. */
function text(
  cur: Cursor, body: string, x: number, y: number, size: number, font: PDFFont, color: RGB,
): void {
  cur.page.drawText(toWinAnsi(body), { x, y, size, font, color })
}

function textRight(
  cur: Cursor, body: string, right: number, y: number, size: number, font: PDFFont, color: RGB,
): void {
  const safe = toWinAnsi(body)
  cur.page.drawText(safe, { x: right - font.widthOfTextAtSize(safe, size), y, size, font, color })
}

/**
 * Generated-at and page N of M on every page.
 *
 * The stamp is not decoration. §"The one place immutability is subtle" accepts
 * that two exports of the same inspection can differ in the remediation column,
 * on the condition that the difference is explainable — which it only is if
 * each copy says when it was taken.
 */
function drawFooters(pdf: PDFDocument, font: PDFFont, report: InspectionReport): void {
  const pages = pdf.getPages()
  const stamp = toWinAnsi(`Generated ${formatStamp(report.generatedAt, { withTime: true })}`)

  pages.forEach((page, i) => {
    page.drawLine({
      start: { x: M, y: M + 14 }, end: { x: W - M, y: M + 14 },
      thickness: 0.5, color: GRAY_LIGHT,
    })
    page.drawText(stamp, { x: M, y: M + 2, size: 7, font, color: GRAY_MED })
    const n = `Page ${i + 1} of ${pages.length}`
    page.drawText(n, {
      x: W - M - font.widthOfTextAtSize(n, 7), y: M + 2, size: 7, font, color: GRAY_MED,
    })
  })
}

