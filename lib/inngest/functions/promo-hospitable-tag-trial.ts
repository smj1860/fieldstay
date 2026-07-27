import { NonRetriableError } from 'inngest'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * Tags an org for the Hospitable launch promo at checkout start. Idempotent —
 * tag_hospitable_trial_signup() only ever writes the tag once per org
 * (guarded by hospitable_tagged_at IS NULL), so firing this on every
 * checkout attempt (including tier upgrades for an already-tagged org) is
 * a harmless no-op.
 */
export const tagHospitableTrialSignup = inngest.createFunction(
  {
    id:      'promo-hospitable-tag-trial-signup',
    name:    'Hospitable Promo: Tag Trial Signup',
    retries: 2,
  },
  { event: 'promo/hospitable.checkout-started' },
  async ({ event, step }) => {
    const { org_id, landing_page_cookie_present } = event.data

    if (!org_id) {
      throw new NonRetriableError('Missing org_id in checkout-started event')
    }

    await step.run('upsert-promo-tag', async () => {
      const supabase = createServiceClient({ system: 'inngest:promo-hospitable-tag-trial-signup' })
      const { error } = await supabase.rpc('tag_hospitable_trial_signup', {
        p_org_id:                      org_id,
        p_landing_page_cookie_present: landing_page_cookie_present,
      })

      if (error) {
        throw new Error(`Failed to tag org ${org_id} for Hospitable promo: ${error.message}`)
      }
    })

    return { org_id }
  }
)
