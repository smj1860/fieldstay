'use client'

import { useState, useEffect, useTransition, useActionState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2, Eye, EyeOff, Lock, Bell, BellOff, Webhook, AlertTriangle, MessageSquare, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/ui/StatusDot'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
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
import { SMS_TEMPLATE_REGISTRY, renderTemplate, type SmsTemplateKey } from '@/lib/sms/template-registry'
import { getOrgSmsTemplates, saveOrgSmsTemplate, resetOrgSmsTemplate } from './actions'

// ── Constants ────────────────────────────────────────────────────────────────

const TABS = ['Organization', 'Billing', 'Security', 'Notifications', 'Team', 'Audit Log', 'Account', 'Legal'] as const
type Tab = typeof TABS[number]

const PLAN_INFO = {
  starter:    { name: 'Starter',   maxProperties: 15,  description: 'Up to 15 properties',   badge: 'blue'  },
  growth:     { name: 'Growth',    maxProperties: 50,  description: '16–50 properties',      badge: 'green' },
  portfolio:  { name: 'Portfolio', maxProperties: 100, description: '51–100 properties',     badge: 'gold'  },
  enterprise: { name: 'Enterprise',maxProperties: 999, description: '100+ properties',       badge: 'amber' },
  // Legacy alias — orgs created before the 'pro' tier was renamed to 'starter'
  pro:        { name: 'Starter',   maxProperties: 15,  description: 'Up to 15 properties',   badge: 'blue'  },
} as const

const PLAN_STATUS_BADGES: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'gold' | 'slate'> = {
  trialing:  'amber',
  active:    'green',
  past_due:  'red',
  cancelled: 'red',
  paused:    'slate',
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
            onFocus={(e) => {
              if (activeTab !== tab) e.currentTarget.style.color = 'var(--text-secondary)'
            }}
            onMouseOut={(e) => {
              if (activeTab !== tab) e.currentTarget.style.color = 'var(--text-muted)'
            }}
            onBlur={(e) => {
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
  const statusBadge = PLAN_STATUS_BADGES[org.plan_status] ?? 'slate'

  return (
    <div className="max-w-xl space-y-6">
      <Card>
        <h2 className="text-base font-semibold text-primary-themed mb-4">Organization Settings</h2>

        {/* Plan info */}
        <div className="flex items-center gap-2 mb-6 p-3 bg-canvas-themed rounded-lg border border-themed">
          <Badge tone={plan.badge}>{plan.name}</Badge>
          <Badge tone={statusBadge}>
            {org.plan_status.replace('_', ' ')}
          </Badge>
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
            <Input
              id="org-name"
              name="name"
              type="text"
              required
              defaultValue={org.name}
              placeholder="My Property Management Co."
            />
          </div>

          <div>
            <label htmlFor="billing-email" className="label">Billing Email</label>
            <Input
              id="billing-email"
              name="billing_email"
              type="email"
              defaultValue={org.billing_email ?? ''}
              placeholder="billing@company.com"
            />
          </div>

          <div className="pt-2 border-t border-themed">
            <Button type="submit" disabled={pending}>
              {pending ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
              ) : 'Save Changes'}
            </Button>
          </div>
        </form>
      </Card>

      {/* Connected Accounts — managed centrally on the Integrations page */}
      <Card>
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
      </Card>

      {/* Kroger — Grocery Cart Automation */}
      <Card>
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
                <StatusDot status="good" label="Connected" />
                Connected
                {typeof connections.kroger.metadata?.location_name === 'string' && (
                  <> — {connections.kroger.metadata.location_name as string}</>
                )}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Below-par items are added to your Kroger Family cart automatically when you click Build Cart.
              </p>
              {krogerNeedsStore && (
                <p className="text-xs mt-1.5 font-medium flex items-start gap-1" style={{ color: 'var(--accent-amber)' }}>
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  We couldn&apos;t find a Kroger store near your properties. Add a
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
      </Card>

      {/* Crew Auto-Assignment */}
      <Card>
        <h2 className="text-base font-semibold text-primary-themed mb-1">Crew Auto-Assignment</h2>
        <p className="text-xs text-muted-themed mb-4">
          Score crew members for new turnovers based on proximity, availability, familiarity, and reliability.
        </p>
        <AutoAssignToggle mode={org.auto_assign_mode ?? 'disabled'} />
      </Card>

      {/* Communications Log */}
      <Card>
        <h2 className="text-base font-semibold text-primary-themed mb-1">Communications Log</h2>
        <p className="text-xs text-muted-themed mb-4">
          How long PM ↔ vendor/crew messages are kept before being removed.
          Records are soft-deleted at the end of the retention period and
          permanently purged 30 days later.
        </p>
        <CommsRetentionSelector days={org.comms_log_retention_days ?? 365} />
      </Card>
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
      <Card>
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
              <Input
                id="new-password"
                name="new_password"
                type={showNew ? 'text' : 'password'}
                required
                minLength={8}
                className="pr-10"
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
              <Input
                id="confirm-password"
                name="confirm_password"
                type={showConfirm ? 'text' : 'password'}
                required
                minLength={8}
                className="pr-10"
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
            <Button type="submit" disabled={pending}>
              {pending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Updating…</>
                : 'Update Password'
              }
            </Button>
          </div>
        </form>
      </Card>
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
      <Card>
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
              onFocus={(e)     => (e.currentTarget.style.background = 'var(--bg-raised)')}
              onMouseOut={(e)  => (e.currentTarget.style.background = 'transparent')}
              onBlur={(e)      => (e.currentTarget.style.background = 'transparent')}
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
                onFocus={(e)     => (e.currentTarget.style.background = 'var(--bg-raised)')}
                onMouseOut={(e)  => (e.currentTarget.style.background = 'transparent')}
                onBlur={(e)      => (e.currentTarget.style.background = 'transparent')}
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
            <Button type="submit" disabled={pending}>
              {pending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                : 'Save Preferences'
              }
            </Button>
          </div>
        </form>
      </Card>

      {/* Slack Notifications */}
      <Card>
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
            <label htmlFor="slack-webhook-url" className="block text-xs font-medium text-muted-themed mb-1.5">
              Slack Incoming Webhook URL
            </label>
            <Input
              id="slack-webhook-url"
              type="url"
              name="slack_webhook_url"
              defaultValue={org.slack_webhook_url ?? ''}
              placeholder="https://hooks.slack.com/services/..."
              className="w-full"
            />
            <p className="text-xs text-muted-themed mt-1.5">
              When a crew member sends you a message, it will also be posted to this Slack channel.
              Leave blank to disable. Create one at{' '}
              <span className="font-mono">api.slack.com/apps</span> → Incoming Webhooks.
            </p>
          </div>

          <Button type="submit" disabled={slackPending}>
            {slackPending
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
              : 'Save Webhook'
            }
          </Button>
        </form>
      </Card>

      {/* SMS Message Templates */}
      <SmsTemplatesCard />
    </div>
  )
}

// ── SMS Templates Card ────────────────────────────────────────────────────────

const AUDIENCE_BADGE: Record<'guest' | 'crew' | 'vendor', 'blue' | 'green' | 'amber'> = {
  guest:  'blue',
  crew:   'green',
  vendor: 'amber',
}

function SmsTemplatesCard() {
  const [customTemplates, setCustomTemplates] = useState<Record<string, string>>({})
  const [edits, setEdits]                     = useState<Record<string, string>>({})
  const [expandedKey, setExpandedKey]         = useState<string | null>(null)
  const [saving,   startSave]                 = useTransition()
  const [resetting, startReset]               = useTransition()
  const [saveKey,  setSaveKey]                = useState<string | null>(null)
  const [statusMsg, setStatusMsg]             = useState<Record<string, string>>({})
  const [loaded, setLoaded]                   = useState(false)

  // Load existing custom templates once on mount
  useEffect(() => {
    getOrgSmsTemplates().then((rows) => {
      const map: Record<string, string> = {}
      rows.forEach((r) => { map[r.key] = r.body })
      setCustomTemplates(map)
      setLoaded(true)
    })
  }, [])

  const getBodyForKey = (key: string) =>
    edits[key] !== undefined
      ? edits[key]
      : (customTemplates[key] ?? SMS_TEMPLATE_REGISTRY.find(t => t.key === key)?.defaultBody ?? '')

  const isCustomized = (key: string) => key in customTemplates

  const hasUnsavedEdit = (key: string) =>
    edits[key] !== undefined && edits[key] !== (customTemplates[key] ?? SMS_TEMPLATE_REGISTRY.find(t => t.key === key)?.defaultBody ?? '')

  const setStatus = (key: string, msg: string) => {
    setStatusMsg(prev => ({ ...prev, [key]: msg }))
    setTimeout(() => setStatusMsg(prev => ({ ...prev, [key]: '' })), 3000)
  }

  const handleSave = (key: SmsTemplateKey) => {
    const body = getBodyForKey(key)
    setSaveKey(key)
    startSave(async () => {
      const result = await saveOrgSmsTemplate(key, body)
      setSaveKey(null)
      if (result.error) {
        setStatus(key, result.error)
      } else {
        setCustomTemplates(prev => ({ ...prev, [key]: body }))
        setEdits(prev => { const n = { ...prev }; delete n[key]; return n })
        setStatus(key, '✓ Saved')
      }
    })
  }

  const handleReset = (key: SmsTemplateKey) => {
    startReset(async () => {
      const result = await resetOrgSmsTemplate(key)
      if (result.error) {
        setStatus(key, result.error)
      } else {
        setCustomTemplates(prev => { const n = { ...prev }; delete n[key]; return n })
        setEdits(prev => { const n = { ...prev }; delete n[key]; return n })
        setStatus(key, '✓ Reset to default')
      }
    })
  }

  if (!loaded) {
    return (
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
               style={{ background: 'var(--accent-gold-dim)' }}>
            <MessageSquare className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
          </div>
          <h2 className="text-base font-semibold text-primary-themed">SMS Message Templates</h2>
        </div>
        <p className="text-xs text-muted-themed">Loading…</p>
      </Card>
    )
  }

  return (
    <Card>
      <div className="flex items-center gap-3 mb-2">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
             style={{ background: 'var(--accent-gold-dim)' }}>
          <MessageSquare className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-primary-themed">SMS Message Templates</h2>
          <p className="text-xs text-muted-themed">
            Customize the messages sent to guests, crew, and vendors on your behalf.
            Use <code className="font-mono text-xs">{'{{variable}}'}</code> tokens shown below each template.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {SMS_TEMPLATE_REGISTRY.map((config) => {
          const isOpen        = expandedKey === config.key
          const body          = getBodyForKey(config.key)
          const customized    = isCustomized(config.key)
          const unsaved       = hasUnsavedEdit(config.key)
          const isSavingThis  = saving && saveKey === config.key

          // Live preview: substitute example values
          const previewVars = Object.fromEntries(
            config.variables.map(v => [
              v.token.replace(/\{\{|\}\}/g, ''),
              v.example,
            ])
          )
          const preview = renderTemplate(body, previewVars)

          return (
            <div
              key={config.key}
              className="border border-themed rounded-xl overflow-hidden"
            >
              {/* Header row */}
              <button
                type="button"
                onClick={() => setExpandedKey(isOpen ? null : config.key)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-raised-themed transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-primary-themed">{config.label}</span>
                    <Badge tone={AUDIENCE_BADGE[config.audience]} className="text-xs">
                      {config.audience}
                    </Badge>
                    {customized && !unsaved && (
                      <span className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
                        Customized
                      </span>
                    )}
                    {unsaved && (
                      <span className="text-xs font-medium" style={{ color: 'var(--accent-amber)' }}>
                        Unsaved
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-themed mt-0.5 truncate">{config.description}</p>
                </div>
                <svg
                  className={cn('w-4 h-4 flex-shrink-0 transition-transform text-muted-themed', isOpen && 'rotate-180')}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Expanded panel */}
              {isOpen && (
                <div className="border-t border-themed px-4 py-4 space-y-4">
                  {/* Variables */}
                  <div>
                    <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2">
                      Available Variables
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {config.variables.map((v) => (
                        <div key={v.token}
                             className="px-2 py-1 rounded-md border border-themed text-xs"
                             style={{ background: 'var(--bg-raised)', fontFamily: 'monospace' }}
                             title={v.description}
                        >
                          {v.token}
                          <span className="ml-1.5 font-sans not-italic text-muted-themed">
                            {v.description}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Body editor */}
                  <div>
                    <label className="label">Message Body</label>
                    <textarea
                      value={body}
                      onChange={(e) => setEdits(prev => ({ ...prev, [config.key]: e.target.value }))}
                      rows={Math.min(10, body.split('\n').length + 2)}
                      className="input resize-y font-mono text-xs leading-relaxed w-full"
                      placeholder="Enter your custom message…"
                      maxLength={1000}
                    />
                    <p className="text-xs text-muted-themed mt-1 text-right">
                      {body.length}/1000
                    </p>
                  </div>

                  {/* Live preview */}
                  <div>
                    <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2">
                      Preview (sample data)
                    </p>
                    <div
                      className="rounded-xl p-3 text-xs whitespace-pre-wrap leading-relaxed border border-themed"
                      style={{ background: 'var(--bg-raised)', color: 'var(--text-secondary)', fontFamily: 'monospace' }}
                    >
                      {preview}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-3 pt-2 border-t border-themed flex-wrap">
                    <Button
                      type="button"
                      onClick={() => handleSave(config.key as SmsTemplateKey)}
                      disabled={isSavingThis || !unsaved}
                      className="text-sm"
                    >
                      {isSavingThis ? 'Saving…' : 'Save Template'}
                    </Button>

                    {customized && (
                      <Button
                        variant="secondary"
                        type="button"
                        onClick={() => handleReset(config.key as SmsTemplateKey)}
                        disabled={resetting}
                        className="text-sm flex items-center gap-1.5"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Reset to Default
                      </Button>
                    )}

                    {statusMsg[config.key] && (
                      <span
                        className="text-xs font-medium"
                        style={{
                          color: statusMsg[config.key]?.startsWith('✓')
                            ? 'var(--accent-green)'
                            : 'var(--accent-red)',
                        }}
                      >
                        {statusMsg[config.key]}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
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
        <Card key={doc.href} className="flex items-center justify-between gap-4">
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
        </Card>
      ))}

      <Card className="mt-4">
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
      </Card>
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
  const statusBadge = PLAN_STATUS_BADGES[org.plan_status] ?? 'slate'
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
      <Card>
        <h2 className="text-base font-semibold text-primary-themed mb-4">Current Plan</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <Badge tone={currentPlan.badge} className="text-sm px-3 py-1">
            {currentPlan.name}
          </Badge>
          <Badge tone={statusBadge}>
            {org.plan_status.replace('_', ' ')}
          </Badge>
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
            <Button
              variant="secondary"
              onClick={handleBillingPortal}
              disabled={portalPending}
            >
              {portalPending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Opening portal…</>
                : 'Manage Billing'
              }
            </Button>
          </div>
        )}
      </Card>

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
              <Card
                key={plan.key}
                className="flex flex-col gap-3"
                style={isCurrent ? { outline: '2px solid var(--accent-gold)', outlineOffset: '2px' } : undefined}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-primary-themed">{plan.name}</span>
                  {isCurrent && <Badge tone="green" className="text-xs">Current</Badge>}
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
                  <Button
                    onClick={() => handleCheckout(plan.key)}
                    disabled={checkoutPending}
                    className="text-sm mt-auto"
                  >
                    {isPending
                      ? <><Loader2 className="w-4 h-4 animate-spin" /> Redirecting…</>
                      : `Upgrade to ${plan.name}`
                    }
                  </Button>
                )}
              </Card>
            )
          })}

          {/* Enterprise */}
          <Card className="flex flex-col gap-3 sm:col-span-3">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <span className="font-semibold text-primary-themed">Enterprise</span>
                <p className="text-sm text-muted-themed mt-0.5">100+ properties — custom pricing</p>
              </div>
              <a href="mailto:hello@fieldstay.app" className="btn-secondary text-sm">
                Contact Us →
              </a>
            </div>
          </Card>
        </div>
      </div>

    </div>
  )
}
