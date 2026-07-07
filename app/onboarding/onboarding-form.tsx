'use client'

import { useActionState, useState } from 'react'
import { createOrganization }       from './actions'
import Link                         from 'next/link'
import { CheckCircle2, ArrowRight, PlugZap } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

type Step = 'name-org' | 'connect-pms'

interface OnboardingFormProps {
  userEmail: string
}

const PMS_OPTIONS = [
  {
    id:          'ownerrez',
    name:        'OwnerRez',
    description: 'Bookings, properties, guest reviews',
    connectUrl:  '/api/integrations/ownerrez/connect',
    authType:    'oauth2' as const,
  },
  {
    id:          'hostaway',
    name:        'Hostaway',
    description: 'Bookings, listings, channels',
    connectUrl:  null,  // uses credential modal
    authType:    'api_key' as const,
  },
  // Guesty is not yet wired — hidden until the integration is live.
  // {
  //   id:          'guesty',
  //   name:        'Guesty',
  //   description: 'Bookings, listings, guest messaging',
  //   connectUrl:  null,
  //   authType:    'api_key' as const,
  // },
]

export function OnboardingForm({ userEmail }: OnboardingFormProps) {
  const [state, action, pending] = useActionState(createOrganization, null)
  const [step, setStep]           = useState<Step>('name-org')

  // When org is created successfully, advance to step 2
  if (state?.success && step === 'name-org') {
    setStep('connect-pms')
  }

  if (step === 'connect-pms') {
    return <ConnectPmsStep />
  }

  return (
    <>
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-6">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{ background: 'var(--accent-gold)', color: '#000' }}
        >
          1
        </div>
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          Name your organization
        </span>
        <div className="flex-1 h-px mx-1" style={{ background: 'var(--border)' }} />
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{ background: 'var(--bg-raised)', color: 'var(--text-muted)' }}
        >
          2
        </div>
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Connect your PMS
        </span>
      </div>

      <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
        Name your organization
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
        This is how your team and properties will be grouped. You can change it later.
      </p>

      <form action={action} className="space-y-4">
        {state?.error && (
          <div className="bg-red-950 border border-red-800 text-red-400 text-sm rounded-lg px-4 py-3">
            {state.error}
          </div>
        )}

        <div>
          <label htmlFor="org_name" className="label">Organization Name</label>
          <Input
            id="org_name"
            name="org_name"
            type="text"
            required
            placeholder="e.g. Lakeview Property Group"
          />
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Signed in as {userEmail}
          </p>
        </div>

        <Button
          type="submit"
          disabled={pending}
          className="w-full py-2.5 flex items-center justify-center gap-2"
        >
          {pending ? 'Setting up…' : <>Continue <ArrowRight className="w-4 h-4" /></>}
        </Button>
      </form>
    </>
  )
}

function ConnectPmsStep() {
  return (
    <>
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-6">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{ background: 'var(--accent-green)', color: '#000' }}
        >
          <CheckCircle2 className="w-4 h-4" />
        </div>
        <span className="text-sm line-through" style={{ color: 'var(--text-muted)' }}>
          Name your organization
        </span>
        <div className="flex-1 h-px mx-1" style={{ background: 'var(--border)' }} />
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{ background: 'var(--accent-gold)', color: '#000' }}
        >
          2
        </div>
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          Connect your PMS
        </span>
      </div>

      <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
        Connect your booking platform
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
        FieldStay syncs your bookings and properties automatically. Connect now or do it later in Settings.
      </p>

      <div className="space-y-3 mb-6">
        {PMS_OPTIONS.map((pms) => (
          <div
            key={pms.id}
            className="flex items-center justify-between gap-4 p-4 rounded-xl border"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-raised)' }}
          >
            <div>
              <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                {pms.name}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {pms.description}
              </p>
            </div>
            {pms.authType === 'oauth2' ? (
              <a
                href={pms.connectUrl!}
                className="btn-secondary text-sm flex-shrink-0 flex items-center gap-1.5"
              >
                <PlugZap className="w-3.5 h-3.5" />
                Connect
              </a>
            ) : (
              // For API-key providers, link to the Integrations settings page
              // where the credential modal lives. ?connect=providerId auto-opens it.
              <a
                href={`/settings/integrations?connect=${pms.id}`}
                className="btn-secondary text-sm flex-shrink-0 flex items-center gap-1.5"
              >
                <PlugZap className="w-3.5 h-3.5" />
                Connect
              </a>
            )}
          </div>
        ))}
      </div>

      <Link
        href="/ops"
        className="block text-center text-sm py-2.5"
        style={{ color: 'var(--text-muted)' }}
      >
        Skip for now — I&apos;ll connect later →
      </Link>
    </>
  )
}
