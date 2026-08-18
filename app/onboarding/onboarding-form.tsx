'use client'

import { useActionState, useState } from 'react'
import { createOrganization }       from './actions'
import Link                         from 'next/link'
import { CheckCircle2, ArrowRight, PlugZap } from 'lucide-react'
import { Button, buttonVariantClass } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

type Step = 'name-org' | 'connect-pms'

interface OnboardingFormProps {
  userEmail:    string
  initialStep?: Step
  /**
   * Set when the user arrived here after an invite acceptance FAILED — an
   * expired or already-used token, an email that does not match the invite, or
   * a crew-role org invite (which acceptOrgInvite refuses on purpose, since an
   * organization_members row would hand a cleaner portfolio-wide guest PII).
   *
   * Without this they landed on "Name your organization" with no explanation
   * and created their own separate org, believing they had joined a team.
   */
  inviteFailed?: boolean
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
    id:          'hospitable',
    name:        'Hospitable',
    description: 'Bookings, properties, crew, guest reviews',
    connectUrl:  '/api/integrations/hospitable/connect',
    authType:    'oauth2' as const,
  },
  {
    id:          'hostex',
    name:        'Hostex',
    // Deliberately narrower than the other two: Hostex's API exposes no crew
    // roster and no reviews, so promising either here would be a lie the
    // sync cannot keep.
    description: 'Bookings and properties',
    connectUrl:  '/api/integrations/hostex/connect',
    authType:    'oauth2' as const,
  },
  {
    id:          'hostaway',
    name:        'Hostaway',
    // Narrower than OwnerRez/Hospitable for the same reason Hostex's is:
    // Hostaway's sync covers listings and reservations. No crew roster and no
    // reviews yet, so promising either here would be a lie the sync cannot keep.
    description: 'Bookings and properties',
    // api_key, so there is no OAuth redirect to send them to — the branch below
    // routes this to /settings/integrations?connect=hostaway, which auto-opens
    // the credential modal.
    connectUrl:  null,
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

export function OnboardingForm({ userEmail, initialStep = 'name-org', inviteFailed = false }: Readonly<OnboardingFormProps>) {
  const [state, action, pending] = useActionState(createOrganization, null)
  const [step, setStep]           = useState<Step>(initialStep)

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

      {inviteFailed && (
        <div
          className="text-sm rounded-lg px-4 py-3 border mb-4"
          style={{ background: 'var(--accent-amber-dim)', borderColor: 'var(--accent-amber)', color: 'var(--accent-amber)' }}
        >
          That invitation could not be accepted — it may have expired, already
          been used, or been sent to a different email address. Ask whoever
          invited you for a new link. Creating an organization below makes a
          NEW, separate account rather than joining theirs.
        </div>
      )}

      <form action={action} className="space-y-4">
        {state?.error && (
          <div
            className="text-sm rounded-lg px-4 py-3 border"
            style={{ background: 'var(--accent-red-dim)', borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}
          >
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
                className={buttonVariantClass('secondary') + ' text-sm flex-shrink-0 flex items-center gap-1.5'}
              >
                <PlugZap className="w-3.5 h-3.5" />
                Connect
              </a>
            ) : (
              // For API-key providers, link to the Integrations settings page
              // where the credential modal lives. ?connect=providerId auto-opens it.
              <a
                href={`/settings/integrations?connect=${pms.id}`}
                className={buttonVariantClass('secondary') + ' text-sm flex-shrink-0 flex items-center gap-1.5'}
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
