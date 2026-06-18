import { requireProperty } from '@/lib/auth'
import { WIZARD_STEPS, calcSetupProgress } from '@/lib/wizard'
import Link from 'next/link'
import { CheckCircle2, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

export default async function SetupLayout({ children, params }: Props) {
  const { id } = await params
  const { property } = await requireProperty(id)
  const completed    = (property.setup_steps_completed as Record<string, boolean>) ?? {}
  const progress     = calcSetupProgress(completed)

  return (
    <div className="max-w-5xl">
      {/* Page header */}
      <div className="page-header">
        <div className="flex items-center gap-2 text-sm text-accent-400 mb-1">
          <Link href="/properties" className="hover:text-accent-600">Properties</Link>
          <span>/</span>
          <Link href={`/properties/${property.id}`} className="hover:text-accent-600">
            {property.name}
          </Link>
          <span>/</span>
          <span className="text-accent-600">Setup</span>
        </div>
        <h1 className="page-title">{property.name}</h1>
        <div className="flex items-center gap-3 mt-2">
          <div className="h-1.5 w-48 bg-accent-100 rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                progress === 100 ? 'bg-green-500' : 'bg-brand-600'
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-accent-500">
            {progress === 100 ? 'Setup complete' : `${progress}% complete`}
          </span>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-8">
        {/* Step nav */}
        <aside className="w-full sm:w-52 sm:flex-shrink-0">
          <nav className="space-y-0.5">
            {WIZARD_STEPS.map((step, idx) => {
              const done = completed[step.key] === true
              return (
                <Link
                  key={step.key}
                  href={`/properties/${property.id}/setup/${step.href}`}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all group',
                    'hover:bg-accent-100'
                  )}
                >
                  {done ? (
                    <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                  ) : (
                    <span className={cn(
                      'w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center',
                      'border-accent-300 text-accent-400 text-[10px] font-bold'
                    )}>
                      {idx + 1}
                    </span>
                  )}
                  <span className={cn(
                    'font-medium truncate',
                    done ? 'text-accent-600' : 'text-secondary-themed'
                  )}>
                    {step.label}
                  </span>
                </Link>
              )
            })}
          </nav>

          <div className="mt-6 pt-4 border-t border-accent-100">
            <Link
              href={`/properties/${property.id}`}
              className="text-xs text-accent-400 hover:text-accent-600 transition-colors"
            >
              ← Back to property
            </Link>
          </div>
        </aside>

        {/* Step content */}
        <div className="flex-1 min-w-0">
          {children}
        </div>
      </div>
    </div>
  )
}
