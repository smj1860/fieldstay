// lib/evidence/packet/render.ts
//
// The claim packet, drawn. pdf-lib with standard fonts and a hand-managed
// cursor, the same approach as lib/inspections/report/render.ts, whose text
// helpers (toWinAnsi, wrapText) it reuses: every string here is user text
// (property names, inspector labels) and drawText THROWS on a character outside
// WinAnsi, which would take down the whole document.
//
// Photographs are fetched and embedded in batches of EMBED_BATCH, and each
// buffer is dropped the moment its image is embedded, so at most one batch of
// raw bytes is alive at once (the cap is MAX_PACKET_PHOTOS, each up to 10MB).
//
// WHAT THE DOCUMENT MAY CLAIM. It states what the ledger recorded: when each
// file arrived, what time the device claimed and by how much that was corrected,
// and whether the stored file's SHA-256 matched the hash taken on the device at
// capture. It does not assert legal admissibility or that a platform will
// accept it. "Hash verified" is a statement about bytes, not about the scene.
import 'server-only'
import {
  PDFDocument, StandardFonts, rgb,
  type PDFFont, type PDFImage, type PDFPage, type RGB,
} from 'pdf-lib'
import { chunkArray } from '@/lib/inngest/chunk'
import { toWinAnsi, wrapText } from '@/lib/inspections/report/text'
import type { PacketModel, CustodyRow } from './model'
import type { PacketEvent, RoomPair } from './pairing'

export type PhotoFormat = 'jpeg' | 'png'
export interface FetchedPhoto { bytes: Uint8Array; format: PhotoFormat }
export type FetchPhoto = (event: PacketEvent) => Promise<FetchedPhoto | null>

export const EMBED_BATCH = 8

const W = 612
const H = 792
const M = 54
const CW = W - M * 2
const GAP = 12
const COL_W = (CW - GAP) / 2
const PHOTO_H = 190

const INK       = rgb(0.15, 0.18, 0.25)
const MUTED     = rgb(0.35, 0.40, 0.50)
const RULE      = rgb(0.65, 0.70, 0.78)
const GREEN     = rgb(0.13, 0.45, 0.28)
const AMBER     = rgb(0.70, 0.45, 0.05)
const BOX_BG    = rgb(0.96, 0.97, 0.99)
const FOOTER_LIMIT = M + 24

interface Cursor {
  pdf:    PDFDocument
  page:   PDFPage
  y:      number
  font:   PDFFont
  bold:   PDFFont
  images: Map<string, PDFImage>
}

/** "Mar 3, 2026, 2:15 PM CST" in the property's timezone; ISO UTC if the zone is bad. */
export function formatZoned(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone, month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(iso))
  } catch {
    return `${new Date(iso).toISOString()} UTC`
  }
}

/** How the capture time was established, in words a claims reviewer can check. */
export function timingNote(e: Pick<PacketEvent, 'captured_at_source' | 'device_clock_offset_seconds'>): string {
  if (e.captured_at_source === 'server') return 'Time is the server receipt time (the device clock was not used).'
  const off = e.device_clock_offset_seconds ?? 0
  if (off === 0) return 'Device clock, no correction needed.'
  const dir = off > 0 ? 'behind' : 'ahead of'
  return `Device clock, corrected: it was ${Math.abs(off)} seconds ${dir} the server.`
}

export function gpsNote(e: Pick<PacketEvent, 'lat' | 'lng' | 'gps_accuracy_m'>): string {
  if (e.lat === null || e.lng === null) return 'No GPS recorded.'
  const acc = e.gps_accuracy_m === null ? '' : `, accuracy ${Math.round(e.gps_accuracy_m)} m`
  return `GPS ${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}${acc}`
}

const t = toWinAnsi

function newPage(cur: Cursor): void {
  cur.page = cur.pdf.addPage([W, H])
  cur.y = H - M
}

function ensure(cur: Cursor, need: number): void {
  if (cur.y - need < FOOTER_LIMIT) newPage(cur)
}

function drawText(cur: Cursor, body: string, o: { x?: number; size: number; color?: RGB; bold?: boolean }): void {
  cur.page.drawText(t(body), {
    x: o.x ?? M, y: cur.y, size: o.size, font: o.bold ? cur.bold : cur.font, color: o.color ?? INK,
  })
}

function paragraph(cur: Cursor, body: string, size: number, color: RGB = INK, width: number = CW, x: number = M): void {
  const lines = wrapText(t(body), cur.font, size, width)
  for (const l of lines) {
    ensure(cur, size + 3)
    cur.y -= size + 3
    cur.page.drawText(l, { x, y: cur.y, size, font: cur.font, color })
  }
}

function heading(cur: Cursor, body: string, size: number): void {
  ensure(cur, size + 14)
  cur.y -= size + 6
  drawText(cur, body, { size, bold: true })
  cur.y -= 4
}

function rule(cur: Cursor): void {
  cur.page.drawLine({ start: { x: M, y: cur.y }, end: { x: W - M, y: cur.y }, thickness: 0.5, color: RULE })
  cur.y -= 8
}

function keyValue(cur: Cursor, key: string, value: string): void {
  ensure(cur, 16)
  cur.y -= 14
  drawText(cur, key, { size: 9, color: MUTED })
  cur.page.drawText(t(value), { x: M + 120, y: cur.y, size: 10, font: cur.font, color: INK })
}

// ── Photographs ──────────────────────────────────────────────────────────────

function photoEvents(model: PacketModel): PacketEvent[] {
  const out: PacketEvent[] = []
  for (const p of model.pairs) {
    if (p.before) out.push(p.before)
    if (p.after) out.push(p.after)
  }
  out.push(...model.others)
  return out
}

async function embedOne(pdf: PDFDocument, fetchPhoto: FetchPhoto, e: PacketEvent): Promise<[string, PDFImage] | null> {
  try {
    const photo = await fetchPhoto(e)
    if (!photo) return null
    const image = photo.format === 'png' ? await pdf.embedPng(photo.bytes) : await pdf.embedJpg(photo.bytes)
    return [e.id, image]
  } catch {
    // A corrupt or unreadable file costs its own tile (drawn as a labelled box),
    // never the document.
    return null
  }
}

async function embedAll(pdf: PDFDocument, fetchPhoto: FetchPhoto, events: readonly PacketEvent[]): Promise<Map<string, PDFImage>> {
  const images = new Map<string, PDFImage>()
  for (const batch of chunkArray(events, EMBED_BATCH)) {
    const done = await Promise.all(batch.map((e) => embedOne(pdf, fetchPhoto, e))) // NOSONAR -- bounded concurrency by design: EMBED_BATCH photos at a time caps peak memory in the PDF render
    for (const d of done) if (d) images.set(d[0], d[1])
  }
  return images
}

function drawPhotoBox(cur: Cursor, e: PacketEvent | null, x: number, width: number, top: number): void {
  const bottom = top - PHOTO_H
  cur.page.drawRectangle({ x, y: bottom, width, height: PHOTO_H, color: BOX_BG, borderColor: RULE, borderWidth: 0.5 })
  const image = e ? cur.images.get(e.id) : undefined
  if (!image) {
    const msg = e ? 'Photograph could not be embedded. See chain of custody.' : 'No photograph on this side.'
    cur.page.drawText(t(msg), { x: x + 8, y: top - PHOTO_H / 2, size: 8, font: cur.font, color: MUTED })
    return
  }
  const scale = Math.min((width - 8) / image.width, (PHOTO_H - 8) / image.height)
  const w = image.width * scale
  const h = image.height * scale
  cur.page.drawImage(image, { x: x + (width - w) / 2, y: bottom + (PHOTO_H - h) / 2, width: w, height: h })
}

function captionLines(label: string, e: PacketEvent | null, timeZone: string): { text: string; color: RGB }[] {
  if (!e) return [{ text: label, color: MUTED }]
  const who = e.captured_by_label ? `${e.captured_by_kind} (${e.captured_by_label})` : e.captured_by_kind
  return [
    { text: `${label}: ${formatZoned(e.captured_at, timeZone)}`, color: INK },
    { text: `Captured by ${who}. ${timingNote(e)}`, color: MUTED },
    { text: e.hash_verified ? 'Hash verified: stored file matches the hash taken at capture.' : 'Hash not verified.', color: e.hash_verified ? GREEN : AMBER },
    { text: gpsNote(e), color: MUTED },
  ]
}

function drawCaption(cur: Cursor, lines: { text: string; color: RGB }[], x: number, width: number, top: number): number {
  let y = top
  for (const l of lines) {
    for (const wrapped of wrapText(t(l.text), cur.font, 7.5, width)) {
      y -= 10
      cur.page.drawText(wrapped, { x, y, size: 7.5, font: cur.font, color: l.color })
    }
  }
  return top - y
}

/** Height a caption will take, so the pair is kept together on one page. */
function captionHeight(cur: Cursor, lines: { text: string }[], width: number): number {
  return lines.reduce((h, l) => h + wrapText(t(l.text), cur.font, 7.5, width).length * 10, 0)
}

function drawPair(cur: Cursor, pair: RoomPair, timeZone: string): void {
  const beforeCap = captionLines('Before the stay', pair.before, timeZone)
  const afterCap  = captionLines('After the stay', pair.after, timeZone)
  const capH = Math.max(captionHeight(cur, beforeCap, COL_W), captionHeight(cur, afterCap, COL_W))
  ensure(cur, 24 + PHOTO_H + capH + 14)

  cur.y -= 14
  drawText(cur, `${pair.sectionName}: ${pair.label}`, { size: 10, bold: true })
  cur.y -= 6
  const top = cur.y
  drawPhotoBox(cur, pair.before, M, COL_W, top)
  drawPhotoBox(cur, pair.after, M + COL_W + GAP, COL_W, top)
  const used = Math.max(
    drawCaption(cur, beforeCap, M, COL_W, top - PHOTO_H - 2),
    drawCaption(cur, afterCap, M + COL_W + GAP, COL_W, top - PHOTO_H - 2),
  )
  cur.y = top - PHOTO_H - 2 - used - 10
}

function drawSingle(cur: Cursor, e: PacketEvent, timeZone: string): void {
  const side = e.position === 'pre_stay' ? 'Before the stay' : 'After the stay'
  const cap = captionLines(side, e, timeZone)
  ensure(cur, PHOTO_H + captionHeight(cur, cap, CW) + 24)
  cur.y -= 8
  const top = cur.y
  drawPhotoBox(cur, e, M, COL_W, top)
  const used = drawCaption(cur, cap, M + COL_W + GAP, COL_W, top - 4)
  cur.y = top - Math.max(PHOTO_H, used) - 12
}

// ── Cover, body, appendix ────────────────────────────────────────────────────

function drawCover(cur: Cursor, model: PacketModel, shown: number): void {
  cur.y -= 22
  drawText(cur, 'Damage Claim Evidence Packet', { size: 20, bold: true })
  cur.y -= 8
  rule(cur)
  const { stay, property } = model
  keyValue(cur, 'Property', property.name)
  if (property.address) keyValue(cur, 'Address', property.address)
  keyValue(cur, 'Stay', `${stay.checkin} to ${stay.checkout}`)
  keyValue(cur, 'Platform', stay.source ?? 'Not recorded')
  keyValue(cur, 'Reservation ref.', stay.reservationRef)
  keyValue(cur, 'Prepared by', model.org.name || 'Property manager')
  keyValue(cur, 'Prepared on', formatZoned(model.generatedAt, property.timezone))
  keyValue(cur, 'Photographs', `${shown} shown, ${model.custody.length} ledger entries cited`)
  cur.y -= 10
  rule(cur)
  paragraph(cur, 'How to read this packet. Each photograph was sealed in the FieldStay evidence ledger when it arrived. '
    + 'The ledger is append-only: entries cannot be edited or removed. For each photograph the packet shows when it was taken '
    + '(in the property\'s timezone), who took it, and whether the stored file\'s SHA-256 matched the hash computed on the '
    + 'device at the moment of capture. "Hash verified" speaks to the file, not to the scene it shows.', 9, MUTED)
  if (model.capNote) {
    cur.y -= 6
    paragraph(cur, model.capNote, 9, AMBER)
  }
}

function drawBody(cur: Cursor, model: PacketModel): void {
  const tz = model.property.timezone
  if (model.pairs.length > 0) {
    newPage(cur)
    heading(cur, 'Before and after, by room', 13)
    for (const pair of model.pairs) drawPair(cur, pair, tz)
  }
  if (model.others.length > 0) {
    newPage(cur)
    heading(cur, 'Other photographs', 13)
    for (const e of model.others) drawSingle(cur, e, tz)
  }
}

const DISPOSITION_TEXT: Record<CustodyRow['disposition'], string> = {
  shown:     'shown in this packet',
  retake:    'superseded by a retake, not drawn',
  over_cap:  'over the photo cap, not drawn',
  withdrawn: 'withdrawn by its uploader, not drawn',
}

function sideLabel(position: CustodyRow['position']): string {
  if (position === null) return ''
  return position === 'pre_stay' ? '  before' : '  after'
}

function drawCustodyEntry(cur: Cursor, n: number, r: CustodyRow, tz: string): void {
  const side = sideLabel(r.position)
  const received = `Received ${formatZoned(r.received_at, tz)}.`
  const device = r.device_captured_at
    ? ` Device claimed ${formatZoned(r.device_captured_at, tz)}.`
    : ''
  const lines = [
    { text: `${n}. ${r.kind}${side}  ${r.id}`, bold: true, color: INK },
    { text: `Captured ${formatZoned(r.captured_at, tz)} by ${r.captured_by}.${device} ${received}`, bold: false, color: MUTED },
    { text: `${r.hash_verified ? 'Hash verified' : 'Hash not verified'}; ${DISPOSITION_TEXT[r.disposition]}. SHA-256 ${r.sha256}`, bold: false, color: r.hash_verified ? GREEN : AMBER },
  ]
  const wrapped = lines.map((l) => ({ ...l, rows: wrapText(t(l.text), l.bold ? cur.bold : cur.font, 7.5, CW) }))
  const need = wrapped.reduce((h, l) => h + l.rows.length * 10, 0) + 8
  ensure(cur, need)
  for (const l of wrapped) {
    for (const row of l.rows) {
      cur.y -= 10
      cur.page.drawText(row, { x: M, y: cur.y, size: 7.5, font: l.bold ? cur.bold : cur.font, color: l.color })
    }
  }
  cur.y -= 8
}

function drawCustody(cur: Cursor, model: PacketModel): void {
  newPage(cur)
  heading(cur, 'Chain of custody', 13)
  paragraph(cur, 'Every ledger entry cited by this packet, oldest first, including photographs not drawn above and '
    + 'withdrawals. Times are in the property\'s timezone.', 8.5, MUTED)
  cur.y -= 6
  model.custody.forEach((r, i) => drawCustodyEntry(cur, i + 1, r, model.property.timezone))
}

function drawFooters(pdf: PDFDocument, font: PDFFont, model: PacketModel): void {
  const pages = pdf.getPages()
  const stamp = t(`Packet ${model.packetId}. Generated ${formatZoned(model.generatedAt, model.property.timezone)}`)
  pages.forEach((page, i) => {
    page.drawLine({ start: { x: M, y: M + 14 }, end: { x: W - M, y: M + 14 }, thickness: 0.5, color: RULE })
    page.drawText(stamp, { x: M, y: M + 2, size: 7, font, color: MUTED })
    const n = `Page ${i + 1} of ${pages.length}`
    page.drawText(n, { x: W - M - font.widthOfTextAtSize(n, 7), y: M + 2, size: 7, font, color: MUTED })
  })
}

export async function renderClaimPacket(model: PacketModel, fetchPhoto: FetchPhoto): Promise<Uint8Array> {
  const pdf  = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  const events = photoEvents(model)
  const images = await embedAll(pdf, fetchPhoto, events)
  const cur: Cursor = { pdf, page: pdf.addPage([W, H]), y: H - M, font, bold, images }

  drawCover(cur, model, events.length)
  drawBody(cur, model)
  drawCustody(cur, model)
  drawFooters(pdf, font, model)
  return pdf.save()
}
