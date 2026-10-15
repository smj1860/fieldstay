import { buildComparisonJsonLd } from '@/components/marketing/comparison-json-ld'
import { EZCARE_FAQ } from '@/lib/faq-content'

// Structured data for /ezcare-alternative: the FAQPage reads this page's own FAQ
// array. The payload shape is shared; see components/marketing/comparison-json-ld.ts.

export const EZCARE_PATH = '/ezcare-alternative'

export const buildJsonLd = (marketingUrl: string) =>
  buildComparisonJsonLd(marketingUrl, EZCARE_PATH, EZCARE_FAQ)

export { serializeJsonLd } from '@/app/strops/json-ld'
