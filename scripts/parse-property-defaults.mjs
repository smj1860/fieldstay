/**
 * Pure parser for lib/properties/defaults.ts's withPropertyDefaults()
 * literals, shared by scripts/check-property-defaults-drift.mjs and
 * unit/guardrails/property-defaults-parse.test.ts.
 *
 * Previously duplicated between the two (the established convention for
 * this class of guardrail — see unit/guardrails/type-drift-map-parses.test.ts
 * — is that two independent copies of a parser must silently agree, so a
 * refactor that breaks one is caught by the other). Extracted to one shared
 * module instead once SonarCloud started flagging the duplicated block: there
 * is exactly one correct way to parse this shape, so sharing the SAME
 * implementation is a strict improvement over two copies — the test still
 * exercises the real parser against the real file with no database needed,
 * which is the property that actually matters.
 *
 * Line-by-line string splitting rather than a regex — SonarCloud flagged
 * every regex shape tried here (including a single unbounded [^,]+ capture,
 * with no alternation) as super-linear on backtracking.
 */

/** `columnName: row.columnName ?? <literal>,` -> { columnName, literal } */
export function parseHardcodedDefaults(text) {
  const parsed = {}
  for (const line of text.split('\n')) {
    const arrowIdx = line.indexOf('??')
    const colonIdx = line.indexOf(':')
    if (arrowIdx === -1 || colonIdx === -1 || colonIdx > arrowIdx) continue

    const name = line.slice(0, colonIdx).trim()
    if (!/^\w+$/.test(name)) continue
    if (!line.slice(colonIdx + 1, arrowIdx).trim().startsWith('row.')) continue

    const afterArrow = line.slice(arrowIdx + 2).trim()
    const commaIdx = afterArrow.indexOf(',')
    if (commaIdx === -1) continue

    const rawLiteral = afterArrow.slice(0, commaIdx).trim()
    parsed[name] = rawLiteral.startsWith("'")
      ? rawLiteral.slice(1, -1)
      : Number(rawLiteral)
  }
  return parsed
}
