import { describe, it } from 'vitest'

import { OPERTO_FAQ } from '@/lib/faq-content'
import * as data from '@/app/operto-teams-alternative/comparison-data'
import * as page from '@/app/operto-teams-alternative/page'
import * as jsonLd from '@/app/operto-teams-alternative/json-ld'
import { comparisonPageCases } from './comparison-page-suite'

describe('/operto-teams-alternative', () => {
  for (const c of comparisonPageCases({ slug: 'operto-teams', name: 'operto teams', faqs: OPERTO_FAQ, data, page, jsonLd })) {
    it(c.name, c.run)
  }
})
