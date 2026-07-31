# `.semgrep/` — AST-level structural enforcement

The fifth layer of the enforcement stack described in CLAUDE.md's *Structural
Enforcement — Guardrails*. ESLint bans single expressions per file; the
`unit/guardrails/` suite checks cross-file invariants with regex over source
text. Semgrep sits between them: real TypeScript AST matching, so a pattern
survives reformatting, renamed intermediate variables, and — unlike the
text-scanning guardrail tests — chained call expressions split across lines.

## Two families, gated differently

| | `chokepoints.yml` | `ratchet.yml` |
|---|---|---|
| Shape | one legitimate owner file | many legitimate owners |
| Owner named via | `paths.exclude` | n/a |
| Current findings | **0** | hundreds (see `baseline-counts.json`) |
| CI gate | `--error`, whole tree | `--baseline-commit` (new findings only) + a per-rule count that may only go down |

**Adding a rule:** if the capability has one owner and you can get the count to
zero, it is a chokepoint. If it does not, it is a ratchet — put it in
`ratchet.yml` and run `node scripts/check-semgrep-ratchet.mjs --update` to
record its starting count. Do not ship a "chokepoint" with a handful of
suppressions; that is a ratchet wearing a costume.

**`paths.exclude` vs. `pattern-not-inside`.** These answer different questions
and are not interchangeable:

- `paths.exclude` = *"this file is an owner of this capability."* It is the
  right tool for "only `lib/sms/telnyx.ts` may call Telnyx" — what makes that
  file allowed is its identity as the SMS_ENABLED + nudge-budget chokepoint,
  which is a property of the path, not of any surrounding syntax.
- `pattern-not-inside` = *"this occurrence is already handled by its
  surroundings."* It is the right tool for "a `.select()` nested inside a
  `.limit()` call is bounded."

Reaching for `pattern-not-inside` to express ownership produces a rule that
suppresses the same construct everywhere it happens to appear in a similar
shape. Reaching for `paths.exclude` to express handling produces a permanently
blind file.

**Never** silence a ratchet with `nosemgrep` or a new `paths.exclude`. Fix the
site or leave it counted — a suppressed rule reports zero and means nothing.

## Scope

`.semgrepignore` at the repo root limits scanning to shipped application source
(`app/`, `lib/`, `components/`, `proxy.ts`, `instrumentation*.ts`). Tests and
the enforcement layer itself are excluded: a guardrail test that quotes a banned
string as a literal is not a violation of it.

## Running it

```bash
semgrep --validate --config .semgrep/          # rules parse
semgrep --config .semgrep/chokepoints.yml --error   # must be silent
semgrep --config .semgrep/ratchet.yml               # the backlog
node scripts/check-semgrep-ratchet.mjs              # counts did not grow
node scripts/check-semgrep-ratchet.mjs --update     # lock in a burn-down
```

Full scan of the 672 in-scope files takes ~10s.
