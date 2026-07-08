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
]

export default eslintConfig
