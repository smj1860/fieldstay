# Frequently Asked Questions

Common questions about FieldStay that don't fit neatly into a single feature guide.

---

## Does FieldStay work with the PMS I already use?

FieldStay currently has integration partnerships with OwnerRez and
Hospitable that will be live soon. We are always looking to add more
integrations. If you use another PMS, let us know what you use.

---

## Can I use FieldStay without connecting OwnerRez?

Yes. OwnerRez integration automates the data entry for properties and bookings, but it is not required. You can manually create properties, add bookings, and manage turnovers without a PMS connection. The integration simply eliminates the manual work.

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

## Does FieldStay store my OwnerRez password?

No. OwnerRez connection uses OAuth 2.0 — FieldStay receives an access token, not your password. You authorize the connection through OwnerRez's own login screen. FieldStay never sees or stores your OwnerRez credentials.

---

## What happens to my data if I cancel?

Your data is retained for 30 days after cancellation. During that window you can export your data or reactivate your account. After 30 days, data is permanently deleted. If you need a data export before cancelling, contact support@fieldstay.app.

---

## Can property owners see everything in FieldStay?

No. Property owners access a separate, read-only Owner Portal via a tokenized link — they do not have FieldStay accounts. The Owner Portal shows only the financial data for their specific property (revenue, expenses, net income). Property managers control which expense line items are visible to owners using the Visible to Owner toggle on each transaction.

Owners cannot see crew assignments, work order details, inventory counts, or any other operational data.

---

## How does FieldStay handle cancellations from OwnerRez?

When a booking is cancelled in OwnerRez, the webhook fires and FieldStay automatically cancels the associated turnover. The turnover is removed from the active board. Any crew assignments associated with that turnover are cleared. Financial entries already posted for that booking remain in the ledger for your records.

---

## Does RepuGuard work with Google or Airbnb reviews?

RepuGuard automatically syncs reviews from OwnerRez. Since OwnerRez aggregates reviews from multiple channels, most Airbnb and Vrbo reviews appear automatically.

For reviews on Google, Booking.com, or platforms that don't sync through OwnerRez, you can add them manually using the **Add Review Manually** feature (2 per week per organization). RepuGuard generates a response draft immediately after you paste the review text.

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

## How often does OwnerRez sync?

Bookings sync in real time via webhooks — when a booking is confirmed, modified, or cancelled in OwnerRez, FieldStay processes the change within seconds.

Property data (WiFi, amenities, instructions) syncs during the initial connection and can be manually refreshed anytime by clicking **Sync** on the Turnovers dashboard.

Reviews sync automatically every 6 hours and immediately after the initial connection.
