'use client'

import { useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ClipboardList } from 'lucide-react'
import { createWorkOrder } from '@/app/(dashboard)/maintenance/actions'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { RequiredMark } from '@/components/ui/RequiredMark'

export interface SpecialProjectCrewOption {
  id:   string
  name: string
  role: string
}

/**
 * "New Special Project" — a one-off job for your own crew at THIS property.
 *
 * It is a work order. Nothing about the row, the events or the completion flow
 * differs from one raised on the Maintenance board; only the wording and the
 * shape of the form do, because the full board modal asks eleven questions that
 * a "pressure wash the deck" job has no answer for (vendor, RFQ vendors, NTE,
 * portal link, asset). This posts the SAME FormData keys to the SAME Server
 * Action rather than a parallel create path, so the validation, the tenant
 * checks and the insert payload cannot drift from the board's.
 *
 * Three fields are fixed and three are deliberately absent:
 *   - property_id is this page's property, so it is hidden rather than asked.
 *   - There is no vendor toggle. A special project is crew work by definition;
 *     a vendor job is what the Maintenance board's modal is for.
 *   - Category defaults to `general` and STAYS EDITABLE. Greying it out was
 *     considered and dropped: a PM who files a deep clean under Cleaning is
 *     giving the record better data, and nothing downstream needs it to be
 *     `general`. (Category is not editable after creation anywhere in the
 *     product, which is the real reason not to lock it here.)
 *
 * There is no crew suggestion to show. The scorer that suggests a crew member
 * runs on TURNOVERS; the only crew suggestion that ever lands on a work order
 * is written by inspection-completed.ts for cleaning found on a walk. A project
 * raised here is assigned by hand, always.
 */
export function SpecialProjectModal({
  propertyId,
  propertyName,
  crewMembers,
  onClose,
  onSuccess,
}: Readonly<{
  propertyId:   string
  propertyName: string
  crewMembers:  SpecialProjectCrewOption[]
  onClose:      () => void
  onSuccess?:   () => void
}>) {
  const [state, action, pending] = useActionState(createWorkOrder, null)

  useEffect(() => {
    if (!state?.success) return
    onSuccess?.()
    onClose()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.success])

  return (
    <Dialog
      open
      onClose={onClose}
      title="New Special Project"
      maxWidthClassName="max-w-xl"
      footer={
        <>
          <Button type="submit" form="special-project-form" disabled={pending} className="flex-1">
            {pending ? 'Creating…' : 'Create Special Project'}
          </Button>
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <form id="special-project-form" action={action} className="space-y-4">
        <input type="hidden" name="property_id" value={propertyId} />
        <input type="hidden" name="request_quotes" value="false" />

        <p className="text-sm text-secondary-themed">
          A one-off job for your own crew at {propertyName}. It does not have to be a
          repair and it does not have to belong to a turnover.
        </p>

        {state?.error && <InlineAlert tone="error">{state.error}</InlineAlert>}

        <div>
          <label htmlFor="sp-title" className="label">
            What needs doing <RequiredMark />
          </label>
          <Input
            id="sp-title"
            name="title"
            type="text"
            required
            placeholder="e.g. Pressure wash the deck before Memorial Day"
          />
        </div>

        <div>
          <label htmlFor="sp-crew" className="label">Assign to</label>
          <select id="sp-crew" name="assigned_crew_member_id" defaultValue="" className="input">
            <option value="">Leave unassigned for now</option>
            {crewMembers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <p className="text-xs text-muted-themed mt-1">
            It appears in their crew app with the turnovers they are already assigned.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="sp-date" className="label">Needed by</label>
            <Input id="sp-date" name="scheduled_date" type="date" />
          </div>
          <div>
            <label htmlFor="sp-priority" className="label">Priority</label>
            <select id="sp-priority" name="priority" defaultValue="medium" className="input">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="sp-category" className="label">
            Category
            <span className="ml-1 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
              Change it if one of these fits better
            </span>
          </label>
          <select id="sp-category" name="category" defaultValue="general" className="input">
            <option value="general">General</option>
            <option value="cleaning">Cleaning</option>
            <option value="landscaping">Landscaping</option>
            <option value="appliance">Appliance</option>
            <option value="plumbing">Plumbing</option>
            <option value="electrical">Electrical</option>
            <option value="hvac">HVAC</option>
            <option value="roofing">Roofing</option>
            <option value="flooring">Flooring</option>
            <option value="windows_doors">Windows/Doors</option>
            <option value="pest_control">Pest Control</option>
            <option value="pool">Pool</option>
            <option value="structural">Structural</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div>
          <label htmlFor="sp-notes" className="label">Notes</label>
          <textarea
            id="sp-notes"
            name="description"
            rows={3}
            className="input"
            placeholder="Access, supplies, anything they need to know"
          />
        </div>

        <p className="text-xs text-muted-themed">
          This creates a work order, so you will find it on this property and on the
          Maintenance board.
        </p>
      </form>
    </Dialog>
  )
}

/**
 * The button that opens it, plus the router.refresh() the Server Action's
 * revalidatePath() cannot do on its own: the modal closes without a
 * navigation, so this page's Maintenance card would otherwise keep the work
 * order it just created out of view until something else navigated.
 */
export function SpecialProjectButton(
  props: Readonly<Omit<React.ComponentProps<typeof SpecialProjectModal>, 'onClose' | 'onSuccess'>>,
) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="secondary" type="button" onClick={() => setOpen(true)}>
        <ClipboardList className="w-4 h-4" />
        New Special Project
      </Button>
      {open && (
        <SpecialProjectModal
          {...props}
          onClose={() => setOpen(false)}
          onSuccess={() => router.refresh()}
        />
      )}
    </>
  )
}
