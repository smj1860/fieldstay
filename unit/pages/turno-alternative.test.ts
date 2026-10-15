import { TURNO_FAQ } from '@/lib/faq-content'
import * as data from '@/app/turno-alternative/comparison-data'
import * as page from '@/app/turno-alternative/page'
import * as jsonLd from '@/app/turno-alternative/json-ld'
import { describeComparisonPage } from './comparison-page-suite'

describeComparisonPage({ slug: 'turno', name: 'turno', faqs: TURNO_FAQ, data, page, jsonLd })
