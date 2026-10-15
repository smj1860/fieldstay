import { buildComparisonJsonLd } from '@/components/marketing/comparison-json-ld'
import { TURNO_FAQ } from '@/lib/faq-content'

// Structured data for /turno-alternative: the FAQPage reads this page's own FAQ
// array. The payload shape is shared; see components/marketing/comparison-json-ld.ts.

export const TURNO_PATH = '/turno-alternative'

export const buildJsonLd = (marketingUrl: string) =>
  buildComparisonJsonLd(marketingUrl, TURNO_PATH, TURNO_FAQ)

export { serializeJsonLd } from '@/app/strops/json-ld'
