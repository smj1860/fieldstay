# The FieldStay Record Guarantee — Terms of Service Draft

> **⚠️ ATTORNEY REVIEW REQUIRED — DO NOT PUBLISH, QUOTE TO A CUSTOMER, OR STATE
> ON A CALL UNTIL A LAWYER HAS SIGNED OFF.**
>
> This file is draft language only. It is not part of FieldStay's live Terms
> of Service and must not be treated as such by anyone — support, sales, or
> engineering — until counsel has reviewed it and it has been incorporated
> into the real ToS through whatever process governs that document. A
> guarantee stated verbally is still a representation, so this restriction
> covers spoken statements on a sales or support call, not just written ones.
>
> This is Workstream 3 of `RECORD_GUARANTEE_IMPLEMENTATION.md`. Workstreams 1
> (crew_sync_incidents adjudication path) and 2 (published guarantee policy at
> `/guarantee`, `lib/guarantee.ts`) are both code-complete as of this writing.
> Per that document's own definition of done, the guarantee does not ship
> anywhere — the site, an email, a sales call — until this workstream clears
> attorney review.

## Why this exists

The published guarantee's own §7 (see `app/guarantee/page.tsx` §4, "The
remedy") names the service credit as the customer's sole and exclusive
remedy for a Record Failure — but that clause is worthless as a matter of
contract law unless the actual Terms of Service agree. If the ToS permits
general breach-of-contract damages elsewhere with no carve-out, a customer
can route around the credit cap entirely by suing under the ToS instead of
the guarantee.

The four sections below are the ToS-side language that makes the guarantee's
remedy cap actually hold, plus the alignment work needed so the guarantee and
the ToS never define the same term two different ways.

---

## 3.1 — Sole and exclusive remedy

> **Record Availability Claims.** The service credit described in the
> FieldStay Record Guarantee is Customer's sole and exclusive remedy, and
> FieldStay's entire liability, for any claim, demand, or cause of action
> arising out of or relating to the availability, completeness, accuracy,
> retention, or production of operational records, however characterised,
> whether in contract, tort, warranty, or otherwise. This provision is in
> addition to, and does not expand, the Limitation of Liability set out in
> Section [X].

## 3.2 — Incorporation by reference

> **The Guarantee.** The FieldStay Record Guarantee, available at
> fieldstay.com/guarantee, is incorporated into and forms part of these
> Terms. In the event of a conflict between the Guarantee and these Terms
> with respect to record availability, the Guarantee controls as to the
> remedy and these Terms control as to all other matters.

## 3.3 — Suspension and data access

Must align with the published guarantee's §2 ("What is not covered"), which
excludes actions occurring during a suspension while preserving
pre-suspension records.

> **Effect of Suspension.** During any period in which Customer's account is
> suspended for non-payment, access to the Service is disabled and no
> operational records are created. FieldStay does not delete Customer data
> by reason of suspension alone. Upon restoration, records created before
> the suspension remain available subject to the retention periods stated
> in these Terms and in the FieldStay Record Guarantee.

**Counsel must confirm the existing ToS does not contradict this** —
particularly any clause permitting deletion after a suspension period.

## 3.4 — Defined term alignment

"Captured by FieldStay" is the term the entire guarantee turns on (see
`app/guarantee/page.tsx` §1a and `lib/guarantee.ts`'s scope line). It should
either be defined identically in the ToS definitions section, or the ToS
should expressly adopt the Guarantee's definition. Two documents defining the
same operative term differently is the worst available outcome.

> **"Captured by FieldStay"** means an action entered into the FieldStay web
> or mobile application on a device signed in to Customer's account, whether
> or not that device had network connectivity at the time.

---

## 3.5 — Questions to put to counsel

1. Does §7 (the published guarantee's sole-remedy clause) plus 3.1 above
   actually foreclose a general breach claim, or is a further waiver needed?
2. Is the guarantee's §1a commitment to resolve ambiguity in the customer's
   favour wise to state contractually, given that ambiguity favours the
   consumer regardless under ordinary contract interpretation?
3. Does "Captured by FieldStay" hold as an administrable boundary in a
   dispute — i.e., is it precise enough that a third party (a mediator, a
   judge) could apply it to a real fact pattern?
4. Is a credit-only remedy sufficient consideration, and does the
   one-credit-per-billing-period cap (`CREDITS_PER_BILLING_PERIOD` in
   `lib/guarantee.ts`) survive scrutiny?
5. State-level treatment across AL, TN, GA, NC, SC and FL — B2B service
   guarantees are not uniformly handled across those states.
6. Is `CHANGE_NOTICE_DAYS` (currently 30 days) adequate notice for the
   change-of-terms mechanic in the published guarantee's §5?

---

## Reference: the live numbers this draft must stay consistent with

Pulled from `lib/guarantee.ts` at the time this draft was written — if
counsel's review changes any of these, `lib/guarantee.ts` is the one place
to update, and every published surface (the `/guarantee` page, the FAQ, the
breezeway-alternative comparison page) updates with it.

| Constant | Value | What it governs |
|---|---|---|
| `RESPONSE_WINDOW_BUSINESS_DAYS` | 2 | FieldStay's commitment to respond to a claim |
| `COVERED_PERIOD_MONTHS` | 24 | How far back a claim may reach |
| `CLAIM_WINDOW_DAYS` | 30 | Days from the event to file a claim |
| `CREDITS_PER_BILLING_PERIOD` | 1 | Maximum credits in one billing period |
| `CHANGE_NOTICE_DAYS` | 30 | Notice before narrowing or ending the guarantee |
