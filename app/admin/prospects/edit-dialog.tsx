'use client'

import { useId, useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { ContactsPanel } from './contacts-panel'
import { HistoryPanel } from './history-panel'
import {
  PROSPECT_STATUSES,
  PROSPECT_STATUS_LABELS,
  type ProspectEditableFields,
  type ProspectRow,
  type ProspectStatus,
  type PromotedPrimary,
} from './constants'

/**
 * Every free-text column an admin may edit, in the order the form shows them.
 *
 * Contact first: finding a name and an address for an account that has none
 * is what this page is FOR, and burying those behind the company's own
 * details put the least-used fields at the top of the screen.
 *
 * The list is data rather than JSX so a new editable column is one line here
 * plus one line in EDITABLE_TEXT_FIELDS in actions.ts — the previous inline
 * editor hand-wrote each field and had silently drifted, omitting `website`
 * and `status_note` even though the server action accepted both.
 */
const TEXT_FIELDS = [
  { key: 'contact_name',  label: 'Contact name',  placeholder: 'Who you found' },
  { key: 'contact_title', label: 'Title',         placeholder: 'Owner, GM, Ops Manager…' },
  { key: 'email',         label: 'Email',         placeholder: 'name@company.com' },
  { key: 'phone',         label: 'Phone',         placeholder: '(865) 555-0142' },
  { key: 'linkedin_url',  label: 'LinkedIn URL',  placeholder: 'https://linkedin.com/in/…' },
  { key: 'company',       label: 'Company name',  placeholder: '' },
  { key: 'website',       label: 'Website',       placeholder: 'https://…' },
  { key: 'domain',        label: 'Domain',        placeholder: 'example.com' },
  { key: 'city',          label: 'City',          placeholder: '' },
  { key: 'state',         label: 'State',         placeholder: 'TN' },
  { key: 'market',        label: 'Market',        placeholder: '' },
  { key: 'pms',           label: 'PMS',           placeholder: 'Streamline, Track…' },
] as const satisfies readonly { key: keyof ProspectEditableFields; label: string; placeholder: string }[]

const LONG_FIELDS = [
  { key: 'pms_note',    label: 'How the PMS was identified' },
  { key: 'status_note', label: 'Status note' },
  { key: 'notes',       label: 'Notes' },
] as const satisfies readonly { key: keyof ProspectEditableFields; label: string }[]

type TextKey = (typeof TEXT_FIELDS)[number]['key'] | (typeof LONG_FIELDS)[number]['key']

function daysSince(iso: string | null): number | null {
  if (iso === null) return null
  const ms = Date.now() - new Date(iso).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null
}

/** Why an account is or is not being refreshed from Comparent. */
function crawlStatusLine(row: ProspectRow): string {
  if (row.comparent_url === null) {
    return 'No comparent_url on file — not eligible for "Refresh from Comparent."'
  }
  if (row.last_crawled_at === null) return 'Never crawled.'

  const days = daysSince(row.last_crawled_at)
  const when = days === 0 ? 'today' : `${days}d ago`

  let suffix = ''
  if (row.crawl_status === 'error') suffix = ' — last attempt failed'
  else if (row.crawl_status === 'no_website') suffix = ' — no website found'

  return `Last crawled ${when}${suffix}`
}

type Draft = Record<TextKey, string> & { status: ProspectStatus; next_action_at: string }

function draftFrom(row: ProspectRow): Draft {
  const draft = { status: row.status, next_action_at: row.next_action_at ?? '' } as Draft
  for (const { key } of [...TEXT_FIELDS, ...LONG_FIELDS]) {
    draft[key] = row[key] ?? ''
  }
  return draft
}

/**
 * Only what actually changed.
 *
 * Sending the whole form would rewrite every column on every save, which
 * makes the audit row's `fields` list meaningless and would stamp
 * last_touch_at from a status that was never touched.
 */
function diff(draft: Draft, row: ProspectRow): Partial<ProspectEditableFields> {
  const patch: Partial<ProspectEditableFields> = {}

  for (const { key } of [...TEXT_FIELDS, ...LONG_FIELDS]) {
    if (draft[key] !== (row[key] ?? '')) Object.assign(patch, { [key]: draft[key] })
  }
  if (draft.status !== row.status) patch.status = draft.status
  if (draft.next_action_at !== (row.next_action_at ?? '')) {
    patch.next_action_at = draft.next_action_at
  }

  return patch
}

/**
 * The one place an account is edited.
 *
 * It replaced an expand-in-place editor that rendered inside the list's
 * horizontally-scrolling table: on a phone the fields sat off the right edge
 * of a ten-column table, behind a 14px chevron with no label, so the page
 * read as though nothing on it could be edited at all. A dialog — a bottom
 * sheet at phone widths — is reachable at any width and needs no horizontal
 * scrolling.
 */
export function ProspectEditDialog({
  row, open, onClose, onSave, onPrimaryChanged, saveError,
}: Readonly<{
  row:              ProspectRow
  open:             boolean
  onClose:          () => void
  onSave:           (patch: Partial<ProspectEditableFields>) => Promise<boolean>
  onPrimaryChanged: (primary: PromotedPrimary) => void
  saveError:        string
}>) {
  // Keyed on the row id by the caller, so opening a different account
  // remounts this and the draft starts from that account's values.
  const [draft, setDraft] = useState<Draft>(() => draftFrom(row))
  const [saving, setSaving] = useState(false)
  const statusId = useId()
  const nextActionId = useId()

  const patch = diff(draft, row)
  const dirty = Object.keys(patch).length > 0

  function set(key: keyof Draft, value: string): void {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  /**
   * Closes only once the server has taken it. On a rejection the dialog stays
   * open with the draft intact, and saveError explains why — the alternative
   * is silently discarding what someone just typed.
   */
  async function save(): Promise<void> {
    if (!dirty) { onClose(); return }
    setSaving(true)
    const accepted = await onSave(patch)
    setSaving(false)
    if (accepted) onClose()
  }

  function saveLabel(): string {
    if (saving) return 'Saving…'
    return dirty ? 'Save changes' : 'No changes'
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={row.company}
      mobileSheet
      maxWidthClassName="max-w-2xl"
      footer={
        <>
          <Button
            variant="primary"
            onClick={() => { void save() }}
            disabled={!dirty || saving}
          >
            {saveLabel()}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Close</Button>
        </>
      }
    >
      <div className="space-y-5 pt-2">
        {saveError !== '' && <InlineAlert tone="error">{saveError}</InlineAlert>}

        <section>
          <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            Primary contact &amp; details
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {TEXT_FIELDS.map((f) => (
              <TextField
                key={f.key}
                label={f.label}
                placeholder={f.placeholder}
                value={draft[f.key]}
                onChange={(v) => set(f.key, v)}
              />
            ))}
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor={statusId}>Status</FieldLabel>
            <select
              id={statusId}
              className="input text-sm"
              value={draft.status}
              onChange={(e) => set('status', e.target.value)}
            >
              {PROSPECT_STATUSES.map((s) => (
                <option key={s} value={s}>{PROSPECT_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel htmlFor={nextActionId}>Next action</FieldLabel>
            <Input
              id={nextActionId}
              type="date"
              className="text-sm"
              value={draft.next_action_at}
              onChange={(e) => set('next_action_at', e.target.value)}
            />
          </div>
        </section>

        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {crawlStatusLine(row)}
        </p>

        <section className="space-y-3">
          {LONG_FIELDS.map((f) => (
            <LongField
              key={f.key}
              label={f.label}
              value={draft[f.key]}
              onChange={(v) => set(f.key, v)}
            />
          ))}
        </section>

        <section
          className="pt-4 border-t space-y-5"
          style={{ borderColor: 'var(--border)' }}
        >
          <ContactsPanel prospectId={row.id} onPrimaryChanged={onPrimaryChanged} />
          <HistoryPanel prospectId={row.id} />
        </section>
      </div>
    </Dialog>
  )
}

function FieldLabel({
  htmlFor, children,
}: Readonly<{ htmlFor: string; children: React.ReactNode }>) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-[11px] uppercase tracking-wide mb-1"
      style={{ color: 'var(--text-muted)' }}
    >
      {children}
    </label>
  )
}

function TextField({
  label, value, placeholder, onChange,
}: Readonly<{
  label:       string
  value:       string
  placeholder: string
  onChange:    (value: string) => void
}>) {
  const id = useId()
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        className="text-sm"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function LongField({
  label, value, onChange,
}: Readonly<{ label: string; value: string; onChange: (value: string) => void }>) {
  const id = useId()
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <textarea
        id={id}
        className="input text-sm w-full"
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
