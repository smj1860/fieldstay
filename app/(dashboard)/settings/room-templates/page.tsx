import type { Metadata } from 'next'
import Link from 'next/link'
import { requireOrgMember } from '@/lib/auth'
import { getRoomTemplatesForOrg } from '@/lib/room-templates/get-room-templates'
import { RoomLibraryBuilder } from './room-library-builder'

export const metadata: Metadata = { title: 'Room Templates — FieldStay' }

export default async function RoomTemplatesPage() {
  const { supabase, membership } = await requireOrgMember()

  const [roomsSorted, { data: org }] = await Promise.all([
    getRoomTemplatesForOrg(supabase, membership.org_id),
    supabase
      .from('organizations')
      .select('bedroom_room_template_id, bathroom_room_template_id')
      .eq('id', membership.org_id)
      .single(),
  ])

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <Link href="/settings" className="text-sm text-muted-themed hover:text-secondary-themed">
          Settings
        </Link>
        <span className="text-muted-themed">/</span>
        <span className="text-sm text-secondary-themed">Room Templates</span>
      </div>

      <div className="page-header mb-6">
        <h1 className="page-title">Room Templates</h1>
        <p className="page-subtitle">
          Build reusable room modules — a task list for a &quot;Standard Bedroom&quot; or
          &quot;Deluxe Bathroom&quot; — once, then compose any property&apos;s turnover
          checklist out of them. Edit a room here and re-apply it to update
          every property using it, instead of hand-editing each one.
        </p>
      </div>

      <RoomLibraryBuilder
        initialRooms={roomsSorted}
        canManage={membership.role !== 'viewer' && membership.role !== 'crew'}
        initialBedroomRoomTemplateId={org?.bedroom_room_template_id ?? null}
        initialBathroomRoomTemplateId={org?.bathroom_room_template_id ?? null}
      />
    </div>
  )
}
