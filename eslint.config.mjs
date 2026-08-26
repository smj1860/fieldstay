import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import sonarjs from 'eslint-plugin-sonarjs'

// eslint-config-next only wires up a handful of jsx-a11y rules (alt-text,
// aria-props, aria-proptypes, aria-unsupported-elements,
// role-has-required-aria-props, role-supports-aria-props) — most of what a
// UI/UX audit would catch (missing label associations, non-interactive
// elements with click handlers and no keyboard support, etc.) was never
// actually being linted. Downgraded to 'warn' (from the preset's default
// 'error') so turning this on surfaces pre-existing issues elsewhere in the
// codebase without immediately failing `npm run lint` over them.
//
// Rules jsx-a11y itself ships disabled (severity 'off') are left alone,
// not flipped to 'warn' — a naive map over every entry previously did this
// unconditionally, silently re-enabling anchor-ambiguous-text,
// control-has-associated-label, and label-has-for. That last one is the
// deprecated predecessor to label-has-associated-control (which IS
// correctly 'error'→'warn' here) and defaults to requiring BOTH nesting
// AND htmlFor/id on every label — an impossible ask for an ordinary
// sibling label+input, which is a perfectly valid, W3C-conformant pattern
// label-has-associated-control already accepts on its own.
const jsxA11yWarnRules = Object.fromEntries(
  Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([rule, severity]) => {
    const defaultSeverity = Array.isArray(severity) ? severity[0] : severity
    if (defaultSeverity === 'off') return [rule, severity]
    return [rule, Array.isArray(severity) ? ['warn', ...severity.slice(1)] : 'warn']
  })
)

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Only the rules — eslint-config-next's core-web-vitals preset already
    // registers the jsx-a11y plugin itself (with a 6-rule subset), so
    // re-spreading flatConfigs.recommended's own `plugins` key here would
    // redefine that same plugin instance and error.
    rules: {
      ...jsxA11yWarnRules,
      // `role` is also FieldStay's MemberRole PROP on several components
      // (BottomNav, PmMoreDrawer, DashboardShell, CommandPalette). Without
      // ignoreNonDOM the rule reads `<BottomNav role="admin" />` as a DOM aria
      // role and reports "not a valid, non-abstract ARIA role" — 8 warnings
      // today, every one of them false, and every future component test that
      // passes a role burns another slot in the --max-warnings ratchet.
      //
      // ignoreNonDOM scopes the rule to lowercase DOM elements, which is the
      // only place an aria role can be wrong. Real `<div role="typo">` is
      // still caught.
      'jsx-a11y/aria-role': ['warn', { ignoreNonDOM: true }],
    },
  },
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    // Playwright's fixture API defines fixtures as `async ({ deps }, use) => ...`
    // — a `use` parameter that react-hooks/rules-of-hooks mistakes for the
    // React 19 `use()` hook based on naming convention alone. This is test
    // fixture code, not React components; the rule (and react-hooks in
    // general) has no business applying to e2e/.
    files: ['e2e/**/*.ts'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  {
    // The codebase already uses a leading underscore to mark a destructured
    // binding as intentionally discarded (e.g. stripping id/created_at/
    // updated_at before re-inserting a row) — recognize that convention
    // instead of flagging it.
    //
    // ERROR, not warn, since 2026-08-23. As a warning it was fungible against
    // the `--max-warnings` ceiling, which is the same hole CLAUDE.md already
    // documents for cognitive-complexity: a refactor that removes two warnings
    // and adds two others nets to zero and lint stays green. That is exactly
    // how two imports left dangling by moving validateWorkOrderCreate out of
    // maintenance/actions.ts reached SonarCloud instead of the local run.
    //
    // Safe to promote because the repo is at ZERO of these — an unused binding
    // is always either a real leftover or an underscore away from being
    // declared intentional, so there is no legitimate case to grandfather.
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    // ── Structural enforcement of CLAUDE.md's "Things That Will Break" ──────
    // Each rule here is a convention promoted from prose to a compile-time
    // failure. Scoped to shipped code — tests/e2e/scripts are exempt (a test
    // may legitimately reference a forbidden pattern to assert against it).
    // The string-level and cross-file invariants that AST rules can't
    // express live in unit/guardrails/ — see CLAUDE.md's "Structural
    // enforcement" section for the system and the meta-rule.
    // Root-level modules (instrumentation.ts, instrumentation-client.ts,
    // proxy.ts) are in scope too: they were previously excluded, so a nested
    // ternary in instrumentation.ts passed `pnpm run lint` clean and was only
    // caught by SonarCloud on the PR — the exact after-the-fact feedback loop
    // this block exists to close.
    files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', '*.{ts,tsx}'],
    plugins: { sonarjs },
    rules: {
      // ── CLAUDE.md "Code Quality Standards" — previously SonarCloud-only,
      // caught on the PR after the fact rather than locally in `npm run
      // lint`. Same rule engine SonarCloud itself uses (sonarjs), same
      // default thresholds CLAUDE.md documents.
      //
      // 'warn', not 'error': turning these on surfaced 236 pre-existing
      // violations across the codebase (64 cognitive-complexity, 122
      // no-nested-conditional, 27 no-nested-functions, 12
      // no-nested-template-literals, 11 nested-control-flow) — same
      // rollout shape as the jsx-a11y block above. Ratchet to 'error' once
      // those are cleared; new code should not add to this count.
      'sonarjs/cognitive-complexity': ['warn', 15],
      'sonarjs/no-nested-functions': ['warn', { threshold: 4 }],
      'sonarjs/nested-control-flow': ['warn', { maximumNestingLevel: 4 }],
      'sonarjs/no-nested-conditional': 'warn',
      'sonarjs/no-nested-template-literals': 'warn',
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.property.name='from'] > Literal[value='memberships']",
          message: "The table is organization_members — 'memberships' does not exist (CLAUDE.md: The Table That Breaks Everything If Wrong).",
        },
        {
          selector: "Literal[value='assigned_crew_id']",
          message: "work_orders.assigned_crew_id is deprecated — use assigned_crew_member_id.",
        },
        {
          selector: "CallExpression[callee.property.name='from'] > Literal[value='work_order_notes']",
          message: "The table is work_order_updates — 'work_order_notes' does not exist (CLAUDE.md: Table and column names).",
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "This codebase's XSS defense depends on zero dangerouslySetInnerHTML uses. If raw HTML rendering is genuinely required, it needs DOMPurify and a CLAUDE.md update first.",
        },
        {
          selector: "CallExpression[callee.property.name='raw'][callee.object.name='supabase']",
          message: "supabase.raw() does not exist on the Supabase JS client — fetch rows and compare in JavaScript.",
        },
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='SUPABASE_SERVICE_ROLE_KEY']",
          message: "The service-role key may only be read in lib/supabase/server.ts — use createServiceClient()/adminFetch() from there (eslint-disable with justification at the canonical site only).",
        },
      ],
      'no-restricted-properties': ['error',
        {
          object: 'Math',
          property: 'random',
          message: 'Never use Math.random() for IDs, storage paths, or tokens — use crypto.randomUUID(). For genuine sampling/jitter, eslint-disable-next-line with a one-line justification.',
        },
      ],
      'no-restricted-globals': ['error',
        {
          name: 'window',
          message: 'Use globalThis — window throws a ReferenceError during SSR.',
        },
      ],
    },
  },
  {
    // ── Complexity limits for the ENFORCEMENT layer itself ──────────────────
    //
    // A DELIBERATELY separate block from the one above, and it must stay
    // separate: that block's no-restricted-syntax bans (`.from('memberships')`,
    // `assigned_crew_id`, the service-role key) are exactly the strings a
    // guardrail test has to write down in order to check for them, so widening
    // it to unit/ would make the suite unable to state its own rules.
    //
    // Only the two rules that are at ZERO here. Nothing is grandfathered and
    // there is no baseline entry for any file in these directories — which is
    // the point: 17 violations were cleared rather than frozen, and clearing
    // them turned up a live coverage hole in inngest-history-secrets where six
    // step.run bodies were going unscanned.
    //
    // The other three sonarjs rules stay off here on purpose rather than for
    // effort: no-nested-functions (14) fires on the ordinary
    // describe > it > callback > helper shape that every test file has, and
    // judging that against a 4-deep limit written for production code would
    // manufacture 14 findings with no defect behind them. no-nested-conditional
    // (3) and no-nested-template-literals (1) are a real, small burn-down still
    // to do.
    files: ['unit/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs}', 'e2e/**/*.ts'],
    plugins: { sonarjs },
    rules: {
      'sonarjs/cognitive-complexity': ['warn', 15],
      'sonarjs/nested-control-flow': ['warn', { maximumNestingLevel: 4 }],
    },
  },
]

export default eslintConfig
