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

export const FAQ_CATEGORIES: FaqCategory[] = [
  {
    id:    'ownerrez',
    label: 'OwnerRez Sync',
    items: [
      {
        id:       'or-connect',
        question: 'How do I connect OwnerRez to FieldStay?',
        answer:
          'Go to Settings → Integrations and click "Connect OwnerRez." You\'ll be redirected to authorize the connection in OwnerRez. Once approved, your properties and upcoming bookings sync automatically within a few minutes.',
      },
      {
        id:       'or-sync-time',
        question: 'How long does the initial sync take?',
        answer:
          'Initial sync typically completes within 3–5 minutes for portfolios under 50 properties. You\'ll see a status indicator on the Properties page while it runs. Larger portfolios may take up to 15 minutes on the first pass.',
      },
      {
        id:       'or-no-properties',
        question: 'My properties didn\'t appear after connecting. What do I do?',
        answer:
          'Wait 10 minutes and refresh the Properties page. If nothing appears, go to Settings → Integrations, disconnect OwnerRez, and reconnect. If the connection shows an error status after reconnecting, email support@fieldstay.app with your account email and we\'ll trace the webhook delivery.',
      },
      {
        id:       'or-historical',
        question: 'Will historical bookings sync over, or only future ones?',
        answer:
          'FieldStay syncs all active and upcoming bookings, plus bookings from the past 90 days. Older records are excluded to keep initial setup fast. All future booking changes sync in real time as OwnerRez sends webhook events.',
      },
      {
        id:       'or-not-updating',
        question: 'A booking changed in OwnerRez but it hasn\'t updated in FieldStay.',
        answer:
          'Booking changes arrive via OwnerRez webhooks, which typically deliver within 60 seconds of a change. If an update hasn\'t appeared after 10 minutes, check Settings → Integrations to confirm your connection shows "Active." Reconnecting will re-establish the webhook subscription if the status shows an error.',
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
          'Go to Crew → Invite Crew Member and enter their email. They\'ll receive a link to create their account and install the app. Crew members see only their assigned turnovers and checklists — not financial data, owner reports, or other crew members\' work.',
      },
      {
        id:       'crew-permissions',
        question: 'What exactly can crew members see and do?',
        answer:
          'Crew members can view their assigned turnovers, step through checklists, capture photos at each section, and mark tasks complete. They cannot view any other crew assignments, property financials, owner portals, maintenance work orders, or billing information.',
      },
      {
        id:       'crew-assignment',
        question: 'How are turnovers assigned after a guest checks out?',
        answer:
          'When OwnerRez sends a checkout event, FieldStay creates a turnover automatically. You assign it from the Turnovers board. If you\'ve set a default crew member per property in Property Settings, assignment happens automatically with no manual step required.',
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
    id:    'billing',
    label: 'Billing & Plans',
    items: [
      {
        id:       'billing-property-count',
        question: 'What counts as a property for billing?',
        answer:
          'Each unique property unit synced from OwnerRez counts as one property. A multi-unit building with 4 apartment units counts as 4. Archived or removed properties do not count toward your billing total.',
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
          'Yes. All data is encrypted in transit and at rest. Row-level security policies in the database enforce strict tenant isolation — no user can ever access another organization\'s data. OwnerRez access tokens are stored in an encrypted vault, never in the application database.',
      },
      {
        id:       'tech-password',
        question: 'How do I reset my password?',
        answer:
          'On the login page, click "Forgot password" and enter your email. You\'ll receive a reset link within a few minutes. Check your spam folder if it doesn\'t arrive — emails come from noreply@fieldstay.app.',
      },
    ],
  },
]

// Flat list used for cross-category search in the accordion component
export const FAQ_FLAT: (FaqItem & { categoryLabel: string })[] =
  FAQ_CATEGORIES.flatMap((cat) =>
    cat.items.map((item) => ({ ...item, categoryLabel: cat.label }))
  )
