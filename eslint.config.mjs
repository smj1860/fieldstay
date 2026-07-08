import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
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
