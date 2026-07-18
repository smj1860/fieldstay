import type { Metadata } from 'next'
import Link from 'next/link'
import { requireOrgMember } from '@/lib/auth'
import { RoomLibraryBuilder } from './room-library-builder'

export const metadata: Metadata = { title: 'Room Templates — FieldStay' }

export default async function RoomTemplatesPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: rooms } = await supabase
    .from('room_templates')
    .select(`id, name, auto_include, room_template_items ( id, task, requires_photo, notes, sort_order )`)
    .eq('org_id', membership.org_id)
    .order('name')

  const roomsSorted = (rooms ?? []).map((room) => ({
    id:          room.id as string,
    name:        room.name as string,
    autoInclude: room.auto_include as boolean,
    items: [...(room.room_template_items ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({
        id:             item.id as string,
        task:           item.task as string,
        requires_photo: item.requires_photo as boolean,
        notes:          (item.notes as string | null) ?? '',
      })),
  }))

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

      <RoomLibraryBuilder initialRooms={roomsSorted} canManage={membership.role !== 'viewer' && membership.role !== 'crew'} />
    </div>
  )
}
