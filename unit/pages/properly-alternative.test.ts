import { PROPERLY_FAQ } from '@/lib/faq-content'
import * as data from '@/app/properly-alternative/comparison-data'
import * as page from '@/app/properly-alternative/page'
import * as jsonLd from '@/app/properly-alternative/json-ld'
import { describeComparisonPage } from './comparison-page-suite'

describeComparisonPage({ slug: 'properly', name: 'properly', faqs: PROPERLY_FAQ, data, page, jsonLd })
