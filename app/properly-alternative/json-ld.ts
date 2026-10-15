import { buildComparisonJsonLd } from '@/components/marketing/comparison-json-ld'
import { PROPERLY_FAQ } from '@/lib/faq-content'

// Structured data for /properly-alternative: the FAQPage reads this page's own FAQ
// array. The payload shape is shared; see components/marketing/comparison-json-ld.ts.

export const PROPERLY_PATH = '/properly-alternative'

export const buildJsonLd = (marketingUrl: string) =>
  buildComparisonJsonLd(marketingUrl, PROPERLY_PATH, PROPERLY_FAQ)

export { serializeJsonLd } from '@/app/strops/json-ld'
