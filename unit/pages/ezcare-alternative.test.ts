import { describe, it } from 'vitest'

import { EZCARE_FAQ } from '@/lib/faq-content'
import * as data from '@/app/ezcare-alternative/comparison-data'
import * as page from '@/app/ezcare-alternative/page'
import * as jsonLd from '@/app/ezcare-alternative/json-ld'
import { comparisonPageCases } from './comparison-page-suite'

describe('/ezcare-alternative', () => {
  for (const c of comparisonPageCases({ slug: 'ezcare', name: 'ezcare', faqs: EZCARE_FAQ, data, page, jsonLd })) {
    it(c.name, c.run)
  }
})
