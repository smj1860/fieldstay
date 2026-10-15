import { EZCARE_FAQ } from '@/lib/faq-content'
import * as data from '@/app/ezcare-alternative/comparison-data'
import * as page from '@/app/ezcare-alternative/page'
import * as jsonLd from '@/app/ezcare-alternative/json-ld'
import { describeComparisonPage } from './comparison-page-suite'

describeComparisonPage({ slug: 'ezcare', name: 'ezcare', faqs: EZCARE_FAQ, data, page, jsonLd })
