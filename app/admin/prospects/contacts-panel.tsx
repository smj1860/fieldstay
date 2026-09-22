'use client'

import { useEffect, useState, useTransition } from 'react'
import { Star, Trash2, Plus, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import {
  listProspectContacts,
  saveProspectContact,
  deleteProspectContact,
  promoteProspectContact,
} from './actions'
import {
  CONTACT_EMAIL_STATUSES,
  CONTACT_EMAIL_STATUS_LABELS,
  type ProspectContactInput,
  type ProspectContactRow,
  type PromotedPrimary,
} from './constants'

const SELECT_CLASS = 'input text-xs py-1'

const EMPTY_DRAFT: ProspectContactInput = {
  full_name: '', title: '', email: '', phone: '', linkedin_url: '',
  email_status: 'unknown', notes: '',
}

function describe(c: ProspectContactRow): string {
  return [c.full_name, c.title].filter(Boolean).join(' · ') || '(unnamed)'
}

/**
 * The ADDITIONAL people at one company.
 *
 * The primary contact is not in this list — it is the account's own
 * contact_name/email/phone fields above, which the contact-channel filter and
 * the CSV export read. "Make primary" swaps one of these into that slot.
 */
export function ContactsPanel({
  prospectId,
  onPrimaryChanged,
}: Readonly<{
  prospectId:       string
  onPrimaryChanged: (primary: PromotedPrimary) => void
}>) {
  const [contacts, setContacts] = useState<ProspectContactRow[] | null>(null)
  const [error, setError]       = useState('')
  const [draft, setDraft]       = useState<ProspectContactInput | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let live = true
    void listProspectContacts(prospectId).then((res) => {
      if (!live) return
      if (res.contacts === undefined) {
        setError(res.error ?? 'Could not load contacts.')
        setContacts([])
        return
      }
      setContacts(res.contacts)
    })
    return () => { live = false }
  }, [prospectId])

  function reload(): void {
    void listProspectContacts(prospectId).then((res) => {
      if (res.contacts !== undefined) setContacts(res.contacts)
    })
  }

  function save(): void {
    if (draft === null) return
    setError('')
    startTransition(async () => {
      const res = await saveProspectContact(prospectId, draft)
      if (res.id === undefined) { setError(res.error ?? 'Could not save.'); return }
      setDraft(null)
      reload()
    })
  }

  function remove(id: string): void {
    setError('')
    startTransition(async () => {
      const res = await deleteProspectContact(id)
      if (res.error !== undefined) { setError(res.error); return }
      reload()
    })
  }

  function promote(id: string): void {
    setError('')
    startTransition(async () => {
      const res = await promoteProspectContact(id, prospectId)
      if (res.error !== undefined) { setError(res.error); return }
      reload()
      if (res.primary !== undefined) onPrimaryChanged(res.primary)
    })
  }

  return (
    <div className="pl-12 pr-2 mt-3">
      <h4 className="text-xs font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Other contacts
      </h4>
      <p className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
        The contact fields above are the primary one — the address this account
        is filtered and exported on. Everyone else you find goes here.
      </p>

      {error !== '' && <InlineAlert tone="error" className="mb-2">{error}</InlineAlert>}

      <ContactList
        contacts={contacts}
        disabled={pending}
        onEdit={(c) => setDraft({
          id: c.id, full_name: c.full_name ?? '', title: c.title ?? '',
          email: c.email ?? '', phone: c.phone ?? '',
          linkedin_url: c.linkedin_url ?? '', email_status: c.email_status,
          notes: c.notes ?? '',
        })}
        onPromote={promote}
        onRemove={remove}
      />

      {draft === null ? (
        <Button
          variant="ghost"
          className="text-xs flex items-center gap-1 mt-1"
          disabled={pending}
          onClick={() => setDraft({ ...EMPTY_DRAFT })}
        >
          <Plus size={12} aria-hidden="true" /> Add a contact
        </Button>
      ) : (
        <ContactForm
          draft={draft}
          disabled={pending}
          onChange={setDraft}
          onCancel={() => { setDraft(null); setError('') }}
          onSave={save}
        />
      )}
    </div>
  )
}

function ContactList({
  contacts, disabled, onEdit, onPromote, onRemove,
}: Readonly<{
  contacts:  ProspectContactRow[] | null
  disabled:  boolean
  onEdit:    (c: ProspectContactRow) => void
  onPromote: (id: string) => void
  onRemove:  (id: string) => void
}>) {
  if (contacts === null) {
    return <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</p>
  }
  if (contacts.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        No other contacts recorded.
      </p>
    )
  }
  return (
    <ul className="space-y-1 mb-1">
      {contacts.map((c) => (
        <li key={c.id} className="flex items-center gap-2 text-xs">
          <span style={{ color: 'var(--text-primary)' }}>{describe(c)}</span>
          {c.email !== null && (
            <span
              style={{
                color: c.email_status === 'bounced' ? 'var(--accent-red)' : 'var(--text-muted)',
                textDecoration: c.email_status === 'bounced' ? 'line-through' : 'none',
              }}
            >
              {c.email}
            </span>
          )}
          {c.phone !== null && (
            <span style={{ color: 'var(--text-muted)' }}>{c.phone}</span>
          )}
          {c.email_status !== 'unknown' && (
            <span style={{ color: 'var(--text-muted)' }}>
              ({CONTACT_EMAIL_STATUS_LABELS[c.email_status]})
            </span>
          )}
          <span className="flex-1" />
          <Button
            variant="ghost"
            className="text-[11px] flex items-center gap-1"
            disabled={disabled}
            title="Swap this contact into the primary slot"
            onClick={() => onPromote(c.id)}
          >
            <Star size={11} aria-hidden="true" /> Make primary
          </Button>
          <Button
            variant="ghost"
            className="text-[11px] flex items-center gap-1"
            disabled={disabled}
            onClick={() => onEdit(c)}
          >
            <Pencil size={11} aria-hidden="true" /> Edit
          </Button>
          <Button
            variant="ghost"
            className="text-[11px] flex items-center gap-1"
            disabled={disabled}
            onClick={() => onRemove(c.id)}
          >
            <Trash2 size={11} aria-hidden="true" /> Remove
          </Button>
        </li>
      ))}
    </ul>
  )
}

function ContactForm({
  draft, disabled, onChange, onCancel, onSave,
}: Readonly<{
  draft:    ProspectContactInput
  disabled: boolean
  onChange: (d: ProspectContactInput) => void
  onCancel: () => void
  onSave:   () => void
}>) {
  const set = (patch: Partial<ProspectContactInput>): void => onChange({ ...draft, ...patch })

  return (
    <div
      className="mt-2 p-2 rounded-lg grid gap-2 sm:grid-cols-3"
      style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}
    >
      <Input
        className="text-xs" placeholder="Name" aria-label="Contact name"
        value={draft.full_name ?? ''} disabled={disabled}
        onChange={(e) => set({ full_name: e.target.value })}
      />
      <Input
        className="text-xs" placeholder="Title" aria-label="Contact title"
        value={draft.title ?? ''} disabled={disabled}
        onChange={(e) => set({ title: e.target.value })}
      />
      <Input
        className="text-xs" placeholder="Email" aria-label="Contact email"
        value={draft.email ?? ''} disabled={disabled}
        onChange={(e) => set({ email: e.target.value })}
      />
      <Input
        className="text-xs" placeholder="Phone" aria-label="Contact phone"
        value={draft.phone ?? ''} disabled={disabled}
        onChange={(e) => set({ phone: e.target.value })}
      />
      <Input
        className="text-xs" placeholder="LinkedIn URL" aria-label="Contact LinkedIn URL"
        value={draft.linkedin_url ?? ''} disabled={disabled}
        onChange={(e) => set({ linkedin_url: e.target.value })}
      />
      <select
        className={SELECT_CLASS}
        aria-label="Email status"
        value={draft.email_status ?? 'unknown'}
        disabled={disabled}
        onChange={(e) => set({ email_status: e.target.value as ProspectContactInput['email_status'] })}
      >
        {CONTACT_EMAIL_STATUSES.map((s) => (
          <option key={s} value={s}>{CONTACT_EMAIL_STATUS_LABELS[s]}</option>
        ))}
      </select>
      <Input
        className="text-xs sm:col-span-3" placeholder="Notes" aria-label="Contact notes"
        value={draft.notes ?? ''} disabled={disabled}
        onChange={(e) => set({ notes: e.target.value })}
      />
      <div className="sm:col-span-3 flex items-center gap-2">
        <Button variant="secondary" className="text-xs" disabled={disabled} onClick={onSave}>
          {draft.id === undefined ? 'Add contact' : 'Save contact'}
        </Button>
        <Button variant="ghost" className="text-xs" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
