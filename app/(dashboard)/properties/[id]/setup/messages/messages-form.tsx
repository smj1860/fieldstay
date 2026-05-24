'use client'

import { useActionState, useState, useRef } from 'react'
import { saveMessageTemplate, completeMessagesStep } from './actions'
import { CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GuestMessageTemplate } from '@/types/database'

const VARIABLES = [
  { key: 'guest_name',       label: 'Guest Name' },
  { key: 'property_name',    label: 'Property Name' },
  { key: 'property_address', label: 'Address' },
  { key: 'checkin_date',     label: 'Check-in Date' },
  { key: 'checkout_date',    label: 'Check-out Date' },
  { key: 'checkin_time',     label: 'Check-in Time' },
  { key: 'checkout_time',    label: 'Check-out Time' },
  { key: 'wifi_name',        label: 'Wi-Fi Name' },
  { key: 'wifi_password',    label: 'Wi-Fi Password' },
  { key: 'door_code',        label: 'Door Code' },
  { key: 'host_name',        label: 'Host Name' },
  { key: 'host_phone',       label: 'Host Phone' },
]

const BOOKING_DEFAULTS = {
  subject: 'Your stay at {{property_name}} is confirmed!',
  body: `Hi {{guest_name}},

We're so excited to host you at {{property_name}}!

Here are your details:
📅 Check-in: {{checkin_date}} at {{checkin_time}}
📅 Check-out: {{checkout_date}} at {{checkout_time}}
📍 Address: {{property_address}}
🔑 Door code: {{door_code}}
📶 Wi-Fi: {{wifi_name}} / {{wifi_password}}

If you have any questions before your arrival, don't hesitate to reach out.

See you soon!
{{host_name}}
{{host_phone}}`,
}

const CHECKOUT_DEFAULTS = {
  subject: 'We hope you enjoyed your stay — checkout reminder',
  body: `Hi {{guest_name}},

Just a friendly reminder that checkout is tomorrow at {{checkout_time}}.

Before you go, please:
• Strip the beds and leave used towels in the bathroom
• Place trash in the outdoor bins
• Lock all doors and return the key

We hope you had a wonderful stay at {{property_name}}. 

Safe travels!
{{host_name}}`,
}

function TemplateEditor({
  propertyId,
  trigger,
  template,
  label,
  defaultSubject,
  defaultBody,
}: {
  propertyId: string
  trigger: 'booking_confirmed' | 'pre_checkout'
  template: GuestMessageTemplate | null
  label: string
  defaultSubject: string
  defaultBody: string
}) {
  const action  = saveMessageTemplate.bind(null, propertyId, template?.id ?? null, trigger)
  const [state, formAction, pending] = useActionState(action, null)
  const [preview, setPreview] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const [body, setBody] = useState(template?.body ?? defaultBody)

  const insertVariable = (key: string) => {
    const ta  = bodyRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end   = ta.selectionEnd
    const token = `{{${key}}}`
    const next  = body.slice(0, start) + token + body.slice(end)
    setBody(next)
    setTimeout(() => {
      ta.focus()
      ta.setSelectionRange(start + token.length, start + token.length)
    }, 0)
  }

  const previewBody = body.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = VARIABLES.find((v) => v.key === key)
    return v ? `[${v.label}]` : `{{${key}}}`
  })

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="is_active" value="true" />

      {state?.error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          {state.error}
        </div>
      )}
      {state?.success && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-3 py-2 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> Saved
        </div>
      )}

      <div>
        <label className="label">Subject Line</label>
        <input
          name="subject"
          type="text"
          defaultValue={template?.subject ?? defaultSubject}
          className="input"
          placeholder={defaultSubject}
        />
      </div>

      {trigger === 'pre_checkout' && (
        <div>
          <label className="label">Send how many days before checkout?</label>
          <select name="days_before" defaultValue={template?.days_before ?? 1} className="input w-40">
            <option value="1">1 day before</option>
            <option value="2">2 days before</option>
            <option value="3">3 days before</option>
          </select>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="label mb-0">Message</label>
          <button
            type="button"
            onClick={() => setPreview((p) => !p)}
            className="text-xs text-brand-700 hover:underline"
          >
            {preview ? 'Edit' : 'Preview'}
          </button>
        </div>

        {preview ? (
          <div className="input min-h-[200px] whitespace-pre-wrap text-sm text-accent-700 bg-accent-50">
            {previewBody}
          </div>
        ) : (
          <textarea
            ref={bodyRef}
            name="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            className="input resize-none font-mono text-sm"
          />
        )}

        {/* Variable chips */}
        {!preview && (
          <div className="mt-2">
            <p className="text-xs text-accent-400 mb-1.5">Click to insert:</p>
            <div className="flex flex-wrap gap-1.5">
              {VARIABLES.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => insertVariable(v.key)}
                  className="text-xs px-2 py-1 rounded-md bg-accent-100 text-accent-600 hover:bg-brand-50 hover:text-brand-700 transition-colors"
                >
                  {`{{${v.key}}}`}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <button type="submit" disabled={pending} className="btn-secondary text-sm">
        {pending ? 'Saving…' : `Save ${label}`}
      </button>
    </form>
  )
}

export function MessagesForm({
  propertyId,
  bookingTemplate,
  checkoutTemplate,
}: {
  propertyId: string
  bookingTemplate: GuestMessageTemplate | null
  checkoutTemplate: GuestMessageTemplate | null
}) {
  const [tab, setTab] = useState<'booking' | 'checkout'>('booking')
  const [completing, setCompleting] = useState(false)

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex border-b border-accent-200">
        {(['booking', 'checkout'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t
                ? 'border-brand-700 text-brand-700'
                : 'border-transparent text-accent-500 hover:text-accent-700'
            )}
          >
            {t === 'booking' ? '📧 Booking Confirmation' : '⏰ Pre-Checkout Reminder'}
          </button>
        ))}
      </div>

      {tab === 'booking' ? (
        <TemplateEditor
          propertyId={propertyId}
          trigger="booking_confirmed"
          template={bookingTemplate}
          label="Booking Message"
          defaultSubject={BOOKING_DEFAULTS.subject}
          defaultBody={BOOKING_DEFAULTS.body}
        />
      ) : (
        <TemplateEditor
          propertyId={propertyId}
          trigger="pre_checkout"
          template={checkoutTemplate}
          label="Checkout Message"
          defaultSubject={CHECKOUT_DEFAULTS.subject}
          defaultBody={CHECKOUT_DEFAULTS.body}
        />
      )}

      <div className="flex items-center gap-3 pt-4 border-t border-accent-100">
        <form action={async () => {
          setCompleting(true)
          await completeMessagesStep(propertyId)
        }}>
          <button type="submit" disabled={completing} className="btn-primary">
            {completing ? 'Saving…' : 'Save & Continue →'}
          </button>
        </form>
      </div>
    </div>
  )
}
