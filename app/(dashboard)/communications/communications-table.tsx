'use client'

import { useState } from 'react'
import { Mail, Inbox } from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import type { MessageTrigger, MessageStatus } from '@/types/database'

interface MessageRow {
  id: string
  property_id: string
  trigger: MessageTrigger
  recipient_name: string | null
  recipient_email: string
  subject: string
  sent_at: string
  status: MessageStatus
  properties: { name: string } | { name: string }[] | null
}

interface Property {
  id: string
  name: string
}

const TRIGGER_LABELS: Record<MessageTrigger, string> = {
  booking_confirmed: 'Booking Confirmed',
  pre_checkout:      'Pre-Checkout',
}

function statusBadgeClass(status: MessageStatus): string {
  switch (status) {
    case 'sent':    return 'badge badge-green'
    case 'failed':  return 'badge badge-red'
    case 'bounced': return 'badge badge-amber'
    default:        return 'badge badge-slate'
  }
}

function statusLabel(status: MessageStatus): string {
  switch (status) {
    case 'sent':    return 'Sent'
    case 'failed':  return 'Failed'
    case 'bounced': return 'Bounced'
    default:        return status
  }
}

function propertyName(msg: MessageRow): string {
  const p = Array.isArray(msg.properties) ? msg.properties[0] : msg.properties
  return p?.name ?? '—'
}

export function CommunicationsTable({
  messages,
  properties,
}: {
  messages: MessageRow[]
  properties: Property[]
}) {
  const [filterProperty, setFilterProperty] = useState<string>('all')
  const [filterTrigger, setFilterTrigger]   = useState<string>('all')

  const filtered = messages.filter((m) => {
    if (filterProperty !== 'all' && m.property_id !== filterProperty) return false
    if (filterTrigger  !== 'all' && m.trigger      !== filterTrigger)  return false
    return true
  })

  return (
    <div>
      {/* Filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        {properties.length > 1 && (
          <select
            value={filterProperty}
            onChange={(e) => setFilterProperty(e.target.value)}
            className="input text-sm py-1.5 w-auto"
          >
            <option value="all">All Properties</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}

        <select
          value={filterTrigger}
          onChange={(e) => setFilterTrigger(e.target.value)}
          className="input text-sm py-1.5 w-auto"
        >
          <option value="all">All Triggers</option>
          <option value="booking_confirmed">Booking Confirmed</option>
          <option value="pre_checkout">Pre-Checkout</option>
        </select>

        {filtered.length !== messages.length && (
          <span className="text-sm text-accent-500">
            {filtered.length} of {messages.length} messages
          </span>
        )}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="card text-center py-16 max-w-md mx-auto">
          <Inbox className="w-10 h-10 text-accent-300 mx-auto mb-3" />
          <h3 className="font-semibold text-accent-700 mb-1">No messages found</h3>
          <p className="text-sm text-accent-400">
            {messages.length === 0
              ? 'No messages sent yet. Messages are sent automatically when bookings are confirmed.'
              : 'No messages match the current filters.'}
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-accent-100 bg-accent-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide whitespace-nowrap">
                    Date Sent
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">
                    Property
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">
                    Guest
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide whitespace-nowrap">
                    Trigger
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">
                    Subject
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-accent-100">
                {filtered.map((msg) => (
                  <tr key={msg.id} className="hover:bg-accent-50 transition-colors">
                    <td className="px-4 py-3 text-accent-600 whitespace-nowrap">
                      {formatDate(msg.sent_at)}
                    </td>
                    <td className="px-4 py-3 font-medium text-accent-900 whitespace-nowrap">
                      {propertyName(msg)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-accent-900">{msg.recipient_name ?? '—'}</div>
                      <div className="text-xs text-accent-500 mt-0.5">{msg.recipient_email}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="badge badge-blue">
                        {TRIGGER_LABELS[msg.trigger] ?? msg.trigger}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-accent-700 max-w-xs truncate">
                      {msg.subject}
                    </td>
                    <td className="px-4 py-3">
                      <span className={statusBadgeClass(msg.status)}>
                        {statusLabel(msg.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
