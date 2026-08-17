# Frequently Asked Questions

Common questions about FieldStay that don't fit neatly into a single feature guide.

---

## Does FieldStay work with the PMS I already use?

FieldStay integrates with OwnerRez, Hospitable, and Hostex today — connect any one of them from onboarding to sync properties, bookings, and reviews automatically. We are always looking to add more integrations. If you use another PMS, let us know what you use.

---

## Can I use FieldStay without connecting a PMS?

Yes. A PMS integration automates the data entry for properties and bookings, but it is not required. You can manually create properties, add bookings, and manage turnovers without a PMS connection. The integration simply eliminates the manual work.

---

## How many users can I add to my account?

There is no limit on the number of users. You can add as many property managers, crew members, and viewers as you need. User roles control what each person can see and do:

- **Admin** — full account access including billing and member management
- **Manager** — property and crew management, financial visibility
- **Crew** — turnover and work order access via the mobile app only
- **Viewer** — read-only dashboard access

---

## Is my data secure?

Yes. FieldStay is built with security as a core design principle:

- Every database table has Row Level Security (RLS) enabled — data from one organization is never accessible to another
- All data is encrypted in transit via TLS
- FieldStay is hosted on Vercel with data stored in Supabase (PostgreSQL) — both are SOC 2 compliant infrastructure providers
- Stripe handles all payment processing — FieldStay never stores credit card data
- Guest phone numbers used for SMS are stored with TCPA-compliant consent records and are never shared or sold
- API keys and tokens are stored in encrypted vaults, never in application code

---

## Does FieldStay store my PMS password?

No. Every PMS connection — OwnerRez, Hospitable, and Hostex — uses OAuth 2.0, so FieldStay receives an access token, not your password. You authorize through your PMS's own login screen. FieldStay never sees or stores those credentials.

---

## What happens to my data if I cancel?

Your data is retained for 30 days after cancellation. During that window you can export your data or reactivate your account. After 30 days, data is permanently deleted. If you need a data export before cancelling, contact support@fieldstay.app.

---

## Can property owners see everything in FieldStay?

No. Property owners access a separate, read-only Owner Portal via a tokenized link — they do not have FieldStay accounts. The Owner Portal shows only the financial data for their specific property (revenue, expenses, net income). Property managers control which expense line items are visible to owners using the Visible to Owner toggle on each transaction.

Owners cannot see crew assignments, work order details, inventory counts, or any other operational data.

---

## How does FieldStay handle cancellations from my PMS?

When a booking is cancelled in your PMS, the webhook fires and FieldStay automatically cancels the associated turnover. The turnover is removed from the active board. Any crew assignments associated with that turnover are cleared. Financial entries already posted for that booking remain in the ledger for your records.

---

## Does RepuGuard work with Google or Airbnb reviews?

RepuGuard automatically syncs reviews from your connected PMS — OwnerRez, Hospitable, or Hostex. All three aggregate reviews from multiple channels, so most Airbnb and Vrbo reviews appear automatically.

For reviews on Google, Booking.com, or platforms that don't sync through your PMS, you can add them manually using the **Add Review Manually** feature (2 per week per organization). RepuGuard generates a response draft immediately after you paste the review text. Note that posting the response back isn't a one-click API submission — for OwnerRez reviews FieldStay links you to the review on OwnerRez's site to paste your response there; for Hospitable, Hostex, and manually-added reviews you post it wherever the review lives and then mark it posted in FieldStay.

---

## What's the difference between deactivating an asset and replacing it?

Deactivating (the **X** button on an asset row) is for retiring something without a direct swap-in — it stops the asset from showing up in health tracking but keeps its history. Replacing (the circular-arrows **Replace** button) is for when a new unit is actually taking an old one's place: it creates the new asset and marks the old one replaced in a single step, which is also what lets FieldStay record how old the old one actually was when it went out of service. If you add a new asset separately and just deactivate the old one by hand instead of using Replace, that age-at-replacement data isn't captured.

---

## Does FieldStay warn me before an asset's warranty expires?

Yes, if you've entered a warranty expiry date on the asset. FieldStay checks daily and sends a one-time notification through the bell icon when a warranty is within 30 days of expiring, naming the asset and its warranty provider. It won't notify you a second time for the same warranty once that first alert has gone out.

---

## How does FieldStay decide whether to recommend repairing or replacing something?

On the Capital Planning page, FieldStay flags an asset for replacement when its trailing 12-month repair spending (plus an estimate for lost booking revenue if a repair kept the property offline) reaches roughly half of its estimated replacement cost, or when repair costs are climbing sharply year over year while the asset's health score is already below "Good." This runs off actual repair history, so it's independent of the age-based 10-year forecast — a newer asset with a rough repair record can get flagged before an older, well-maintained one ever would.

---

## What is Capital Planning?

Capital Planning is the budgeting view built on top of your asset data: a 10-year replacement cost forecast, a recommended monthly reserve fund, repair-vs-replace flags, and a What-If tool that shows the real-dollar cost of inflation and of deferring a replacement. Find it in the sidebar under Portfolio (Admins and Managers). It's included on every plan.

---

## How do I get help with something not covered here?

Use the chat widget in the bottom right corner of your dashboard for immediate questions. For issues that need account-level investigation, email **support@fieldstay.app** with your organization name, which property is affected, and a description of the issue.

---

## What is the crew app URL?

```
https://app.fieldstay.app/crew
```

Crew members should install this as a PWA (Progressive Web App) on their phone home screen. On iPhone use Safari → Share → Add to Home Screen. On Android use Chrome → menu → Add to Home Screen.

---

## Does FieldStay have a native iOS or Android app?

FieldStay uses a Progressive Web App (PWA) for the crew mobile experience. A PWA installs from the browser and appears on the home screen exactly like a native app — it works offline, receives push notifications, and does not require an App Store or Google Play download. There is no separate native app to install.

---

## Two crew members are assigned to the same turnover — why did only one of them see the Start Turnover button work?

This is expected, not a bug. A turnover has a single shared status (Assigned → In Progress → Complete) — it isn't tracked separately per crew member. Whichever assigned crew member taps **Start Turnover** first moves it to In Progress for everyone; the button then disappears from every other assigned crew member's screen, because as far as the turnover is concerned, it's already started.

This comes up most often when two crew members are working different parts of the same property (e.g. one on the kitchen, one on bedrooms) and both reach for the Start button around the same time. Only one tap is needed — whoever gets there first starts it for the whole team. The other crew member doesn't need to do anything differently: they can go straight to checking off checklist items or logging inventory, since every assigned crew member has full access to the checklist and inventory regardless of who tapped Start.

If a crew member's Start Turnover button seems to have "done nothing," it almost always means a teammate already started it a moment earlier — check the turnover's status at the top of the screen to confirm it's already In Progress.

---

## How often does my PMS sync?

Bookings sync in real time via webhooks — when a booking is confirmed, modified, or cancelled in your PMS, FieldStay processes the change within seconds.

Hostex is the one exception worth knowing about: it sends each webhook once and never retries a delivery that fails. FieldStay runs a full reservation sweep every morning to catch anything a missed delivery would have lost, so the worst case for a Hostex booking is that it appears by the next morning rather than within seconds. **Trigger Resync** pulls it in immediately.

Property data (WiFi, amenities, instructions) syncs during the initial connection and can be manually refreshed anytime by clicking **Sync** on the Turnovers dashboard.

Reviews sync automatically every 6 hours and immediately after the initial connection.
