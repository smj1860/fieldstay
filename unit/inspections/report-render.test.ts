import { describe, it, expect, vi } from 'vitest'
import {
  PDFDocument, StandardFonts, PDFName, PDFArray, PDFRawStream, decodePDFRawStream,
} from 'pdf-lib'

import { toWinAnsi, wrapText, formatStamp } from '@/lib/inspections/report/text'
import {
  attachmentLine,
  actionsLine,
  conditionsLine,
  historyCapNote,
  historyRange,
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

describe('historyRange', () => {
  const at = (iso: string) => inspection({ completedAt: iso })
  const of = (...isos: string[]): InspectionReport => ({
    orgId: 'o', propertyName: 'x', generatedAt: '2026-08-25T12:00:00.000Z',
    inspections: isos.map(at), photosIncluded: false, omittedCount: 0,
  })

  it('returns [earliest, latest] whatever order the walks arrive in', () => {
    // Replaced a `.sort()` with min/max on 2026-08-25 (SonarQube: sorting
    // strings with no comparator). Getting the two reduces the wrong way round
    // prints the span backwards, and PDF text is not greppable — nothing else
    // in the suite would have caught it.
    expect(historyRange(of(
      '2026-05-02T00:00:00.000Z',
      '2024-01-15T00:00:00.000Z',
      '2025-09-30T00:00:00.000Z',
    ))).toEqual(['2024-01-15T00:00:00.000Z', '2026-05-02T00:00:00.000Z'])
  })

  it('is already ordered when the input is', () => {
    expect(historyRange(of('2024-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')))
      .toEqual(['2024-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'])
  })

  it('collapses to a single point for one walk', () => {
    expect(historyRange(of('2025-03-03T00:00:00.000Z')))
      .toEqual(['2025-03-03T00:00:00.000Z', '2025-03-03T00:00:00.000Z'])
  })

  it('returns null rather than throwing on an empty set', () => {
    expect(historyRange(of())).toBeNull()
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

describe('the sign-off is never split across a page break', () => {
  // @smj1860, 2026-08-25: "put the entirety of the signoff on the last page."
  //
  // ASSERTED ON PAGE GEOMETRY, not on page counts. A count comparison was the
  // first attempt and it was a bad proxy twice over: it passed for the wrong
  // reason whenever the body happened to end near a boundary, and it could not
  // distinguish "moved whole" from "split and happened to add a page anyway".
  //
  // pdf-lib writes one content stream per page, so decoding each page's own
  // stream says exactly which page a given string was drawn on — which is the
  // literal question being asked. Note this reads the CONTENT STREAM rather
  // than the saved file: drawn text is not greppable in the file itself, which
  // is why the claims live in content.ts.

  // EVERY THIRD ANSWER CARRIES DETAIL LINES, and that is not decoration. The
  // height measurement adds prompt lines AND detail lines; with a filler of
  // bare passes the detail term is always zero, so dropping it from
  // answerHeight() left all of these green — caught by canarying the fix.
  // A failure with a note and a work order is also the realistic shape.
  const filler = (n: number) => ({
    key: 'body', name: 'Checked Items',
    answers: Array.from({ length: n }, (_, i) => (i % 3 === 0
      ? answer({
          id: `f-${i}`,
          prompt: `Checked item number ${i}`,
          result: 'fail',
          note: `Finding ${i}: the detail line that makes this answer taller than one row, `
            + 'long enough to wrap across more than a single line of the report',
          actions: ['repair'],
          remediation: { kind: 'work_order', reference: `WO-${i}`, status: 'open' },
        })
      : answer({ id: `f-${i}`, prompt: `Checked item number ${i}` }))),
  })

  // THE SIGNATURE ITEM CARRIES A DETAIL LINE, and that is what makes the
  // measurement honest. answerHeight() sums prompt lines AND detail lines, but
  // it is only ever called on the SIGN-OFF section — so with a sign-off of two
  // bare answers the detail term is dead weight, and deleting it from
  // answerHeight() left every test here green. Twice: the first attempt put
  // details on the FILLER, which changes where the body ends but is never
  // measured. It has to be inside the section being measured.
  //
  // photo_unavailable_reason on the signature is also the realistic case — an
  // inspector whose camera failed records why, and §12.1 makes that the only
  // way past a photo_required item.
  const signoffSection = {
    key: 'signoff', name: 'Inspector Sign-Off & Verification',
    answers: [
      answer({ id: 'cert', prompt: 'I hereby certify that the property listed above has undergone a '
        + 'comprehensive safety inspection on the date indicated, and all verified items meet '
        + 'standard operational safety guidelines.' }),
      answer({
        id: 'sig', prompt: 'Inspector signature', result: null,
        // LONG ENOUGH TO WRAP TO SEVERAL LINES, and that is a measurement
        // requirement rather than flavour. The filler steps the body in ~16pt
        // increments, so a defect window narrower than that falls BETWEEN two
        // sample points and the sweep walks straight past it. A one-line reason
        // gave a 10pt window and the drift canary stayed green through three
        // attempts; at ~4 lines the window is wider than the step, so some n
        // must land inside it.
        photoUnavailableReason: 'Camera would not focus in the low light of the crawl space and '
          + 'the tablet reported insufficient storage on the third attempt. The inspector signed '
          + 'the paper copy instead, which was countersigned by the property manager on arrival '
          + 'and is retained at the management office with the rest of the walk paperwork.',
      }),
    ],
  }

  /** Every string drawn, grouped by the page it was drawn on. */
  async function stringsByPage(report: InspectionReport): Promise<string[][]> {
    const doc = await PDFDocument.load(await renderInspectionReport(report))
    const dec = new TextDecoder('windows-1252')

    return doc.getPages().map((page) => {
      const contents = page.node.context.lookup(page.node.get(PDFName.of('Contents')))
      const refs = contents instanceof PDFArray ? contents.asArray() : []
      const out: string[] = []

      for (const ref of refs) {
        const stream = page.node.context.lookup(ref)
        if (!(stream instanceof PDFRawStream)) continue
        const body = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')
        for (const m of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
          out.push(dec.decode(Buffer.from(m[1]!, 'hex')))
        }
      }
      return out
    })
  }

  /** Index of the single page carrying `needle`, or -1 / -2 if absent / split. */
  function pageWith(pages: string[][], needle: string): number {
    const hits = pages
      .map((strings, i) => (strings.some((t) => t.includes(needle)) ? i : -1))
      .filter((i) => i >= 0)
    if (hits.length === 0) return -1
    return hits.length === 1 ? hits[0]! : -2
  }

  /** Every part of the attestation, section heading through attachment line. */
  const PARTS = [
    'Inspector Sign-Off & Verification',   // the form section's heading
    'I hereby certify',                    // its declaration item
    'Inspector signature',                 // its signature item
    'INSPECTOR SIGN-OFF & VERIFICATION',   // the rendered block
    'Date of inspection',
    'Signed by',
    'Attached documentation',
  ]

  it('lands whole on one page at EVERY body length that crosses a boundary', async () => {
    // Swept at step 1 rather than sampled. The defect is boundary-dependent —
    // it only shows when the body ends within the sign-off's own height of the
    // page foot — so a handful of sample points can miss it entirely, which is
    // how it reached the sample @smj1860 reviewed.
    //
    // It also has to be this dense to keep the test honest. A 13-point sample
    // could not detect a measurement that was ~20pt short: that window is 3% of
    // a page, so the sample walked straight past it and the canary for
    // measurement drift stayed green through two attempts to provoke it.
    const straddled: string[] = []

    for (let n = 0; n <= 48; n++) {
      const pages = await stringsByPage(reportWith({
        inspections: [inspection({ sections: [filler(n), signoffSection] })],
      }))

      const located = PARTS.map((part) => [part, pageWith(pages, part)] as const)
      const missing = located.filter(([, page]) => page < 0)
      if (missing.length > 0) {
        straddled.push(`n=${n}: not drawn exactly once — ${missing.map(([p]) => p).join(', ')}`)
        continue
      }

      const distinct = new Set(located.map(([, page]) => page))
      if (distinct.size !== 1) {
        straddled.push(`n=${n}: split across pages ${[...distinct].sort().join(' and ')} — `
          + located.map(([part, page]) => `${part.slice(0, 24)}=p${page}`).join(', '))
      }
    }

    expect(straddled, `the sign-off straddled a page break:\n  ${straddled.join('\n  ')}`)
      .toEqual([])
  })

  it('never splits ANY section across a page break, at every offset', async () => {
    // Generalised from the sign-off rule after @smj1860 reviewed the real form:
    // Electrical ran heading-plus-two-items at the foot of page 1 and finished
    // at the top of page 2, where those four items appeared under NO heading —
    // "Gas appliances — PASS" with nothing saying what it belonged to.
    //
    // SWEPT, for the same reason the sign-off test is. A fixed fixture of
    // equal-sized sections lands them cleanly N-per-page and never straddles a
    // boundary at all: the first version of this passed with the rule deleted.
    // Varying a leading section by one item walks every following section
    // across every offset, so some arrangement must straddle if nothing stops it.
    const straddled: string[] = []

    for (let lead = 0; lead <= 20; lead++) {
      const sections = [
        { key: 'lead', name: 'Leading Section',
          answers: Array.from({ length: lead }, (_, i) =>
            answer({ id: `l-${i}`, prompt: `Leading item ${i}` })) },
        ...Array.from({ length: 4 }, (_, sIdx) => ({
          key: `sec-${sIdx}`, name: `Section ${sIdx} Heading`,
          answers: Array.from({ length: 7 }, (_, i) =>
            answer({ id: `s${sIdx}-i${i}`, prompt: `Item ${i} of section ${sIdx}` })),
        })),
      ].filter((sec) => sec.answers.length > 0)

      const pages = await stringsByPage(reportWith({
        inspections: [inspection({ sections })],
      }))

      for (const section of sections) {
        const seen = new Set([
          pageWith(pages, section.name),
          ...section.answers.map((a) => pageWith(pages, a.prompt)),
        ])
        if (seen.size !== 1) {
          straddled.push(`lead=${lead} ${section.name}: spans p${[...seen].sort().join('/p')}`)
        }
      }
    }

    expect(straddled, `sections split across page breaks:\n  ${straddled.join('\n  ')}`)
      .toEqual([])
  })

  it('a section too tall for any page starts immediately, without a wasted blank page', async () => {
    // The escape hatch, asserted on the thing that distinguishes it. Keeping
    // this section whole is impossible, so the rule must stand aside — without
    // the guard it breaks to a fresh page, finds it still does not fit, and
    // splits anyway, having spent a page carrying nothing but the letterhead.
    const pages = await stringsByPage(reportWith({
      inspections: [inspection({ sections: [{
        key: 'huge', name: 'Oversized Section',
        answers: Array.from({ length: 70 }, (_, i) =>
          answer({ id: `h${i}`, prompt: `Oversized item ${i}` })),
      }] })],
    }))

    expect(pages.length).toBeGreaterThan(1)
    expect(
      pageWith(pages, 'Oversized item 0'),
      'the oversized section must begin on the letterhead page, not after a blank one',
    ).toBe(0)
    expect(pageWith(pages, 'Oversized item 69')).toBeGreaterThan(0)
  })

  it('does not spend a blank page when the sign-off already fits', async () => {
    // A short walk must not push the attestation onto a page of its own —
    // that reads as something missing rather than deliberate.
    const pages = await stringsByPage(reportWith({
      inspections: [inspection({ sections: [filler(2), signoffSection] })],
    }))
    expect(pages).toHaveLength(1)
  })

  it('still renders when the sign-off is taller than an entire page', async () => {
    // No amount of moving keeps this whole, so the rule must step aside rather
    // than spend a blank page and split it anyway.
    const doc = await PDFDocument.load(await renderInspectionReport(reportWith({
      inspections: [inspection({ sections: [{
        key: 'signoff', name: 'Inspector Sign-Off & Verification',
        answers: Array.from({ length: 60 }, (_, i) =>
          answer({ id: `s${i}`, prompt: `Attestation clause ${i}`, note: 'x'.repeat(200) })),
      }] })],
    })))
    expect(doc.getPageCount()).toBeGreaterThan(1)
  })

  it('renders a form with no sign-off section at all', async () => {
    const pages = await stringsByPage(reportWith({
      inspections: [inspection({ sections: [filler(3)] })],
    }))
    expect(pageWith(pages, 'INSPECTOR SIGN-OFF & VERIFICATION')).toBeGreaterThanOrEqual(0)
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
