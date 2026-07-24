# Disconnecting or Reconnecting OwnerRez

**Disconnecting OwnerRez stops future syncs but preserves all historical data already in FieldStay — your turnovers, work orders, and financial records are not deleted.**

The same applies if you're connected to Hospitable instead — the disconnect steps below work the same way from its card in Settings → Integrations.

---

## Disconnecting OwnerRez

Go to **Settings → Integrations**, find the OwnerRez card, and click **Disconnect**.

This immediately:
- Stops all future property and booking syncs
- Revokes FieldStay's access token

Note: disconnecting does not remove FieldStay's webhook subscriptions on
OwnerRez's side — any webhooks OwnerRez still sends after a disconnect are
simply ignored, since FieldStay no longer has an active connection to
process them against.

This does not delete:
- Properties already in FieldStay
- Historical bookings and turnovers
- Financial records and owner ledger entries
- Work orders and vendor assignments
- Crew assignments and checklist data

---

## When to Disconnect

Common reasons to disconnect:

- **Switching OwnerRez accounts** — if you're moving properties to a different OwnerRez account, disconnect first and then reconnect with the new account credentials
- **Troubleshooting sync issues** — sometimes a fresh reconnect resolves persistent sync problems
- **Pausing operations** — if you're taking a break and don't want to accumulate unused sync data

---

## Reconnecting After Disconnect

Go to **Settings → Integrations** and click **Connect** on the OwnerRez card. The OAuth flow runs again and a new initial sync begins. This will re-import your properties and recent bookings.

**Important:** Reconnecting does not re-import the full booking history. Only bookings that are currently active or future bookings will sync. Historical bookings that were already in FieldStay from your previous connection are not duplicated.

---

## If Sync Stops Working

If you notice properties or bookings aren't syncing but you haven't disconnected, a few things can cause this:

**Expired or revoked token**
If you changed your OwnerRez password or revoked FieldStay's access in OwnerRez, the integration token becomes invalid. The fix is to disconnect and reconnect from Settings → Integrations.

**OwnerRez webhook changes**
If webhook subscriptions were removed in OwnerRez, real-time booking updates stop flowing. Reconnecting re-registers all webhooks automatically.

**Manual sync**
For a one-time refresh without disconnecting, go to your Turnovers dashboard and click **Sync**. This triggers a fresh pull of all properties and recent bookings.

---

## Managing Multiple OwnerRez Accounts

If you manage properties across two separate OwnerRez accounts, each account requires a separate FieldStay connection. Contact **support@fieldstay.app** for guidance on multi-account setups.

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
