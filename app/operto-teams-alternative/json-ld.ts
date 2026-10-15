import { buildComparisonJsonLd } from '@/components/marketing/comparison-json-ld'
import { OPERTO_FAQ } from '@/lib/faq-content'

// Structured data for /operto-teams-alternative: the FAQPage reads this page's own FAQ
// array. The payload shape is shared; see components/marketing/comparison-json-ld.ts.

export const OPERTO_PATH = '/operto-teams-alternative'

export const buildJsonLd = (marketingUrl: string) =>
  buildComparisonJsonLd(marketingUrl, OPERTO_PATH, OPERTO_FAQ)

export { serializeJsonLd } from '@/app/strops/json-ld'
