export interface FaqItem {
  id:       string
  question: string
  answer:   string
}

export interface FaqCategory {
  id:    string
  label: string
  items: FaqItem[]
}

/**
 * Crew visibility — the single source of truth for this answer.
 *
 * It appears on three PM-facing surfaces (the OwnerRez and Hospitable landing
 * pages, and the in-app help page), and it makes specific claims about what
 * crew can and cannot reach. Defining it once means a correction lands
 * everywhere instead of leaving two stale copies behind.
 *
 * Each claim below is enforced in the database, not just hidden in the UI
 * (verified 2026-07-27):
 *   - assigned turnovers only    → turnovers_select uses get_crew_turnover_ids(),
 *                                  which joins turnover_assignments to crew_members
 *   - no unassigned listings     → properties_select's crew branch is limited to
 *                                  properties of assigned turnovers
 *   - no guest contact info      → bookings is the only table holding guest_name /
 *                                  guest_email, and bookings_select requires
 *                                  get_user_org_ids(); crew hold no
 *                                  organization_members row, so it returns empty
 *                                  and the table is denied outright
 *   - can submit work orders     → work_orders_insert has a crew branch requiring
 *                                  source = 'crew_flag'
 *   - messaging                  → messages_select is sender/recipient = auth.uid()
 *
 * Payout wording is deliberately scoped to the app rather than stated
 * absolutely. RLS is row-level, not column-level: the crew sync never pulls
 * cost columns (see lib/dexie/sync/turnovers.ts), but a crew token querying
 * Supabase directly could still read properties.cleaning_cost and
 * work_orders.actual_cost on rows already visible to them. If column-level
 * grants or a crew-facing view are added later, this can become absolute.
 */
export const CREW_VISIBILITY_FAQ = {
  question: 'What do my cleaners see when I invite them?',
  answer:
    'Cleaners only see their actively assigned turnovers, associated checklists, and inventory lists. They can submit work orders during a turnover and use in-app messaging, but they never see guest contact information or listings they aren\'t assigned to, and the app never shows them payout details.',
} as const

/**
 * Team-member access — companion to CREW_VISIBILITY_FAQ, same three surfaces.
 *
 * Describes only what the product can actually do today (verified 2026-07-27):
 *   - Invites hardcode role: 'admin' (app/(dashboard)/settings/team/actions.ts).
 *     There is no role picker, and no action anywhere changes a member's role
 *     after the fact — so Owner and Admin are the only roles a customer can
 *     produce. The member_role enum also contains 'manager' and 'viewer', and
 *     RLS has policies referencing them, but neither is assignable through the
 *     app. Deliberately not mentioned here: describing a read-only "viewer"
 *     seat customers cannot create would be a false product claim.
 *   - Owner-exclusive: inviteTeamMember, removeMember and revokeInvite all
 *     check membership.role !== 'owner'; account deletion does the same.
 *   - Billing is NOT owner-only — openBillingPortal and createCheckoutSession
 *     gate on requireOrgMember() alone, so any admin reaches it. Called out
 *     explicitly because it is the one access surprise worth knowing before
 *     you invite someone.
 *   - Org scoping is DB-enforced: every team-facing policy resolves through
 *     get_user_org_ids(), which reads organization_members for auth.uid().
 */
export const TEAM_ACCESS_FAQ = {
  question: 'What can team members see and do?',
  answer:
    'Anyone you invite to your team joins as an Admin with full access to the app — properties, turnovers, work orders, crew scheduling, inventory, owner reporting, and billing. Two things stay with the account Owner: only the Owner can invite or remove team members, and only the Owner can delete the account. Everything a team member sees is scoped to your organization, so they never have access to another company\'s data.',
} as const

/**
 * Multi-crew Start Turnover behavior — shared between the in-app help page
 * and the crew app's own FAQ panel (app/crew/crew-shell.tsx) so the two
 * audiences never end up with an explanation that's quietly drifted apart.
 *
 * A turnover has one shared status column, not one per assignee — see
 * turnovers.status and the status === 'assigned' gate on the Start
 * Turnover button. Confirmed against live production data 2026-07-31.
 */
export const MULTI_CREW_START_FAQ = {
  question: 'Two crew members are assigned to the same turnover — why did only one of them see Start Turnover work?',
  answer:
    'This is expected. A turnover has a single shared status (Assigned → In Progress → Complete) — it isn\'t tracked separately per crew member. Whichever assigned crew member taps Start Turnover first moves it to In Progress for everyone, and the button then disappears from every other assigned crew member\'s screen. This comes up most often when crew split up and work different parts of the same property at the same time. Only one tap is needed — the other crew member doesn\'t need to do anything differently, since every assigned crew member already has full access to the checklist and inventory regardless of who tapped Start.',
} as const

/**
 * Marketing-only pair — shared between the OwnerRez and Hospitable landing
 * pages ONLY (components/ownerrez/faq-section.tsx, components/hospitable/
 * faq-section.tsx). Found already near-verbatim duplicated between the two
 * (one word apart on MARKETING_OFFLINE_FAQ, byte-for-byte identical on
 * MARKETING_TRIAL_FAQ) — extracted 2026-07-31 to stop that drift.
 *
 * Deliberately NOT wired into FAQ_CATEGORIES or the crew app's FAQ_ITEMS —
 * those have their own separately-worded answers to the same underlying
 * facts, written for a different audience (an existing customer's crew
 * asking "why doesn't this sync" reads differently than a prospect asking
 * "will this work for my rural properties"). Only merge those in too if a
 * future edit makes the wording accidentally identical, the same test this
 * pair failed.
 */
export const MARKETING_OFFLINE_FAQ = {
  question: 'Does it work without cell service?',
  answer:
    'Yes. The crew app stores checklists and task details on the device. Crew can complete an entire turnover offline and the work syncs to the cloud the moment they\'re back in range. Built specifically for properties in rural and low-signal areas.',
} as const

export const MARKETING_TRIAL_FAQ = {
  question: 'What happens when my trial ends?',
  answer:
    'After 14 days you\'ll be prompted to choose a plan. If you don\'t subscribe, your account is paused and your data is retained for 30 days so you can pick back up without losing anything. No credit card is required to start.',
} as const

/**
 * The four FAQ items /ownerrez, /hospitable, and the homepage all share
 * verbatim — offline capability, trial length, crew visibility, team access
 * — already converted to the `{ q, a }` shape every FaqSection/json-ld.ts
 * consumer on those pages uses. Appended after each page's own persona-
 * specific entries (or, for the homepage, used as the entire FAQ array — see
 * app/json-ld.ts).
 *
 * Extracted 2026-08-31: app/ownerrez/json-ld.ts and app/hospitable/json-ld.ts
 * carried a byte-identical copy of these four `{ q: X.question, a: X.answer }`
 * object literals, which is what SonarCloud kept flagging even after the
 * @graph-scaffolding duplication between those two files was extracted into
 * buildFaqSoftwareJsonLd() — the FAQ *content*, not just the JSON-LD shape
 * around it, was genuinely duplicated.
 */
export const SHARED_LANDING_FAQ_TAIL: ReadonlyArray<{ q: string; a: string }> = [
  { q: MARKETING_OFFLINE_FAQ.question, a: MARKETING_OFFLINE_FAQ.answer },
  { q: MARKETING_TRIAL_FAQ.question, a: MARKETING_TRIAL_FAQ.answer },
  { q: CREW_VISIBILITY_FAQ.question, a: CREW_VISIBILITY_FAQ.answer },
  { q: TEAM_ACCESS_FAQ.question, a: TEAM_ACCESS_FAQ.answer },
]

/**
 * /hosts — the solo-host landing page's two persona-specific FAQ items.
 *
 * Distinct from CREW_VISIBILITY_FAQ / TEAM_ACCESS_FAQ (which assume the
 * reader is already deciding how to configure a team). These two answer the
 * question that comes *before* that: "does this even apply to someone
 * without a team." Kept separate under the same rule STROPS_FAQ documents —
 * different audience, don't merge just because the underlying facts overlap.
 *
 * HOSTS_CREW_REQUIRED_FAQ verified 2026-08-10 against BOTH the schema and the
 * server action, which do not agree on what a crew member minimally needs:
 *   - crew_members is its own table, independent of organization_members.
 *     org_id and name are its only NOT NULL columns without a default;
 *     user_id and email are nullable and role defaults to 'general'. So at
 *     the DATABASE level a crew row needs only a name.
 *   - addCrewMember() (app/(dashboard)/settings/actions.ts) is stricter than
 *     that: it rejects on `!email && !phone`. A name alone is not actually
 *     acceptable through the form a customer uses.
 *   The answer below is worded to the SERVER ACTION, not the schema. The
 *   first draft said "it's a name and a role" — true of the table, false of
 *   the product, and a prospect would have hit the validation error inside
 *   their first minute. The claim that matters here is unaffected: no
 *   auth.users row, no invite, and no second account are required.
 *   - Inviting that row to get app/login access ("Invite to App") is a
 *     separate, later action — see CREW_VISIBILITY_FAQ's own note on the
 *     two-step Add Crew Member / Invite to App flow this claim is built on.
 *
 * HOSTS_REPLACES_PMS_FAQ generalizes the provider-specific "Does FieldStay
 * replace OwnerRez/Hospitable?" pair (components/ownerrez/faq-section.tsx,
 * components/hospitable/faq-section.tsx) to cover a visitor who isn't on
 * either — the more likely case at 1–4 properties. The iCal claim is the
 * same one homepage-content.tsx's "How it works" step 1 already makes.
 */
export const HOSTS_CREW_REQUIRED_FAQ = {
  question: 'Do I need to run a crew to use this?',
  answer:
    'No. Add yourself as your own crew member — a name, a role, and an email or phone number, which takes ' +
    'under a minute — and you can assign yourself to turnovers, work checklists, and track inventory from ' +
    'day one. No separate account or invite is involved. You can send yourself an app login, or invite an ' +
    'actual cleaner, later if you ever need to. Nothing about the Hosts plan requires a team.',
} as const

export const HOSTS_REPLACES_PMS_FAQ = {
  question: 'Does FieldStay replace Airbnb, VRBO, or my PMS?',
  answer:
    'No. Airbnb, VRBO, OwnerRez, Hospitable, and Hostex handle bookings, rates, and guest messaging — FieldStay ' +
    'handles what happens on the ground after a guest books: turnovers, checklists, inventory, vendor work ' +
    'orders, and your own P&L. If you\'re on OwnerRez, Hospitable, or Hostex, connect it in about 2 minutes ' +
    'and everything syncs automatically. If you\'re on none of them, paste your Airbnb or VRBO iCal link ' +
    'instead — ' +
    'same result.',
} as const

/**
 * /enterprise — the large-portfolio segment landing page's FAQ content.
 *
 * Kept honest about two real limits rather than glossing over them:
 * ENTERPRISE_SLA_FAQ names no specific uptime percentage or credit terms
 * because none are published anywhere in this codebase (checked — only the
 * feature-bullet phrase "SLA-backed uptime" in plan-tiers.ts, no actual
 * number), and ENTERPRISE_TEAM_ACCESS_FAQ says plainly that every invited
 * team member gets full org-wide Admin access today — there is no region-
 * or property-scoped permission tier yet, which TEAM_ACCESS_FAQ's own
 * wording already confirms ("Anyone you invite... joins as an Admin with
 * full access"). An enterprise buyer will ask this exact question; answering
 * it honestly here is worth more than a page that goes quiet on it.
 */
export const ENTERPRISE_SLA_FAQ = {
  question: 'What SLA do you offer for Enterprise accounts?',
  answer:
    'Enterprise accounts get an uptime SLA and dedicated support commitments — the specific terms are set ' +
    'per contract based on your deployment, so we don\'t publish a single number here. Talk to us and we\'ll ' +
    'work out what\'s right for your operation.',
} as const

export const ENTERPRISE_SECURITY_FAQ = {
  question: 'What security and compliance measures does FieldStay have in place?',
  answer:
    'All data is encrypted in transit (TLS 1.2+) and sensitive credentials and tokens are encrypted at rest ' +
    '(AES-256, via Supabase Vault). Every security-relevant action — logins, permission changes, data exports ' +
    '— is written to an append-only audit log retained for 3 years, consistent with SOC 2 Type II audit ' +
    'requirements. A signed Data Processing Agreement (GDPR Article 28) is available for any account — see ' +
    '/dpa. We don\'t hold a SOC 2 or ISO 27001 certification today; if that\'s a hard requirement for your ' +
    'organization, tell us and we can talk through where things stand.',
} as const

export const ENTERPRISE_TEAM_ACCESS_FAQ = {
  question: 'Can different teams or regions have different levels of access?',
  answer:
    'Not yet, and we\'d rather say that plainly than let you find out after signing up. Today, every person ' +
    'you invite to your organization joins with full Admin access to the whole account — every property, ' +
    'every region. Crew members are separate and already scoped to only their own assigned turnovers, but ' +
    'there is no region- or property-scoped permission tier for office staff. If granular, per-region access ' +
    'control is a requirement for your team, talk to us before you commit.',
} as const

export const ENTERPRISE_MIGRATION_FAQ = {
  question: 'What happens to our existing data when we switch to FieldStay?',
  answer:
    'If you\'re on OwnerRez, Hospitable, or Hostex, connecting your account pulls in your full booking ' +
    'history — not just upcoming stays — on the first sync, so nothing before today is lost. There isn\'t a ' +
    'separate white-glove migration product beyond that connection: it\'s the same sync every FieldStay ' +
    'account uses, just at your scale. Portfolio and Enterprise accounts get custom onboarding and dedicated ' +
    'account support to walk through the cutover with you.',
} as const

/**
 * /for-vendors — the vendor/contractor-facing landing page's FAQ content.
 *
 * Every answer here is checked against the live token-portal flow
 * (app/work-orders/[token]/vendor-portal.tsx, lib/stripe/vendor-connect-invite.ts,
 * lib/inngest/functions/work-order-dispatch.ts and work-order-invoice.ts) —
 * not the older docs/support/26-work-order-vendor-dispatch.md article, which
 * describes a sign-off-only flow that predates the current itemized-invoice
 * + Stripe Connect payout system and is stale relative to what's actually
 * live. VENDOR_PAYOUT_TIMING_FAQ deliberately doesn't promise a specific
 * number of days: no payout SLA is published anywhere in this codebase, and
 * the real timing depends on when the property manager approves the invoice
 * plus Stripe's own transfer schedule, neither of which FieldStay controls.
 */
export const VENDOR_NO_ACCOUNT_FAQ = {
  question: 'Do I need to create an account to use FieldStay?',
  answer:
    'No. A work order arrives as a link by email — you open it, see the property details and the ' +
    'authorized spending limit, and can submit a quote or mark the job complete with photos, all with no ' +
    'account and nothing to install. The one exception: before you can submit an invoice for payment, ' +
    'you\'ll be asked to set up a Stripe Connect payout account (a one-time step, so payment can reach your ' +
    'bank) — that\'s a Stripe account, not a FieldStay login.',
} as const

export const VENDOR_PAYOUT_TIMING_FAQ = {
  question: 'How fast do I get paid?',
  answer:
    'Once the property manager reviews and approves your invoice, payment is sent via Stripe Connect ' +
    'directly to your bank account. We don\'t control — and won\'t promise a specific number of days for — ' +
    'how quickly a given property manager reviews an invoice, and Stripe\'s own transfer timing applies ' +
    'once payment is released.',
} as const

export const VENDOR_MULTIPLE_PMS_FAQ = {
  question: 'What if I work with multiple property managers who don\'t all use FieldStay?',
  answer:
    'Nothing changes on your end. Each work order link is independent and tied to that one job — there\'s ' +
    'no FieldStay account for you to maintain across property managers, so a job from a manager who uses ' +
    'FieldStay works exactly like any other, and the property managers who don\'t use it just reach you the ' +
    'way they always have.',
} as const

/**
 * /strops — the offline SEO landing page.
 *
 * Lives here rather than in app/strops/ because this file is where FAQ content
 * belongs, and because putting it next to MARKETING_OFFLINE_FAQ is the point:
 * that pair and these answers make the same claims to the same kind of reader,
 * so whoever edits one should see the other. The first draft of this content
 * was a separate app/strops/faq.ts with its own duplicate FaqItem interface,
 * which SonarCloud flagged at 70% duplication against this file.
 *
 * Kept SEPARATE from MARKETING_OFFLINE_FAQ rather than merged, under the rule
 * that pair's own comment sets out: different audiences may keep differently
 * worded answers to the same fact, and only accidentally-identical wording
 * gets extracted. MARKETING_OFFLINE_FAQ is one line on a page about an
 * integration; these are the whole subject of a page written for someone
 * typing "what app is best for turnovers in low service areas" into Google.
 * They are checked for CONSISTENCY, not merged — nothing below contradicts it.
 *
 * Questions are phrased as SEARCHES, not tidy headings, because they carry
 * FAQPage structured data aimed at the "People also ask" block. The last one
 * exists to say what does NOT work offline; a page that only claims wins reads
 * like every other vendor's, and unit/pages/strops.test.ts fails if it goes.
 *
 * Every answer must stay true to app/strops/offline-capabilities.ts, which
 * cites the implementing file for each claim.
 */
export const STROPS_FAQ: readonly FaqItem[] = [
  {
    id:       'strops-what-app-is-best',
    question: 'What app is best for turnovers in low service areas?',
    answer:
      'FieldStay is built offline-first for exactly this. The crew app installs to the phone and stores ' +
      'the day\'s turnovers, checklists, property details and inventory on the device, so it opens and ' +
      'works with no bars at all. Cleaners tick items, take photos and complete turnovers normally; ' +
      'everything queues locally and uploads the moment the phone finds signal again — usually before ' +
      'they have driven back to the main road.',
  },
  {
    id:       'strops-does-the-cleaning-checklist',
    question: 'Does the cleaning checklist work without internet?',
    answer:
      'Yes. The entire checklist — every room and item, including photo requirements — is cached on the ' +
      'phone before the crew arrives. Ticking items, adding notes and attaching photos all work with the ' +
      'phone in airplane mode. Completion timestamps are recorded on the device at the moment of the tap, ' +
      'not when it syncs, so job duration stays accurate even if the upload happens an hour later.',
  },
  {
    id:       'strops-what-happens-to-photos',
    question: 'What happens to photos taken with no cell service?',
    answer:
      'They are stored on the device in their own upload queue and sent independently of everything else, ' +
      'with automatic retries. A 40-photo turnover in a basement is not held up by one failed request, ' +
      'and a photo that ultimately cannot upload shows in the app with a retry button rather than ' +
      'disappearing.',
  },
  {
    id:       'strops-will-i-lose-work',
    question: 'Will I lose work if the phone dies or the app closes mid-turnover?',
    answer:
      'No. Each change and its pending upload are written to the phone in a single transaction, so a ' +
      'phone killed mid-tap either has the change and the queued upload or neither — never a checkbox ' +
      'that looks ticked but was never queued. Reopening the app picks up exactly where the crew left off.',
  },
  {
    id:       'strops-what-does-not-work',
    question: 'What does NOT work offline in FieldStay?',
    answer:
      'Three things need a connection: requesting time off, scrolling back through message history ' +
      '(sending a message queues offline fine), and the manager dashboard, which assumes a desk. Offline ' +
      'support is built for the crew app on a phone at the property.',
  },
  {
    id:       'strops-do-cleaners-need-to',
    question: 'Do cleaners need to remember to sync?',
    answer:
      'No. There is no sync button to forget. The app uploads in the background whenever it has a ' +
      'connection, replaying changes in the order they were made. The only time a crew member sees ' +
      'anything about syncing is if something genuinely failed, which surfaces with a retry button.',
  },
  {
    id:       'strops-does-this-work-for',
    question: 'Does this work for rural or mountain vacation rentals?',
    answer:
      'That is the case it was designed around. Cabins, lake houses and mountain properties routinely ' +
      'have no usable signal inside the building even when the driveway has a bar. Because FieldStay ' +
      'caches everything the crew needs before they arrive and queues everything they do, the crew never ' +
      'has to stand outside to load a checklist or upload a photo.',
  },
  {
    id:       'strops-is-fieldstay-offline-first',
    question: 'Is FieldStay offline-first or just offline-tolerant?',
    answer:
      'Offline-first. The crew app reads from local device storage as its normal mode of operation and ' +
      'syncs in the background — it is not an online app with a cache bolted on. There is no separate ' +
      '"offline mode" to switch into, because there is no online mode to switch out of.',
  },
] as const

/**
 * /breezeway-alternative — comparison-page FAQ, written for both AEO
 * (each answer stands alone and is directly quotable by an answer engine —
 * no "as mentioned above", no pronoun that needs the question above it) and
 * for a prospect who has already used Breezeway and wants the specific
 * differences, not a generic pitch. See app/breezeway-alternative/
 * comparison-data.ts for the source of every factual claim repeated here —
 * this file and that one must not drift, and
 * unit/pages/breezeway-alternative.test.ts checks the numbers this file
 * quotes against the real bracket schedule.
 */
export const BREEZEWAY_FAQ: readonly FaqItem[] = [
  {
    id:       'breezeway-vs-fieldstay-difference',
    question: 'What is the difference between FieldStay and Breezeway?',
    answer:
      'The biggest practical differences are pricing transparency and how vendors are onboarded. FieldStay ' +
      'publishes one graduated rate schedule that prices any property count from 1 to 150 with no sales ' +
      'call required. Breezeway publishes a flat $19.99/property rate only for portfolios of 4 properties ' +
      'or fewer; 5 or more requires a demo and a custom quote. On vendors: a FieldStay work order reaches a ' +
      'vendor as a link they open on their phone, with no account and nothing to install. Breezeway invites ' +
      'vendors and cleaners to a Breezeway account and its dedicated mobile app.',
  },
  {
    id:       'breezeway-alternative-pricing',
    question: 'Is FieldStay cheaper than Breezeway?',
    answer:
      'It depends on your property count, and for most real portfolios the honest answer is "we don\'t ' +
      'know, because Breezeway won\'t say." For 10 properties, FieldStay is $148/month, publicly calculable ' +
      'from the rate schedule before you ever talk to anyone. Breezeway\'s published $19.99/property rate ' +
      'only covers portfolios of 4 or fewer — at 10 properties you\'re already past that and into a custom ' +
      'quote, so there is no public number to compare against.',
  },
  {
    id:       'breezeway-alternative-vendor-app',
    question: 'Do vendors need to download an app to work with FieldStay, the way they do with Breezeway?',
    answer:
      'No. A FieldStay work order is dispatched as a link — the vendor opens it on their phone, sees the ' +
      'job details, submits a quote or completion photos, and is done. No account, no password, no app to ' +
      'install. Breezeway\'s vendor and cleaner workflow runs through dedicated Android and iOS apps with ' +
      'account login, per Breezeway\'s own help documentation.',
  },
  {
    id:       'breezeway-alternative-offline',
    question: 'Does FieldStay work offline the way Breezeway does?',
    answer:
      'Both platforms support offline field work, so this isn\'t a capability gap — the real difference is ' +
      'HOW. FieldStay\'s crew app is a progressive web app: no App Store or Play Store install, added ' +
      'straight to the home screen, and it works with zero signal because it reads from the phone\'s local ' +
      'storage as its normal mode, not a special "offline mode." Breezeway ships native iOS and Android ' +
      'apps with their own offline sync.',
  },
  {
    id:       'breezeway-alternative-switching',
    question: 'How do I switch from Breezeway to FieldStay?',
    answer:
      'There\'s no data migration to run, because FieldStay doesn\'t import FROM Breezeway — it connects TO ' +
      'your booking platform (OwnerRez, Hospitable, or Hostex) and builds your turnover schedule from your ' +
      'existing bookings automatically. Most teams run FieldStay on a handful of properties during a free ' +
      'trial alongside their current setup before moving the rest of the portfolio over.',
  },
  {
    id:       'breezeway-alternative-guidebook',
    question: 'Does FieldStay charge extra for a guest guidebook, the way Breezeway does?',
    answer:
      'No — FieldStay\'s guest guidebook is included on every plan at no extra cost, and it can actually pay ' +
      'for itself: sign 5 local business sponsors into your guidebook and FieldStay applies a real $10 credit ' +
      'against your monthly bill automatically, or $25 at 6 or more sponsors. Breezeway\'s digital welcome ' +
      'book ("Guide") sits in a higher "Operations + Guest Experience" tier, and Breezeway\'s own pricing page ' +
      'lists it among the add-ons priced a la carte — an added monthly cost with no revenue-sharing back to you.',
  },
  {
    id:       'breezeway-alternative-guarantee',
    question: 'Does FieldStay offer any kind of guarantee?',
    answer:
      'Yes — the Glass Box Operations Guarantee. Run it on your 3-5 hardest properties for 14 days, ' +
      'cancel with one click if it doesn\'t help. If you ever think something was missed or mishandled, ' +
      'FieldStay doesn\'t ask you to take its word for it — every checklist step, photo, and work order ' +
      'status change is timestamped and logged, and that record is what settles the question. It is not a ' +
      'money-back guarantee; it is a transparency guarantee backed by an actual audit trail.',
  },
] as const

export const FAQ_CATEGORIES: FaqCategory[] = [
  {
    id:    'pms-sync',
    label: 'PMS Sync',
    items: [
      {
        id:       'or-connect',
        question: 'How do I connect my PMS to FieldStay?',
        answer:
          'Go to Settings → Integrations and click "Connect" next to OwnerRez, Hospitable, or Hostex — whichever you use. You\'ll be redirected to authorize the connection with your PMS. Once approved, your properties and upcoming bookings sync automatically within a few minutes.',
      },
      {
        id:       'or-sync-time',
        question: 'How long does the initial sync take?',
        answer:
          'Initial sync typically completes within a few minutes for most portfolios. You\'ll see a status indicator on the Properties page while it runs. Larger portfolios typically sync within 15 minutes.',
      },
      {
        id:       'or-no-properties',
        question: 'My properties didn\'t appear after connecting. What do I do?',
        answer:
          'Wait 10 minutes and refresh the Properties page. If nothing appears, go to Settings → Integrations, disconnect your PMS, and reconnect. If the connection shows an error status after reconnecting, email support@fieldstay.app with your account email and we\'ll trace the webhook delivery.',
      },
      {
        id:       'or-historical',
        question: 'Will historical bookings sync over, or only future ones?',
        answer:
          'On your initial connection, FieldStay syncs your full booking history from your PMS, not just upcoming stays — so past bookings are already there for reporting from day one. All future booking changes sync in real time as your PMS sends webhook events. Note this only applies to the first connection: if you disconnect and reconnect later, that re-sync only pulls in active and future bookings, not your full history again.',
      },
      {
        id:       'or-not-updating',
        question: 'A booking changed in my PMS but it hasn\'t updated in FieldStay.',
        answer:
          'Booking changes arrive via your PMS\'s webhooks, which typically deliver within 60 seconds of a change. If an update hasn\'t appeared after 10 minutes, check Settings → Integrations to confirm your connection shows "Active." Reconnecting will re-establish the webhook subscription if the status shows an error.',
      },
    ],
  },
  {
    id:    'crew',
    label: 'Crew & Turnovers',
    items: [
      {
        id:       'crew-invite',
        question: 'How do crew members access FieldStay?',
        answer:
          'Go to Crew, add the person with the "Add Crew Member" form, then click "Invite to App" on their row (or "Invite All" to send every pending invite at once). They\'ll receive a link to create their account and install the app. Crew members see only their assigned turnovers and checklists — not financial data, owner reports, or other crew members\' work.',
      },
      {
        // Replaces an earlier answer that claimed crew "cannot view ...
        // maintenance work orders". That was wrong on both counts: crew can
        // raise a work order from a turnover (work_orders_insert permits
        // source = 'crew_flag') and can see the ones assigned to them
        // (work_orders_select's assigned_crew_member_id branch).
        id:       'crew-permissions',
        question: CREW_VISIBILITY_FAQ.question,
        answer:   CREW_VISIBILITY_FAQ.answer,
      },
      {
        id:       'crew-assignment',
        question: 'How are turnovers assigned after a guest checks out?',
        answer:
          'When your connected PMS sends a checkout event, FieldStay creates a turnover automatically. What happens next depends on your Crew Auto-Assignment setting: "Suggest" scores every available crew member on proximity, reliability, workload, and past familiarity with the property, then shows you the best match on the Turnovers board so you can assign with one click. "Autopilot" assigns that best match automatically with no manual step. "Off" leaves every turnover unassigned for you to pick manually.',
      },
      {
        id:       'crew-offline',
        question: 'Can crew complete checklists without cell service?',
        answer:
          'Yes. The crew app uses local-first sync — checklists, property details, and assignments download to the device. Crew can work through an entire turnover offline and capture photos. Everything syncs to the cloud automatically when connectivity returns.',
      },
      {
        id:       'crew-pwa',
        question: 'Does the crew app need to be installed from the App Store?',
        answer:
          'No. It\'s a Progressive Web App (PWA). After accepting the invite, crew open the link in Safari (iPhone) or Chrome (Android) and tap "Add to Home Screen." It installs like a native app with offline support — no App Store or Google Play account required.',
      },
      {
        id:       'crew-multi-assign-start',
        question: MULTI_CREW_START_FAQ.question,
        answer:   MULTI_CREW_START_FAQ.answer,
      },
    ],
  },
  {
    id:    'team',
    label: 'Team & Access',
    items: [
      {
        id:       'team-permissions',
        question: TEAM_ACCESS_FAQ.question,
        answer:   TEAM_ACCESS_FAQ.answer,
      },
      {
        id:       'team-vs-crew',
        question: 'What\'s the difference between a team member and a crew member?',
        answer:
          'Team members are office staff — they sign in to the full dashboard and manage the business. Crew members are the people doing turnovers in the field; they use a separate phone app and only see the jobs assigned to them. They are two different account types, so adding a cleaner as a team member would give them far more access than they need. Add cleaners under Crew, and office staff under Team.',
      },
    ],
  },
  {
    id:    'billing',
    label: 'Billing & Plans',
    items: [
      {
        id:       'billing-property-count',
        question: 'What counts as a property for billing, and how is the price calculated?',
        answer:
          'Each unique property unit synced from your connected PMS (OwnerRez, Hospitable, or Hostex) counts as one property. A multi-unit building with 4 apartment units counts as 4. Archived or removed properties do not count toward your billing total. Pricing is graduated: your first property is $49/mo, then $13/property for properties 2-4, $10/property for 5-15, $8/property for 16-50, and $6/property for 51-150 — so adding one more property never causes a big jump, it just adds that property\'s own rate. See Settings → Billing for an itemized breakdown at your current property count.',
      },
      {
        id:       'billing-crew-seats',
        question: 'Are crew members billed as additional seats?',
        answer:
          'No. FieldStay pricing is based entirely on property count. You can invite as many crew members as your operation needs at no extra charge.',
      },
      {
        id:       'billing-trial',
        question: 'How does the 14-day free trial work?',
        answer:
          'You get full access to every feature for 14 days with no credit card required. At the end of the trial you\'ll be prompted to subscribe. If you don\'t, your account is paused and your data is retained for 30 days so you can reactivate without losing anything.',
      },
      {
        id:       'billing-plan-change',
        question: 'What happens to my bill when I add or remove a property?',
        answer:
          'There\'s no plan to switch — your bill simply reflects your current property count, computed the same way every time (see the property-count question above). What changes is WHEN it takes effect, and it depends on your billing interval. On monthly billing, an added or removed property is reflected starting your next invoice — nothing changes mid-cycle. On annual billing, added properties are held and only billed once you\'ve added a 5th property since your last renewal, at which point all 5 are prorated together for the remainder of your billing year; removed properties are credited at your next renewal. Either way, you never see a mid-cycle surprise charge.',
      },
      {
        id:       'billing-cancel',
        question: 'How do I cancel my subscription?',
        answer:
          'Go to Settings → Billing → Manage Subscription and click Cancel. You retain full access until the end of your current billing period. Your data is preserved for 30 days after cancellation.',
      },
    ],
  },
  {
    id:    'technical',
    label: 'Technical',
    items: [
      {
        id:       'tech-browsers',
        question: 'Which browsers and devices are supported?',
        answer:
          'The PM dashboard works in any modern browser — Chrome, Safari, Firefox, and Edge on desktop and mobile. The crew app is optimized for Safari on iOS and Chrome on Android. Keep your browser updated for the best experience.',
      },
      {
        id:       'tech-local-first',
        question: 'What does "local-first" mean for my data?',
        answer:
          'FieldStay syncs your data to a local database on your device. Pages load instantly from local storage rather than waiting on a network round-trip. Changes you make are written locally first, then synced to the cloud in the background — so the app feels fast even on slow connections.',
      },
      {
        id:       'tech-security',
        question: 'Is my data secure?',
        answer:
          'Yes. All data is encrypted in transit and at rest. Row-level security policies in the database enforce strict tenant isolation — no user can ever access another organization\'s data. PMS access tokens (OwnerRez, Hospitable, Hostex) are stored in an encrypted vault, never in the application database.',
      },
      {
        id:       'tech-password',
        question: 'How do I reset my password?',
        answer:
          'On the login page, click "Forgot password" and enter your email. You\'ll receive a reset link within a few minutes. Check your spam folder if it doesn\'t arrive — emails come from noreply@fieldstay.app.',
      },
    ],
  },
  /**
   * Inventory — rewritten 2026-08-12, when par levels stopped being a number
   * a PM types and became one the system computes per property.
   *
   * The previous copy did not merely age out of date, it walked PMs into a
   * bug: it said "set them at Inventory → [Property Name]", and doing that on
   * a scaling item wrote a value the next recompute silently overwrote. That
   * is fixed (an edit now re-bases the item — see rebaseParFromTarget in
   * lib/inventory/par-engine.ts), and this copy describes the fixed behaviour.
   *
   * Each claim below, checked against the code rather than the spec:
   *   - scales per property        → PAR_SMART_GROUPS maps bathroom_essential /
   *                                  bedroom_essential / guest_consumable to
   *                                  bathrooms / bedrooms / max_guests
   *   - your number is kept        → updateParLevel calls rebaseParFromTarget,
   *                                  which stores a base_qty reproducing it and
   *                                  sets auto_adjust = false so the historical
   *                                  branch cannot supersede it
   *   - fixed items exist          → par_mode = 'static' short-circuits
   *                                  resolvePar entirely
   *   - rescale "within seconds"   → saveDetails/createProperty send
   *                                  inventory/par-recompute-requested; measured
   *                                  at ~1.0s and ~1.2s end to end on 2026-08-11
   *   - learns from real usage     → resolvePar's historical branch, at
   *                                  HISTORICAL_MIN_SAMPLES (3) counts
   *   - added catalog items scale  → addInventoryItems inherits par_mode /
   *                                  smart_group / base_qty from inventory_catalog
   *   - ask the support chat       → get_par_level_explanation in
   *                                  lib/support/account-tools.ts
   *   - re-apply never overwrites  → applyTemplateToProperties inserts only
   *                                  items absent from the property (deduped on
   *                                  catalog_item_id AND lowercased name); it
   *                                  has no update path for existing rows
   *
   * DELIBERATELY NOT DESCRIBED: par_mode, smart_group, base_qty, auto_adjust
   * or the buffer percentages. A PM has no UI for any of them, so naming them
   * would describe controls that do not exist.
   */
  {
    id:    'inventory',
    label: 'Inventory & Restocking',
    items: [
      {
        id:       'inv-par-level',
        question: 'What is a par level and how do I set one?',
        answer:
          'A par level is the minimum quantity of a supply item you want on hand before it needs restocking — e.g. 4 rolls of paper towels. Most items set themselves: FieldStay scales them to each property, so a 4-bathroom house gets more towels than a studio without you doing anything. To override one, click the par level at Inventory → [Property Name] and type the number you want. Your number is used as-is, and the item keeps scaling from it if the property changes later.',
      },
      {
        id:       'inv-smart-par',
        question: 'Why is the same item a different quantity at each property?',
        answer:
          'Because most supply items scale with the property. Bathroom items (towels, bath mats, toiletries) scale with the bathroom count, bedroom items (hangers, spare linens) with the bedroom count, and guest consumables (coffee, dinnerware, glasses) with how many guests the property sleeps — each with a small safety buffer on top. So the same catalog item shows a different number at a 1-bathroom condo than at a 4-bathroom lodge. Items that do not vary by size — a plunger, a first aid kit — stay a fixed number everywhere.',
      },
      {
        id:       'inv-par-changed',
        question: 'My par levels changed on their own — why?',
        answer:
          'Editing a property\'s bedrooms, bathrooms or max guests rescales every item that scales with it, within a few seconds. That is expected: it is the same recalculation that sizes a new property. Two things are never touched by it — an item you set yourself, which keeps scaling from your number, and any item marked as a fixed quantity. Once a property has enough inventory counts on record, FieldStay also starts using what that property actually goes through instead of the size estimate. If a number still looks wrong, ask the in-app support chat "why is my [item] par level what it is" and it will explain that specific item at that specific property.',
      },
      {
        id:       'inv-add-own-items',
        question: 'Can I add my own items, or items only some properties need?',
        answer:
          'Yes. Every property starts from the FieldStay standard list, and you add anything else it needs — pool towels, fire pit supplies, a hot tub kit — at Inventory → [Property Name]. Items added from the catalog scale with property size the same way the standard ones do. You can also build your own template from scratch at Inventory → Templates if a group of properties needs a different list entirely.',
      },
      {
        id:       'inv-kroger',
        question: 'How does the Kroger cart work?',
        answer:
          'When crew inventory counts come in below par, FieldStay creates a purchase order automatically. If you\'ve connected Kroger, go to Inventory → Portfolio and click "Build Cart" to add every below-par item to your Kroger cart in the right quantities. You still review and check out yourself — building the cart never places the order on its own.',
      },
      {
        id:       'inv-not-near-kroger',
        question: 'There\'s no store called "Kroger" near my property — can I still use this?',
        answer:
          'Almost certainly yes. Kroger owns dozens of regional grocery chains under different names — Ralphs, Fred Meyer, King Soopers, Smith\'s, Fry\'s, QFC, Harris Teeter, Mariano\'s, and more. FieldStay automatically connects to whichever Kroger-owned store is closest to your property, whatever it\'s branded locally.',
      },
      {
        id:       'inv-template-change',
        question: 'If I edit an inventory template, does it update properties that already use it?',
        answer:
          'No. Templates are a starting point, not a live link — once applied, that property\'s items are independent. Re-applying an edited template to the same property adds any items it does not have yet, but never changes the par levels already there, so a level you adjusted is safe from a re-apply.',
      },
    ],
  },
  {
    id:    'guidebook',
    label: 'Guest Guidebook & SMS',
    items: [
      {
        id:       'gb-what-is',
        question: 'What is the Guest Guidebook?',
        answer:
          'A personalized, mobile-friendly page delivered to each guest with their door code, WiFi password, check-in instructions, house rules, and local recommendations. It requires no app download and is pre-populated from your PMS connection — review it at Guidebook → [Property Name] and toggle Published when ready.',
      },
      {
        id:       'gb-sms-optin',
        question: 'How does the SMS door-code text work?',
        answer:
          'Guests get a pre-arrival email with a prompt to receive their door code by text. They enter their number and explicitly consent before anything is sent — no guest is ever texted without opting in first. They can reply STOP at any time to stop all messages instantly.',
      },
      {
        id:       'gb-repeat-guest',
        question: 'Why is a repeat guest being asked to opt in to texts again?',
        answer:
          'SMS consent is recorded per booking, not per phone number, so a guest who opted in on a previous stay will still see the prompt on their next booking. This keeps consent tied to the specific stay it covers rather than assuming indefinite consent from one opt-in.',
      },
      {
        id:       'gb-sponsors',
        question: 'How do guidebook sponsors work?',
        answer:
          'Local businesses pay $15/month to be featured in your guidebook and in SMS recommendation messages. At 3 active sponsors the Guidebook itself unlocks permanently (it\'s otherwise free only during your trial); 5 sponsors add a $10/month plan credit, 6 sponsors bumps that to $25/month. Add one at Guidebook → Sponsors → Add Sponsor.',
      },
    ],
  },
  {
    id:    'reviews',
    label: 'Reviews & RepuGuard',
    items: [
      {
        id:       'rg-how',
        question: 'How does RepuGuard work?',
        answer:
          'When a guest review syncs in from OwnerRez, Hospitable, or Hostex, RepuGuard generates a draft response using AI, tailored to the review and your property. Go to Reviews to read, edit, and approve any draft before it goes anywhere.',
      },
      {
        id:       'rg-post',
        question: 'Does RepuGuard post my response automatically?',
        answer:
          'No — approving a draft doesn\'t submit it anywhere by itself. For OwnerRez reviews, clicking "Post to OwnerRez" opens the review on OwnerRez\'s site so you can paste your response there. For Hospitable, Hostex, and manually-added reviews, you post the response wherever the review actually lives, then click "Mark as Posted" in FieldStay so the status reflects reality.',
      },
      {
        id:       'rg-manual',
        question: 'Can I get a draft response for a review that didn\'t sync automatically?',
        answer:
          'Yes. Reviews on Google, Booking.com, or other platforms that don\'t sync through your PMS can be added at Reviews → Add Review Manually, up to 2 per week per organization (resets every Monday). Manually-added reviews get one draft and can\'t be regenerated.',
      },
    ],
  },
  {
    id:    'work-orders',
    label: 'Work Orders & Vendors',
    items: [
      {
        id:       'wo-create',
        question: 'How do I create and assign a work order?',
        answer:
          'Go to Maintenance → New Work Order, fill in the property, description, priority, and an optional Not-To-Exceed amount, then choose Assign Vendor (dispatches an email with a secure portal link) or Assign Crew (appears in their crew app alongside turnovers).',
      },
      {
        id:       'wo-compliance',
        question: 'What happens if a vendor\'s insurance has expired?',
        answer:
          'FieldStay checks compliance before every dispatch. A document expired 1–45 days puts the vendor in a Grace Period — you can acknowledge the risk and proceed, and it\'s logged. Expired 46+ days hard-blocks the vendor from being assigned until they update their documents.',
      },
      {
        id:       'wo-payment',
        question: 'How do vendors get paid for completed work orders?',
        answer:
          'Vendors connect a bank account through Stripe Connect (a one-time, 3–5 minute setup) — FieldStay sends this setup link when they\'re first assigned a work order. Once a vendor signs off on completed work, payment can be released directly to their account. Vendors who haven\'t finished Stripe setup can still be assigned and complete work, but payment is held until they do, or you can settle with them outside FieldStay.',
      },
    ],
  },
  {
    id:    'owner-portal',
    label: 'Owner Portal',
    items: [
      {
        id:       'owner-what-they-see',
        question: 'What do property owners see in the Owner Portal?',
        answer:
          'A read-only view of their property\'s revenue, expenses, and net income for any date range, accessed through a secure tokenized link — no FieldStay account required. They never see crew assignments, work order details, inventory, or any other operational data.',
      },
      {
        id:       'owner-visibility',
        question: 'Can I control which expenses owners see?',
        answer:
          'Yes. Every transaction has a Visible to Owner toggle. By default, booking revenue, cleaning fees, and work order costs are visible; inventory purchases are hidden as an internal operational cost. Change any transaction\'s visibility from the Owner Portal page.',
      },
      {
        id:       'owner-share-revoke',
        question: 'How do I share or revoke an owner\'s portal access?',
        answer:
          'Go to Owner Portal and click Copy Link next to the owner to share it. To cut off access, click Revoke Access on the same page — this is a separate, deliberate action from generating the link, so revoking and re-sharing are two distinct steps rather than one "regenerate" button.',
      },
    ],
  },
  {
    id:    'assets',
    label: 'Asset Health',
    items: [
      {
        id:       'asset-what-is',
        question: 'What is asset health tracking?',
        answer:
          'Go to Assets to track big-ticket items per property — HVAC, water heaters, roofs, appliances — each with a 0–100 health score based on age and repair history. Scores update automatically as time passes and as work orders get logged against an asset. It\'s included on every plan at no extra cost.',
      },
      {
        id:       'asset-depreciation',
        question: 'Does FieldStay handle tax depreciation for assets?',
        answer:
          'If you enter a purchase price and installation date on an asset, FieldStay generates an annual MACRS depreciation schedule using standard IRS tables, and flags Section 179-eligible assets. This is a planning aid, not tax advice — confirm your actual filing with your accountant.',
      },
    ],
  },
  {
    id:    'inspections',
    label: 'Inspections',
    items: [
      {
        id:       'inspections-what-are',
        question: 'What are inspections, and how are they different from a turnover checklist?',
        answer:
          'Inspections are structured walk-throughs recorded against a fixed form — Safety & Risk Mitigation, Indoor Property & Inventory, and Outdoor Property & Grounds. A turnover checklist is an operational to-do list for one guest changeover and is disposable. An inspection is evidence: it is retained permanently, cannot be edited once completed, posts to the owner portal, and is meant to be shown to an insurer or a permitting authority as a multi-year record.',
      },
      {
        id:       'inspections-schedule',
        question: 'How do I set how often inspections happen?',
        answer:
          'You answer it once during onboarding — how often the Safety inspection runs (once or twice a year) and which month it starts in — and FieldStay applies that to every property, including ones you add later. Twice a year means the month you chose and the month six after it: March pairs with September, October with April. Indoor and Outdoor inspections are scheduled the way any other recurring maintenance is. You can change the cadence any time in Maintenance → Inspections.',
      },
      {
        id:       'inspections-different-dates',
        question: 'Why is the same inspection due on different dates at different properties?',
        answer:
          'Because FieldStay puts the walk on a day the property is empty. After a property\u2019s first completed inspection, the due date lands inside a gap between bookings in the target month — and every property has a different calendar, so the days differ even though the month is the same. It is also why a due date can move earlier as well as later. The first time a property is scheduled it is the 1st of the month, because there are no completed walks to schedule around yet.',
      },
      {
        id:       'inspections-overdue-email',
        question: 'When does FieldStay email me about an overdue inspection?',
        answer:
          'On the 1st of each month, in a single email listing everything that was due in a previous month and has not been walked. It goes to the account Owner/Admin, covers every property at once rather than one email per house, and repeats each month until the inspections are done. Inspection due dates cluster by month, so emailing a few days after each due date would mean a trickle of separate messages all month. The dashboard shows an inspection as overdue from the first day, so the email is the escalation rather than the first you hear of it.',
      },
      {
        id:       'inspections-offline',
        question: 'Do inspections work without cell service?',
        answer:
          'Yes, as long as the device has loaded the Inspections page at least once while online. After that the forms and your property list are held on the device, and you can start a walk, answer every item, take photos and complete it with no connection at all. It uploads when you are back in range, and a banner with a retry appears if anything fails to send.',
      },
      {
        id:       'inspections-failed-item',
        question: 'What happens when an inspection item fails?',
        answer:
          'It becomes a work order, a purchase order, a notification, or a recorded fact — decided by the item itself. A loose handrail raises a work order; an expired detector goes on a purchase order; a lapsed permit notifies you without creating a job for anyone. Cleaning failures roll into one cleaning work order per walk rather than one each, and everything purchasable goes onto a single purchase order. A failed item needs a description, because that description becomes the work order\u2019s title.',
      },
      {
        id:       'inspections-edit',
        question: 'Can I edit an inspection after completing it?',
        answer:
          'No. A completed inspection is locked in the database, not just behind a disabled button. The value of the record is that it was not adjusted afterward — a history that can be edited later proves very little to an insurer or an owner. If something needs correcting, run a new inspection of the same form at that property; both stay in the history in date order, the later one superseding the earlier.',
      },
      {
        id:       'inspections-owner-visibility',
        question: 'What do owners see about inspections?',
        answer:
          'Completed inspections post to the owner portal on the day they are finished, including failed items and the work order or purchase order each one produced, with that record\u2019s current status. Scheduled and in-progress inspections are not shown — an unfinished form is not a record. Purely factual items, like noting that a property has no alarm system, are recorded but are not listed as findings, because they are not problems.',
      },
    ],
  },
]

// Flat list used for cross-category search in the accordion component
export const FAQ_FLAT: (FaqItem & { categoryLabel: string })[] =
  FAQ_CATEGORIES.flatMap((cat) =>
    cat.items.map((item) => ({ ...item, categoryLabel: cat.label }))
  )
