# Freeze Watch

Freeze Watch creates a prep work order when the forecast low for a home drops to your threshold and nobody is checked in that night. When the work order is completed with photos, the photos become a proof of care record you can hand an insurer.

It runs once a day for every active property that has an address on the map. There is nothing to turn on.

---

## How it decides

Every afternoon, for each property, FieldStay reads tomorrow's forecast low from the weather service and asks three questions:

1. **Is the low at or below this home's threshold?** The default is 28°F. Set a different number per property under the property's details: **Freeze Watch threshold (°F)**. Leave it blank for the default.
2. **Is the home vacant tonight?** A home is vacant if no confirmed or tentative guest stay covers tonight. Owner stays and calendar blocks count as vacant, since a guest in the house is what keeps it warm.
3. **Is there already an open freeze prep work order for this home?** If so, nothing new is created.

If all three come back yes, yes, no, FieldStay creates the work order. Tomorrow's low happens in the early hours of tomorrow, which is tonight's freeze, so the work order is due today.

If the weather service has no low for that day, nothing fires. FieldStay never guesses a temperature.

---

## The work order

The work order is titled **Freeze prep at [property]: forecast low [temperature] on [date]** and is marked high priority. Its description lists what to do and what to photograph:

1. Set the thermostat to hold at 55°F or above. Photo of the thermostat.
2. Open the cabinet doors under every sink on an exterior wall. Photo of one.
3. Set a slow drip on the faucet farthest from the water main. Photo of the drip.
4. Disconnect and drain exterior hoses. Photo of the spigot.
5. If the property has a well, crawlspace, or exposed supply line, confirm heat tape or insulation. Photo if applicable.

At least two photos are required before marking it complete.

### Who gets it

If the property has an active maintenance schedule whose name contains "freeze" and that schedule has a vendor assigned, the work order goes to that vendor. If the vendor has portal access, they are notified the usual way (see **Work Order Vendor Dispatch**). If the vendor does not have portal access, the work order is assigned to them but nobody is notified, and your bell tells you to contact them directly.

If there is no freeze schedule with a vendor, the work order is created unassigned and your bell asks you to assign it.

---

## Proof of care

When the freeze prep work order is completed with two or more sealed photos, FieldStay writes a **proof of care** entry on the property's evidence record. It references every photo, the date, and the vendor. You will see it on the Evidence page and get a green notification.

If the work order is completed with fewer than two photos, no proof of care is written and you get an amber notification saying so.

A proof of care record is what you show an insurer when a pipe bursts anyway. It says the home was winterized, when, by whom, with photos.

---

## Common questions

**Why did Freeze Watch not fire last night?**
In order of likelihood: the low did not reach the threshold; a guest was checked in; there was already an open freeze prep work order; the property has no coordinates on the map; the weather service had no forecast for that day.

**Can I run it for a home that has guests?**
No. Guests in the house keep it warm, and sending a vendor into an occupied home is not what this is for. Create a regular work order if you want one anyway.

**What threshold should I use?**
28°F is a hard freeze and the default. Homes with exposed plumbing or a well may want 32. Homes with a well insulated crawlspace may go lower.

**Does it cost extra?**
No.
