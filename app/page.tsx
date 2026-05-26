import Link from 'next/link'
import { CalendarCheck, Package, Wrench, BarChart3, CheckCircle2, ArrowRight } from 'lucide-react'

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">

      {/* ── Nav ─────────────────────────────────────────────── */}
      <nav className="border-b border-accent-100 px-6 py-4 sticky top-0 bg-white/95 backdrop-blur z-50">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <span className="text-2xl font-bold text-brand-800">FieldStay</span>
          <div className="flex items-center gap-3">
            <Link href="/login"  className="btn-ghost text-sm">Log In</Link>
            <Link href="/signup" className="btn-primary text-sm">Start Free Trial</Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 py-24 text-center">
        <h1 className="text-5xl font-bold text-brand-800 leading-tight mb-5">
          STR Operations,<br />Finally Handled.
        </h1>
        <p className="text-xl text-accent-500 max-w-2xl mx-auto mb-8">
          FieldStay gives short-term rental property managers one platform
          for turnovers, inventory, maintenance, and owner reporting — with
          true offline access for your cleaning crew.
        </p>
        <Link
          href="/signup"
          className="btn-cta text-base px-8 py-3 inline-flex items-center gap-2"
        >
          Start Free Trial <ArrowRight className="w-5 h-5" />
        </Link>
        <p className="text-sm text-accent-400 mt-3">
          14-day free trial · No credit card required
        </p>
      </section>

      {/* ── Features ─────────────────────────────────────────── */}
      <section className="bg-accent-50 py-16">
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-brand-800 text-center mb-12">
            Everything between check-out and check-in
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
            {[
              {
                icon: CalendarCheck,
                title: 'Turnovers',
                desc:  'Auto-generated from your Airbnb and VRBO calendars. Assign crew, track checklists, capture photos.',
              },
              {
                icon: Package,
                title: 'Inventory',
                desc:  'Par levels per property. Crew submits counts. Purchase orders generated and sent to you automatically.',
              },
              {
                icon: Wrench,
                title: 'Maintenance',
                desc:  'Work orders, vendor portal, routine and seasonal schedule tracking — all in one place.',
              },
              {
                icon: BarChart3,
                title: 'Owner P&L',
                desc:  'Revenue from bookings, expenses from work orders. Owners get a clean, tokenized read-only portal.',
              },
            ].map((f) => (
              <div key={f.title} className="bg-white rounded-xl p-5 shadow-sm border border-accent-100">
                <f.icon className="w-7 h-7 text-brand-800 mb-3" />
                <h3 className="font-semibold text-accent-900 mb-1">{f.title}</h3>
                <p className="text-sm text-accent-500">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────── */}
      <section className="py-16">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl font-bold text-brand-800 mb-10">
            Up and running in minutes
          </h2>
          <div className="space-y-6 text-left">
            {[
              {
                n:    '1',
                title: 'Add your property',
                desc:  'Name, address, check-in times, door codes, Wi-Fi — everything your crew and guests need.',
              },
              {
                n:    '2',
                title: 'Connect your calendars',
                desc:  'Paste your Airbnb or VRBO iCal URL. FieldStay syncs bookings and generates turnovers automatically.',
              },
              {
                n:    '3',
                title: 'Invite your crew',
                desc:  'Crew gets an email link, creates an account, and sees their assignments on their phone — offline included.',
              },
            ].map((step) => (
              <div key={step.n} className="flex items-start gap-4">
                <span className="w-8 h-8 rounded-full bg-gold-300 text-brand-800 font-bold text-sm flex items-center justify-center flex-shrink-0 mt-0.5">
                  {step.n}
                </span>
                <div>
                  <p className="font-semibold text-accent-900">{step.title}</p>
                  <p className="text-sm text-accent-500 mt-0.5">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────── */}
      <section className="bg-accent-50 py-16">
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-brand-800 text-center mb-2">
            Simple, transparent pricing
          </h2>
          <p className="text-center text-accent-500 mb-10">
            Full software on every plan. No features gated.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {[
              {
                name:      'Pro',
                price:     '$149',
                annual:    '$1,490/yr',
                savings:   'Save $298',
                props:     'Up to 15 properties',
                highlight: false,
                features:  ['All core features', 'Crew offline app', 'Inventory + POs', 'Owner P&L portal', 'Vendor portal'],
              },
              {
                name:      'Growth',
                price:     '$219',
                annual:    '$2,190/yr',
                savings:   'Save $438',
                props:     '16–45 properties',
                highlight: true,
                features:  ['Everything in Pro', 'Up to 45 properties', 'Priority support'],
              },
              {
                name:      'Enterprise',
                price:     'Custom',
                annual:    '',
                savings:   '',
                props:     '45+ properties',
                highlight: false,
                features:  ['Everything in Growth', 'Custom onboarding', 'Dedicated support', 'Volume pricing'],
              },
            ].map((plan) => (
              <div
                key={plan.name}
                className={`bg-white rounded-xl p-6 border border-accent-100 flex flex-col ${
                  plan.highlight ? 'ring-2 ring-brand-800 shadow-md' : 'shadow-sm'
                }`}
              >
                {plan.highlight && (
                  <span className="inline-block bg-gold-300 text-brand-800 text-xs font-bold px-2 py-0.5 rounded-full mb-3 self-start">
                    Most Popular
                  </span>
                )}
                <h3 className="text-lg font-bold text-accent-900">{plan.name}</h3>
                <div className="my-2">
                  <span className="text-3xl font-bold text-brand-800">{plan.price}</span>
                  {plan.price !== 'Custom' && (
                    <span className="text-sm font-normal text-accent-400">/mo</span>
                  )}
                </div>
                {plan.annual && (
                  <p className="text-xs text-accent-400 mb-0.5">
                    or {plan.annual}{plan.savings && ` · ${plan.savings}`}
                  </p>
                )}
                <p className="text-sm text-accent-500 mb-4">{plan.props}</p>
                <ul className="space-y-2 mb-5 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-accent-700">
                      <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                {plan.price === 'Custom' ? (
                  <a
                    href="mailto:hello@fieldstay.app"
                    className="btn-secondary w-full text-center block py-2.5 text-sm"
                  >
                    Contact Us
                  </a>
                ) : (
                  <Link
                    href="/signup"
                    className="btn-primary w-full text-center block py-2.5 text-sm"
                  >
                    Start Free Trial
                  </Link>
                )}
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-accent-400 mt-6">
            All plans include a 14-day free trial. No credit card required.
            Annual billing saves approximately 2 months.
          </p>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer className="border-t border-accent-100 py-8">
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-between">
          <span className="font-bold text-brand-800">FieldStay</span>
          <div className="flex items-center gap-6 text-sm text-accent-400">
            <a href="mailto:hello@fieldstay.app" className="hover:text-accent-600 transition-colors">
              Contact
            </a>
            <Link href="/login"  className="hover:text-accent-600 transition-colors">Log In</Link>
            <Link href="/signup" className="hover:text-accent-600 transition-colors">Sign Up</Link>
          </div>
        </div>
      </footer>

    </div>
  )
}
