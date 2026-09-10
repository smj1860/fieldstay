import { STR_OPERATIONS_FAQ, SHARED_LANDING_FAQ_TAIL } from '@/lib/faq-content'
import { buildFaqSoftwareJsonLd } from '@/app/strops/json-ld'
import { DEFINITION, TURNOVER_STEPS } from './capabilities'

// ============================================================================
// Structured data for /short-term-rental-operations-software.
//
// The FAQPage + SoftwareApplication half comes from buildFaqSoftwareJsonLd()
// (app/strops/json-ld.ts) exactly as every other landing page's does — this
// file supplies the FAQ content and feature copy, plus THREE nodes no other
// page in this repo emits. Each is here for a specific reason, and none of
// them is speculative markup:
//
// ── Organization ────────────────────────────────────────────────────────────
//
// Every page so far emits SoftwareApplication with no publisher. That leaves
// the product as an entity with no company behind it, which is precisely the
// gap that makes an answer engine hedge ("a tool called FieldStay, though
// details are limited") or, worse, conflate it with a similarly-named
// product. The Organization node names the real legal entity — Lake Martin
// Delivery LLC, DBA FieldStay — and the SoftwareApplication now points at it
// via `publisher`. `legalName` differing from `name` is the point, not an
// error: it is the detail that makes the entity resolvable against public
// records rather than only against our own marketing.
//
// ── BreadcrumbList ──────────────────────────────────────────────────────────
//
// A two-level trail (home → this page). Cheap, and it does two things: the
// SERP renders the breadcrumb instead of a raw URL, and it states the page's
// place in the site to a crawler that arrived without following a link.
//
// ── HowTo ───────────────────────────────────────────────────────────────────
//
// The four-step turnover sequence is genuinely procedural, so HowTo is the
// honest type for it rather than a stretch. It is also the single most
// quotable thing on the page for a "how does automated turnover management
// work" query, which is a process question — the shape an answer engine most
// readily reproduces as a numbered list.
//
// Steps are read from capabilities.ts, the same array the page RENDERS, so
// the markup cannot describe a sequence a visitor does not see. Google's
// structured-data guidelines forbid marking up content that isn't visible,
// and the price rule already documented in app/strops/json-ld.ts is the same
// rule applied to a different node — see unit/pages/str-operations-software.
// test.ts, which asserts both halves.
// ============================================================================

export const STR_OPS_PATH = '/short-term-rental-operations-software'

/**
 * The page's FAQ: its own eight category/definitional entries, then the tail
 * every landing page appends. Exported so page.tsx renders the SAME array
 * this file marks up — a FAQPage describing questions absent from the page is
 * the exact mismatch that gets a rich result suppressed.
 */
export const STR_OPS_FAQ_ITEMS = [...STR_OPERATIONS_FAQ, ...SHARED_LANDING_FAQ_TAIL]

/** The legal entity behind the product. Kept here so both nodes agree. */
const ORGANIZATION_ID_FRAGMENT = '#organization'

export function buildJsonLd(marketingUrl: string) {
  const base = buildFaqSoftwareJsonLd(marketingUrl, {
    faqPath: STR_OPS_PATH,
    faqItems: STR_OPS_FAQ_ITEMS,
    // The same sentence the page renders as its opening definition — see
    // DEFINITION's docstring for why the two must not diverge.
    description: DEFINITION,
    featureList: [
      'Automatic crew assignment by proximity and workload',
      'Offline-first crew app for properties with no cell service',
      'Photo-verified turnover and inspection checklists',
      'Scheduled preventive maintenance with automatic work orders',
      'No-login vendor work order portal with invoicing',
      'Vendor compliance tracking that blocks expired contractors',
      'Asset health scoring and CapEx replacement forecasting',
      'MACRS depreciation schedules per asset',
      'Par-level inventory with automatic restocking',
      'Owner P&L reporting portal',
      'Self-funding guest guidebook with local business sponsors',
      'Connects to OwnerRez, Hospitable, Hostaway and iCal',
    ],
  })

  const software = base['@graph'].find((n) => n['@type'] === 'SoftwareApplication')
  if (software) {
    // Attach the publisher rather than rebuilding the node — the shared
    // builder owns everything else about it, including the site-wide @id.
    Object.assign(software, {
      publisher: { '@id': `${marketingUrl}${ORGANIZATION_ID_FRAGMENT}` },
    })
  }

  return {
    ...base,
    '@graph': [
      ...base['@graph'],
      {
        '@type': 'Organization',
        '@id': `${marketingUrl}${ORGANIZATION_ID_FRAGMENT}`,
        name: 'FieldStay',
        // The registered entity. Deliberately different from `name` — see
        // this file's header for why that difference is load-bearing.
        legalName: 'Lake Martin Delivery LLC',
        url: marketingUrl,
        logo: `${marketingUrl}/logo.png`,
        email: 'hello@fieldstay.app',
        description:
          'FieldStay builds short-term rental property operations software for managers running ' +
          'turnovers, crews, maintenance and inventory across 1 to 150 properties.',
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${marketingUrl}${STR_OPS_PATH}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'FieldStay', item: marketingUrl },
          {
            '@type': 'ListItem',
            position: 2,
            name: 'Short-Term Rental Operations Software',
            item: `${marketingUrl}${STR_OPS_PATH}`,
          },
        ],
      },
      {
        '@type': 'HowTo',
        '@id': `${marketingUrl}${STR_OPS_PATH}#howto`,
        name: 'How an automated short-term rental turnover works',
        description:
          'The sequence FieldStay runs for every turnover, from the guest checkout that triggers it to the ' +
          'synced record and posted expense at the end.',
        step: TURNOVER_STEPS.map((s, i) => ({
          '@type': 'HowToStep',
          position: i + 1,
          name: s.name,
          text: s.text,
        })),
      },
    ],
  }
}

export { serializeJsonLd } from '@/app/strops/json-ld'
