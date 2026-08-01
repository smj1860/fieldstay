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

**Promoting a ratchet to a chokepoint** is the point of the ratchet. When a
rule's count reaches 0, move the whole rule into `chokepoints.yml`, raise its
severity to `ERROR`, and DELETE its `baseline-counts.json` key — a baseline
entry for a rule `ratchet.yml` no longer declares is a number nobody can
lower, and `check-semgrep-ratchet.mjs` fails on it in that direction too.
Then prove it gates: reintroduce the violation, confirm
`semgrep --config .semgrep/chokepoints.yml --error` exits 1, revert. Two rules
were promoted this way on 2026-08-01 —
`fieldstay-role-filtered-membership-read` (3 → 0, the three crons migrated onto
`getPmMembersByOrgIds`) and `fieldstay-untimed-external-fetch` (1 → 0, the
Anthropic call in `build-shopping-cart.ts` given `ANTHROPIC_TIMEOUT_MS`).

## Severity inside the ratchet family

A ratchet rule whose majority is permitted-by-policy is one people learn to
ignore, and `fieldstay-supabase-unbounded-select` was exactly that: 284
findings, all pattern-correct, most of them the case CLAUDE.md explicitly
allows ("Fine for a request handler rendering one org's page; never acceptable
for a platform-wide scan"). It is now a four-tier ladder along the only axis
that predicts whether PostgREST's 1000-row cap can actually be reached — what
bounds the result set:

| Tier | Rule suffix | Bound | Sev | Count |
|---|---|---|---|---|
| 1 | `-table-scan` | nothing but the table | ERROR | 38 → **0, promoted** |
| 2 | `-cross-tenant` | some entity, but not one org | ERROR | 81 |
| 3 | `-in-list` | one org, sized by an `.in()` array | WARNING | 50 |
| 4 | `-org-scoped` | one org, one parent — the permitted case | INFO | 112 |

The four are **mutually exclusive and exhaustive**: every finding of the
original rule lands in exactly one tier, so the counts still sum to the whole
class and no site is lost between tiers. Tier 1 WAS the burn-down target and
reached 0 on 2026-08-01, so it now lives in `chokepoints.yml` and gates at
`--error` across the whole tree; its `baseline-counts.json` key was deleted in
the same change. `-cross-tenant` is the next target.

Tier 1 is the one promoted rule with no `paths.exclude`: no file legitimately
owns "read an entire table unbounded", so the exemption is expressed purely as
the bounding constructs (`.limit` / `.range` / `.single` / `.maybeSingle` / a
head-count aggregate) in `pattern-not-inside`.

Two mechanics worth knowing before editing these:

- The POSITIVE `pattern-inside: $Y.eq("org_id", ...)` that tiers 3–4 use to
  assert single-tenant scope must **not** be wrapped in a `pattern-either`.
  Semgrep then emits the enclosing call's own range as a finding and the count
  inflates several-fold (591 instead of 81 when it was tried). Two sibling
  `pattern-inside`s AND correctly and do not inflate — that is how tier 3
  requires org scope and an `.in()` list at once.
- `.in('org_id', …)` is deliberately **not** treated as org scope. All five
  occurrences in the tree are multi-tenant cron fan-ins, i.e. the high-signal
  case, not the permitted one.

`lib/inngest/**` gets no tier of its own: it is already gated at file
granularity by `unit/guardrails/unbounded-select.test.ts` on a shrink-only
baseline, so a cron tier would add a number without adding coverage — and the
ladder already promotes about half of `lib/inngest`'s findings into tiers 1–2
on merit rather than by path.

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
