import Link from 'next/link'
import { CalendarCheck, Package, Wrench, BarChart3, Check } from 'lucide-react'

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-accent-900">

      {/* ── Nav ──────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur border-b border-accent-100">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <span className="text-brand-800 text-xl font-bold tracking-tight">FieldStay</span>
          <nav className="flex items-center gap-3">
            <Link href="/login" className="btn-ghost text-sm px-4 py-2">
              Log In
            </Link>
            <Link href="/signup" className="btn-primary text-sm px-4 py-2">
              Start Free Trial
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="bg-brand-800 text-white py-24 px-6 text-center">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-5xl font-bold tracking-tight leading-tight mb-6">
            STR Operations,<br />Finally Handled.
          </h1>
          <p className="text-brand-200 text-xl mb-10 max-w-xl mx-auto">
            Turnover coordination, inventory, maintenance, and owner P&amp;L — all in one place for short-term rental property managers.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <Link href="/signup" className="btn-cta text-brand-800 text-base px-8 py-3 font-semibold">
              Get Started Free →
            </Link>
          </div>
          <p className="text-brand-300 text-sm mt-4">
            14-day free trial · No credit card required
          </p>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────── */}
      <section className="py-20 px-6 bg-accent-50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-bold text-brand-800 mb-3">Everything your operation needs</h2>
            <p className="text-accent-500 max-w-xl mx-auto">
              Built specifically for STR property managers who are tired of spreadsheets and group texts.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              {
                icon: CalendarCheck,
                title: 'Turnover Coordination',
                desc:  'Auto-generate turnovers from iCal feeds. Assign crew, track checklists, get notified when the property is guest-ready.',
              },
              {
                icon: Package,
                title: 'Inventory Management',
                desc:  'Set par levels, run counts, and let FieldStay automatically generate purchase orders when supplies run low.',
              },
              {
                icon: Wrench,
                title: 'Maintenance Scheduling',
                desc:  'Track one-off repairs and recurring maintenance. Send vendors a completion portal link with one click.',
              },
              {
                icon: BarChart3,
                title: 'Owner P&L Reporting',
                desc:  'Give owners a read-only portal with monthly revenue, expenses, and net — no spreadsheets required.',
              },
            ].map(({ icon: Icon, title, desc }) => (
              <div key={title} className="card flex flex-col gap-4">
                <div className="w-10 h-10 rounded-xl bg-brand-800 flex items-center justify-center flex-shrink-0">
                  <Icon className="w-5 h-5 text-gold-300" />
                </div>
                <div>
                  <h3 className="font-semibold text-accent-900 mb-1">{title}</h3>
                  <p className="text-sm text-accent-500 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How It Works ─────────────────────────────────────── */}
      <section className="py-20 px-6 bg-white">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-bold text-brand-800 mb-3">Up and running in minutes</h2>
            <p className="text-accent-500">No onboarding calls. No implementation fees.</p>
          </div>
          <div className="flex flex-col gap-8">
            {[
              {
                n:    '1',
                head: 'Connect your listings',
                body: 'Add your properties and paste in any iCal feed URL — Airbnb, VRBO, or direct booking. FieldStay pulls your calendar automatically.',
              },
              {
                n:    '2',
                head: 'Set up your crew and vendors',
                body: 'Invite crew members by email. They accept the invite and get access to their assigned turnovers — no account setup headaches.',
              },
              {
                n:    '3',
                head: 'Let FieldStay handle the rest',
                body: 'Turnovers generate automatically. Inventory gets tracked. Maintenance schedules run themselves. Owners see their P&L anytime.',
              },
            ].map(({ n, head, body }) => (
              <div key={n} className="flex gap-5 items-start">
                <div className="w-10 h-10 rounded-full bg-gold-300 flex items-center justify-center flex-shrink-0">
                  <span className="text-brand-800 font-bold text-lg">{n}</span>
                </div>
                <div>
                  <h3 className="font-semibold text-accent-900 mb-1">{head}</h3>
                  <p className="text-sm text-accent-500 leading-relaxed">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────── */}
      <section className="py-20 px-6 bg-accent-50">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-bold text-brand-800 mb-3">Simple, transparent pricing</h2>
            <p className="text-accent-500">Try free for 14 days — no credit card required.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">

            {/* Starter */}
            <div className="card flex flex-col">
              <h3 className="text-lg font-bold text-accent-900 mb-1">Starter</h3>
              <p className="text-accent-500 text-sm mb-6">Perfect for managing 1–2 properties</p>
              <div className="mb-2">
                <span className="text-5xl font-bold text-brand-800">$69.99</span>
                <span className="text-accent-400 text-sm">/mo</span>
              </div>
              <p className="text-xs text-gold-500 font-medium mb-6">14-day free trial · No credit card required</p>
              <ul className="space-y-2.5 mb-8 flex-1">
                {[
                  'Up to 2 properties',
                  'iCal sync (Airbnb, VRBO, direct)',
                  'Turnover coordination',
                  'Inventory management',
                  'Crew app (offline-capable)',
                  'Owner P&L portal',
                ].map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-accent-600">
                    <Check className="w-4 h-4 text-brand-800 flex-shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/signup" className="btn-secondary text-center py-2.5 text-sm font-medium">
                Start Free Trial
              </Link>
            </div>

            {/* FieldStay — featured */}
            <div className="card flex flex-col ring-2 ring-brand-800 relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <span className="bg-gold-300 text-brand-800 text-xs font-bold px-3 py-1 rounded-full">
                  Most Popular
                </span>
              </div>
              <h3 className="text-lg font-bold text-accent-900 mb-1">FieldStay</h3>
              <p className="text-accent-500 text-sm mb-6">The full platform for growing portfolios</p>
              <div className="mb-2">
                <span className="text-5xl font-bold text-brand-800">$99.99</span>
                <span className="text-accent-400 text-sm">/mo</span>
              </div>
              <p className="text-xs text-gold-500 font-medium mb-6">14-day free trial · No credit card required</p>
              <ul className="space-y-2.5 mb-8 flex-1">
                {[
                  'Up to 20 properties',
                  'Everything in Starter',
                  'Maintenance scheduling',
                  'Vendor completion portal',
                  'Work order expense tracking',
                  'Priority support',
                ].map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-accent-600">
                    <Check className="w-4 h-4 text-brand-800 flex-shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/signup" className="btn-cta text-brand-800 text-center py-2.5 text-sm font-semibold">
                Start Free Trial
              </Link>
            </div>

          </div>

          <p className="text-center text-sm text-accent-400 mt-8">
            Managing 50+ properties?{' '}
            <a href="mailto:hello@fieldstay.com" className="text-brand-800 font-medium hover:underline">
              Contact us for enterprise pricing →
            </a>
          </p>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────── */}
      <section className="py-20 px-6 bg-brand-800 text-white text-center">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl font-bold mb-4">Ready to run a tighter operation?</h2>
          <p className="text-brand-200 mb-8">
            Join property managers who use FieldStay to coordinate turnovers, manage inventory, and keep owners informed — automatically.
          </p>
          <Link href="/signup" className="btn-cta text-brand-800 text-base px-8 py-3 font-semibold inline-block">
            Start Your Free Trial →
          </Link>
          <p className="text-brand-300 text-sm mt-4">14-day free trial · No credit card required</p>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer className="bg-brand-800 border-t border-brand-700 py-10 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-white font-bold text-lg tracking-tight">FieldStay</span>
          <nav className="flex items-center gap-6 text-brand-300 text-sm">
            <a href="mailto:hello@fieldstay.com" className="hover:text-white transition-colors">Contact</a>
            <Link href="/login"  className="hover:text-white transition-colors">Log In</Link>
            <Link href="/signup" className="hover:text-white transition-colors">Sign Up</Link>
          </nav>
          <p className="text-brand-400 text-xs">© {new Date().getFullYear()} FieldStay. All rights reserved.</p>
        </div>
      </footer>

    </div>
  )
}
