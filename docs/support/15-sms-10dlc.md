# SMS and 10DLC — What Guests Experience

**FieldStay sends SMS messages to guests who have explicitly opted in — door codes, WiFi credentials, and contextual recommendations during their stay. This is what that experience looks like and how compliance works.**

---

## What 10DLC Means

10DLC (10-Digit Long Code) is the carrier-regulated system for business SMS in the US and Canada. FieldStay is registered as an A2P (Application-to-Person) sender, which means messages come from a dedicated number, not a shared pool.

This registration is what allows FieldStay's messages to reliably reach guests rather than being filtered as spam. It also establishes the legal framework for the messages — they are consented, transactional, and compliant with TCPA regulations.

---

## How Guests Opt In

Guests are never texted without explicit consent. The opt-in flow is:

1. Guest receives a pre-arrival email from FieldStay a few days before check-in
2. The email contains a prominent prompt: *"Want your door code texted directly to your phone?"*
3. Guest taps the link, enters their mobile number, and taps **Text Me My Door Code**
4. Directly below that button, the form displays this text: *"By submitting, you consent to receive automated text messages. Msg & data rates may apply. Reply STOP to opt out."*
5. Guest receives a confirmation text immediately

No messages are sent until step 4 is completed. Consent records are stored with a timestamp and the booking ID.

---

## Messages Guests Receive

**Check-in message (one per booking):**
Sent when the guest's stay begins. Contains their door code, WiFi password, and a link to their personalized guidebook.

**Morning message (once per day, during stay):**
A weather-driven sponsor recommendation (coffee shop, or a rainy-day suggestion when it's raining), a PM-written featured-amenity note (e.g. a hot tub timing reminder), or both — see **How the Guest Guidebook Works** for how PMs configure featured amenities. Sent if either a sponsor or a featured amenity is configured; not sent if neither is.

**Evening message (once per day, during stay, not on checkout day):**
A dinner or activity recommendation, a featured-amenity note, or both — same logic as the morning message, rotated to a different featured amenity so it doesn't repeat.

No messages are sent after checkout.

---

## Opting Out

Guests can text **STOP** at any time to immediately stop all messages from that number. FieldStay processes STOP messages in real time — once a guest opts out, no further messages are sent regardless of their active booking status.

Guests who opt out can re-subscribe by texting **START**.

---

## Does a Repeat Guest Have to Opt In Every Time?

Yes. Consent is recorded per booking, not per phone number — so a returning guest who opted in on a previous stay will still see the opt-in prompt on their next booking's pre-arrival email. This isn't a bug: it keeps consent tied to the specific stay it applies to (the same TCPA-compliant record described above) rather than assuming a guest wants texts for every future booking indefinitely. If a returning guest asks why they're being prompted again, that's the reason.

---

## Can I Turn Off SMS for My Account or a Specific Property?

There is no account-level or property-level toggle to disable the SMS program today — self-serve or otherwise. Guest texting is controlled entirely guest-by-guest: nobody is texted unless they complete the opt-in form for that specific booking, and any guest can stop it instantly by replying STOP. If you don't want a particular property's guests prompted at all, the honest answer right now is that there's no switch for that — flag it to support@fieldstay.app so it can be tracked as a feature request.

---

## What You Can Tell Concerned Guests or Property Owners

If a guest or property owner asks about the SMS program:

- Guests explicitly opt in before any message is sent — it is never automatic
- Messages are only sent during the active booking period
- Guests can stop messages instantly by replying STOP
- Phone numbers are used only for guest communications and are not shared or sold
- FieldStay is TCPA compliant and registered with US mobile carriers

---

## If a Guest Reports Not Receiving Messages

Check the following:

- Confirm the guest completed the opt-in form (not just clicked the link)
- Confirm their phone number is a US or Canadian mobile number
- Some carriers filter business SMS — if the guest is on a carrier known to be aggressive about filtering, the message may be in a filtered folder on their device
- If SMS is new to your account, confirm with support that your 10DLC campaign is active

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
