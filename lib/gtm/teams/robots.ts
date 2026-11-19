/**
 * robots.txt, as far as a polite one-off reader needs it.
 *
 * The file comes from a stranger's website, so it is untrusted input: it is
 * parsed by splitting and indexOf, never by compiling its patterns to a regular
 * expression (a pattern like `/*a*a*a*a*a*b` is exactly what makes a regex
 * backtrack for minutes), and it is capped in size and rule count first.
 *
 * Semantics follow the common reading: the most specific user-agent group wins
 * (ours, else `*`), the longest matching rule wins, and on a tie Allow beats
 * Disallow. `*` matches any run of characters and a trailing `$` anchors the end.
 */

const MAX_BYTES = 100_000
const MAX_RULES = 500

interface Rule { allow: boolean; pattern: string }
interface Group { agents: string[]; rules: Rule[] }

function stripComment(line: string): string {
  const hash = line.indexOf('#')
  return (hash >= 0 ? line.slice(0, hash) : line).trim()
}

interface ParsedLine { field: string; value: string }

function parseLine(raw: string): ParsedLine | null {
  const line = stripComment(raw)
  const colon = line.indexOf(':')
  if (colon < 0) return null
  return { field: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() }
}

interface ParseState { groups: Group[]; current: Group | null; lastWasAgent: boolean; rules: number }

function addAgent(state: ParseState, value: string): void {
  // Consecutive user-agent lines share one group; one after a rule starts a new one.
  if (!state.current || !state.lastWasAgent) {
    state.current = { agents: [], rules: [] }
    state.groups.push(state.current)
  }
  state.current.agents.push(value.toLowerCase())
  state.lastWasAgent = true
}

function addRule(state: ParseState, line: ParsedLine): void {
  state.lastWasAgent = false
  const isRule = line.field === 'allow' || line.field === 'disallow'
  if (!isRule || !state.current || state.rules >= MAX_RULES) return
  state.rules += 1
  state.current.rules.push({ allow: line.field === 'allow', pattern: line.value })
}

function parseGroups(text: string): Group[] {
  const state: ParseState = { groups: [], current: null, lastWasAgent: false, rules: 0 }
  for (const raw of text.slice(0, MAX_BYTES).split(/\r?\n/)) {
    const line = parseLine(raw)
    if (!line) continue
    if (line.field === 'user-agent') addAgent(state, line.value)
    else addRule(state, line)
  }
  return state.groups
}

/** Whether the last segment of a pattern fits after `position`, anchored to the end of the path or not. */
function tailMatches(last: string, path: string, position: number, anchored: boolean): boolean {
  if (anchored) return path.length - position >= last.length && path.endsWith(last)
  return last === '' || path.indexOf(last, position) >= 0
}

/**
 * Linear wildcard match of `pattern` (with `*` and a trailing `$`) at the start
 * of `path`. Returns the pattern's length when it matches, which is what ranks
 * one rule against another, or -1.
 */
export function patternMatchLength(pattern: string, path: string): number {
  if (pattern === '') return -1
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const parts = body.split('*')

  const first = parts[0]
  if (!path.startsWith(first)) return -1
  if (parts.length === 1) return anchored && path.length !== first.length ? -1 : body.length

  let position = first.length
  for (const part of parts.slice(1, -1)) {
    const found = path.indexOf(part, position)
    if (found < 0) return -1
    position = found + part.length
  }
  return tailMatches(parts[parts.length - 1], path, position, anchored) ? body.length : -1
}

function groupFor(groups: Group[], agent: string): Group | null {
  const token = agent.toLowerCase()
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && a !== '' && token.includes(a)))
  const matching = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'))
  if (matching.length === 0) return null
  // Several groups for the same agent are merged, as the common reading has it.
  return { agents: [], rules: matching.flatMap((g) => g.rules) }
}

/**
 * Whether `agent` may fetch `path`. No file, an empty file, or no group that
 * applies means yes: the absence of a rule is not a prohibition.
 */
export function robotsAllows(robotsTxt: string, path: string, agent: string): boolean {
  const group = groupFor(parseGroups(robotsTxt), agent)
  if (!group) return true

  let best: { allow: boolean; length: number } | null = null
  for (const rule of group.rules) {
    const length = patternMatchLength(rule.pattern, path)
    if (length < 0) continue
    if (best === null || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length }
    }
  }
  return best === null ? true : best.allow
}
