import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { seedOrgInventoryCatalogIfNeeded } from '@/lib/inventory/seed-org-catalog'
import { getStandardInventoryTemplateId } from '@/lib/inventory/standard-template'

/**
 * Leg 2 of auto-applying the standard inventory template: give a brand-new org
 * its inventory starting point without anyone pressing a button.
 *
 * Before this, both halves were manual. `seedOrgInventoryCatalogIfNeeded` only
 * ran when someone happened to open Master List or Create Template — NOT Par
 * Levels, which is where a PM actually goes to add a property's supplies, so a
 * new org that went straight there found an empty picker. And the platform
 * template only reached an org when a platform admin pressed Broadcast, which
 * enumerates orgs at dispatch time: an org created after that broadcast never
 * received it, and nothing back-filled later. Signing up is exactly the moment
 * both should happen.
 *
 * Deliberately an Inngest function rather than inline work in
 * createOrganization. Seeding the catalog copies the whole platform catalog a
 * page at a time, and resolving the standard template is another round trip;
 * neither belongs in the signup request, and neither should be able to fail
 * account creation. Here they get retries and the user never waits.
 *
 * Idempotent throughout, which matters because Inngest retries the whole
 * function: the catalog seed short-circuits on a count and upserts with
 * ignoreDuplicates against org_inventory_catalog_org_name_unique, and
 * syncInventoryTemplateForOrg (which the event below invokes) reuses the org's
 * existing template row and inserts only items it does not already have.
 */
export const bootstrapNewOrgInventory = inngest.createFunction(
  {
    id:      'bootstrap-new-org-inventory',
    name:    'New Org — seed inventory catalog and standard template',
    retries: 3,
    // One bootstrap per org, ever. Signup cannot legitimately fire twice for
    // the same org (create_organization_with_owner is advisory-locked per
    // user), but a retried Inngest delivery can, and the work below is cheap
    // to skip rather than repeat.
    idempotency: 'event.data.org_id',
  },
  { event: 'organization/created' },
  async ({ event, step, logger }) => {
    const { org_id: orgId } = event.data

    // Independent of the template: an org needs its own catalog copy whether
    // or not the platform has designated a standard template yet.
    await step.run('seed-org-inventory-catalog', async () => {
      await seedOrgInventoryCatalogIfNeeded(orgId)
      return { seeded: true }
    })

    // Returns a DECISION, not an action. Step tooling (sendEvent) must not be
    // called inside a step.run callback — the SDK only warns, then unwinds the
    // request to schedule the nested op, leaving this callback unresolved so it
    // re-runs from the top next pass and replays whatever ran before it. See
    // CLAUDE.md's Inngest constraints.
    const templateId = await step.run('resolve-standard-template', async () => {
      const supabase = createServiceClient({ system: 'inngest:bootstrap-new-org-inventory' })
      return await getStandardInventoryTemplateId(supabase, {
        site:  'inngest.bootstrap-new-org-inventory.resolve-standard-template',
        orgId,
      })
    })

    if (!templateId) {
      // No standard designated yet. Ordinary state, not a failure — the org
      // keeps its seeded catalog and a PM builds a template by hand.
      logger.info(`[bootstrap-new-org-inventory] no standard template set — org ${orgId} seeded catalog only`)
      return { org_id: orgId, catalog_seeded: true, template_synced: false }
    }

    // Top level, not inside a step.run — see the note above.
    await step.sendEvent('request-standard-template-sync', {
      name: 'inventory_template/sync_org.requested',
      data: { org_id: orgId, platform_template_id: templateId },
    })

    return { org_id: orgId, catalog_seeded: true, template_synced: true }
  }
)
