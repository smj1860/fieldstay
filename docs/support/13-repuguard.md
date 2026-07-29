# RepuGuard — Responding to Reviews

**RepuGuard generates professional AI-drafted responses to your guest reviews, flags sensitive content before you post, and helps you maintain a consistent response cadence across all properties.**

---

## How It Works

When a guest leaves a review in your connected PMS — OwnerRez or Hospitable — FieldStay syncs it automatically and queues a response draft. RepuGuard uses Claude AI to generate a response tailored to the review content, your property, and the guest's name.

You review the draft and edit it if needed. Posting the response is not an automatic API round-trip today — see **Editing and Approving a Draft** below for exactly what that step looks like.

---

## The Reviews Page

Go to **Reviews** to see all your reviews sorted by urgency. Each card shows:

- **Star rating** and guest name
- **Review snippet** — the first few lines
- **Deadline badge** — you have 14 days from the review date to respond before the badge turns red
- **Status** — Pending, Draft Ready, or Posted

Click any review to open the full detail view with the generated draft.

---

## Editing and Approving a Draft

The draft appears in an editable text field. Read it carefully and:

- Edit for tone, accuracy, or any detail the AI missed
- Check the **word count** indicator — aim to stay under 150 words
- Look for any **flag icons** — these appear when the AI detected content that may need review (legal language, billing disputes, safety concerns)

When you're happy with the response, click **Mark as Ready** to save it. What comes next depends on where the review came from:

- **OwnerRez reviews** — click **Post to OwnerRez**. This opens the review directly on OwnerRez's site in a new tab so you can paste in your response there (FieldStay does not post it via API on your behalf). Once you've posted it, come back and confirm **Yes, mark as posted** so FieldStay's status reflects reality.
- **Hospitable and manually-added reviews** — there's no direct link back to the original platform yet, so click **Mark as Posted**, post your response wherever the review actually lives (Hospitable, Google, Booking.com, etc.), and confirm once you've done so.

Either way, the response text itself only ever lives in FieldStay until you paste or type it into the review platform — nothing is sent automatically.

---

## Regenerating a Response

If the first draft misses the mark, click **Regenerate**. For a review that synced in automatically from OwnerRez or Hospitable, you have up to 2 regenerations. After 2, edit the response manually — at that point you know better than the AI what you want to say.

**Manually-added reviews work differently: they can't be regenerated at all.** If you added a review yourself (see below), you get the one draft RepuGuard generates and edit it by hand from there — clicking Regenerate on a manual review returns an error rather than a new draft.

---

## Flag Indicators

RepuGuard flags certain content before you post:

- **Legal flag** — the response contains language that could be interpreted as an admission or legal statement
- **Safety flag** — the review or response mentions safety incidents or injuries
- **Billing flag** — the response references refunds, charges, or payment disputes

Flags don't block you from posting — they're advisory. Read flagged content carefully before submitting.

---

## Adding Reviews Manually

Reviews sync automatically from OwnerRez and Hospitable. If you receive a review on Airbnb, Vrbo, Google, or Booking.com outside those, and you'd like a draft response for it, you can add it manually.

Go to **Reviews → Add Review Manually** and enter the review text, star rating, guest name, and platform. RepuGuard generates a response immediately.

**Manual review limit:** 2 per week per organization. This resets every Monday.

---

## Response Best Practices

RepuGuard drafts are a starting point. Strong review responses share a few traits:

- **Acknowledge specifically** — mention something from the actual review, not a generic thank-you
- **Be brief** — future guests read your responses. Long responses signal defensiveness
- **Address negatives calmly** — if the guest raised an issue, acknowledge it and note what you've done or will do
- **Don't over-apologize** — one acknowledgment is enough; excessive apology reads as amateur

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
