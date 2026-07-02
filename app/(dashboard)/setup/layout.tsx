import Link from 'next/link'
import { requireOrgMember } from '@/lib/auth'
import { ONBOARDING_STEPS, calcOnboardingProgress } from '@/lib/onboarding-wizard'
import { cn } from '@/lib/utils'

export default async function OnboardingLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const { supabase, membership } = await requireOrgMember()

  const { data: org } = await supabase
    .from('organizations')
    .select('onboarding_steps_completed')
    .eq('id', membership.org_id)
    .single()

  const completed = (org?.onboarding_steps_completed ?? {}) as Record<string, boolean>
  const pct       = calcOnboardingProgress(completed)

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-display font-bold page-title">Account Setup</h1>
          <span className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
            {pct}% complete
          </span>
        </div>

        {/* Progress bar */}
        <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-raised)' }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, background: 'var(--accent-gold)' }}
          />
        </div>
      </div>

      {/* Step nav */}
      <div className="flex gap-1 mb-8 flex-wrap">
        {ONBOARDING_STEPS.map((step, i) => {
          const done = !!completed[step.key]
          return (
            <Link
              key={step.key}
              href={`/setup/${step.href}`}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              )}
              style={done
                ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' }
                : { background: 'var(--bg-raised)', color: 'var(--text-muted)' }}
            >
              <span
                className="w-4 h-4 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                style={done
                  ? { background: 'var(--accent-gold)', color: 'var(--text-inverse)' }
                  : { background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
              >
                {done ? '✓' : i + 1}
              </span>
              {step.label}
            </Link>
          )
        })}
      </div>

      {/* Step content */}
      {children}
    </div>
  )
}
