# Frequently Asked Questions

Common questions about FieldStay that don't fit neatly into a single feature guide.

---

## Does FieldStay work with the PMS I already use?

FieldStay integrates with OwnerRez, Hospitable, Hostex, Hostaway, and Lodgify today — connect any one of them from onboarding to sync properties and bookings automatically. We are always looking to add more integrations. If you use another PMS, let us know what you use.

Two things differ by provider and are worth knowing before you pick:

- **Reviews** sync from OwnerRez, Hospitable, Hostex and Hostaway. Lodgify's API has no reviews resource, so Lodgify reviews have to be added manually. See **Connecting Lodgify to FieldStay**.
- **Lodgify syncs once daily** rather than within seconds — see "How often does my PMS sync?" below.

**Any PMS that publishes an iCal link** works too, connected or not: paste the calendar link on each property and your bookings and turnovers flow in. That gets you dates and turnovers, but not revenue or guest details.

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

No. OwnerRez, Hospitable, and Hostex connect via OAuth 2.0, so FieldStay receives an access token, not your password — you authorize through your PMS's own login screen. Hostaway connects differently: you generate an API key from your own Hostaway dashboard and enter that in FieldStay. Either way, FieldStay never sees or stores your PMS login credentials.

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

RepuGuard automatically syncs reviews from your connected PMS — OwnerRez, Hospitable, Hostex, or Hostaway. All four aggregate reviews from multiple channels, so most Airbnb and Vrbo reviews appear automatically.

For reviews on Google, Booking.com, or platforms that don't sync through your PMS, you can add them manually using the **Add Review Manually** feature (2 per week per organization). RepuGuard generates a response draft immediately after you paste the review text. Note that posting the response back isn't a one-click API submission — for OwnerRez reviews FieldStay links you to the review on OwnerRez's site to paste your response there; for Hospitable, Hostex, Hostaway, and manually-added reviews you post it wherever the review lives and then mark it posted in FieldStay.

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

## A work order has a "Needed by" date. Where did the scheduled date go?

They were the same field and they were being read two different ways, which is why it changed.

**Needed by** is yours: the date you need the work finished by. FieldStay prefills it from the property's next confirmed check-in, since for a short-term rental that is usually the real deadline, and you can change or clear it.

**The appointment** is the vendor's: the date and window they commit to when they accept the job. You set the deadline, they commit to a date inside it.

Before the split, one date tried to be both. The practical consequence was that a vendor's on-time percentage was being measured against a date the vendor had often chosen themselves. On-time now scores against your needed-by date, which is what it always meant to measure.

Where both exist, screens show the appointment, because a confirmed visit is the stronger fact. Where there is no appointment yet, you see the deadline, labelled as one.

---

## Can a vendor turn down a work order?

Yes. A dispatched work order is an offer rather than an instruction.

The vendor accepts, and picks the date and window they can come, or declines with a reason: no capacity, outside their service area, not their trade, below their minimum, cannot access the property, or other. A declined work order goes back to unassigned with the reason attached and you get a notification.

FieldStay does not pick a replacement vendor for you. Re-dispatching is your call, from the Maintenance board.

If a vendor does not answer at all, FieldStay nudges them after a day and flags it to you after three.

---

## When does a vendor see the door code?

Only after they accept the job.

The dispatch email and the portal page before acceptance contain no door code, no access notes and no parking instructions. They are not hidden behind a click: the page does not contain them. A dispatch link that reaches the wrong inbox gives away nothing about getting into the property.

The code comes from the property record, where it is stored encrypted. You set it once on the property, not on each work order. The per-job access and parking notes you write when creating the work order appear at the same moment.

Every reveal is recorded with who saw it and when. The code itself is never written into that record.

---

## Can a vendor send the job to one of their own technicians?

Yes, and it is better than forwarding the email.

From their portal page the vendor generates a separate link for a named technician. The technician opens it, enters their name, and optionally their own mobile number. Their work is then recorded under their name rather than a free-text note at the end of the job.

Each technician link covers one work order. The vendor can revoke one at any time, and they all stop working when the job closes. Technicians see the same access gating: nothing until the vendor has accepted.

The vendor never types their employee's phone number. The technician supplies it themselves, if they want to, and it saves them being set up by hand next time.

---

## Can I stop FieldStay giving one cleaner six turnovers in a day?

Yes. Each crew member can carry a **Max/day** limit, set beside the Auto-assign toggle when you edit them in Manage Crew. Blank means no limit, which is how everyone starts.

FieldStay will not auto-assign or suggest someone for a date they have already filled. It is a hard stop rather than a scoring nudge, because a nearby, familiar crew member would otherwise still win on score while over their limit, and on Autopilot nobody reviews the result.

You can still assign past the limit by hand. It governs only what FieldStay proposes.

One trade worth knowing: if everyone eligible is at their limit for a date, the turnover stays unassigned and you get an alert naming the limit as the reason. FieldStay tells you rather than quietly ignoring the limit you set.

Separately, assignment scoring now counts a crew member's jobs **on the specific date** being assigned, not only across the next fortnight. Three jobs stacked on one Tuesday used to score the same as three spread across two weeks.

---

## My crew app shows "Start 10:40" and "Free from 10:00". Which one is it?

Both, and they mean different things. **Free from 10:00** is when the guest leaves and the property becomes available. **Start 10:40** is when FieldStay has planned for that crew member to actually begin, given the job they are doing before it and the drive between the two.

The start time is the one to work to. It only appears once you have published that day's plan from the Day plan bar on the Turnovers board. Until then the card shows the checkout time alone, exactly as it always did. See [The Crew Day Plan](./38-crew-day-plan.md).

---

## If a crew member misses their planned start time, does it count against them?

No. Late is still measured against the guest: a turnover is late when it is completed after the guest's check-in time. The planned start is a plan, not a deadline, and missing it does not touch anyone's reliability score.

---

## Can a crew member take just a morning off?

Yes. In the crew app under Time Off, tapping a day marks the whole day, and three chips narrow it to Morning, Afternoon or Evening.

The windows are fixed: morning until noon, afternoon until 5pm, evening after that, in your local time. FieldStay will not auto-assign or suggest that person for a turnover whose checkout falls in a window they marked off, and will still consider them for the rest of the day.

Two things stay whole-day on purpose. Manage Crew lists upcoming time off without splitting it by window, because it is a roster summary. Work orders carry a date and no time, so there is no hour to compare against, and only a whole-day absence raises a warning there.

---

## A crew member tapped "I am running late". What happens?

You get one notification naming the property, immediately. The button then reads "Your manager has been told", and a second tap does nothing.

It works with no signal: the tap queues on the device and sends when the phone reconnects, keeping the time it was raised rather than the time it arrived. So a flag raised at 10am in a basement still reads 10am when it reaches you.

It is the counterpart to the automatic running-late alert, which works out that a job is behind from the checklist. This one is the person saying so, usually earlier, and for reasons the checklist cannot see.

---

## Why does a travel time say "at least"?

Because part of that day could not be measured. A drive needs both ends on the map, and a property with no geocodable address gives FieldStay nothing to measure from or to.

The figure shown is the sum of the legs it could measure, so it is a floor rather than a total. It used to read "Travel time unavailable" in this case, which told you less than the legs it already knew. To clear it, give the property a full address under Properties; coordinates are resolved on save.

---

## Are drive times real routes or straight lines?

Real driving routes wherever FieldStay has been able to look one up. Each pair of properties is routed once and reused, since a crew member's week is mostly the same pairs, and refreshed a few times a year.

Where a route is not available, the estimate falls back to a straight line, which is always shorter than the road. That is why a planned day can run tighter than it looks on a day of unroutable stops.

---

## What is the "running late" notification, and why did I only get one?

Every 30 minutes FieldStay checks for a turnover that is past its own check-in with checklist items still open, where the same crew member has another job later that day. The notification tells you how far past check-in they are and how far the delay is projected to run into the next job, so you can decide whether to move that job, warn the guest, or let it ride.

You get one per turnover per day. The first check that sees the job slip notifies you and the rest of the day's checks stay quiet, because being told early is the point and a job that is 30 minutes late at noon does not need reminding about every half hour until 5pm.

FieldStay does not reassign anything on its own. See **Running-Late Alerts** in [Notifications](./32-notifications-and-digests.md).

---

## Can my crew post progress updates the way vendors do?

Not in the same detail. Crew have **Start Work** and **Mark Work Complete** on a work order, and that is it.

The longer list, parts ordered, waiting on access, tech on site and the rest, is a vendor feature. An in-house job shows as In Progress rather than naming a reason, so if you need that level of visibility on a particular job, send it to a vendor.

Turnovers are different again: those start themselves when the first checklist item is ticked, and the checklist is the progress.

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

## Does the crew app support Spanish?

Yes. Crew members can switch the crew app to Spanish themselves — the toggle lives in the crew app's own settings, so no property manager setup is required. Once switched, the app's navigation and menus, the in-app FAQ, and the checklist and inventory item text all display in Spanish. Switching back to English works the same way, at any time.

---

## Two crew members are assigned to the same turnover — why did only one of them see the Start Turnover button work?

This is expected, not a bug. A turnover has a single shared status (Assigned → In Progress → Complete) — it isn't tracked separately per crew member. Whichever assigned crew member taps **Start Turnover** first moves it to In Progress for everyone; the button then disappears from every other assigned crew member's screen, because as far as the turnover is concerned, it's already started.

This comes up most often when two crew members are working different parts of the same property (e.g. one on the kitchen, one on bedrooms) and both reach for the Start button around the same time. Only one tap is needed — whoever gets there first starts it for the whole team. The other crew member doesn't need to do anything differently: they can go straight to checking off checklist items or logging inventory, since every assigned crew member has full access to the checklist and inventory regardless of who tapped Start.

If a crew member's Start Turnover button seems to have "done nothing," it almost always means a teammate already started it a moment earlier — check the turnover's status at the top of the screen to confirm it's already In Progress.

The button can also disappear because nobody tapped it at all: ticking the first checklist item starts the turnover on its own. If one crew member went straight to the checklist, the turnover is already In Progress and the Start button is gone for everyone.

---

## How often does my PMS sync?

Bookings sync in real time via webhooks — when a booking is confirmed, modified, or cancelled in your PMS, FieldStay processes the change within seconds.

Two exceptions are worth knowing about.

**Hostex** sends each webhook once and never retries a delivery that fails. FieldStay runs a full reservation sweep every morning to catch anything a missed delivery would have lost, so the worst case for a Hostex booking is that it appears by the next morning rather than within seconds.

**Lodgify syncs once daily, not in real time.** Lodgify's webhook delivery is held off until we have verified how it behaves against a live account, so a change made in Lodgify can take up to 24 hours to appear on its own. When that is switched on, existing connections pick it up automatically — nothing to reconnect.

For both, **Trigger Resync** on Settings → Integrations pulls everything in immediately.

Property data (WiFi, amenities, instructions) syncs during the initial connection and can be manually refreshed anytime by clicking **Sync** on the Turnovers dashboard.

Reviews sync automatically every 6 hours and immediately after the initial connection.

## How often do inspections happen, and who decides?

You set it once during onboarding: how often the Safety inspection runs (once or twice a year) and which month it starts in. That answer is a template — FieldStay applies it to every property, including ones you add later. Indoor and Outdoor inspections are scheduled the way any other recurring maintenance is.

Choose twice a year and the second one falls six months after the first: March pairs with September, October with April.

See *Inspection Schedules* for the full detail.

## Why is the same inspection due on different dates at different properties?

Because FieldStay puts the walk on a day the property is empty. After a property's first completed inspection, the due date lands inside a gap between bookings in the target month — and every property has a different calendar, so the days differ even though the month is the same. It's also why a date can move earlier as well as later.

The first time a property is scheduled it's the 1st of the month, before there are any completed walks to schedule around.

## When does FieldStay email me about an overdue inspection?

On the 1st of each month, in a single email listing everything that was due in a previous month and hasn't been walked. It goes to the account's Owner/Admin, covers every property at once rather than sending one email per house, and repeats each month until the inspections are done.

Inspection due dates cluster by month, so emailing three days after each due date would mean a trickle of separate messages all month. The dashboard shows an inspection as overdue from the first day, so the email is the escalation rather than the first you hear of it.

## Can I edit an inspection after I've completed it?

No. A completed inspection is locked at the database level, not just hidden behind a disabled button. The value of the record is that it wasn't adjusted afterward — a history that can be edited later proves very little to an insurer or an owner.

If something needs correcting, run a new inspection of the same form at that property. Both stay in the history in date order.

## Do inspections work without cell service?

Yes, as long as the device has loaded the Inspections page at least once while online. After that the forms and property list are held on the device, and you can start a walk, answer everything, take photos and complete it with no connection. It uploads when you're back in range, and a banner with a retry appears if anything fails to send.

## What happens to an inspection item that fails?

It becomes a work order, a purchase order, a notification, or just a recorded fact — decided by the item itself. A loose handrail raises a work order; an expired detector goes on a purchase order; a lapsed permit notifies you without creating a job.

Cleaning items are rolled into one cleaning work order per walk rather than one each, and everything purchasable goes on one purchase order. A failed item needs a description, because that description becomes the work order's title.

See *Running an Inspection* for the full detail.

---

## What is Stay evidence, and did I turn it on?

Stay evidence is the sealed photo record FieldStay keeps on every property. Every photo taken through FieldStay gets a fingerprint, an honest capture time, and who took it, the moment it is captured, and is filed to the guest stay it belongs to. It is on for every property from day one and there is no switch. Open any property and click **Evidence** to see it. See **Stay Evidence: Your Sealed Photo Record**.

---

## What does "sealed" actually mean?

The photo gets a unique fingerprint computed from its bytes the moment it is taken, and FieldStay computes it again when the photo reaches the server. If the two match, the record says so. If the file ever changes afterward, the fingerprint no longer matches and the record shows it. Nothing on the record is ever edited; a photo can be withdrawn, which adds a new dated entry pointing at the original.

---

## Why is there a "Room condition photo" at the end of every section on my checklist?

That is the one photo per room that makes a before and after possible. Crew stand in the doorway and photograph the whole room. The photo from the turnover between two guests is the After for the guest who left and the Before for the guest arriving, so crew take it once. Sections that are not rooms, like Exterior or Final Checks, do not get one. See **Room Photos and Claim Spots**.

---

## My crew says the new photos are too much. What can I trim?

Trim the claim spots, not the room photos. Open the property, click **Evidence**, and edit the **Claim photo spots** card. Five to eight photos per home, counting the room photos, is the right number. One doorway photo per room is the minimum that makes a claim packet possible.

---

## Why does my crew member have to share their location to start a turnover?

Starting a turnover records a visit check-in: the phone's location, the time, and how far it was from the property. Every photo taken during the visit points back to it, which is what lets a claim packet show the crew was at the property. FieldStay asks for location once, when the crew member taps Start Turnover, and never during a photo. If they decline, the turnover cannot be started until they allow location for FieldStay in their browser settings. See **Stay Evidence: Your Sealed Photo Record**.

---

## What does "Turnover started away from the property" mean?

A crew member started a turnover from farther away than the property's check-in radius, which is about a third of a mile unless you changed it. Nothing is blocked. Open the turnover to review. If the distance is normal for that property, such as a large lot or a rural address, widen the radius: open the property, click **Details**, and set **Crew check-in radius (feet)** between 150 and 16,000.

---

## Every check-in says my property is away, but the crew is there. How do I fix it?

The map pin is probably in the wrong place. FieldStay places a property's pin from its ZIP code unless your PMS supplies exact coordinates, which can put a rural or large property on the wrong road. Open the property, click **Details**, and under the street address click **Use last check-in as map pin**. Confirm, and the pin moves to where your crew last checked in. The button needs a latest check-in accurate to under 100 feet; if it is greyed out it says why. Future check-ins are measured against the new pin, past ones keep the distance recorded at the time, and your PMS sync will not move a pin you set this way. If your property is simply large, widen the **Crew check-in radius** instead.

---

## I got a notification asking me to add a map pin. Why?

The property has no location on the map, so FieldStay cannot tell whether a crew check-in was at the property. Nothing is flagged and nothing is blocked. Open the property, click **Details**, and verify the address. You get this notification once per property.

---

## Can a crew member check in again during a turnover?

Yes. On an in-progress turnover, tap **Check in again** to record a fresh location. Use it when the first reading was poor or the crew member moved from the driveway to the unit. The first check-in is kept; photos taken afterward point to the newest one.

---

## Does the claim packet show repairs?

Yes. The **Repairs tied to this stay** section lists the work orders linked to the stay, each with its line items, vendor, dates and totals. A work order is included when one of the packet's photos belongs to it, or when it was raised from the turnover after the stay. The section lists up to 20 work orders and 200 line items and says how many were left out if there are more. See **Building a Claim Packet**.

---

## Can my crew still take photos with no signal?

Yes. The photo is sealed on the phone with the real capture time and syncs when signal comes back. The record shows when the photo was taken, not when it uploaded. If the phone's clock is wrong, FieldStay records the correction rather than the wrong time.

---

## How do I build a claim packet?

Open the property, click **Evidence**, select the stay, choose the photos in the **Claim packet** card, and click **Build packet**. You get a PDF with before and after photos by room and a chain of custody page listing every photo's fingerprint and times. The download link expires after five minutes; build again for a fresh one. See **Building a Claim Packet**.

---

## Does the claim packet include the guest's name?

No. The cover shows the property, the stay dates, the booking platform, and the platform's confirmation code. No guest name, email, or phone number appears anywhere in the packet.

---

## Will Airbnb or my insurer accept the packet?

FieldStay does not promise any outcome and does not file claims. What the packet gives you is a dated, sealed record with the chain of custody printed, which is more than a camera roll. The platform or adjuster decides.

---

## What starts a claim countdown, and why did I not get one for a normal stay?

A countdown opens only when you flag a turnover or your crew reports an issue from the crew app. A normal stay never produces one. You get at most four notifications per stay: when it opens, at seven days left, at two days left, and when the window closes. See **Claim Countdown**.

---

## Where does FieldStay get the claim deadline?

Airbnb and VRBO stays use that platform's own rules, and the notification names the rule. Direct bookings and other sources use your account's **Claim window**, set on any property's Evidence page, default 14 days after checkout. Platform rules change and the platform's help center is the authority. When in doubt, file early.

---

## Can a vendor delete a photo they uploaded?

They can remove it from their view of the work order. The photo stays on the property's evidence record, marked as withdrawn with the date. Each work order also has a lifetime limit on vendor uploads, so a vendor cannot upload and remove photos indefinitely.

---

## Can a vendor see my crew's photos?

A vendor sees the photos your team took on that work order before they arrived, labeled as such, on their vendor portal page. They see nothing else from the property. This is so "it was already like that" is answered before it is said.

---

## Can an owner see the evidence photos?

Only the photos behind a charge on their statement, and only when you have marked that charge **Visible to Owner**. Owners see a "View photos" link on those charges in their portal. They cannot see the Evidence page or any other photos.

---

## What is Freeze Watch, and how do I set the temperature?

Freeze Watch creates a prep work order when tomorrow's forecast low reaches your threshold and nobody is checked in tonight. The default threshold is 28°F. Set a different one per property under the property's details, **Freeze Watch threshold (°F)**. When the work order is completed with at least two photos, FieldStay writes a proof of care record. See **Freeze Watch**.

---

## Why did Freeze Watch not create a work order last night?

In order of likelihood: the forecast low did not reach the threshold; a guest was checked in; a freeze prep work order was already open for that home; the property has no location on the map; or the weather service had no forecast for that day. FieldStay never guesses a temperature.

---

## Who gets a Freeze Watch work order?

If the property has an active maintenance schedule with "freeze" in its name and a vendor assigned, that vendor. If the vendor has portal access they are notified the usual way; if not, the work order is assigned to them but nobody is contacted, and your notification says to reach them directly. With no such schedule, the work order is created unassigned.

---

## What is proof of care?

An entry on the property's evidence record, written when a Freeze Watch work order is completed with two or more sealed photos. It references every photo, the date, and the vendor. It is what you show an insurer after a freeze loss to demonstrate the home was winterized, when, and by whom.

---

## Does any of this cost extra?

No. Every FieldStay subscription includes the full platform, including Stay evidence, claim packets, the claim countdown, and Freeze Watch. See **Pricing and Plans**.
