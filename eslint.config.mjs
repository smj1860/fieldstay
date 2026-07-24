import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'
import jsxA11y from 'eslint-plugin-jsx-a11y'

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
    rules: jsxA11yWarnRules,
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
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
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
    files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
    rules: {
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
]

export default eslintConfig
