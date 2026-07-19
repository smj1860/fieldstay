import { requireOrgMember } from '@/lib/auth'
import { RoomLibraryBuilder } from '../../settings/room-templates/room-library-builder'
import { getRoomTemplatesForOrg } from '@/lib/room-templates/get-room-templates'
import { applyMasterChecklistToProperties } from './actions'
import { markStepComplete } from '../actions'

export default async function OnboardingChecklistTemplatePage() {
  const { supabase, membership } = await requireOrgMember()

  const [roomsSorted, { data: org }, { data: properties }] = await Promise.all([
    getRoomTemplatesForOrg(supabase, membership.org_id),
    supabase
      .from('organizations')
      .select('bedroom_room_template_id, bathroom_room_template_id')
      .eq('id', membership.org_id)
      .single(),
    supabase.from('properties').select('id').eq('org_id', membership.org_id).eq('is_active', true),
  ])

  const propertyIds = (properties ?? []).map((p) => p.id as string)
  const hasRoomTemplateConfig =
    !!org?.bedroom_room_template_id ||
    !!org?.bathroom_room_template_id ||
    roomsSorted.some((r) => r.autoInclude)

  async function continueAction() {
    'use server'
    // hasRoomTemplateConfig/propertyIds close over the values fetched
    // above — no re-query needed. Any mapping/room edit made on this page
    // already revalidates this route (setBedroomBathroomMapping,
    // saveRoomTemplateItems both call revalidatePath('/setup/checklist-
    // template')), so continueAction is always bound to the render the PM
    // is actually looking at when they click it — no staleness risk.
    if (hasRoomTemplateConfig && propertyIds.length > 0) {
      await applyMasterChecklistToProperties(propertyIds)
    }
    await markStepComplete('checklist_template', '/setup/maintenance-template')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Turnover Checklist — Room Library
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Every property already has a real turnover checklist — nothing to
          set up to get started.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
            <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>Already done, automatically</p>
            <ul className="text-sm space-y-1.5" style={{ color: 'var(--text-primary)' }}>
              <li>• Whole Home — general tasks, every property</li>
              <li>• Kitchen — every property</li>
              <li>• Living Room — every property</li>
              <li>• Bedrooms &amp; Bathrooms — one section per room, from your PMS count</li>
            </ul>
          </div>
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
            <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>Your turn, anytime after this</p>
            <ul className="text-sm space-y-1.5" style={{ color: 'var(--text-primary)' }}>
              <li>• Add any other rooms a property needs (Office, Den, etc.) from the Properties page</li>
              <li>• Remove Kitchen and/or Living Room from any property that doesn&apos;t actually have one</li>
              <li>• We&apos;ll flag any property showing 0 bedrooms or no bathroom count, so you know to double-check it</li>
            </ul>
          </div>
        </div>
      </div>

      <RoomLibraryBuilder
        initialRooms={roomsSorted}
        canManage={membership.role !== 'viewer' && membership.role !== 'crew'}
        initialBedroomRoomTemplateId={org?.bedroom_room_template_id ?? null}
        initialBathroomRoomTemplateId={org?.bathroom_room_template_id ?? null}
        continueAction={continueAction}
        continuePropertyCount={propertyIds.length}
      />
    </div>
  )
}
