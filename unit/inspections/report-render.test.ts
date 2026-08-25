import { describe, it, expect, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'

import { toWinAnsi, wrapText, formatStamp } from '@/lib/inspections/report/text'
import {
  attachmentLine,
  actionsLine,
  conditionsLine,
  historyCapNote,
  metaRows,
  remediationLine,
  statusLabel,
} from '@/lib/inspections/report/content'
import { renderInspectionReport } from '@/lib/inspections/report/render'
import type {
  InspectionReport, ReportAnswer, ReportInspection,
} from '@/lib/inspections/report/model'

// ============================================================================
// THE EXPORTED REPORT.
//
// The claims the document makes are tested against ./content.ts, NOT against
// the rendered bytes. pdf-lib encodes text into the content stream, so nothing
// drawn is greppable in the saved file — verified, not assumed — which means a
// test that rendered a PDF and searched it for a phrase would report a
// confident pass whether or not the phrase was ever drawn.
//
// The render itself is smoke-tested for the things bytes CAN answer: that it
// produces a parseable document, that it survives text no standard PDF font can
// encode, and that a corrupt photograph costs one page rather than the export.
// ============================================================================

// ── WinAnsi, the one that turns a typo into a 500 ────────────────────────────

describe('toWinAnsi', () => {
  it('substitutes what drawText would THROW on', () => {
    // Verified against pdf-lib directly: emoji, CJK and "→" all raise
    // `WinAnsi cannot encode`. There is no lenient mode, so one emoji in a
    // failure description takes down the whole export — not the line, the
    // document. Every string on this report is user text.
    expect(toWinAnsi('Cracked tile 🙂')).toBe('Cracked tile ?')
    expect(toWinAnsi('湖畔小屋')).toBe('????')
    expect(toWinAnsi('A → B')).toBe('A ? B')
  })

  it('keeps what WinAnsi really has, including the 0x80–0x9F block', () => {
    // Latin-1 plus 27 characters where Latin-1 has controls. A phone keyboard
    // produces curly quotes by default, so treating the block as unencodable
    // would mangle the majority of typed notes.
    expect(toWinAnsi('Café façade')).toBe('Café façade')
    expect(toWinAnsi('Owner’s note — “fine”… • ½')).toBe('Owner’s note — “fine”… • ½')
  })

  it('flattens newlines and tabs to spaces', () => {
    // drawText draws one line; an embedded newline would either be dropped or
    // render as a box depending on the viewer.
    expect(toWinAnsi('line one\nline two\tend')).toBe('line one line two end')
  })
})

// ── Wrapping, because clipping a finding loses the finding ──────────────────

describe('wrapText', () => {
  const font = { widthOfTextAtSize: (t: string, s: number) => t.length * s * 0.5 }

  it('wraps on words, at a pixel width', () => {
    const lines = wrapText('handrail on the deck stairs is loose at the top bracket', font, 10, 100)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(100)
    expect(lines.join(' ')).toBe('handrail on the deck stairs is loose at the top bracket')
  })

  it('never loses text — this is the difference from the CPA export', () => {
    // That export clips a cell at width/5 characters with an ellipsis, which is
    // right for asset names. §5 makes a failure description the work order's
    // title precisely because the detail is what makes it actionable; clipping
    // it to "handrail on the deck stai…" throws away the half that carries the
    // meaning, on the evidentiary copy.
    const body = 'water heater TPR discharge pipe terminates above the pan rather than to the exterior'
    expect(wrapText(body, font, 9, 120).join(' ')).toBe(body)
  })

  it('hard-breaks a token longer than the line rather than running off the page', () => {
    const url = 'https://example.com/a/very/long/path/that/never/breaks/anywhere/at/all'
    const lines = wrapText(url, font, 10, 60)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(60)
    expect(lines.join('')).toBe(url)
  })

  it('terminates when maxWidth is narrower than one glyph', () => {
    // breakLongWord must advance at least one character per iteration. This
    // runs on a request thread, so a spin here is a hung export, not a slow one.
    expect(wrapText('abc', font, 10, 1)).toEqual(['a', 'b', 'c'])
  })

  it('sanitizes BEFORE measuring, because widthOfTextAtSize throws too', () => {
    // The ordering is load-bearing and easy to get backwards: pdf-lib raises
    // the same WinAnsi error from the measurement path as from drawText, so
    // wrapping unsanitized text throws before a single line is produced.
    const measured: string[] = []
    const spy = { widthOfTextAtSize: (t: string, s: number) => { measured.push(t); return t.length * s } }
    wrapText('tile 🙂 cracked', spy, 10, 1000)
    expect(measured.every((m) => !m.includes('🙂'))).toBe(true)
  })
})

// ── The attachment line ─────────────────────────────────────────────────────

describe('attachmentLine — the line that must never be printed unconditionally', () => {
  it('says photographs are ON FILE when this copy simply does not carry them', () => {
    // The owner's copy. This branch was UNREACHABLE in the first draft, because
    // the count came from loaded bytes and the owner path loads none — so a
    // walk that photographed everything would have printed "no photographs were
    // recorded". That is a worse falsehood than the omission it describes.
    expect(attachmentLine(false, 7, 0)).toBe('Photographs on file (7); not included in this copy')
  })

  it('says none were recorded only when none were', () => {
    expect(attachmentLine(false, 0, 0)).toBe('No photographs were recorded on this inspection')
    expect(attachmentLine(true,  0, 0)).toBe('No photographs were recorded on this inspection')
  })

  it('claims an appended log only when one is appended', () => {
    expect(attachmentLine(true, 3, 3)).toBe('Photo log appended — 3 photographs')
    expect(attachmentLine(true, 1, 1)).toBe('Photo log appended — 1 photograph')
  })

  it('admits a PARTIAL log rather than overstating it', () => {
    // A photograph that will not download or will not parse still exists in the
    // bucket. Printing "3 photographs" over a log holding 2 is the same class
    // of false claim as the owner case above.
    expect(attachmentLine(true, 3, 2))
      .toBe('Photo log appended — 2 of 3 photographs (1 could not be retrieved)')
    expect(attachmentLine(true, 3, 0))
      .toBe('3 photographs on file; none could be retrieved for this copy')
  })
})

// ── The other claims ────────────────────────────────────────────────────────

const answer = (over: Partial<ReportAnswer> = {}): ReportAnswer => ({
  id: 'a', prompt: 'Smoke detectors present', result: 'pass', value: null,
  note: null, naReason: null, actions: [], needsCleaning: false,
  isRecordOnly: false, photo: null, photoUnavailableReason: null,
  remediation: { kind: 'none' }, ...over,
})

const inspection = (over: Partial<ReportInspection> = {}): ReportInspection => ({
  id: 'i', propertyId: 'p', formKey: 'safety', formLabel: 'Safety & Risk Mitigation',
  formVersion: 3, header: null,
  startedAt: '2026-08-20T14:00:00.000Z', startedAtSource: 'server',
  completedAt: '2026-08-20T15:30:00.000Z', inspectorName: 'Dana Reed',
  sections: [], photosOnFile: 0, passCount: 0, failCount: 0, ...over,
})

describe('statusLabel', () => {
  it('answers a RECORD-ONLY item Yes or No, never Pass or Fail', () => {
    // "no alarm" is stored as a `fail` because it answers through the same
    // control. Printing FAIL asserts a deficiency where the honest answer was
    // simply no — and most short-term rentals have no alarm, so this would put
    // a red mark on the majority of properties for answering truthfully.
    expect(statusLabel(answer({ isRecordOnly: true, result: 'fail' })))
      .toEqual({ label: 'No', tone: 'neutral' })
    expect(statusLabel(answer({ isRecordOnly: true, result: 'pass' })))
      .toEqual({ label: 'Yes', tone: 'neutral' })
  })

  it('keeps PASS/FAIL/N-A for a real check', () => {
    expect(statusLabel(answer({ result: 'fail' }))).toEqual({ label: 'FAIL', tone: 'bad'  })
    expect(statusLabel(answer({ result: 'pass' }))).toEqual({ label: 'PASS', tone: 'good' })
    expect(statusLabel(answer({ result: 'na'   }))).toEqual({ label: 'N/A',  tone: 'neutral' })
  })

  it('prints the VALUE for a count/text/date item, which has no pass-fail', () => {
    expect(statusLabel(answer({ result: null, value: '0' })).label).toBe('0')
  })
})

describe('metaRows', () => {
  it('MARKS a start time that came from a device clock', () => {
    // §8: a walk can be started offline, and started_at is then the device's
    // time corrected by measured skew. The spec's phase-7 row says
    // "server-stamped", which is true of the alternatives it ruled out and not
    // of every row. Asserting the stronger claim on the weaker one's behalf is
    // the mistake ConditionsSnapshot's recorded/reported split exists to stop.
    const rows = new Map(metaRows(inspection({ startedAtSource: 'device' })))
    expect(rows.get('Inspection date')).toContain('(recorded on device)')
  })

  it('does not mark a server stamp', () => {
    const rows = new Map(metaRows(inspection()))
    expect(rows.get('Inspection date')).not.toContain('recorded on device')
  })

  it('omits Conditions entirely when the lookup never resolved', () => {
    // Offline is exactly when an outdoor inspection is most likely happening,
    // so null is an expected outcome and an empty "Conditions:" row would read
    // as a missing answer.
    expect(metaRows(inspection()).map(([k]) => k)).not.toContain('Conditions')
  })
})

describe('conditionsLine', () => {
  it('never prints a reported observation as a recorded one', () => {
    const recorded = inspection({ header: {
      property_name: 'x', property_address: '', org_name: '', org_owner_name: null,
      captured_at: '', conditions: { source: 'recorded', temperature_f: 41,
        label: 'light rain', is_rainy: true, is_snowy: false },
    } })
    const reported = inspection({ header: {
      property_name: 'x', property_address: '', org_name: '', org_owner_name: null,
      captured_at: '', conditions: { source: 'reported', text: 'overcast' },
    } })

    expect(conditionsLine(recorded)).toBe('41°F, light rain (recorded)')
    expect(conditionsLine(reported)).toBe('overcast (reported by inspector)')
  })
})

describe('remediationLine', () => {
  it('stamps the status as of the REPORT, not the walk', () => {
    // Two exports of one inspection can legitimately disagree here. Saying so
    // on the line is what makes the difference explainable rather than
    // suspicious.
    expect(remediationLine(answer({
      remediation: { kind: 'work_order', reference: 'WO-2026-0031', status: 'in_progress' },
    }))).toBe('Work order WO-2026-0031 — In progress as of report date')
  })

  it('is silent when nothing was raised', () => {
    expect(remediationLine(answer())).toBeNull()
  })
})

describe('actionsLine', () => {
  it('carries the independent cleaning flag alongside the work classification', () => {
    expect(actionsLine(answer({ actions: ['repair', 'replace'], needsCleaning: true })))
      .toBe('Repair · Replace · Cleaning')
  })
  it('is silent on a passed item', () => {
    expect(actionsLine(answer())).toBeNull()
  })
})

describe('historyCapNote', () => {
  const report = (over: Partial<InspectionReport> = {}): InspectionReport => ({
    orgId: 'o', propertyName: 'Lake House', generatedAt: '2026-08-25T12:00:00.000Z',
    inspections: [inspection(), inspection()], photosIncluded: false, omittedCount: 0, ...over,
  })

  it('states the cap when one applied', () => {
    expect(historyCapNote(report({ omittedCount: 46 }))).toContain('2 most recent of 48')
  })
  it('adds no caveat to a complete history', () => {
    expect(historyCapNote(report())).toBeNull()
  })
})

describe('formatStamp', () => {
  it('renders an invalid date as an em dash rather than "Invalid Date"', () => {
    expect(formatStamp('not-a-date')).toBe('—')
  })
})

// ── The render itself ───────────────────────────────────────────────────────

const JPEG_1PX = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64'))

function reportWith(over: Partial<InspectionReport> = {}): InspectionReport {
  return {
    orgId: 'o', propertyName: 'Lake House', generatedAt: '2026-08-25T12:00:00.000Z',
    photosIncluded: false, omittedCount: 0,
    inspections: [inspection({
      sections: [{ key: 'd', name: 'Detectors', answers: [
        answer({ id: 'a1', result: 'fail', note: 'Upstairs hallway unit is expired',
          actions: ['replace'],
          remediation: { kind: 'work_order', reference: 'WO-1', status: 'open' } }),
        answer({ id: 'a2' }),
      ] }],
      passCount: 1, failCount: 1,
    })],
    ...over,
  }
}

describe('renderInspectionReport', () => {
  it('produces a document pdf-lib can read back', async () => {
    const bytes = await renderInspectionReport(reportWith())
    const parsed = await PDFDocument.load(bytes)
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('survives text no standard PDF font can encode', async () => {
    // The whole reason ./text.ts exists. Without it this throws and the PM sees
    // a 500 where a report should be.
    const hostile = reportWith({
      propertyName: '湖畔小屋 🙂',
      inspections: [inspection({
        inspectorName: 'Дана → R',
        sections: [{ key: 's', name: 'Секция', answers: [
          answer({ prompt: 'Tile 🙂 cracked?', result: 'fail', note: 'Corner → chipped 🙂' }),
        ] }],
      })],
    })
    const bytes = await renderInspectionReport(hostile)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('adds a cover page for a history and none for a single inspection', async () => {
    const single = await PDFDocument.load(await renderInspectionReport(reportWith()))
    const many   = await PDFDocument.load(await renderInspectionReport(reportWith({
      inspections: [inspection(), inspection(), inspection()],
    })))
    expect(many.getPageCount()).toBeGreaterThan(single.getPageCount())
  })

  it('embeds a real photograph', async () => {
    const withPhoto = reportWith({
      photosIncluded: true,
      inspections: [inspection({
        photosOnFile: 1,
        sections: [{ key: 'd', name: 'Detectors', answers: [
          answer({ id: 'a1', photo: { path: 'o/i/a.jpg', bytes: JPEG_1PX, format: 'jpeg' } }),
        ] }],
      })],
    })
    const doc = await PDFDocument.load(await renderInspectionReport(withPhoto))
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2)   // body + photo log
  })

  it('does NOT lose the export to a corrupt photograph', async () => {
    // A truncated upload has a valid JPEG header and a corrupt body, so the
    // magic-byte screen passes it and pdf-lib's parse throws. The walk, the
    // findings and the work orders are all already correct at that point —
    // losing them over one damaged file is the wrong trade.
    const corrupt = reportWith({
      photosIncluded: true,
      inspections: [inspection({
        photosOnFile: 1,
        sections: [{ key: 'd', name: 'Detectors', answers: [
          answer({ id: 'a1', photo: {
            path: 'o/i/bad.jpg',
            bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]),
            format: 'jpeg',
          } }),
        ] }],
      })],
    })
    const bytes = await renderInspectionReport(corrupt)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('renders a walk with no answers at all rather than throwing', async () => {
    const empty = reportWith({ inspections: [inspection({ sections: [] })] })
    expect((await PDFDocument.load(await renderInspectionReport(empty))).getPageCount())
      .toBeGreaterThanOrEqual(1)
  })
})

describe('the rendered bytes are NOT searchable — which is why content.ts exists', () => {
  it('confirms drawn text cannot be found in the saved file', async () => {
    // If this ever starts passing, byte-level assertions become possible and
    // this file could test the drawing directly. Until then, a test that
    // rendered a PDF and grepped it for a phrase would be reporting a confident
    // pass on an assertion it never actually made.
    const doc  = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    doc.addPage([612, 792]).drawText('Photo log appended', { x: 50, y: 700, size: 10, font })
    const raw = Buffer.from(await doc.save()).toString('latin1')
    expect(raw.includes('Photo log appended')).toBe(false)
  })
})

vi.mock('server-only', () => ({}))
