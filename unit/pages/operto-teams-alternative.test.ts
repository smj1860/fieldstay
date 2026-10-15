import { OPERTO_FAQ } from '@/lib/faq-content'
import * as data from '@/app/operto-teams-alternative/comparison-data'
import * as page from '@/app/operto-teams-alternative/page'
import * as jsonLd from '@/app/operto-teams-alternative/json-ld'
import { describeComparisonPage } from './comparison-page-suite'

describeComparisonPage({ slug: 'operto-teams', name: 'operto teams', faqs: OPERTO_FAQ, data, page, jsonLd })
