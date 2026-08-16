// lib/inngest/functions/shared/property-onboarding.ts
// ============================================================================
// The post-property-import tail every PMS initial sync runs: seed the org's
// room templates, apply the master checklist to each new property, and bring
// the guidebook configs into line.
//
// Identical in hospInitialSync and hostexInitialSync save for the provider
// string and the log prefix — SonarCloud measured hostex/initial-sync.ts at
// 20.4% duplicated, and this was most of it.
//
// STEP IDS ARE PART OF THE CONTRACT. Inngest memoizes on them, so they are
// spelled exactly as both callers already used them; a run in flight across
// the deploy that introduced this resumes rather than replaying.
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError }         from '@/lib/observability/report-error'
import {
  applyMasterChecklistToProperty,
  fetchOrgRoomTemplateData,
  type OrgRoomTemplateData,
} from '@/lib/checklists/apply-master-template'
import { seedDefaultRoomTemplatesIfNeeded } from '@/lib/checklists/seed-default-room-templates'
import {
  ensureGuidebookConfiguration,
  createGuidebookPropertyConfigsForProperties,
  syncGuidebookConfigsFromProperty,
} from '@/lib/guidebook/sync'
import type { SyncLogger } from './reservation-pipeline'

type SyncStep = GetStepTools<typeof inngest>

/**
 * Apply the org's master checklist to each freshly-imported property.
 *
 * The org-level seed and template read happen ONCE for the whole run rather
 * than once per property: applyMasterChecklistToProperty's default is to
 * re-fetch the org's seed-check, mapping and room templates on every call,
 * which is identical data for every property in this loop.
 */
export async function applyChecklistsToProperties(
  step:        SyncStep,
  orgId:       string,
  propertyIds: string[],
  system:      string,
): Promise<void> {
  if (!propertyIds.length) return

  await step.run('seed-room-templates', async () => {
    await seedDefaultRoomTemplatesIfNeeded(orgId)
  })

  const orgRoomData: OrgRoomTemplateData = await step.run('fetch-room-template-data', async () => {
    const supabase = createServiceClient({ system })
    return fetchOrgRoomTemplateData(orgId, supabase)
  })

  for (const propertyId of propertyIds) {
    await step.run(`apply-master-checklist-${propertyId}`, async () => {
      const supabase = createServiceClient({ system })
      await applyMasterChecklistToProperty(propertyId, orgId, supabase, {
        orgRoomData,
        skipSeed: true,
      })
    })
  }
}

/**
 * Start the org's guidebook trial if it has none, create blank configs for any
 * active property lacking one, then copy the WiFi/house-manual/access text the
 * property import staged onto `properties` into those configs — without
 * overwriting anything the PM has already entered.
 *
 * The middle step is non-fatal by design: a guidebook config is an
 * enhancement, and failing the whole sync over one would discard the
 * properties and bookings already imported.
 */
export async function syncGuidebookForOrg(
  step:     SyncStep,
  logger:   SyncLogger,
  orgId:    string,
  provider: string,
  /** Log prefix, e.g. '[Hostex:user_1]'. */
  label:    string,
): Promise<void> {
  await step.run('create-guidebook-org-config', async () => {
    await ensureGuidebookConfiguration(orgId)
  })

  await step.run('create-guidebook-property-configs', async () => {
    try {
      await createGuidebookPropertyConfigsForProperties(orgId)
    } catch (err) {
      logger.error(`${label} guidebook config creation failed: ${err instanceof Error ? err.message : String(err)}`)
      reportError(err, { site: `inngest.${provider}-initial-sync.create-guidebook-property-configs`, orgId })
      // Non-fatal — see above.
    }
  })

  await step.run('sync-guidebook-configs-from-property', async () => {
    await syncGuidebookConfigsFromProperty(orgId, provider)
    logger.info(`${label} Synced guidebook configs for org ${orgId}`)
  })
}
