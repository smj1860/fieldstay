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

export const FAQ_CATEGORIES: FaqCategory[] = [
  {
    id:    'pms-sync',
    label: 'PMS Sync',
    items: [
      {
        id:       'or-connect',
        question: 'How do I connect my PMS to FieldStay?',
        answer:
          'Go to Settings → Integrations and click "Connect" next to OwnerRez or Hospitable — whichever you use. You\'ll be redirected to authorize the connection with your PMS. Once approved, your properties and upcoming bookings sync automatically within a few minutes.',
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
        question: 'What counts as a property for billing?',
        answer:
          'Each unique property unit synced from your connected PMS (OwnerRez or Hospitable) counts as one property. A multi-unit building with 4 apartment units counts as 4. Archived or removed properties do not count toward your billing total.',
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
        question: 'Can I switch plans if my property count changes?',
        answer:
          'Yes. Go to Settings → Billing → Manage Subscription. Upgrades take effect immediately with prorated billing. Downgrades apply at the start of your next billing period.',
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
          'Yes. All data is encrypted in transit and at rest. Row-level security policies in the database enforce strict tenant isolation — no user can ever access another organization\'s data. PMS access tokens (OwnerRez, Hospitable) are stored in an encrypted vault, never in the application database.',
      },
      {
        id:       'tech-password',
        question: 'How do I reset my password?',
        answer:
          'On the login page, click "Forgot password" and enter your email. You\'ll receive a reset link within a few minutes. Check your spam folder if it doesn\'t arrive — emails come from noreply@fieldstay.app.',
      },
    ],
  },
  {
    id:    'inventory',
    label: 'Inventory & Restocking',
    items: [
      {
        id:       'inv-par-level',
        question: 'What is a par level and how do I set one?',
        answer:
          'A par level is the minimum quantity of a supply item you want on hand before it needs restocking — e.g. 4 rolls of paper towels. Set them at Inventory → Templates, or per property at Inventory → [Property Name] if one property needs different levels than the rest.',
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
          'No. Templates are a starting point, not a live link — once applied to a property, that property\'s items and par levels are independent. Editing the template later only affects properties you apply it to afterward.',
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
          'When a guest review syncs in from OwnerRez or Hospitable, RepuGuard generates a draft response using AI, tailored to the review and your property. Go to Reviews to read, edit, and approve any draft before it goes anywhere.',
      },
      {
        id:       'rg-post',
        question: 'Does RepuGuard post my response automatically?',
        answer:
          'No — approving a draft doesn\'t submit it anywhere by itself. For OwnerRez reviews, clicking "Post to OwnerRez" opens the review on OwnerRez\'s site so you can paste your response there. For Hospitable and manually-added reviews, you post the response wherever the review actually lives, then click "Mark as Posted" in FieldStay so the status reflects reality.',
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
]

// Flat list used for cross-category search in the accordion component
export const FAQ_FLAT: (FaqItem & { categoryLabel: string })[] =
  FAQ_CATEGORIES.flatMap((cat) =>
    cat.items.map((item) => ({ ...item, categoryLabel: cat.label }))
  )
