// The hospitable landing page's FAQ content. The accordion itself is
// components/faq/FaqSection.tsx — this file and its OwnerRez twin used to
// carry byte-identical copies of that markup, which is what SonarCloud kept
// flagging. Shared answers come from lib/faq-content.ts.

'use client'

import { CREW_VISIBILITY_FAQ, TEAM_ACCESS_FAQ, MARKETING_OFFLINE_FAQ, MARKETING_TRIAL_FAQ } from '@/lib/faq-content'
import FaqSection from '@/components/faq/FaqSection'

const MARKETING_FAQ = [
  {
    q: 'Does FieldStay replace Hospitable?',
    a: 'No — FieldStay is a field operations layer that works alongside Hospitable. Hospitable handles bookings, rates, and guest messaging. FieldStay handles what happens on the ground: turnovers, crew assignments, inventory, maintenance, capital planning, and owner reporting. Your Hospitable account stays your system of record — FieldStay never writes back to it.',
  },
  {
    q: 'How long does setup take?',
    a: 'Connecting Hospitable takes about 2 minutes via OAuth. Your properties and upcoming bookings appear within a minute or two. If you have teammates set up in Hospitable, they sync in automatically too — name, email, phone, and role, mapped straight into FieldStay crew accounts.',
  },
  {
    q: 'What data syncs from Hospitable?',
    a: 'FieldStay syncs your properties, upcoming bookings, and teammates on initial connection, then stays current in real time via webhooks — new and modified reservations, cancellations, property changes, and new reviews (which trigger a RepuGuard draft response automatically). It\'s read-only: nothing FieldStay does ever changes your Hospitable data.',
  },
  {
    q: 'How do my crew members access the app?',
    a: 'Teammates synced from Hospitable are added as FieldStay crew members automatically, mapped to the right role — Cleaning, Maintenance, Concierge, Manager, and so on. They get an email invite, create a free account, and install the app to their phone home screen. No App Store required, and they only ever see their own assigned turnovers.',
  },
  {
    // Shared verbatim with the OwnerRez landing page — see lib/faq-content.ts.
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

export default function HospitableFaqSection() {
  return <FaqSection items={MARKETING_FAQ} />
}
