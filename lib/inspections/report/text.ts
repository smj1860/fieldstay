// Text preparation for the PDF renderer. Pure functions over strings and a
// font's measurements — no pdf-lib document, so all of it is testable without
// building a PDF.

/**
 * Anything `page.drawText` can be handed with a StandardFont.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: drawText THROWS, it does not fall back
 *
 * The 14 standard PDF fonts are WinAnsi-encoded. pdf-lib raises
 * `Cannot encode "…" in WinAnsi` for any character outside it and there is no
 * lenient mode — so ONE emoji in a failure description, one CJK character in a
 * property name, one "≈" typed into an inspector's note takes down the entire
 * export with a 500. Not the photograph, not the line: the document.
 *
 * Every string on this report is user text. Prompts come from a snapshot an
 * operator wrote, notes and N/A reasons are typed on a phone at a property, the
 * inspector's name is free text by design (§5: whoever the PM hands the tablet
 * to counts), and property and org names are whatever the PM entered. Assuming
 * any of it is Latin-1 is assuming something nobody enforces at the boundary.
 *
 * Substituting is the right failure: a report reading "Cracked tile ?" still
 * carries the finding, the date, the inspector and the work order. A 500 carries
 * nothing, and — worse — reads as the record being unavailable rather than as
 * one character being unprintable.
 *
 * Embedding a Unicode font instead would be the real fix and costs a ~300KB
 * subset per document plus a font file in the repo. Worth revisiting if a
 * customer ever needs a non-Latin report; not worth it to avoid the substitution
 * above.
 */
export function toWinAnsi(input: string): string {
  let out = ''
  for (const ch of input) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x09) { out += ' '; continue }               // tab → space
    if (cp === 0x0a || cp === 0x0d) { out += ' '; continue } // newline → space
    out += isWinAnsi(cp) ? ch : REPLACEMENT
  }
  return out
}

const REPLACEMENT = '?'

/**
 * WinAnsi (CP1252) is Latin-1 plus 27 characters occupying 0x80–0x9F, where
 * Latin-1 has controls. Those 27 are listed explicitly rather than approximated
 * by a range, because the range is exactly what is NOT there.
 *
 * Smart quotes, the en and em dash, the ellipsis and the bullet are all in that
 * block — which matters more than it looks, since a phone keyboard produces
 * curly quotes by default and this file's own prose uses the rest.
 */
const WINANSI_HIGH = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
])

function isWinAnsi(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true          // printable ASCII
  if (cp >= 0xa0 && cp <= 0xff) return true          // Latin-1 supplement
  return WINANSI_HIGH.has(cp)
}

/** Just enough of pdf-lib's PDFFont to measure a string. */
export interface Measurer {
  widthOfTextAtSize(text: string, size: number): number
}

/**
 * Word-wrap to a pixel width, NOT a character count.
 *
 * The CPA export clips with an ellipsis at `width / 5` characters, which is
 * right for a fixed-width table of asset names. It is wrong here: the strings
 * that overflow on this document are the failure descriptions, and §5 makes
 * those the work order's title precisely because "handrail on the deck stairs
 * is loose at the top bracket" is actionable where "broken" is not. Clipping it
 * to "handrail on the deck stai…" on the evidentiary copy throws away the half
 * that carries the meaning.
 *
 * A word longer than the line is broken mid-word rather than allowed to run off
 * the page — a 60-character URL pasted into a note is rare and silently losing
 * it is worse than an ugly break.
 */
export function wrapText(
  text:  string,
  font:  Measurer,
  size:  number,
  maxWidth: number,
): string[] {
  const cleaned = toWinAnsi(text).replace(/\s+/g, ' ').trim()
  if (!cleaned) return []

  const lines: string[] = []
  let line = ''

  for (const word of cleaned.split(' ')) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    // The word alone still may not fit.
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      line = word
    } else {
      const pieces = breakLongWord(word, font, size, maxWidth)
      lines.push(...pieces.slice(0, -1))
      line = pieces.at(-1) ?? ''
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Hard-breaks a single unbreakable token.
 *
 * Advances at least one character per iteration unconditionally — a zero-width
 * measurement or a maxWidth narrower than one glyph would otherwise spin
 * forever, and this runs on a request thread.
 */
function breakLongWord(
  word: string,
  font: Measurer,
  size: number,
  maxWidth: number,
): string[] {
  const pieces: string[] = []
  let current = ''

  for (const ch of word) {
    const candidate = current + ch
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      pieces.push(current)
      current = ch
    } else {
      current = candidate
    }
  }
  if (current) pieces.push(current)
  return pieces
}

/**
 * A date for the page, in the report's own words.
 *
 * `sourceLabel` is appended for a walk that was STARTED OFFLINE, where
 * `started_at` is a device clock corrected by the skew measured at sync rather
 * than a server stamp (§8). Both are honest timestamps and they are not the
 * same claim, so the stronger one is not asserted on behalf of the weaker.
 */
export function formatStamp(iso: string, opts: { withTime?: boolean } = {}): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    year:  'numeric',
    month: 'long',
    day:   'numeric',
    ...(opts.withTime ? { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } : {}),
    timeZone: 'UTC',
  })
}
