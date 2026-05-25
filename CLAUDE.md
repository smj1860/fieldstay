# CLAUDE.md — FieldStay

Read this entire file before writing any code or running any commands.

---

## Current State — What's Done, What Remains

### ✅ Complete and working
- All PM dashboard features (properties, turnovers, inventory, maintenance,
  communications, owners, settings, owner portal, vendor portal)
- Inngest pipeline (10 functions — iCal sync, emails, POs, alerts)
- Brand colors (#102246 navy, #FCD116 gold), btn-cta class
- PowerSync schema (`lib/powersync/schema.ts`) and client (`lib/powersync/client.ts`)
- Crew shell with offline indicator (`app/crew/crew-shell.tsx`)
- Crew dashboard page (`app/crew/page.tsx`)
- Crew inventory count page + API route
- New property form includes `avg_nightly_rate`
- `fieldstay_migration_v2.sql` exists (partial — see Step 1)
- `types/database.ts` updated for most v2 fields

### ❌ Still needs to be built (this session)

| # | What | Files |
|---|------|-------|
| 1 | v2 migration: add invite + milestones | `fieldstay_migration_v2.sql` |
| 2 | types: add `invite_sent_at` | `types/database.ts` |
| 3 | Bulk photo toggle in checklist builder | `checklist-builder.tsx` |
| 4 | Photo capture in crew turnover page | `app/crew/turnovers/[id]/page.tsx` |
| 5 | Crew invite: settings action + button | `settings/actions.ts`, `settings-tabs.tsx` |
| 6 | Crew invite: accept pages + API route | new files |
| 7 | middleware: add accept-invite to public | `middleware.ts` |

---

## Step 1 — Update fieldstay_migration_v2.sql

The current v2 file only has `avg_nightly_rate` and `booking_id`.
Add the invite fields and milestones table. All statements use
`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` so re-running the full
file on the existing Supabase project is safe — nothing breaks.

**Replace the entire contents of `fieldstay_migration_v2.sql`:**

```sql
-- FieldStay Migration v2
-- Safe to re-run — all statements are idempotent

-- avg_nightly_rate on properties
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS avg_nightly_rate numeric(10,2) DEFAULT NULL;

-- booking_id on owner_transactions
ALTER TABLE owner_transactions
  ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_owner_txn_booking_id
  ON owner_transactions(booking_id);

-- Crew invite fields
ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS invite_token       uuid UNIQUE DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS invite_sent_at     timestamptz,
  ADD COLUMN IF NOT EXISTS invite_accepted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_crew_members_invite_token
  ON crew_members(invite_token);

-- Milestones table (review prompt framework — phase 2 feature)
CREATE TABLE IF NOT EXISTS org_milestones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  milestone      text NOT NULL,
  achieved_at    timestamptz NOT NULL DEFAULT NOW(),
  prompted_at    timestamptz,
  review_clicked boolean NOT NULL DEFAULT false,
  dismissed      boolean NOT NULL DEFAULT false,
  UNIQUE(org_id, milestone)
);

CREATE INDEX IF NOT EXISTS idx_org_milestones_org_id
  ON org_milestones(org_id);
```

Then run this file in Supabase SQL Editor.

---

## Step 2 — Add invite_sent_at to types/database.ts

**Edit:** `types/database.ts`

In the `CrewMember` interface, `invite_sent_at` is missing. Add it:

```ts
// CrewMember interface should have all three:
invite_token:        string | null
invite_sent_at:      string | null   // ← ADD THIS
invite_accepted_at:  string | null
```

---

## Step 3 — Checklist Builder: Bulk Photo Toggle

The checklist builder has a per-item camera icon toggle for `requires_photo`
but no bulk controls. PMs need to require photos for an entire section
(e.g. "all final walkthrough items") or the whole checklist at once.

**Edit:** `app/(dashboard)/properties/[id]/setup/checklist/checklist-builder.tsx`

### 3a — Add bulk toggle logic

After the existing state declarations (`useState`, `useTransition` calls),
add these two helper functions inside the `ChecklistBuilder` component:

```ts
// Toggle ALL items across ALL sections
const toggleAllPhotos = () => {
  const totalItems    = sections.reduce((n, s) => n + s.items.length, 0)
  const photoItems    = sections.reduce((n, s) => n + s.items.filter((i) => i.requires_photo).length, 0)
  const newValue      = !(totalItems > 0 && photoItems === totalItems)
  setSections((prev) => prev.map((s) => ({
    ...s,
    items: s.items.map((item) => ({ ...item, requires_photo: newValue })),
  })))
}

// Toggle ALL items in a single section
const toggleSectionPhotos = (sectionTempId: string) => {
  setSections((prev) => prev.map((s) => {
    if (s.tempId !== sectionTempId) return s
    const newValue = !s.items.every((i) => i.requires_photo)
    return { ...s, items: s.items.map((item) => ({ ...item, requires_photo: newValue })) }
  }))
}
```

### 3b — Global toggle bar

Add this block immediately after the title/description of the checklist
builder and before the sections list (before the `sections.map(...)` call):

```tsx
{/* Global photo requirement toggle */}
{sections.some((s) => s.items.length > 0) && (() => {
  const totalItems  = sections.reduce((n, s) => n + s.items.length, 0)
  const photoItems  = sections.reduce((n, s) => n + s.items.filter((i) => i.requires_photo).length, 0)
  const allOn       = totalItems > 0 && photoItems === totalItems

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-accent-50
                    rounded-xl border border-accent-200 mb-4">
      <div className="flex items-center gap-2">
        <Camera className="w-4 h-4 text-accent-500" />
        <div>
          <p className="text-sm font-medium text-accent-700">
            Require photo proof for all tasks
          </p>
          <p className="text-xs text-accent-400">
            {photoItems} of {totalItems} tasks require a photo
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={toggleAllPhotos}
        className={cn(
          'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full',
          'border-2 border-transparent transition-colors duration-200 focus:outline-none',
          allOn ? 'bg-brand-800' : 'bg-accent-300'
        )}
        role="switch"
        aria-checked={allOn}
      >
        <span className={cn(
          'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow',
          'transform transition-transform duration-200',
          allOn ? 'translate-x-5' : 'translate-x-0'
        )} />
      </button>
    </div>
  )
})()}
```

### 3c — Per-section camera toggle

In the section header row (the `div` containing the section name input and
the up/down/delete buttons), add a section-level camera toggle button.
Insert it between the section name input and the move/delete controls:

```tsx
{/* Section photo toggle — inside section header div, before up/down buttons */}
{(() => {
  const sectionAllPhoto = section.items.length > 0 &&
    section.items.every((i) => i.requires_photo)
  return (
    <button
      type="button"
      onClick={() => toggleSectionPhotos(section.tempId)}
      title={sectionAllPhoto
        ? 'Remove photo requirement for all items in this section'
        : 'Require photo for all items in this section'}
      className={cn(
        'p-1 rounded transition-colors',
        sectionAllPhoto
          ? 'text-brand-800 bg-brand-50'
          : 'text-accent-300 hover:text-accent-500'
      )}
    >
      <Camera className="w-3.5 h-3.5" />
    </button>
  )
})()}
```

Make sure `Camera` is imported from `lucide-react` (it likely already is).

---

## Step 4 — Crew Turnover Page: Real Photo Capture

The current `app/crew/turnovers/[id]/page.tsx` shows the camera icon as a
visual indicator only. It has no upload logic and `toggleItem` ignores
`requires_photo` entirely — crew can check off any item without a photo
even if one is required.

**Replace the entire file** `app/crew/turnovers/[id]/page.tsx` with:

```tsx
'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'
import { useParams, useRouter } from 'next/navigation'
import { useState, useRef } from 'react'
import {
  ArrowLeft, Camera, CheckCircle2, Circle,
  Loader2, ImageIcon, AlertCircle,
} from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'

export default function CrewTurnoverPage() {
  const { id }   = useParams<{ id: string }>()
  const router   = useRouter()
  const db       = usePowerSync()
  const supabase = createClient()

  const [uploadingItemId, setUploadingItemId] = useState<string | null>(null)
  const [uploadError, setUploadError]         = useState<string | null>(null)
  const [completing, setCompleting]           = useState(false)
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  // Data fetching via PowerSync (offline-capable)
  const { data: turnovers } = usePowerSyncQuery(
    'SELECT * FROM turnovers WHERE id = ?', [id]
  )
  const turnover = turnovers?.[0]

  const { data: instances } = usePowerSyncQuery(
    'SELECT * FROM checklist_instances WHERE turnover_id = ?', [id]
  )
  const instance = instances?.[0]

  const { data: items } = usePowerSyncQuery(
    `SELECT * FROM checklist_instance_items
     WHERE instance_id = ?
     ORDER BY section_name, sort_order`,
    [instance?.id ?? '']
  )

  const completedCount  = items?.filter((i) => i.is_completed).length ?? 0
  const totalCount      = items?.length ?? 0
  const pendingPhotos   = items?.filter(
    (i) => i.requires_photo && !i.photo_storage_path
  ) ?? []

  // Group items by section
  const sections = (items ?? []).reduce<Record<string, NonNullable<typeof items>>>(
    (acc, item) => {
      if (!acc[item.section_name]) acc[item.section_name] = []
      acc[item.section_name]!.push(item)
      return acc
    },
    {}
  )

  // ── Toggle checklist item completion ────────────────────────────────────────
  const toggleItem = async (
    itemId: string,
    current: number,
    requiresPhoto: number,
    photoPath: string | null
  ) => {
    // Requires photo but none uploaded — trigger camera instead of toggling
    if (!current && requiresPhoto && !photoPath) {
      fileInputRefs.current[itemId]?.click()
      return
    }
    await db.execute(
      'UPDATE checklist_instance_items SET is_completed = ? WHERE id = ?',
      [current ? 0 : 1, itemId]
    )
  }

  // ── Photo capture and upload ─────────────────────────────────────────────────
  // Photos REQUIRE an internet connection (offline photo queuing is phase 2).
  const handlePhotoCapture = async (itemId: string, file: File) => {
    setUploadingItemId(itemId)
    setUploadError(null)
    try {
      const ext  = file.name.split('.').pop() ?? 'jpg'
      const path = `turnover-${id}/${itemId}-${Date.now()}.${ext}`

      const { error } = await supabase.storage
        .from('turnover-photos')
        .upload(path, file, { contentType: file.type, upsert: true })

      if (error) throw new Error(error.message)

      // Update local PowerSync DB — connector syncs to Supabase when online
      await db.execute(
        `UPDATE checklist_instance_items
         SET photo_storage_path = ?, is_completed = 1
         WHERE id = ?`,
        [path, itemId]
      )
    } catch (err) {
      console.error('Photo upload failed:', err)
      setUploadError(
        'Photo upload failed. Make sure you have a connection and try again.'
      )
    } finally {
      setUploadingItemId(null)
    }
  }

  // ── Status actions ───────────────────────────────────────────────────────────
  const markInProgress = async () => {
    await db.execute(
      'UPDATE turnovers SET status = ? WHERE id = ?',
      ['in_progress', id]
    )
  }

  const markComplete = async () => {
    if (pendingPhotos.length > 0) {
      const ok = confirm(
        `${pendingPhotos.length} item${pendingPhotos.length !== 1 ? 's' : ''} ` +
        `still need photos. Mark complete anyway?`
      )
      if (!ok) return
    }
    setCompleting(true)
    await db.execute(
      'UPDATE turnovers SET status = ? WHERE id = ?',
      ['completed', id]
    )
    router.push('/crew')
  }

  // ── Loading state ────────────────────────────────────────────────────────────
  if (!turnover) {
    return (
      <div className="text-center py-20 text-accent-400">
        <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
        <p className="text-sm">Loading…</p>
      </div>
    )
  }

  return (
    <div>
      <Link
        href="/crew"
        className="flex items-center gap-1.5 text-sm text-accent-400
                   hover:text-accent-600 mb-4 transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Assignments
      </Link>

      {/* Turnover info */}
      <div className="bg-white rounded-xl border border-accent-200 p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className={cn(
            'text-xs font-semibold px-2 py-0.5 rounded-full',
            turnover.priority === 'urgent' ? 'bg-red-50 text-red-600' :
            turnover.priority === 'high'   ? 'bg-amber-50 text-amber-700' :
            'bg-accent-100 text-accent-600'
          )}>
            {turnover.priority} priority
          </span>
          {turnover.window_minutes && (
            <span className="text-sm font-semibold text-accent-600">
              {Math.floor(turnover.window_minutes / 60)}h
              {turnover.window_minutes % 60 > 0
                ? ` ${turnover.window_minutes % 60}m`
                : ''} window
            </span>
          )}
        </div>
        <div className="space-y-1 text-sm">
          <div className="flex gap-3">
            <span className="text-accent-400 w-20 flex-shrink-0">Checkout</span>
            <span className="font-medium text-accent-900">
              {formatDateTime(turnover.checkout_datetime)}
            </span>
          </div>
          <div className="flex gap-3">
            <span className="text-accent-400 w-20 flex-shrink-0">Next In</span>
            <span className="font-medium text-accent-900">
              {formatDateTime(turnover.checkin_datetime)}
            </span>
          </div>
        </div>
        {turnover.notes && (
          <p className="mt-3 text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
            📝 {turnover.notes}
          </p>
        )}
      </div>

      {/* Upload error banner */}
      {uploadError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200
                        rounded-xl px-4 py-3 mb-4">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{uploadError}</p>
        </div>
      )}

      {/* Checklist progress */}
      {totalCount > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-semibold text-accent-700">
              Checklist — {completedCount} of {totalCount}
            </span>
            <span className="text-sm text-accent-400">
              {Math.round((completedCount / totalCount) * 100)}%
            </span>
          </div>
          <div className="h-2 bg-accent-200 rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                completedCount === totalCount ? 'bg-green-500' : 'bg-brand-800'
              )}
              style={{ width: `${Math.round((completedCount / totalCount) * 100)}%` }}
            />
          </div>
          {pendingPhotos.length > 0 && (
            <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
              <Camera className="w-3 h-3" />
              {pendingPhotos.length} item{pendingPhotos.length !== 1 ? 's' : ''} still
              need{pendingPhotos.length === 1 ? 's' : ''} a photo
            </p>
          )}
        </div>
      )}

      {/* Sections */}
      {Object.entries(sections).map(([sectionName, sectionItems]) => (
        <div key={sectionName} className="mb-4">
          <h3 className="text-xs font-semibold text-accent-500 uppercase
                         tracking-wide mb-2 px-1">
            {sectionName}
          </h3>
          <div className="bg-white rounded-xl border border-accent-200
                          divide-y divide-accent-100 overflow-hidden">
            {sectionItems.map((item) => {
              const needsPhoto = item.requires_photo && !item.photo_storage_path
              const uploading  = uploadingItemId === item.id

              return (
                <div
                  key={item.id}
                  className={cn(
                    'flex items-start gap-3 px-4 py-3',
                    item.is_completed ? 'bg-green-50' : 'bg-white'
                  )}
                >
                  {/* Completion circle — tapping triggers photo if required */}
                  <button
                    className="flex-shrink-0 mt-0.5"
                    onClick={() => toggleItem(
                      item.id,
                      item.is_completed,
                      item.requires_photo,
                      item.photo_storage_path
                    )}
                  >
                    {item.is_completed
                      ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                      : <Circle className={cn(
                          'w-5 h-5',
                          needsPhoto ? 'text-amber-400' : 'text-accent-300'
                        )} />
                    }
                  </button>

                  {/* Task label */}
                  <div className="flex-1 min-w-0">
                    <p className={cn(
                      'text-sm leading-snug',
                      item.is_completed
                        ? 'text-green-700 line-through'
                        : 'text-accent-800'
                    )}>
                      {item.task}
                    </p>
                    {item.notes && (
                      <p className="text-xs text-accent-400 mt-0.5">{item.notes}</p>
                    )}
                    {item.photo_storage_path && (
                      <p className="text-xs text-green-600 mt-0.5 flex items-center gap-1">
                        <ImageIcon className="w-3 h-3" />
                        Photo attached
                      </p>
                    )}
                    {needsPhoto && !uploading && (
                      <p className="text-xs text-amber-600 mt-0.5">
                        Photo required before completing
                      </p>
                    )}
                  </div>

                  {/* Camera button — only shown when requires_photo */}
                  {item.requires_photo && (
                    <div className="flex-shrink-0">
                      {uploading ? (
                        <div className="p-1.5">
                          <Loader2 className="w-4 h-4 text-accent-400 animate-spin" />
                        </div>
                      ) : (
                        <button
                          onClick={() => fileInputRefs.current[item.id]?.click()}
                          className={cn(
                            'p-1.5 rounded-lg transition-colors',
                            item.photo_storage_path
                              ? 'text-green-600 bg-green-50 hover:bg-green-100'
                              : 'text-amber-600 bg-amber-50 hover:bg-amber-100'
                          )}
                          title={
                            item.photo_storage_path
                              ? 'Replace photo'
                              : 'Tap to take required photo'
                          }
                        >
                          <Camera className="w-4 h-4" />
                        </button>
                      )}
                      {/*
                        Hidden file input.
                        capture="environment" triggers the rear camera on mobile.
                        On desktop it opens the file picker.
                      */}
                      <input
                        ref={(el) => { fileInputRefs.current[item.id] = el }}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) handlePhotoCapture(item.id, file)
                          e.target.value = '' // reset so same file can be re-selected
                        }}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {totalCount === 0 && (
        <div className="bg-white rounded-xl border border-accent-200 p-6
                        text-center text-accent-400 text-sm mb-4">
          No checklist for this turnover.
        </div>
      )}

      {/* Actions */}
      <div className="space-y-3 pb-8 mt-4">
        {turnover.status === 'assigned' && (
          <button
            onClick={markInProgress}
            className="btn-secondary w-full py-3"
          >
            Start Turnover
          </button>
        )}
        <button
          onClick={markComplete}
          disabled={completing || turnover.status === 'completed'}
          className="btn-cta w-full py-3 flex items-center justify-center gap-2
                     disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {completing
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
            : turnover.status === 'completed'
            ? '✓ Marked Complete'
            : 'Mark as Complete'
          }
        </button>
      </div>
    </div>
  )
}
```

---

## Step 5 — Crew Invite Flow

Crew members are added to the roster in Settings but have no way to log
in until they have a Supabase Auth account linked to `crew_members.user_id`.
This step builds the full invite flow.

### 5a — Update middleware.ts

**Edit:** `middleware.ts`

Add `/crew/accept-invite` to `PUBLIC_ROUTES`:

```ts
const PUBLIC_ROUTES = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/crew/accept-invite',   // ← ADD THIS
]
```

### 5b — Add inviteCrewMember action to settings

**Edit:** `app/(dashboard)/settings/actions.ts`

Add this function (after existing exports):

```ts
export async function inviteCrewMember(
  crewMemberId: string
): Promise<{ error?: string; success?: boolean }> {
  const { supabase, membership } = await requireOrgMember()

  if (!['admin', 'manager'].includes(membership.role)) {
    return { error: 'Permission denied' }
  }

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, email, invite_token, user_id')
    .eq('id', crewMemberId)
    .eq('org_id', membership.org_id)
    .single()

  if (!crew)        return { error: 'Crew member not found' }
  if (!crew.email)  return { error: 'No email address on file for this crew member' }
  if (crew.user_id) return { error: 'This crew member already has an active account' }

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', membership.org_id)
    .single()

  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/crew/accept-invite/${crew.invite_token}`

  const { resend, FROM } = await import('@/lib/resend/client')
  const { error: emailError } = await resend.emails.send({
    from:    FROM,
    to:      crew.email,
    subject: `You've been invited to join ${org?.name ?? 'FieldStay'}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#102246;margin-bottom:8px">
          You're invited to FieldStay
        </h2>
        <p style="color:#1A1D20">Hi ${crew.name},</p>
        <p style="color:#1A1D20">
          <strong>${org?.name ?? 'Your property manager'}</strong> has invited
          you to join their team on FieldStay — the app you'll use to view
          cleaning assignments, complete checklists, and submit inventory counts.
        </p>
        <p style="margin:28px 0">
          <a href="${inviteUrl}"
             style="background:#FCD116;color:#102246;padding:14px 28px;
                    text-decoration:none;border-radius:8px;font-weight:700;
                    display:inline-block;font-size:15px">
            Accept Invitation →
          </a>
        </p>
        <p style="color:#6C757D;font-size:13px">
          This link expires in 7 days. If you weren't expecting this, you can
          safely ignore it.
        </p>
      </div>
    `,
  })

  if (emailError) return { error: emailError.message }

  await supabase
    .from('crew_members')
    .update({ invite_sent_at: new Date().toISOString() })
    .eq('id', crewMemberId)

  revalidatePath('/settings')
  return { success: true }
}
```

### 5c — Add invite button to settings crew tab

**Edit:** `app/(dashboard)/settings/settings-tabs.tsx`

First, import `inviteCrewMember` at the top with the other action imports.

Update the `CrewMember` interface to include the new fields:

```ts
interface CrewMember {
  id:                  string
  name:                string
  email:               string | null
  phone:               string | null
  specialty:           string
  preferred_contact:   string
  is_active:           boolean
  user_id:             string | null
  invite_sent_at:      string | null
  invite_accepted_at:  string | null
}
```

Update the crew fetch in `app/(dashboard)/settings/page.tsx` to include
these fields:

```ts
.select(`id, name, email, phone, specialty, preferred_contact,
         is_active, user_id, invite_sent_at, invite_accepted_at`)
```

In the `CrewRow` component add these state declarations and the invite handler:

```tsx
const [inviting, setInviting]         = useState(false)
const [inviteSent, setInviteSent]     = useState(false)
const [inviteError, setInviteError]   = useState<string | null>(null)

const handleInvite = async () => {
  setInviting(true)
  setInviteError(null)
  const result = await inviteCrewMember(member.id)
  setInviting(false)
  if (result.error) {
    setInviteError(result.error)
  } else {
    setInviteSent(true)
  }
}
```

In the crew row JSX, add an invite status column. The logic:
- `user_id` is set → show green "Active" badge
- `invite_accepted_at` is set but no `user_id` → anomaly, show "Active"
- `inviteSent` just happened → show "✓ Invite sent"
- `invite_sent_at` is set (previously sent) → show "Resend invite" link
- None of the above → show "Invite to app" button

```tsx
{/* Status / invite column */}
<td className="py-2.5 pr-2">
  {member.user_id ? (
    <span className="text-xs text-green-600 font-medium flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
      Active
    </span>
  ) : inviteSent ? (
    <span className="text-xs text-brand-700 font-medium">✓ Invite sent</span>
  ) : member.invite_sent_at ? (
    <button
      onClick={handleInvite}
      disabled={inviting}
      className="text-xs text-accent-500 hover:text-accent-700 underline
                 underline-offset-2 disabled:opacity-50"
    >
      {inviting ? 'Sending…' : 'Resend invite'}
    </button>
  ) : (
    <button
      onClick={handleInvite}
      disabled={inviting}
      className="btn-secondary text-xs px-2.5 py-1 disabled:opacity-50"
    >
      {inviting ? 'Sending…' : 'Invite to app'}
    </button>
  )}
  {inviteError && (
    <p className="text-xs text-red-500 mt-0.5">{inviteError}</p>
  )}
</td>
```

### 5d — Accept invite landing page

**New file:** `app/crew/accept-invite/[token]/page.tsx`

```tsx
import { createServiceClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { AcceptInviteForm } from './accept-invite-form'

interface Props { params: { token: string } }

export default async function AcceptInvitePage({ params }: Props) {
  const supabase = createServiceClient()

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, email, invite_sent_at, invite_accepted_at, user_id')
    .eq('invite_token', params.token)
    .single()

  if (!crew) notFound()

  // Already linked to an account
  if (crew.user_id || crew.invite_accepted_at) {
    return (
      <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
          <p className="text-3xl mb-3">✅</p>
          <h2 className="text-lg font-bold text-accent-900 mb-2">
            Account Already Active
          </h2>
          <p className="text-sm text-accent-500 mb-6">
            Your FieldStay account is set up. Log in to see your assignments.
          </p>
          <a href="/login" className="btn-primary w-full block text-center py-2.5">
            Go to Login →
          </a>
        </div>
      </div>
    )
  }

  // Check expiry (7 days from when invite was sent)
  if (crew.invite_sent_at) {
    const expired =
      new Date(crew.invite_sent_at).getTime() + 7 * 86_400_000 < Date.now()
    if (expired) {
      return (
        <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
            <p className="text-3xl mb-3">⏰</p>
            <h2 className="text-lg font-bold text-accent-900 mb-2">
              Invite Link Expired
            </h2>
            <p className="text-sm text-accent-500">
              This link has expired. Ask your property manager to send a new invite.
            </p>
          </div>
        </div>
      )
    }
  }

  return (
    <div className="min-h-screen bg-brand-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">
            FieldStay
          </h1>
          <p className="text-brand-200 text-sm mt-1">Crew App</p>
        </div>
        <div className="bg-white rounded-2xl shadow-lg p-8">
          <h2 className="text-xl font-bold text-accent-900 mb-1">
            Welcome, {crew.name}
          </h2>
          <p className="text-sm text-accent-500 mb-6">
            Create a password to activate your account.
          </p>
          <AcceptInviteForm
            token={params.token}
            crewId={crew.id}
            email={crew.email ?? ''}
            name={crew.name}
          />
        </div>
      </div>
    </div>
  )
}
```

**New file:** `app/crew/accept-invite/[token]/accept-invite-form.tsx`

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export function AcceptInviteForm({
  token,
  crewId,
  email,
  name,
}: {
  token:  string
  crewId: string
  email:  string
  name:   string
}) {
  const router              = useRouter()
  const [password, setPass] = useState('')
  const [confirm, setConf]  = useState('')
  const [error, setError]   = useState<string | null>(null)
  const [loading, setLoad]  = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }

    setLoad(true)
    try {
      const supabase = createClient()

      // Create Supabase Auth account
      const { data, error: signUpErr } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: name } },
      })

      if (signUpErr)  throw signUpErr
      if (!data.user) throw new Error('Account creation failed — please try again')

      // Link Auth user to crew record
      const res = await fetch('/api/crew/accept-invite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token, userId: data.user.id }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to activate account')
      }

      router.push('/crew')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoad(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700
                        text-sm rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      <div>
        <label className="label">Email</label>
        <input
          type="email"
          value={email}
          disabled
          className="input bg-accent-50 text-accent-500 cursor-not-allowed"
        />
      </div>

      <div>
        <label className="label">
          Password <span className="text-red-500">*</span>
        </label>
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPass(e.target.value)}
          className="input"
          placeholder="At least 8 characters"
          autoComplete="new-password"
        />
      </div>

      <div>
        <label className="label">
          Confirm Password <span className="text-red-500">*</span>
        </label>
        <input
          type="password"
          required
          value={confirm}
          onChange={(e) => setConf(e.target.value)}
          className="input"
          placeholder="Repeat password"
          autoComplete="new-password"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="btn-cta w-full py-2.5 disabled:opacity-60"
      >
        {loading ? 'Creating account…' : 'Activate Account →'}
      </button>
    </form>
  )
}
```

### 5e — Accept invite API route

**New file:** `app/api/crew/accept-invite/route.ts`

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.token || !body?.userId) {
    return NextResponse.json(
      { error: 'Missing token or userId' },
      { status: 400 }
    )
  }

  const { token, userId } = body as { token: string; userId: string }
  const supabase = createServiceClient()

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, user_id, invite_accepted_at')
    .eq('invite_token', token)
    .single()

  if (!crew) {
    return NextResponse.json({ error: 'Invalid invite token' }, { status: 404 })
  }

  if (crew.user_id || crew.invite_accepted_at) {
    return NextResponse.json({ error: 'Invite already used' }, { status: 409 })
  }

  const { error } = await supabase
    .from('crew_members')
    .update({
      user_id:            userId,
      invite_accepted_at: new Date().toISOString(),
    })
    .eq('id', crew.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
```

---

## Final File Map — Everything Touched This Session

```
fieldstay_migration_v2.sql            REPLACE (add invite cols + milestones)
types/database.ts                     EDIT (add invite_sent_at to CrewMember)
middleware.ts                         EDIT (add /crew/accept-invite to PUBLIC_ROUTES)

app/(dashboard)/properties/[id]/setup/checklist/
  checklist-builder.tsx               EDIT (bulk photo toggles — Steps 3a/3b/3c)

app/(dashboard)/settings/
  actions.ts                          EDIT (add inviteCrewMember)
  settings-tabs.tsx                   EDIT (invite button in crew rows)
  page.tsx                            EDIT (fetch invite fields)

app/crew/
  turnovers/[id]/page.tsx             REPLACE (full photo capture — Step 4)

app/crew/accept-invite/[token]/       CREATE (new directory)
  page.tsx                            CREATE
  accept-invite-form.tsx              CREATE

app/api/crew/
  accept-invite/route.ts              CREATE
```

---

## Code Patterns

### Auth (every server component + server action)
```ts
const { user, supabase, membership } = await requireOrgMember()
// Always filter by membership.org_id — never skip
```

### Service client (Inngest, webhooks, tokenized routes ONLY)
```ts
import { createServiceClient } from '@/lib/supabase/server'
const supabase = createServiceClient()
// Bypasses RLS — never in dashboard pages or regular server actions
```

### Crew pages — PowerSync pattern
```tsx
'use client'
import { usePowerSyncQuery, usePowerSync } from '@powersync/react'

const { data } = usePowerSyncQuery('SELECT * FROM turnovers WHERE ...', [param])
const db = usePowerSync()
await db.execute('UPDATE ... SET ... WHERE id = ?', [value, id])
```

### Pre-built CSS (use before writing custom Tailwind)
```
.btn-primary  .btn-secondary  .btn-ghost  .btn-danger
.btn-cta                          ← yellow, MUST use text-brand-800
.card  .input  .label
.badge  .badge-green  .badge-amber  .badge-red  .badge-blue  .badge-slate
.section-header  .page-title  .page-subtitle  .page-header
```

---

## Rules — Never Violate

1. Always filter by `org_id` on every database query
2. Never call `getSession()` — always `getUser()` (validates JWT server-side)
3. Never forget `revalidatePath()` after mutations
4. Never use service client in dashboard pages or server actions
5. Never register an Inngest function without adding it to `app/api/inngest/route.ts`
6. Never use `any` type — import from `types/database.ts`
7. `btn-cta` (yellow) MUST use `text-brand-800` — never white text on yellow

---

## Verification Checklist

After completing all steps, verify:

- [ ] v2 migration re-run — check `crew_members` table in Supabase for
  `invite_token`, `invite_sent_at`, `invite_accepted_at` columns
- [ ] Settings → Crew tab → crew member with email shows "Invite to app" button
- [ ] Click invite → email received → link goes to `/crew/accept-invite/[token]`
- [ ] Accept invite form → create account → redirected to `/crew`
- [ ] In Supabase, `crew_members.user_id` now populated for that crew member
- [ ] Checklist builder → global photo toggle switches all items
- [ ] Section header camera button toggles all items in that section
- [ ] Crew app turnover page → item with `requires_photo=true` → tapping
  circle triggers camera → photo uploads → item auto-checks off
- [ ] Item with `requires_photo=false` → tapping circle toggles immediately
  (no camera prompt)
- [ ] "Mark as Complete" on a turnover with pending photos → shows confirm
  dialog before proceeding
