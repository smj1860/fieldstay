import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'

interface SeedTemplate {
  name:        string
  autoInclude: boolean
  tasks:       string[]
}

// Standalone content — not sourced from CLEANING_CATALOG/
// org_master_checklist_items, which this feature replaces rather than
// reads from.
const SEED_TEMPLATES: SeedTemplate[] = [
  {
    name: 'Kitchen', autoInclude: true,
    tasks: [
      'Wipe down all countertops and backsplash',
      'Clean stovetop and burners',
      'Wipe down oven interior and exterior',
      'Clean microwave inside and out',
      'Wipe exterior of refrigerator; clean inside and remove any old food',
      'Wash, dry, and put away any dishes; run dishwasher if needed',
      'Empty trash and replace liner',
      'Wipe cabinet fronts and handles',
      'Sweep and mop floor',
      'Restock dish soap, sponge, and paper towels',
    ],
  },
  {
    name: 'Living Room', autoInclude: true,
    tasks: [
      'Dust all surfaces, shelves, and electronics',
      'Vacuum or sweep and mop floor',
      'Fluff and straighten couch cushions and throw pillows',
      'Fold and neatly arrange any throw blankets',
      'Wipe down coffee table and end tables',
      'Check under and between furniture cushions for anything a guest left behind',
      'Empty trash',
      'Straighten remotes and check/replace batteries if needed',
    ],
  },
  {
    name: 'Whole Home', autoInclude: true,
    tasks: [
      'Check all windows are closed and locked',
      'Turn off all lights',
      'Set thermostat to the standard vacant temperature',
      'Empty all trash cans throughout the property, not just kitchen/bathrooms',
      'Confirm smoke and CO detectors are present and not beeping low-battery',
      'Walk every room and take photos for the condition record',
      'Lock all doors on exit',
      'Report any damage, missing items, or maintenance issues found',
    ],
  },
  {
    name: 'Bedroom', autoInclude: false,
    tasks: [
      'Strip all bed linens and pillowcases',
      'Make bed with fresh linens',
      'Dust all furniture surfaces',
      'Vacuum floor and under bed',
      'Empty trash',
      'Check closet and dresser drawers for anything a guest left behind',
      'Restock extra blankets/pillows if the property provides them',
    ],
  },
  {
    name: 'Bathroom', autoInclude: false,
    tasks: [
      'Scrub toilet bowl, seat, and base',
      'Clean sink, faucet, and countertop',
      'Wipe mirror',
      'Scrub shower/tub and glass doors',
      'Sweep and mop floor',
      'Empty trash and replace liner',
      'Restock toilet paper, hand soap, and shampoo/conditioner',
      'Replace bath mat if provided',
    ],
  },
]

/**
 * Auto-creates Whole Home, Kitchen, Living Room, Bedroom, and Bathroom room
 * templates for an org the first time any property's checklist gets
 * applied, and sets the org's bedroom/bathroom mapping to point at the two
 * new ones — so a brand-new org's very first synced property gets a real,
 * room-template-composed checklist with zero PM configuration.
 *
 * Always uses the service-role client internally, regardless of which
 * role/session triggered it — this is automatic system bookkeeping, not a
 * PM-gated business action, and organizations.orgs_update is admin/owner-
 * only. Gating these writes on the caller's own RLS-scoped client would
 * silently no-op the claim/mapping UPDATEs for any org whose first property
 * was added by a manager (or via createProperty, which has no role check
 * at all), leaving that org permanently unmapped with no error surfaced.
 * Every query stays explicitly scoped to the passed-in orgId.
 *
 * Bedroom/Bathroom are NOT auto_include — they're driven entirely by the
 * bedrooms/bathrooms count in composeFromRoomTemplates. Marking them
 * auto_include too would add one extra unwanted section on top of the
 * counted ones on every property.
 *
 * Safe to call on every applyMasterChecklistToProperty invocation — the
 * early-return check makes it near-free for orgs that are fully seeded,
 * and everything past that point is idempotent (upsert-on-conflict for
 * templates, an item-count check before seeding items), so a call that
 * only partially succeeded last time correctly finishes the job this time
 * instead of being permanently skipped.
 *
 * The bedroom/bathroom mapping columns are only ever backfilled from a
 * template that was genuinely CREATED by this call, never from one that
 * already existed (see upsertOneSeedTemplate's `created` flag) — earlier,
 * this checked bedroom_room_template_id itself as the "fully seeded"
 * signal, which meant a PM who later cleared that mapping via Settings
 * (a legitimate, supported action) had it silently reset back to the
 * seeded template the next time any property's checklist was applied
 * anywhere. Template existence, not the mapping column, is the real
 * completion signal — the mapping is a separate, PM-owned setting once
 * seeding has actually finished.
 *
 * Known, accepted risk: the item-count-then-insert step below is a
 * load-then-write sequence, not backed by a DB constraint (room_template_items
 * has no natural unique key to upsert against without risking collision
 * with the existing item-reorder code path). Two truly concurrent calls for
 * the same brand-new org's very first property (e.g. two browser tabs both
 * submitting "Add Property" the same instant) could each see zero existing
 * items and both insert, duplicating that template's task rows. Low
 * probability, low consequence (a PM would notice and delete the
 * duplicates via the room template editor) — not worth a schema change
 * that could destabilize normal reordering. The `room_templates` row
 * itself can never duplicate (UNIQUE (org_id, name) + ignoreDuplicates).
 */
export async function seedDefaultRoomTemplatesIfNeeded(orgId: string): Promise<void> {
  const supabase = createServiceClient()

  const { data: org } = await supabase
    .from('organizations')
    .select('default_room_templates_seeded_at')
    .eq('id', orgId)
    .single()

  if (org?.default_room_templates_seeded_at) {
    // Claimed — but confirm all seed templates actually exist before
    // trusting the claim, so a genuinely partial seed (a transient
    // failure left only some of them created) still gets finished here
    // rather than being permanently skipped. Template existence, not the
    // bedroom/bathroom mapping columns, is what answers "did this
    // finish" — see the doc comment above for why the mapping can't be
    // used for this anymore.
    const { count } = await supabase
      .from('room_templates')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .in('name', SEED_TEMPLATES.map((t) => t.name))

    if ((count ?? 0) >= SEED_TEMPLATES.length) return
  } else {
    // Best-effort race guard for the common case (two truly concurrent
    // callers) — not load-bearing for correctness on its own, since
    // everything below is independently idempotent regardless of who
    // "wins" this claim.
    await supabase
      .from('organizations')
      .update({ default_room_templates_seeded_at: new Date().toISOString() })
      .eq('id', orgId)
      .is('default_room_templates_seeded_at', null)
  }

  const results = await upsertSeedTemplates(supabase, orgId)

  // Only backfill from a template genuinely created THIS call — never
  // from one that already existed, whether because seeding had already
  // fully completed or because a PM cleared just one side of the
  // mapping. Re-deriving an existing template's id here would silently
  // overwrite whatever the PM currently has that mapping set to.
  const mappingUpdates: Record<string, string> = {}
  if (results['Bedroom']?.created)  mappingUpdates.bedroom_room_template_id  = results['Bedroom'].id
  if (results['Bathroom']?.created) mappingUpdates.bathroom_room_template_id = results['Bathroom'].id

  if (Object.keys(mappingUpdates).length > 0) {
    await supabase.from('organizations').update(mappingUpdates).eq('id', orgId)
  }

  const createdNames = Object.entries(results).filter(([, r]) => r.created).map(([name]) => name)

  if (createdNames.length > 0) {
    // actorId is intentionally omitted (resolves to null on audit_events)
    // — this fires from automated sync paths as often as from a PM action,
    // and a null actor is the correct way to represent "the system did
    // this," not a gap to fill in.
    await logAuditEvent({
      orgId,
      action:     'org.default_room_templates_seeded',
      targetType: 'organization',
      targetId:   orgId,
      metadata:   { created: createdNames },
    }).catch((err: unknown) => {
      console.error('[seedDefaultRoomTemplatesIfNeeded] audit log failed:', err)
    })
  }
}

type ServiceClient = ReturnType<typeof createServiceClient>

interface UpsertResult {
  id:      string
  created: boolean
}

// Extracted from seedDefaultRoomTemplatesIfNeeded to keep that function's
// cognitive complexity down — one focused job (create-or-find each seed
// template, seed its items if empty) per helper.
async function upsertSeedTemplates(
  supabase: ServiceClient,
  orgId:    string,
): Promise<Record<string, UpsertResult>> {
  const results: Record<string, UpsertResult> = {}

  for (const template of SEED_TEMPLATES) {
    const result = await upsertOneSeedTemplate(supabase, orgId, template)
    if (result) results[template.name] = result
  }

  return results
}

async function upsertOneSeedTemplate(
  supabase: ServiceClient,
  orgId:    string,
  template: SeedTemplate,
): Promise<UpsertResult | null> {
  const { data: room, error: upsertErr } = await supabase
    .from('room_templates')
    .upsert(
      { org_id: orgId, name: template.name, auto_include: template.autoInclude },
      { onConflict: 'org_id,name', ignoreDuplicates: true }
    )
    .select('id')
    .maybeSingle()

  let roomId = room?.id as string | undefined
  // The upsert returns the row only on a genuine insert — ignoreDuplicates
  // means a conflict resolves with no row, which is how "created" is
  // distinguished from "already existed" below.
  let created = !!roomId

  if (!roomId) {
    // ignoreDuplicates doesn't return the row on conflict — fetch the
    // existing one. "Not returned" here means "already exists," not
    // "failed" (upsertErr would be set for a genuine failure).
    const { data: existing } = await supabase
      .from('room_templates')
      .select('id')
      .eq('org_id', orgId)
      .eq('name', template.name)
      .maybeSingle()
    roomId = existing?.id as string | undefined
    created = false
  }

  if (!roomId) {
    console.error(`[seedDefaultRoomTemplatesIfNeeded] failed to create/find "${template.name}":`, upsertErr)
    return null
  }

  // Only seed items into a template that has none yet — never overwrite
  // real content, whether from a PM's own edit or a previous partial
  // seed attempt that got this far.
  const { count } = await supabase
    .from('room_template_items')
    .select('id', { count: 'exact', head: true })
    .eq('room_template_id', roomId)

  if (!count) {
    await supabase.from('room_template_items').insert(
      template.tasks.map((task, i) => ({
        room_template_id: roomId,
        task,
        requires_photo:    false,
        notes:             null,
        sort_order:        i,
      }))
    )
  }

  return { id: roomId, created }
}
