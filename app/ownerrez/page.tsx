/**
 * /ownerrez — OwnerRez marketplace landing page.
 *
 * Auth-aware Server Component:
 *  - Not logged in → show sign-up form / Get Started CTA
 *  - Logged in     → show Connect OwnerRez button
 *
 * No pricing displayed.
 */

import type { Metadata }  from 'next'
import Link               from 'next/link'
import { createClient }   from '@/lib/supabase/server'
import {
  CalendarCheck,
  Users,
  ClipboardList,
  Zap,
  ArrowRight,
} from 'lucide-react'

export const metadata: Metadata = {
  title: 'Connect OwnerRez — FieldStay',
  description: 'Sync your OwnerRez bookings and properties with FieldStay for seamless field operations.',
}

const CONNECT_URL = '/api/integrations/ownerrez/connect'
const SIGNUP_URL  = `/signup?provider=ownerrez&next=${encodeURIComponent(CONNECT_URL)}`

const features = [
  {
    icon: CalendarCheck,
    title: 'Bookings sync automatically',
    body:  'Check-in and check-out dates flow straight from OwnerRez into your turnover schedule — no manual entry.',
  },
  {
    icon: Users,
    title: 'Crew gets the right jobs',
    body:  'FieldStay auto-creates turnovers from your bookings and routes them to your crew based on availability.',
  },
  {
    icon: ClipboardList,
    title: 'Checklists tied to each stay',
    body:  'Customizable room-by-room checklists and photo documentation — every turnover, every time.',
  },
  {
    icon: Zap,
    title: 'Real-time updates',
    body:  'When a booking is modified or cancelled in OwnerRez, your ops calendar updates within minutes.',
  },
]

export default async function OwnerRezLandingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const isLoggedIn = !!user

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>

      {/* Nav */}
      <header className="border-b border-themed px-6 py-4 flex items-center justify-between">
        <span className="text-xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
          FieldStay
        </span>
        {!isLoggedIn && (
          <Link href="/login" className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
            Sign in
          </Link>
        )}
      </header>

      {/* Hero */}
      <section className="max-w-3xl mx-auto px-6 pt-16 pb-12 text-center">
        <div
          className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full mb-6"
          style={{ background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' }}
        >
          OwnerRez Integration
        </div>

        <h1
          className="text-4xl font-extrabold tracking-tight mb-4 leading-tight"
          style={{ color: 'var(--text-primary)' }}
        >
          Your OwnerRez bookings,<br />
          your crew, fully in sync.
        </h1>

        <p
          className="text-lg max-w-xl mx-auto mb-10"
          style={{ color: 'var(--text-muted)' }}
        >
          FieldStay connects directly to OwnerRez so turnovers, checklists, and crew assignments
          happen automatically — the moment a guest books.
        </p>

        {isLoggedIn ? (
          <Link
            href={CONNECT_URL}
            className="btn-primary inline-flex items-center gap-2 py-3 px-6 rounded-xl text-base font-bold"
            style={{ background: 'var(--accent-gold)', color: '#0a1628' }}
          >
            Connect OwnerRez <ArrowRight className="w-4 h-4" />
          </Link>
        ) : (
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href={SIGNUP_URL}
              className="btn-primary inline-flex items-center gap-2 py-3 px-6 rounded-xl text-base font-bold"
              style={{ background: 'var(--accent-gold)', color: '#0a1628' }}
            >
              Get Started Free <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/login"
              className="text-sm font-medium"
              style={{ color: 'var(--text-muted)' }}
            >
              Already have an account? Sign in →
            </Link>
          </div>
        )}
      </section>

      {/* Features */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {features.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-2xl p-6"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
                style={{ background: 'var(--accent-gold-dim)' }}
              >
                <Icon className="w-5 h-5" style={{ color: 'var(--accent-gold)' }} />
              </div>
              <h3
                className="font-bold text-base mb-1"
                style={{ color: 'var(--text-primary)' }}
              >
                {title}
              </h3>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <section
        className="text-center py-16 px-6"
        style={{ background: 'var(--bg-card)', borderTop: '1px solid var(--border-subtle)' }}
      >
        <h2
          className="text-2xl font-bold mb-3"
          style={{ color: 'var(--text-primary)' }}
        >
          Ready to automate your turnovers?
        </h2>
        <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
          Connect OwnerRez and your first sync happens in seconds.
        </p>

        {isLoggedIn ? (
          <Link
            href={CONNECT_URL}
            className="btn-primary inline-flex items-center gap-2 py-3 px-6 rounded-xl text-base font-bold"
            style={{ background: 'var(--accent-gold)', color: '#0a1628' }}
          >
            Connect OwnerRez <ArrowRight className="w-4 h-4" />
          </Link>
        ) : (
          <Link
            href={SIGNUP_URL}
            className="btn-primary inline-flex items-center gap-2 py-3 px-6 rounded-xl text-base font-bold"
            style={{ background: 'var(--accent-gold)', color: '#0a1628' }}
          >
            Get Started Free <ArrowRight className="w-4 h-4" />
          </Link>
        )}
      </section>

    </div>
  )
}
