// scripts/migrate-kroger-tokens.ts
//
// One-time migration: copy any existing organizations.kroger_customer_token /
// kroger_refresh_token into Vault-backed integration_connections rows, using
// the new generic Kroger provider adapter (lib/integrations/providers/kroger.ts).
//
// Run manually after deploying the Stream A migrations:
//   npx tsx scripts/migrate-kroger-tokens.ts
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
// environment. Safe to re-run — storeIntegrationToken upserts.
//
// After verifying (Settings → Kroger card shows "Connected" for migrated
// orgs, and `inventory/cart_requested` builds a cart successfully), uncomment
// Step 3 below and re-run to clear the now-redundant organizations columns.

import { createClient } from '@supabase/supabase-js'
import {
  storeIntegrationToken,
  storeIntegrationRefreshToken,
} from '../lib/integrations/vault'
import { getKrogerProfile } from '../lib/kroger/client'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  const { data: orgs, error } = await admin
    .from('organizations')
    .select('id, kroger_location_id, kroger_location_name, kroger_customer_token, kroger_refresh_token, kroger_token_expires_at')
    .not('kroger_customer_token', 'is', null)

  if (error) throw error
  if (!orgs?.length) {
    console.log('No orgs with a stored Kroger token. Nothing to migrate.')
    return
  }

  for (const org of orgs) {
    console.log(`[migrate-kroger-tokens] Org ${org.id}`)

    // Find an admin/owner to own this connection (Kroger is connected by one PM per org).
    const { data: admins } = await admin
      .from('organization_members')
      .select('user_id')
      .eq('org_id', org.id)
      .in('role', ['admin', 'owner'])
      .not('invite_accepted_at', 'is', null)
      .limit(1)

    const userId = admins?.[0]?.user_id
    if (!userId) {
      console.warn(`  skipped — no admin/owner member found for org ${org.id}`)
      continue
    }

    let externalUserId = `org_${org.id}`
    try {
      const profile = await getKrogerProfile(org.kroger_customer_token!)
      if (profile?.id) externalUserId = profile.id
    } catch (err) {
      console.warn(`  could not fetch Kroger profile (token may be expired): ${err instanceof Error ? err.message : err}`)
    }

    await storeIntegrationToken({
      userId,
      providerId:     'kroger',
      accessToken:    org.kroger_customer_token!,
      externalUserId,
      scope:          'cart.basic:write profile.compact',
      metadata: {
        location_id:   org.kroger_location_id,
        location_name: org.kroger_location_name,
      },
    })

    if (org.kroger_refresh_token) {
      await storeIntegrationRefreshToken({
        userId,
        providerId:   'kroger',
        refreshToken: org.kroger_refresh_token,
        expiresAt:    org.kroger_token_expires_at,
      })
    }

    // storeIntegrationToken doesn't know about org_id — link it now.
    await admin
      .from('integration_connections')
      .update({ org_id: org.id })
      .eq('user_id', userId)
      .eq('provider_id', 'kroger')

    console.log(`  migrated → user ${userId}, external_user_id ${externalUserId}`)
  }

  console.log('Done. Verify Settings → Kroger and a cart build before clearing organizations.kroger_* columns.')

  // ── Step 3 (run only after manual verification) ──────────────────────────
  // for (const org of orgs) {
  //   await admin.from('organizations').update({
  //     kroger_customer_token:   null,
  //     kroger_refresh_token:    null,
  //     kroger_token_expires_at: null,
  //     kroger_location_id:      null,
  //     kroger_location_name:    null,
  //   }).eq('id', org.id)
  // }
}

main().catch((err) => {
  console.error('[migrate-kroger-tokens] Failed:', err)
  process.exit(1)
})
