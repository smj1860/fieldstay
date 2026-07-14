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
const jsxA11yWarnRules = Object.fromEntries(
  Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([rule, severity]) => [
    rule,
    Array.isArray(severity) ? ['warn', ...severity.slice(1)] : 'warn',
  ])
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
]

export default eslintConfig
