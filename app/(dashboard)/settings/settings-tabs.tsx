'use client'

import { useState, useEffect, useTransition, useActionState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2, Eye, EyeOff, Lock, Bell, BellOff, Webhook } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Organization } from '@/types/database'
import {
  updateOrgSettings,
  changePassword,
  updateNotificationPrefs,
  openBillingPortal,
  createCheckoutSession,
  updateAutoAssignMode,
  updateCommsRetention,
  updateSlackWebhook,
  type SettingsActionState,
} from './actions'

// ── Constants ────────────────────────────────────────────────────────────────

const TABS = ['Organization', 'Billing', 'Security', 'Notifications', 'Team', 'Audit Log', 'Account', 'Legal'] as const
type Tab = typeof TABS[number]

const PLAN_INFO = {
  starter:    { name: 'Starter',   maxProperties: 15,  description: 'Up to 15 properties',   badge: 'badge-blue'  },
  growth:     { name: 'Growth',    maxProperties: 50,  description: '16–50 properties',      badge: 'badge-green' },
  portfolio:  { name: 'Portfolio', maxProperties: 100, description: '51–100 properties',     badge: 'badge-gold'  },
  enterprise: { name: 'Enterprise',maxProperties: 999, description: '100+ properties',       badge: 'badge-amber' },
  // Legacy alias — orgs created before the 'pro' tier was renamed to 'starter'
  pro:        { name: 'Starter',   maxProperties: 15,  description: 'Up to 15 properties',   badge: 'badge-blue'  },
} as const

const PLAN_STATUS_BADGES: Record<string, string> = {
  trialing:  'badge-amber',
  active:    'badge-green',
  past_due:  'badge-red',
  cancelled: 'badge-red',
  paused:    'badge-slate',
}

// ── Root component ───────────────────────────────────────────────────────────

export interface ConnectionInfo {
  provider_id:      string
  status:           string
  external_user_id: string | null
  connected_at:     string
  metadata:         Record<string, unknown>
}

interface Props {
  org:               Organization
  connections?:      Record<string, ConnectionInfo>
  krogerNeedsStore?: boolean
}

export function SettingsTabs({ org, connections = {}, krogerNeedsStore = false }: Props) {
  const searchParams = useSearchParams()
  const requestedTab = searchParams.get('tab') as Tab | null
  const initialTab   = requestedTab && (TABS as readonly string[]).includes(requestedTab)
    ? requestedTab
    : 'Organization'
  const [activeTab, setActiveTab] = useState<Tab>(initialTab)

  return (
    <div>
      {/* Tab bar */}
      <div className="flex flex-wrap gap-x-0 gap-y-0 border-b border-themed mb-6 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'px-3 py-2.5 text-xs sm:text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap flex-shrink-0'
            )}
            style={
              activeTab === tab
                ? { borderColor: 'var(--accent-gold)', color: 'var(--text-primary)' }
                : { borderColor: 'transparent', color: 'var(--text-muted)' }
            }
            onMouseOver={(e) => {
              if (activeTab !== tab) e.currentTarget.style.color = 'var(--text-secondary)'
            }}
            onMouseOut={(e) => {
              if (activeTab !== tab) e.currentTarget.style.color = 'var(--text-muted)'
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      {activeTab === 'Organization'  && <OrgTab org={org} connections={connections} krogerNeedsStore={krogerNeedsStore} />}
      {activeTab === 'Billing'       && <BillingTab org={org} />}
      {activeTab === 'Security'      && <SecurityTab />}
      {activeTab === 'Notifications' && <NotificationsTab org={org} />}
      {activeTab === 'Team'          && <TeamTabRedirect />}
      {activeTab === 'Audit Log'     && <AuditLogTabRedirect />}
      {activeTab === 'Account'       && <AccountTabRedirect />}
      {activeTab === 'Legal'         && <LegalTab />}
    </div>
  )
}

// ── Organization tab ─────────────────────────────────────────────────────────

function OrgTab({ org, connections, krogerNeedsStore }: { org: Organization; connections: Record<string, ConnectionInfo>; krogerNeedsStore?: boolean }) {
  const [state, formAction, pending] = useActionState(updateOrgSettings, null)

  const plan        = PLAN_INFO[org.plan as keyof typeof PLAN_INFO] ?? PLAN_INFO.starter
  const statusBadge = PLAN_STATUS_BADGES[org.plan_status] ?? 'badge-slate'

  return (
    <div className="max-w-xl space-y-6">
      <div className="card">
        <h2 className="text-base font-semibold text-primary-themed mb-4">Organization Settings</h2>

        {/* Plan info */}
        <div className="flex items-center gap-2 mb-6 p-3 bg-canvas-themed rounded-lg border border-themed">
          <span className={cn('badge', plan.badge)}>{plan.name}</span>
          <span className={cn('badge', statusBadge)}>
            {org.plan_status.replace('_', ' ')}
          </span>
          <span className="text-xs text-muted-themed ml-auto">{plan.description}</span>
        </div>

        {state?.success && (
          <div className="bg-green-950 border border-green-800 text-green-400 text-sm rounded-lg px-4 py-3 mb-4">
            Settings saved successfully.
          </div>
        )}
        {state?.error && (
          <div className="bg-red-950 border border-red-800 text-red-400 text-sm rounded-lg px-4 py-3 mb-4">
            {state.error}
          </div>
        )}

        <form action={formAction} className="space-y-4">
          <div>
            <label htmlFor="org-name" className="label">
              Organization Name <span className="text-red-400">*</span>
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

          <div className="pt-2 border-t border-themed">
            <button type="submit" disabled={pending} className="btn-primary">
              {pending ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
              ) : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>

      {/* Connected Accounts — managed centrally on the Integrations page */}
      <div className="card">
        <h2 className="text-base font-semibold text-primary-themed mb-1">
          Connected Accounts
        </h2>
        <p className="text-xs text-muted-themed mb-3">
          Connect OwnerRez, Hostaway, and other platforms to sync
          bookings and properties automatically.
        </p>
        <a href="/settings/integrations" className="btn-secondary text-sm inline-flex items-center gap-1.5">
          Manage Integrations →
        </a>
      </div>

      {/* Kroger — Grocery Cart Automation */}
      <div className="card">
        <h2 className="text-base font-semibold text-primary-themed mb-1">Grocery Cart Automation</h2>
        <p className="text-xs text-muted-themed mb-1">
          Connect your Kroger account to build shopping carts automatically from below-par inventory.
        </p>
        <p className="text-xs text-muted-themed mb-4" style={{ fontStyle: 'italic' }}>
          Works across the entire Kroger family of stores — Ralphs, Fred Meyer, King Soopers, Smith&apos;s, Fry&apos;s, QFC,
          City Market, Dillons, Mariano&apos;s, Pick &apos;n Save, Metro Market, Harris Teeter, Gerbes, and Baker&apos;s.
        </p>
        {connections.kroger ? (
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
                <span style={{ color: 'var(--accent-green)' }}>●</span>
                Connected
                {typeof connections.kroger.metadata?.location_name === 'string' && (
                  <> — {connections.kroger.metadata.location_name as string}</>
                )}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Below-par items are added to your Kroger Family cart automatically when you click Build Cart.
              </p>
              {krogerNeedsStore && (
                <p className="text-xs mt-1.5 font-medium" style={{ color: 'var(--accent-amber)' }}>
                  ⚠️ We couldn&apos;t find a Kroger store near your properties. Add a
                  property with a ZIP code, then click Reconnect below.
                </p>
              )}
            </div>
            <a href="/api/integrations/kroger/connect" className="btn-secondary text-sm flex-shrink-0">Reconnect</a>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Not connected</p>
            <a href="/api/integrations/kroger/connect" className="btn-primary text-sm flex-shrink-0">Connect Kroger Account</a>
          </div>
        )}
      </div>

      {/* Crew Auto-Assignment */}
      <div className="card">
        <h2 className="text-base font-semibold text-primary-themed mb-1">Crew Auto-Assignment</h2>
        <p className="text-xs text-muted-themed mb-4">
          Score crew members for new turnovers based on proximity, availability, familiarity, and reliability.
        </p>
        <AutoAssignToggle mode={org.auto_assign_mode ?? 'disabled'} />
      </div>

      {/* Communications Log */}
      <div className="card">
        <h2 className="text-base font-semibold text-primary-themed mb-1">Communications Log</h2>
        <p className="text-xs text-muted-themed mb-4">
          How long PM ↔ vendor/crew messages are kept before being removed.
          Records are soft-deleted at the end of the retention period and
          permanently purged 30 days later.
        </p>
        <CommsRetentionSelector days={org.comms_log_retention_days ?? 365} />
      </div>
    </div>
  )
}

// ── Comms log retention selector ─────────────────────────────────────────────

const COMMS_RETENTION_OPTIONS = [
  { value: 90,  label: '90 days' },
  { value: 180, label: '6 months (180 days)' },
  { value: 365, label: '12 months (365 days) — default' },
  { value: 730, label: '24 months (730 days)' },
]

function CommsRetentionSelector({ days }: { days: number }) {
  const [current,   setCurrent]   = useState(days)
  const [saving,    startSave]    = useTransition()
  const [saveError, setSaveError] = useState<string | null>(null)

  const handleChange = (value: number) => {
    setCurrent(value)
    setSaveError(null)
    startSave(async () => {
      const result = await updateCommsRetention(value)
      if (result.error) setSaveError(result.error)
    })
  }

  return (
    <div>
      {saveError && (
        <div className="bg-red-950 border border-red-800 text-red-400 text-sm rounded-lg px-3 py-2 mb-3">
          {saveError}
        </div>
      )}

      <select
        value={current}
        onChange={(e) => handleChange(Number(e.target.value))}
        disabled={saving}
        className="input text-sm w-auto"
      >
        {COMMS_RETENTION_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  )
}

// ── Auto-Assignment mode toggle ───────────────────────────────────────────────

const AUTO_ASSIGN_OPTIONS = [
  {
    value:  'disabled' as const,
    label:  'Off',
    desc:   'No automatic suggestions or assignments.',
  },
  {
    value:  'suggest' as const,
    label:  'Suggest',
    desc:   'Shows the best-matched crew on each new turnover — you accept or change.',
  },
  {
    value:  'autopilot' as const,
    label:  'Autopilot',
    desc:   'Best-matched crew is assigned automatically.',
  },
]

function AutoAssignToggle({ mode }: { mode: string }) {
  const [current,  setCurrent]  = useState(mode)
  const [saving,   startSave]   = useTransition()
  const [saveError, setSaveError] = useState<string | null>(null)

  const handleChange = (value: 'disabled' | 'suggest' | 'autopilot') => {
    setCurrent(value)
    setSaveError(null)
    startSave(async () => {
      const result = await updateAutoAssignMode(value)
      if (result.error) setSaveError(result.error)
    })
  }

  return (
    <div>
      {saveError && (
        <div className="bg-red-950 border border-red-800 text-red-400 text-sm rounded-lg px-3 py-2 mb-3">
          {saveError}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {AUTO_ASSIGN_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => handleChange(opt.value)}
            disabled={saving}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
              current === opt.value
                ? ''
                : 'border-themed hover:border-themed',
              saving && 'opacity-60 cursor-not-allowed'
            )}
            style={
              current === opt.value
                ? { background: 'var(--bg-raised)', color: 'var(--text-primary)', borderColor: 'var(--accent-gold)' }
                : { color: 'var(--text-muted)' }
            }
          >
            {opt.label}
          </button>
        ))}
      </div>

      <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
        {AUTO_ASSIGN_OPTIONS.find((o) => o.value === current)?.desc}
      </p>
    </div>
  )
}

// ── Security tab ─────────────────────────────────────────────────────────────

function SecurityTab() {
  const [state, formAction, pending] = useActionState(changePassword, null)
  const [showNew,     setShowNew]     = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  return (
    <div className="max-w-xl space-y-6">
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--accent-gold-dim)' }}
          >
            <Lock className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
          </div>
          <div>
            <h2 className="text-base font-semibold text-primary-themed">Change Password</h2>
            <p className="text-xs text-muted-themed">Must be at least 8 characters</p>
          </div>
        </div>

        {state?.success && (
          <div className="bg-green-950 border border-green-800 text-green-400 text-sm rounded-lg px-4 py-3 mb-4">
            Password updated successfully.
          </div>
        )}
        {state?.error && (
          <div className="bg-red-950 border border-red-800 text-red-400 text-sm rounded-lg px-4 py-3 mb-4">
            {state.error}
          </div>
        )}

        <form action={formAction} className="space-y-4">
          <div>
            <label htmlFor="new-password" className="label">New Password</label>
            <div className="relative">
              <input
                id="new-password"
                name="new_password"
                type={showNew ? 'text' : 'password'}
                required
                minLength={8}
                className="input pr-10"
                placeholder="Min. 8 characters"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowNew((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--text-muted)' }}
              >
                {showNew
                  ? <EyeOff className="w-4 h-4" />
                  : <Eye    className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="confirm-password" className="label">Confirm New Password</label>
            <div className="relative">
              <input
                id="confirm-password"
                name="confirm_password"
                type={showConfirm ? 'text' : 'password'}
                required
                minLength={8}
                className="input pr-10"
                placeholder="Re-enter your new password"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--text-muted)' }}
              >
                {showConfirm
                  ? <EyeOff className="w-4 h-4" />
                  : <Eye    className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="pt-2 border-t border-themed">
            <button type="submit" disabled={pending} className="btn-primary">
              {pending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Updating…</>
                : 'Update Password'
              }
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Notifications tab ─────────────────────────────────────────────────────────

const PUSH_PREFS = [
  { key: 'push_turnovers',   label: 'Turnover assignments',      desc: 'When a turnover is scheduled or updated' },
  { key: 'push_maintenance', label: 'Maintenance alerts',        desc: 'New work orders and status changes'      },
  { key: 'push_inventory',   label: 'Inventory low-stock alerts',desc: 'When items fall below reorder threshold' },
  { key: 'push_work_orders', label: 'Work order updates',        desc: 'When vendors update or complete work'    },
] as const

const EMAIL_PREFS = [
  { key: 'email_daily_digest',  label: 'Daily ops digest',    desc: 'Summary of today\'s activity each morning'  },
  { key: 'email_weekly_report', label: 'Weekly report',       desc: 'Full ops report every Monday morning'       },
] as const

function NotificationsTab({ org }: { org: Organization }) {
  const [state, formAction, pending] = useActionState(updateNotificationPrefs, null)
  const [slackState, slackAction, slackPending] = useActionState(updateSlackWebhook, null)

  return (
    <div className="max-w-xl space-y-6">

      {/* Push Notifications */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--accent-blue-dim)' }}
          >
            <Bell className="w-4 h-4" style={{ color: 'var(--accent-blue)' }} />
          </div>
          <div>
            <h2 className="text-base font-semibold text-primary-themed">Push Notifications</h2>
            <p className="text-xs text-muted-themed">Receive alerts on this device</p>
          </div>
        </div>

        {state?.success && (
          <div className="bg-green-950 border border-green-800 text-green-400 text-sm rounded-lg px-4 py-3 mb-4">
            Preferences saved.
          </div>
        )}
        {state?.error && (
          <div className="bg-red-950 border border-red-800 text-red-400 text-sm rounded-lg px-4 py-3 mb-4">
            {state.error}
          </div>
        )}

        <form action={formAction} className="space-y-1">
          {PUSH_PREFS.map((pref) => (
            <label
              key={pref.key}
              className="flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors"
              style={{ background: 'transparent' }}
              onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-raised)')}
              onMouseOut={(e)  => (e.currentTarget.style.background = 'transparent')}
            >
              <input
                type="checkbox"
                name={pref.key}
                defaultChecked
                className="mt-0.5 w-4 h-4 rounded"
                style={{ accentColor: 'var(--accent-gold)' }}
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-primary-themed">{pref.label}</p>
                <p className="text-xs text-muted-themed">{pref.desc}</p>
              </div>
            </label>
          ))}

          {/* Email preferences */}
          <div className="pt-4 mt-2 border-t border-themed">
            <div className="flex items-center gap-2 mb-3">
              <BellOff className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
              <span className="text-xs font-semibold text-muted-themed uppercase tracking-wide">
                Email Digests
              </span>
            </div>
            {EMAIL_PREFS.map((pref) => (
              <label
                key={pref.key}
                className="flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors"
                style={{ background: 'transparent' }}
                onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-raised)')}
                onMouseOut={(e)  => (e.currentTarget.style.background = 'transparent')}
              >
                <input
                  type="checkbox"
                  name={pref.key}
                  defaultChecked
                  className="mt-0.5 w-4 h-4 rounded"
                  style={{ accentColor: 'var(--accent-gold)' }}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-primary-themed">{pref.label}</p>
                  <p className="text-xs text-muted-themed">{pref.desc}</p>
                </div>
              </label>
            ))}
          </div>

          <div className="pt-4 border-t border-themed">
            <button type="submit" disabled={pending} className="btn-primary">
              {pending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                : 'Save Preferences'
              }
            </button>
          </div>
        </form>
      </div>

      {/* Slack Notifications */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--accent-blue-dim)' }}
          >
            <Webhook className="w-4 h-4" style={{ color: 'var(--accent-blue)' }} />
          </div>
          <div>
            <h2 className="text-base font-semibold text-primary-themed">Slack Notifications</h2>
            <p className="text-xs text-muted-themed">Get pinged in Slack when crew message you</p>
          </div>
        </div>

        {slackState?.success && (
          <div className="bg-green-950 border border-green-800 text-green-400 text-sm rounded-lg px-4 py-3 mb-4">
            Webhook saved.
          </div>
        )}
        {slackState?.error && (
          <div className="bg-red-950 border border-red-800 text-red-400 text-sm rounded-lg px-4 py-3 mb-4">
            {slackState.error}
          </div>
        )}

        <form action={slackAction} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-themed mb-1.5">
              Slack Incoming Webhook URL
            </label>
            <input
              type="url"
              name="slack_webhook_url"
              defaultValue={org.slack_webhook_url ?? ''}
              placeholder="https://hooks.slack.com/services/..."
              className="input w-full"
            />
            <p className="text-xs text-muted-themed mt-1.5">
              When a crew member sends you a message, it will also be posted to this Slack channel.
              Leave blank to disable. Create one at{' '}
              <span className="font-mono">api.slack.com/apps</span> → Incoming Webhooks.
            </p>
          </div>

          <button type="submit" disabled={slackPending} className="btn-primary">
            {slackPending
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
              : 'Save Webhook'
            }
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Team tab redirect ─────────────────────────────────────────────────────────

function TeamTabRedirect() {
  const router = useRouter()
  useEffect(() => { router.push('/settings/team') }, [router])
  return null
}

// ── Audit Log tab redirect ────────────────────────────────────────────────────

function AuditLogTabRedirect() {
  const router = useRouter()
  useEffect(() => { router.push('/settings/audit') }, [router])
  return null
}

// ── Account tab redirect ──────────────────────────────────────────────────────

function AccountTabRedirect() {
  const router = useRouter()
  useEffect(() => { router.push('/settings/account') }, [router])
  return null
}

// ── Legal tab ─────────────────────────────────────────────────────────────────

function LegalTab() {
  const docs = [
    {
      title:       'Privacy Policy',
      description: 'How FieldStay collects, uses, and protects your data.',
      href:        '/privacy',
      updated:     'Effective June 9, 2026',
    },
    {
      title:       'Terms of Service',
      description: 'The agreement governing your use of FieldStay.',
      href:        '/terms',
      updated:     'Effective June 9, 2026',
    },
    {
      title:       'Data Processing Agreement',
      description: 'GDPR-compliant DPA for business customers processing personal data through FieldStay.',
      href:        '/dpa',
      updated:     'Effective June 9, 2026',
    },
  ]

  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        FieldStay&apos;s legal documents governing your account and data.
      </p>
      {docs.map((doc) => (
        <div key={doc.href} className="card flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
              {doc.title}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {doc.description}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
              {doc.updated}
            </p>
          </div>
          <a
            href={doc.href}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary text-sm flex-shrink-0"
          >
            View →
          </a>
        </div>
      ))}

      <div className="card mt-4">
        <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
          Questions about your data?
        </p>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Contact us at{' '}
          <a
            href="mailto:privacy@fieldstay.app"
            className="underline underline-offset-2 hover:opacity-80"
          >
            privacy@fieldstay.app
          </a>
        </p>
      </div>
    </div>
  )
}

// ── Billing tab ───────────────────────────────────────────────────────────────

const DISPLAY_PLANS = [
  {
    key:     'starter' as const,
    name:    'Starter',
    props:   'Up to 15 properties',
    monthly: 199,
    annual:  1990,
    savings: '$398',
  },
  {
    key:     'growth' as const,
    name:    'Growth',
    props:   '16–50 properties',
    monthly: 379,
    annual:  3790,
    savings: '$758',
  },
  {
    key:     'portfolio' as const,
    name:    'Portfolio',
    props:   '51–100 properties',
    monthly: 599,
    annual:  5990,
    savings: '$1,198',
  },
]

function BillingTab({ org }: { org: Organization }) {
  const currentPlan = PLAN_INFO[org.plan as keyof typeof PLAN_INFO] ?? PLAN_INFO.starter
  const statusBadge = PLAN_STATUS_BADGES[org.plan_status] ?? 'badge-slate'
  const isTrialing  = org.plan_status === 'trialing'

  const [interval, setInterval]           = useState<'monthly' | 'annual'>('monthly')
  const [checkoutPlan, setCheckoutPlan]   = useState<string | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [checkoutPending, startCheckoutT] = useTransition()
  const [portalPending, startPortal]      = useTransition()

  function handleBillingPortal() {
    startPortal(async () => { await openBillingPortal() })
  }

  function handleCheckout(planKey: 'starter' | 'growth' | 'portfolio') {
    setCheckoutPlan(planKey)
    setCheckoutError(null)
    startCheckoutT(async () => {
      const result = await createCheckoutSession(planKey, interval)
      if (result?.redirectUrl) {
        window.location.href = result.redirectUrl
      } else if (result?.error) {
        setCheckoutError(result.error)
        setCheckoutPlan(null)
      }
    })
  }

  return (
    <div className="max-w-2xl space-y-6">

      {/* Current plan summary */}
      <div className="card">
        <h2 className="text-base font-semibold text-primary-themed mb-4">Current Plan</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <span className={cn('badge text-sm px-3 py-1', currentPlan.badge)}>
            {currentPlan.name}
          </span>
          <span className={cn('badge', statusBadge)}>
            {org.plan_status.replace('_', ' ')}
          </span>
          <span className="text-sm text-secondary-themed">{currentPlan.description}</span>
        </div>

        {isTrialing && org.trial_ends_at && (
          <p className="mt-3 text-sm rounded-lg px-3 py-2"
             style={{ color: 'var(--accent-amber)', background: 'var(--accent-amber-dim)', border: '1px solid rgba(245,158,11,0.25)' }}>
            Trial ends on{' '}
            <strong>
              {new Date(org.trial_ends_at).toLocaleDateString('en-US', {
                month: 'long', day: 'numeric', year: 'numeric',
              })}
            </strong>
          </p>
        )}

        {org.stripe_customer_id && (
          <div className="mt-4 pt-4 border-t border-themed">
            <button
              onClick={handleBillingPortal}
              disabled={portalPending}
              className="btn-secondary"
            >
              {portalPending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Opening portal…</>
                : 'Manage Billing'
              }
            </button>
          </div>
        )}
      </div>

      {/* Plan upgrade cards */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="section-header mb-0">Available Plans</h3>
          {/* Monthly / Annual toggle */}
          <div className="flex items-center gap-1 bg-raised-themed rounded-lg p-1 text-sm">
            {(['monthly', 'annual'] as const).map((iv) => (
              <button
                key={iv}
                onClick={() => setInterval(iv)}
                className="px-3 py-1 rounded-md font-medium transition-colors"
                style={
                  interval === iv
                    ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
                    : { color: 'var(--text-muted)' }
                }
              >
                {iv === 'monthly' ? 'Monthly' : (
                  <>Annual <span className="ml-1.5 text-xs" style={{ color: 'var(--accent-green)' }}>2 months free</span></>
                )}
              </button>
            ))}
          </div>
        </div>

        {checkoutError && (
          <div className="mb-4 text-sm rounded-lg px-3 py-2"
               style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)', border: '1px solid rgba(240,84,84,0.2)' }}>
            {checkoutError}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {DISPLAY_PLANS.map((plan) => {
            const isCurrent = org.plan === plan.key && org.plan_status === 'active'
            const isPending = checkoutPlan === plan.key && checkoutPending

            return (
              <div
                key={plan.key}
                className="card flex flex-col gap-3"
                style={isCurrent ? { outline: '2px solid var(--accent-gold)', outlineOffset: '2px' } : undefined}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-primary-themed">{plan.name}</span>
                  {isCurrent && <span className="badge badge-green text-xs">Current</span>}
                </div>
                <p className="text-sm text-muted-themed">{plan.props}</p>
                <div>
                  {interval === 'monthly' ? (
                    <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                      <span style={{ color: 'var(--accent-gold)' }}>${plan.monthly}</span>
                      <span className="text-sm font-normal text-muted-themed">/mo</span>
                    </p>
                  ) : (
                    <>
                      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        <span style={{ color: 'var(--accent-gold)' }}>${plan.annual}</span>
                        <span className="text-sm font-normal text-muted-themed">/yr</span>
                      </p>
                      <p className="text-xs" style={{ color: 'var(--accent-green)' }}>
                        Save {plan.savings} vs monthly
                      </p>
                    </>
                  )}
                </div>
                {!isCurrent && (
                  <button
                    onClick={() => handleCheckout(plan.key)}
                    disabled={checkoutPending}
                    className="btn-primary text-sm mt-auto"
                  >
                    {isPending
                      ? <><Loader2 className="w-4 h-4 animate-spin" /> Redirecting…</>
                      : `Upgrade to ${plan.name}`
                    }
                  </button>
                )}
              </div>
            )
          })}

          {/* Enterprise */}
          <div className="card flex flex-col gap-3 sm:col-span-3">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <span className="font-semibold text-primary-themed">Enterprise</span>
                <p className="text-sm text-muted-themed mt-0.5">100+ properties — custom pricing</p>
              </div>
              <a href="mailto:hello@fieldstay.app" className="btn-secondary text-sm">
                Contact Us →
              </a>
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}
