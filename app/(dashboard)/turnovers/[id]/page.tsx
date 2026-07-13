import { requireOrgMember } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { formatDateTime, formatWindow, TURNOVER_STATUS_LABELS, PRIORITY_COLORS } from '@/lib/utils'
import { CheckCircle2, Clock, User, ArrowLeft, Camera } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/Card'
import { TurnoverRating } from './turnover-rating'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Turnover Detail' }

interface Props { params: Promise<{ id: string }> }

export default async function TurnoverDetailPage({ params }: Props) {
  const { id } = await params
  const { supabase, membership } = await requireOrgMember()

  const { data: turnover } = await supabase
    .from('turnovers')
    .select(`
      id, property_id, checkout_datetime, checkin_datetime,
      window_minutes, status, priority, notes, completion_notes,
      completed_at, auto_generated, checklist_template_id,
      bookings!booking_id ( guest_name, checkin_date, checkout_date, source ),
      turnover_assignments (
        id, assigned_at, notified_at,
        crew_members ( id, name, phone, email )
      ),
      checklist_instances (
        id, status, started_at, completed_at,
        checklist_instance_items ( id, section_name, task, is_completed, requires_photo, photo_storage_path, crew_notes, photo_reason )
      )
    `)
    .eq('id', id)
    .eq('org_id', membership.org_id)
    .single()

  if (!turnover) redirect('/turnovers')

  const { data: property } = await supabase
    .from('properties')
    .select('id, name, city, state, address, checkin_time, checkout_time')
    .eq('id', turnover.property_id)
    .single()

  const assignments = turnover.turnover_assignments ?? []

  let existingRating: number | null = null
  if (turnover.status === 'completed') {
    const { data: outcomes } = await supabase
      .from('assignment_outcomes')
      .select('pm_rating')
      .eq('turnover_id', id)
      .not('pm_rating', 'is', null)
      .limit(1)
    existingRating = outcomes?.[0]?.pm_rating ?? null
  }

  const checklistInstance = Array.isArray(turnover.checklist_instances)
    ? turnover.checklist_instances[0]
    : turnover.checklist_instances

  const checklistItems = checklistInstance
    ? Array.isArray((checklistInstance as { checklist_instance_items: unknown }).checklist_instance_items)
      ? (checklistInstance as { checklist_instance_items: Array<{ id: string; section_name: string; task: string; is_completed: boolean; requires_photo: boolean; photo_storage_path: string | null; crew_notes: string | null; photo_reason: string | null }> }).checklist_instance_items
      : []
    : []

  // Group checklist items by section
  const checklistBySection = checklistItems.reduce<Record<string, typeof checklistItems>>((acc, item) => {
    if (!acc[item.section_name]) acc[item.section_name] = []
    acc[item.section_name].push(item)
    return acc
  }, {})

  const completedCount = checklistItems.filter((i) => i.is_completed).length
  const totalCount     = checklistItems.length
  const checklistPct   = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  const incomingBooking = Array.isArray(turnover.bookings) ? turnover.bookings[0] : turnover.bookings

  return (
    <div className="max-w-3xl">
      {/* Back */}
      <Link href="/turnovers" className="flex items-center gap-1.5 text-sm text-accent-400 hover:text-accent-600 mb-5 transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Turnovers
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="page-title">{property?.name}</h1>
          {property?.city && (
            <p className="text-sm text-accent-400 mt-0.5">{property.city}, {property.state}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('badge text-sm px-3 py-1', PRIORITY_COLORS[turnover.priority as keyof typeof PRIORITY_COLORS])}>
            {turnover.priority} priority
          </span>
          <span className={cn('badge text-sm px-3 py-1',
            turnover.status === 'completed'          ? 'badge-green' :
            turnover.status === 'flagged'            ? 'badge-red' :
            turnover.status === 'in_progress'        ? 'bg-purple-50 text-purple-700' :
            turnover.status === 'assigned'           ? 'badge-blue' : 'badge-amber'
          )}>
            {TURNOVER_STATUS_LABELS[turnover.status as keyof typeof TURNOVER_STATUS_LABELS] ?? turnover.status}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        {/* Timing card */}
        <Card>
          <h3 className="section-header">Timing</h3>
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-accent-400 text-xs">Checkout</p>
              <p className="font-semibold text-primary-themed">{formatDateTime(turnover.checkout_datetime)}</p>
            </div>
            <div>
              <p className="text-accent-400 text-xs">Next Check-in</p>
              <p className="font-semibold text-primary-themed">{formatDateTime(turnover.checkin_datetime)}</p>
            </div>
            <div className="flex items-center gap-2 pt-1 border-t border-accent-100">
              <Clock className="w-4 h-4 text-accent-400" />
              <span className="font-bold text-secondary-themed">
                {formatWindow(turnover.window_minutes ?? 0)} window
              </span>
            </div>
          </div>
        </Card>

        {/* Guest + Crew card */}
        <Card>
          <h3 className="section-header">Assignment</h3>
          {incomingBooking && (
            <div className="mb-3">
              <p className="text-xs text-accent-400">Incoming Guest</p>
              <p className="text-sm font-medium text-primary-themed">
                {incomingBooking.guest_name ?? 'Unknown'} · {incomingBooking.source}
              </p>
            </div>
          )}
          {assignments.length > 0 ? (
            assignments.map((a) => {
              const crew = a.crew_members[0]
              return (
                <div key={a.id} className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 text-sm font-bold flex items-center justify-center">
                    {crew?.name[0]?.toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-primary-themed">{crew?.name}</p>
                    <p className="text-xs text-accent-400">
                      Assigned {new Date(a.assigned_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              )
            })
          ) : (
            <div className="flex items-center gap-2 text-amber-600">
              <User className="w-4 h-4" />
              <p className="text-sm font-medium">No crew assigned</p>
            </div>
          )}
        </Card>
      </div>

      {/* Notes */}
      {(turnover.notes || turnover.completion_notes) && (
        <Card className="mb-4">
          {turnover.notes && (
            <div className="mb-3">
              <p className="section-header">Notes</p>
              <p className="text-sm text-secondary-themed">{turnover.notes}</p>
            </div>
          )}
          {turnover.completion_notes && (
            <div>
              <p className="section-header">Completion Notes</p>
              <p className="text-sm text-secondary-themed">{turnover.completion_notes}</p>
            </div>
          )}
        </Card>
      )}

      {/* PM rating — feeds crew reliability scoring */}
      {turnover.status === 'completed' && (
        <Card className="mb-4">
          <TurnoverRating turnoverId={turnover.id} initialRating={existingRating} />
        </Card>
      )}

      {/* Checklist */}
      {totalCount > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-primary-themed">Turnover Checklist</h3>
            <div className="flex items-center gap-3">
              <span className="text-sm text-accent-500">{completedCount}/{totalCount}</span>
              <div className="w-24 h-1.5 bg-accent-100 rounded-full overflow-hidden">
                <div
                  className={cn('h-full rounded-full', checklistPct === 100 ? 'bg-green-500' : 'bg-brand-600')}
                  style={{ width: `${checklistPct}%` }}
                />
              </div>
              <span className="text-sm font-medium text-accent-600">{checklistPct}%</span>
            </div>
          </div>

          <div className="space-y-4">
            {Object.entries(checklistBySection).map(([section, items]) => {
              const sectionDone = items.filter((i) => i.is_completed).length
              return (
                <div key={section}>
                  <div className="flex items-center gap-2 mb-2">
                    <p className="text-xs font-semibold text-accent-500 uppercase tracking-wide">{section}</p>
                    <span className="text-xs text-accent-400">{sectionDone}/{items.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {items.map((item) => (
                      <div
                        key={item.id}
                        className={cn(
                          'flex items-start gap-2.5 px-3 py-2 rounded-lg text-sm',
                          item.is_completed ? 'bg-green-50' : 'bg-accent-50'
                        )}
                      >
                        <div className={cn(
                          'w-4 h-4 rounded-full border-2 flex-shrink-0 mt-0.5 flex items-center justify-center',
                          item.is_completed ? 'border-green-500 bg-green-500' : 'border-accent-300'
                        )}>
                          {item.is_completed && <CheckCircle2 className="w-3 h-3 text-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={cn('text-sm', item.is_completed ? 'text-green-700 line-through' : 'text-secondary-themed')}>
                            {item.task}
                          </p>
                          {item.crew_notes && (
                            <p className="text-xs text-accent-400 mt-0.5">{item.crew_notes}</p>
                          )}
                          {item.requires_photo && item.photo_reason && (
                            <p className="text-xs text-amber-600 mt-0.5 flex items-center gap-1">
                              <Camera className="w-3.5 h-3.5 flex-shrink-0" /> {item.photo_reason}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {item.requires_photo && (
                            <Camera className={cn('w-3.5 h-3.5', item.photo_storage_path ? 'text-green-500' : 'text-accent-300')} />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {totalCount === 0 && (
        <Card className="text-center py-8 text-accent-400">
          <p className="text-sm">No checklist template assigned to this turnover.</p>
          <Link href={`/properties/${turnover.property_id}/setup/checklist`} className="text-sm text-brand-700 hover:underline mt-1 block">
            Set up a checklist for this property →
          </Link>
        </Card>
      )}
    </div>
  )
}
