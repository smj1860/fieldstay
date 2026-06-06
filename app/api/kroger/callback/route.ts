// app/api/kroger/callback/route.ts
// Place at: app/api/kroger/callback/route.ts

import { NextRequest, NextResponse }   from 'next/server'
import { cookies }                     from 'next/headers'
import { requireOrgMember }            from '@/lib/auth'
import {
  exchangeCodeForCustomerToken,
  getClientToken,
  findNearestKrogerStore,
} from '@/lib/kroger/client'

export async function GET(req: NextRequest) {
  const { supabase, membership } = await requireOrgMember()

  const { searchParams } = req.nextUrl
  const code  = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!

  if (error) {
    return NextResponse.redirect(`${appUrl}/settings?kroger=declined`)
  }

  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/settings?kroger=error&reason=missing_params`)
  }

  const cookieStore = await cookies()
  const savedState  = cookieStore.get('kroger_oauth_state')?.value

  if (!savedState || savedState !== state) {
    return NextResponse.redirect(`${appUrl}/settings?kroger=error&reason=state_mismatch`)
  }

  cookieStore.delete('kroger_oauth_state')

  const redirectUri = `${appUrl}/api/kroger/callback`

  try {
    const tokens = await exchangeCodeForCustomerToken(code, redirectUri)

    const { data: org } = await supabase
      .from('organizations')
      .select('kroger_location_id, zip')
      .eq('id', membership.org_id)
      .single()

    let locationId   = org?.kroger_location_id ?? null
    let locationName = 'Kroger'

    if (!locationId && org?.zip) {
      const clientToken = await getClientToken()
      const store       = await findNearestKrogerStore(org.zip, clientToken)
      if (store) {
        locationId   = store.locationId
        locationName = `${store.chain} — ${store.address.city}`
      }
    }

    await supabase
      .from('organizations')
      .update({
        kroger_customer_token:   tokens.access_token,
        kroger_refresh_token:    tokens.refresh_token ?? null,
        kroger_token_expires_at: new Date(
          Date.now() + tokens.expires_in * 1000
        ).toISOString(),
        preferred_retailer: 'kroger',
        ...(locationId ? {
          kroger_location_id:   locationId,
          kroger_location_name: locationName,
        } : {}),
      })
      .eq('id', membership.org_id)

    return NextResponse.redirect(`${appUrl}/settings?kroger=connected`)
  } catch (err) {
    console.error('[kroger/callback]', err)
    return NextResponse.redirect(`${appUrl}/settings?kroger=error&reason=token_exchange`)
  }
}
