'use client'

import { useState, useTransition, useActionState } from 'react'
import { Pencil, X, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Organization, CrewMember, Vendor, OrganizationMember, MemberRole, VendorSpecialty } from '@/types/database'
import {
  updateOrgSettings,
  addCrewMember,
  updateCrewMember,
  deactivateCrewMember,
  addVendor,
  updateVendorPortal,
  deactivateVendor,
  openBillingPortal,
  startCheckout,
  type SettingsActionState,
} from './actions'

// ── Constants ────────────────────────────────────────────────────────────────

const TABS = ['Organization', 'Crew', 'Vendors', 'Billing'] as const
type Tab = typeof TABS[number]

const VENDOR_SPECIALTY_LABELS: Record<VendorSpecialty, string> = {
  plumbing:     'Plumbing',
  electrical:   'Electrical',
  hvac:         'HVAC',
  landscaping:  'Landscaping',
  cleaning:     'Cleaning',
  pest_control: 'Pest Control',
  pool:         'Pool',
  roofing:      'Roofing',
  general:      'General',
  other:        'Other',
}

const VENDOR_SPECIALTIES = Object.keys(VENDOR_SPECIALTY_LABELS) as VendorSpecialty[]

const PLAN_INFO = {
  starter:    { name: 'Starter',    maxProperties: 5,   description: 'Up to 5 properties',    badge: 'badge-slate' },
  growth:     { name: 'Growth',     maxProperties: 20,  description: 'Up to 20 properties',   badge: 'badge-blue'  },
  pro:        { name: 'Pro',        maxProperties: 50,  description: 'Up to 50 properties',   badge: 'badge-green' },
  enterprise: { name: 'Enterprise', maxProperties: 999, description: 'Unlimited properties',  badge: 'badge-amber' },
} as const

const PLAN_STATUS_BADGES: Record<string, string> = {
  trialing:  'badge-amber',
  active:    'badge-green',
  past_due:  'badge-red',
  cancelled: 'badge-red',
  paused:    'badge-slate',
}

// ── Root component ───────────────────────────────────────────────────────────

interface Props {
  org: Organization
  crew: CrewMember[]
  vendors: Vendor[]
  orgMembers: OrganizationMember[]
  currentRole: MemberRole
}

export function SettingsTabs({ org, crew, vendors, orgMembers, currentRole }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('Organization')

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-accent-200 mb-6">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px',
              activeTab === tab
                ? 'border-brand-700 text-brand-800'
                : 'border-transparent text-accent-500 hover:text-accent-700 hover:border-accent-300'
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      {activeTab === 'Organization' && <OrgTab org={org} />}
      {activeTab === 'Crew'         && <CrewTab crew={crew} />}
      {activeTab === 'Vendors'      && <VendorsTab vendors={vendors} />}
      {activeTab === 'Billing'      && <BillingTab org={org} />}
    </div>
  )
}

// ── Organization tab ─────────────────────────────────────────────────────────

function OrgTab({ org }: { org: Organization }) {
  const [state, formAction, pending] = useActionState(updateOrgSettings, null)

  const plan       = PLAN_INFO[org.plan as keyof typeof PLAN_INFO] ?? PLAN_INFO.starter
  const statusBadge = PLAN_STATUS_BADGES[org.plan_status] ?? 'badge-slate'

  return (
    <div className="max-w-xl space-y-6">
      <div className="card">
        <h2 className="text-base font-semibold text-accent-900 mb-4">Organization Settings</h2>

        {/* Plan info */}
        <div className="flex items-center gap-2 mb-6 p-3 bg-accent-50 rounded-lg border border-accent-100">
          <span className={cn('badge', plan.badge)}>{plan.name}</span>
          <span className={cn('badge', statusBadge)}>
            {org.plan_status.replace('_', ' ')}
          </span>
          <span className="text-xs text-accent-500 ml-auto">{plan.description}</span>
        </div>

        {state?.success && (
          <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3 mb-4">
            Settings saved successfully.
          </div>
        )}
        {state?.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">
            {state.error}
          </div>
        )}

        <form action={formAction} className="space-y-4">
          <div>
            <label htmlFor="org-name" className="label">
              Organization Name <span className="text-red-500">*</span>
            </label>
            <input
              id="org-name"
              name="name"
              type="text"
              required
              defaultValue={org.name}
              className="input"
              placeholder="My Property Management Co."
            />
          </div>

          <div>
            <label htmlFor="billing-email" className="label">Billing Email</label>
            <input
              id="billing-email"
              name="billing_email"
              type="email"
              defaultValue={org.billing_email ?? ''}
              className="input"
              placeholder="billing@company.com"
            />
          </div>

          <div className="pt-2 border-t border-accent-100">
            <button type="submit" disabled={pending} className="btn-primary">
              {pending ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
              ) : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Crew tab ─────────────────────────────────────────────────────────────────

function CrewTab({ crew }: { crew: CrewMember[] }) {
  const [showAddForm, setShowAddForm] = useState(false)

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-accent-900">Crew Members</h2>
          <button
            onClick={() => setShowAddForm((v) => !v)}
            className="btn-secondary text-sm"
          >
            {showAddForm ? 'Cancel' : '+ Add Crew Member'}
          </button>
        </div>

        {showAddForm && (
          <AddCrewForm onSuccess={() => setShowAddForm(false)} />
        )}

        {crew.length === 0 && !showAddForm ? (
          <p className="text-sm text-accent-500 py-4 text-center">
            No active crew members yet. Add one to get started.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-accent-100">
                  <th className="text-left py-2 pr-4 font-medium text-accent-500 text-xs uppercase tracking-wide">Name</th>
                  <th className="text-left py-2 pr-4 font-medium text-accent-500 text-xs uppercase tracking-wide">Specialty</th>
                  <th className="text-left py-2 pr-4 font-medium text-accent-500 text-xs uppercase tracking-wide">Contact</th>
                  <th className="text-left py-2 pr-4 font-medium text-accent-500 text-xs uppercase tracking-wide">Pref</th>
                  <th className="py-2 text-right font-medium text-accent-500 text-xs uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-accent-50">
                {crew.map((member) => (
                  <CrewRow key={member.id} member={member} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function AddCrewForm({ onSuccess }: { onSuccess: () => void }) {
  const [state, formAction, pending] = useActionState(addCrewMember, null)

  if (state?.success) {
    onSuccess()
    return null
  }

  return (
    <div className="mb-6 p-4 bg-accent-50 rounded-lg border border-accent-200">
      <h3 className="text-sm font-semibold text-accent-700 mb-3">New Crew Member</h3>

      {state?.error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-3">
          {state.error}
        </div>
      )}

      <form action={formAction} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="crew-name" className="label">Name <span className="text-red-500">*</span></label>
            <input id="crew-name" name="name" type="text" required className="input" placeholder="Alex Johnson" />
          </div>
          <div>
            <label htmlFor="crew-specialty" className="label">Specialty</label>
            <input id="crew-specialty" name="specialty" type="text" className="input" placeholder="e.g. Cleaning, HVAC" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="crew-email" className="label">Email</label>
            <input id="crew-email" name="email" type="email" className="input" placeholder="alex@example.com" />
          </div>
          <div>
            <label htmlFor="crew-phone" className="label">Phone</label>
            <input id="crew-phone" name="phone" type="tel" className="input" placeholder="+1 555-0100" />
          </div>
        </div>

        <div className="w-48">
          <label htmlFor="crew-pref" className="label">Preferred Contact</label>
          <select id="crew-pref" name="preferred_contact" className="input">
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="both">Both</option>
          </select>
        </div>

        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={pending} className="btn-primary text-sm">
            {pending ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</>
            ) : 'Add Crew Member'}
          </button>
        </div>
      </form>
    </div>
  )
}

function CrewRow({ member }: { member: CrewMember }) {
  const [editing, setEditing]         = useState(false)
  const [name, setName]               = useState(member.name)
  const [specialty, setSpecialty]     = useState(member.specialty)
  const [email, setEmail]             = useState(member.email ?? '')
  const [phone, setPhone]             = useState(member.phone ?? '')
  const [pref, setPref]               = useState(member.preferred_contact)
  const [error, setError]             = useState<string | null>(null)
  const [saving, startSave]           = useTransition()
  const [deactivating, startDeact]    = useTransition()

  function handleSave() {
    setError(null)
    startSave(async () => {
      const result = await updateCrewMember(member.id, {
        name,
        email:             email || undefined,
        phone:             phone || undefined,
        specialty,
        preferred_contact: pref,
      })
      if (result.error) {
        setError(result.error)
      } else {
        setEditing(false)
      }
    })
  }

  function handleDeactivate() {
    startDeact(async () => {
      await deactivateCrewMember(member.id)
    })
  }

  if (editing) {
    return (
      <tr className="bg-accent-50/50">
        <td className="py-2 pr-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input py-1 text-sm"
          />
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
        </td>
        <td className="py-2 pr-4">
          <input
            value={specialty}
            onChange={(e) => setSpecialty(e.target.value)}
            className="input py-1 text-sm"
            placeholder="Specialty"
          />
        </td>
        <td className="py-2 pr-4">
          <div className="space-y-1">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input py-1 text-sm"
              placeholder="Email"
              type="email"
            />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="input py-1 text-sm"
              placeholder="Phone"
              type="tel"
            />
          </div>
        </td>
        <td className="py-2 pr-4">
          <select
            value={pref}
            onChange={(e) => setPref(e.target.value as typeof pref)}
            className="input py-1 text-sm"
          >
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="both">Both</option>
          </select>
        </td>
        <td className="py-2 text-right">
          <div className="flex items-center justify-end gap-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn-primary py-1 px-2 text-xs"
              title="Save"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="btn-ghost py-1 px-2 text-xs"
              title="Cancel"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr className="hover:bg-accent-50/50 transition-colors">
      <td className="py-2.5 pr-4 font-medium text-accent-900">{member.name}</td>
      <td className="py-2.5 pr-4 text-accent-600">{member.specialty || '—'}</td>
      <td className="py-2.5 pr-4 text-accent-600">
        <div className="space-y-0.5">
          {member.email && <div className="truncate max-w-[180px]">{member.email}</div>}
          {member.phone && <div>{member.phone}</div>}
          {!member.email && !member.phone && <span className="text-accent-400">—</span>}
        </div>
      </td>
      <td className="py-2.5 pr-4">
        <span className="badge badge-slate capitalize">{member.preferred_contact}</span>
      </td>
      <td className="py-2.5 text-right">
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => setEditing(true)}
            className="btn-ghost py-1 px-2 text-xs"
            title="Edit"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleDeactivate}
            disabled={deactivating}
            className="btn-danger py-1 px-2 text-xs"
            title="Deactivate"
          >
            {deactivating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
          </button>
        </div>
      </td>
    </tr>
  )
}

// ── Vendors tab ───────────────────────────────────────────────────────────────

function VendorsTab({ vendors }: { vendors: Vendor[] }) {
  const [showAddForm, setShowAddForm] = useState(false)

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-accent-900">Vendors</h2>
          <button
            onClick={() => setShowAddForm((v) => !v)}
            className="btn-secondary text-sm"
          >
            {showAddForm ? 'Cancel' : '+ Add Vendor'}
          </button>
        </div>

        {showAddForm && (
          <AddVendorForm onSuccess={() => setShowAddForm(false)} />
        )}

        {vendors.length === 0 && !showAddForm ? (
          <p className="text-sm text-accent-500 py-4 text-center">
            No active vendors yet. Add one to get started.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-accent-100">
                  <th className="text-left py-2 pr-4 font-medium text-accent-500 text-xs uppercase tracking-wide">Name</th>
                  <th className="text-left py-2 pr-4 font-medium text-accent-500 text-xs uppercase tracking-wide">Specialty</th>
                  <th className="text-left py-2 pr-4 font-medium text-accent-500 text-xs uppercase tracking-wide">Contact</th>
                  <th className="text-left py-2 pr-4 font-medium text-accent-500 text-xs uppercase tracking-wide">Portal</th>
                  <th className="py-2 text-right font-medium text-accent-500 text-xs uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-accent-50">
                {vendors.map((vendor) => (
                  <VendorRow key={vendor.id} vendor={vendor} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function AddVendorForm({ onSuccess }: { onSuccess: () => void }) {
  const [state, formAction, pending] = useActionState(addVendor, null)

  if (state?.success) {
    onSuccess()
    return null
  }

  return (
    <div className="mb-6 p-4 bg-accent-50 rounded-lg border border-accent-200">
      <h3 className="text-sm font-semibold text-accent-700 mb-3">New Vendor</h3>

      {state?.error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-3">
          {state.error}
        </div>
      )}

      <form action={formAction} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="vendor-name" className="label">Vendor Name <span className="text-red-500">*</span></label>
            <input id="vendor-name" name="name" type="text" required className="input" placeholder="ABC Plumbing" />
          </div>
          <div>
            <label htmlFor="vendor-contact" className="label">Contact Name</label>
            <input id="vendor-contact" name="contact_name" type="text" className="input" placeholder="John Smith" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="vendor-email" className="label">Email</label>
            <input id="vendor-email" name="email" type="email" className="input" placeholder="info@abcplumbing.com" />
          </div>
          <div>
            <label htmlFor="vendor-phone" className="label">Phone</label>
            <input id="vendor-phone" name="phone" type="tel" className="input" placeholder="+1 555-0100" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="vendor-specialty" className="label">Specialty</label>
            <select id="vendor-specialty" name="specialty" className="input">
              {VENDOR_SPECIALTIES.map((s) => (
                <option key={s} value={s}>{VENDOR_SPECIALTY_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-accent-700">
              <input
                type="checkbox"
                name="portal_enabled"
                className="w-4 h-4 rounded border-accent-300 text-brand-700 focus:ring-brand-500"
              />
              Enable vendor portal
            </label>
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={pending} className="btn-primary text-sm">
            {pending ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</>
            ) : 'Add Vendor'}
          </button>
        </div>
      </form>
    </div>
  )
}

function VendorRow({ vendor }: { vendor: Vendor }) {
  const [portalEnabled, setPortalEnabled] = useState(vendor.portal_enabled)
  const [togglingPortal, startToggle]     = useTransition()
  const [deactivating, startDeact]        = useTransition()

  function handleTogglePortal() {
    const next = !portalEnabled
    setPortalEnabled(next)
    startToggle(async () => {
      await updateVendorPortal(vendor.id, next)
    })
  }

  function handleDeactivate() {
    startDeact(async () => {
      await deactivateVendor(vendor.id)
    })
  }

  return (
    <tr className="hover:bg-accent-50/50 transition-colors">
      <td className="py-2.5 pr-4">
        <div className="font-medium text-accent-900">{vendor.name}</div>
        {vendor.contact_name && (
          <div className="text-xs text-accent-400">{vendor.contact_name}</div>
        )}
      </td>
      <td className="py-2.5 pr-4">
        <span className="badge badge-blue">{VENDOR_SPECIALTY_LABELS[vendor.specialty]}</span>
      </td>
      <td className="py-2.5 pr-4 text-accent-600">
        <div className="space-y-0.5">
          {vendor.email && <div className="truncate max-w-[180px]">{vendor.email}</div>}
          {vendor.phone && <div>{vendor.phone}</div>}
          {!vendor.email && !vendor.phone && <span className="text-accent-400">—</span>}
        </div>
      </td>
      <td className="py-2.5 pr-4">
        <button
          onClick={handleTogglePortal}
          disabled={togglingPortal}
          className={cn(
            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:opacity-50',
            portalEnabled ? 'bg-brand-700' : 'bg-accent-300'
          )}
          role="switch"
          aria-checked={portalEnabled}
          title={portalEnabled ? 'Disable vendor portal' : 'Enable vendor portal'}
        >
          <span
            className={cn(
              'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
              portalEnabled ? 'translate-x-4' : 'translate-x-0.5'
            )}
          />
        </button>
      </td>
      <td className="py-2.5 text-right">
        <button
          onClick={handleDeactivate}
          disabled={deactivating}
          className="btn-danger py-1 px-2 text-xs"
          title="Deactivate vendor"
        >
          {deactivating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
        </button>
      </td>
    </tr>
  )
}

// ── Billing tab ───────────────────────────────────────────────────────────────

const UPGRADE_PLANS = ['starter', 'growth', 'pro'] as const

function BillingTab({ org }: { org: Organization }) {
  const currentPlan  = PLAN_INFO[org.plan as keyof typeof PLAN_INFO] ?? PLAN_INFO.starter
  const statusBadge  = PLAN_STATUS_BADGES[org.plan_status] ?? 'badge-slate'
  const isTrialing   = org.plan_status === 'trialing'

  const [portalPending, startPortal]     = useTransition()
  const [checkoutPlan, setCheckoutPlan]  = useState<string | null>(null)
  const [checkoutPending, startCheckoutT] = useTransition()

  function handleBillingPortal() {
    startPortal(async () => {
      await openBillingPortal()
    })
  }

  function handleCheckout(plan: string) {
    setCheckoutPlan(plan)
    startCheckoutT(async () => {
      await startCheckout(plan)
      setCheckoutPlan(null)
    })
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Current plan summary */}
      <div className="card">
        <h2 className="text-base font-semibold text-accent-900 mb-4">Current Plan</h2>

        <div className="flex items-center gap-3 flex-wrap">
          <span className={cn('badge text-sm px-3 py-1', currentPlan.badge)}>
            {currentPlan.name}
          </span>
          <span className={cn('badge', statusBadge)}>
            {org.plan_status.replace('_', ' ')}
          </span>
          <span className="text-sm text-accent-600">{currentPlan.description}</span>
        </div>

        {isTrialing && org.trial_ends_at && (
          <p className="mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Trial ends on{' '}
            <strong>
              {new Date(org.trial_ends_at).toLocaleDateString('en-US', {
                month: 'long', day: 'numeric', year: 'numeric',
              })}
            </strong>
          </p>
        )}

        {org.stripe_customer_id && (
          <div className="mt-4 pt-4 border-t border-accent-100">
            <button
              onClick={handleBillingPortal}
              disabled={portalPending}
              className="btn-secondary"
            >
              {portalPending ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Opening portal…</>
              ) : 'Manage Billing'}
            </button>
          </div>
        )}
      </div>

      {/* Plan comparison */}
      <div>
        <h3 className="section-header">Available Plans</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {UPGRADE_PLANS.map((planKey) => {
            const plan      = PLAN_INFO[planKey]
            const isCurrent = org.plan === planKey
            const isPending = checkoutPlan === planKey

            return (
              <div
                key={planKey}
                className={cn(
                  'card flex flex-col gap-3',
                  isCurrent && 'ring-2 ring-brand-700 ring-offset-2'
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-accent-900">{plan.name}</span>
                  {isCurrent && (
                    <span className="badge badge-green text-xs">Current</span>
                  )}
                </div>
                <p className="text-sm text-accent-500">{plan.description}</p>
                <p className="text-xs text-accent-400">
                  Up to {plan.maxProperties} properties
                </p>
                {!isCurrent && (
                  <button
                    onClick={() => handleCheckout(planKey)}
                    disabled={checkoutPending}
                    className="btn-primary text-sm mt-auto"
                  >
                    {isPending && checkoutPending ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Redirecting…</>
                    ) : `Upgrade to ${plan.name}`}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
