'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

const MARKETING_FAQ = [
  {
    q: 'Does FieldStay replace OwnerRez?',
    a: 'No — FieldStay is a field operations layer that works alongside OwnerRez. OwnerRez handles bookings, rates, and guest communication. FieldStay handles what happens on the ground: turnovers, crew assignments, inventory, maintenance, and owner reporting. They do different jobs and work better together.',
  },
  {
    q: 'How long does setup take?',
    a: 'Connecting OwnerRez takes about 2 minutes via OAuth. Your properties and upcoming bookings appear automatically within 5 minutes. Most property managers complete full setup — crew invites, checklists, and inventory — in under an hour.',
  },
  {
    q: 'What data syncs from OwnerRez?',
    a: 'FieldStay syncs your properties, active and upcoming bookings, and guest checkout and check-in events in real time. Booking changes in OwnerRez — modifications, cancellations — update in FieldStay automatically via webhooks.',
  },
  {
    q: 'How do my crew members access the app?',
    a: 'You invite crew members by email from the Crew section. They receive a link, create a free account, and install the app to their phone home screen — no App Store required. Crew see only their assigned turnovers and checklists, nothing else.',
  },
  {
    q: 'Does it work without cell service?',
    a: 'Yes. The crew app stores checklists and task details on the device. Crew can complete an entire turnover offline and the work syncs to the cloud when they\'re back in range. Built specifically for properties in rural and low-signal areas.',
  },
  {
    q: 'What happens when my trial ends?',
    a: 'After 14 days you\'ll be prompted to choose a plan. If you don\'t subscribe, your account is paused and your data is retained for 30 days so you can pick back up without losing anything. No credit card is required to start.',
  },
] as const

export default function FaqSection() {
  const [openIdx, setOpenIdx] = useState<number | null>(null)

  return (
    <div className="bg-white border-t border-[#e8edf4]">
      <div className="max-w-3xl mx-auto px-6 py-20">

        <h2 className="text-3xl font-bold text-center text-[#0a1628] mb-2 font-display">
          Common questions
        </h2>
        <p className="text-center text-gray-500 mb-12">
          Quick answers before you connect.
        </p>

        <div className="divide-y divide-[#e8edf4] border border-[#e8edf4] rounded-2xl overflow-hidden">
          {MARKETING_FAQ.map((faq, idx) => {
            const isOpen = openIdx === idx
            return (
              <div key={idx}>
                <button
                  onClick={() => setOpenIdx(isOpen ? null : idx)}
                  aria-expanded={isOpen}
                  className="w-full flex items-start justify-between gap-4
                             px-6 py-5 text-left transition-colors"
                  style={{ background: isOpen ? '#f8fafc' : 'white' }}
                >
                  <span className="text-sm font-semibold text-[#0a1628] leading-snug pt-px">
                    {faq.q}
                  </span>
                  <ChevronDown
                    className="w-4 h-4 flex-shrink-0 mt-0.5 transition-transform duration-200 text-gray-400"
                    style={{
                      transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    }}
                  />
                </button>
                {isOpen && (
                  <p className="px-6 pb-5 text-sm text-gray-500 leading-relaxed">
                    {faq.a}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <p className="text-center text-sm text-gray-400 mt-8">
          Something else?{' '}
          <a
            href="mailto:support@fieldstay.app"
            className="text-brand-800 underline font-medium hover:opacity-70
                       transition-opacity"
          >
            Email us
          </a>{' '}
          — we respond same day.
        </p>

      </div>
    </div>
  )
}
