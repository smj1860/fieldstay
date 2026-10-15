import { describe, it } from 'vitest'

import { TURNO_FAQ } from '@/lib/faq-content'
import * as data from '@/app/turno-alternative/comparison-data'
import * as page from '@/app/turno-alternative/page'
import * as jsonLd from '@/app/turno-alternative/json-ld'
import { comparisonPageCases } from './comparison-page-suite'

describe('/turno-alternative', () => {
  for (const c of comparisonPageCases({ slug: 'turno', name: 'turno', faqs: TURNO_FAQ, data, page, jsonLd })) {
    it(c.name, c.run)
  }
})
