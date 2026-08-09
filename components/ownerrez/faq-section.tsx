// The ownerrez landing page's FAQ content. The accordion itself is
// components/faq/FaqSection.tsx — this file and its Hospitable twin used to
// carry byte-identical copies of that markup, which is what SonarCloud kept
// flagging. Shared answers come from lib/faq-content.ts.

'use client'

import { CREW_VISIBILITY_FAQ, TEAM_ACCESS_FAQ, MARKETING_OFFLINE_FAQ, MARKETING_TRIAL_FAQ } from '@/lib/faq-content'
import FaqSection from '@/components/faq/FaqSection'

const MARKETING_FAQ = [
  {
    q: 'Does FieldStay replace OwnerRez?',
    a: 'No — FieldStay is a field operations layer that works alongside OwnerRez. OwnerRez handles bookings, rates, and guest communication. FieldStay handles what happens on the ground: turnovers, crew assignments, inventory, maintenance, and owner reporting. They do different jobs and work better together.',
  },
  {
    q: 'How long does setup take?',
    a: 'Connecting OwnerRez takes about 2 minutes via OAuth. Your properties and upcoming bookings typically sync within a few minutes — for larger portfolios, typically within 15 minutes. Most property managers complete full setup — crew invites, checklists, and inventory — in under an hour.',
  },
  {
    q: 'What data syncs from OwnerRez?',
    a: 'FieldStay syncs your properties and your full booking history — not just upcoming stays — on initial connection, so past bookings are already there for reporting from day one. Booking changes in OwnerRez — modifications, cancellations — update in FieldStay automatically via webhooks.',
  },
  {
    q: 'How do my crew members access the app?',
    a: 'Go to Crew, add the person with the "Add Crew Member" form, then click "Invite to App" on their row. They receive a link, create a free account, and install the app to their phone home screen — no App Store required. Crew see only their assigned turnovers and checklists, nothing else.',
  },
  {
    // Shared verbatim with the Hospitable landing page — see lib/faq-content.ts.
    q: MARKETING_OFFLINE_FAQ.question,
    a: MARKETING_OFFLINE_FAQ.answer,
  },
  {
    q: MARKETING_TRIAL_FAQ.question,
    a: MARKETING_TRIAL_FAQ.answer,
  },
  {
    // Shared verbatim with the other landing page and the in-app help page —
    // see lib/faq-content.ts for the claim-by-claim RLS backing.
    q: CREW_VISIBILITY_FAQ.question,
    a: CREW_VISIBILITY_FAQ.answer,
  },
  {
    q: TEAM_ACCESS_FAQ.question,
    a: TEAM_ACCESS_FAQ.answer,
  },
] as const

export default function OwnerrezFaqSection() {
  return <FaqSection items={MARKETING_FAQ} />
}
