'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import {
  AUTONOMY_LABELS,
  AUTONOMY_LEVELS,
  TEAM_BLURBS,
  TEAM_LABELS,
  isAutonomy,
  type SettingsTeam,
} from '@/lib/gtm/constants'
import type { TeamSetting } from '@/lib/gtm/policy'
import { requestQueueProposal, requestRevOpsReport, updateTeamSettings } from '../agents-actions'

type ActionResult = { error?: string }

/** Runs one settings action, reporting a refusal inline and refreshing on success. */
function useSettingsAction() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function run(action: () => Promise<ActionResult>) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (result.error) setError(result.error)
      else router.refresh()
    })
  }
  return { pending, error, run }
}

export function MasterSwitch({ setting }: Readonly<{ setting: TeamSetting }>) {
  const { pending, error, run } = useSettingsAction()
  const on = setting.enabled

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {TEAM_LABELS.global}
            </h3>
            <Badge tone={on ? 'green' : 'red'}>{on ? 'Agents on' : 'All agents paused'}</Badge>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{TEAM_BLURBS.global}</p>
        </div>
        <Button
          type="button"
          variant={on ? 'danger' : 'primary'}
          disabled={pending}
          onClick={() => run(() => updateTeamSettings('global', { enabled: !on }))}
        >
          {on ? 'Pause all agents' : 'Resume agents'}
        </Button>
      </div>
      {error && <p role="alert" className="text-xs mt-3" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </Card>
  )
}

function statusBadge(setting: TeamSetting, masterOn: boolean) {
  if (!setting.enabled) return <Badge tone="slate">Off</Badge>
  if (!masterOn) return <Badge tone="amber">Held by master switch</Badge>
  return <Badge tone="green">Running</Badge>
}

const dollarsOf = (cents: number): string => (cents / 100).toFixed(2)

/** "5" or "5.00" to whole cents, or null when it is not a usable amount. */
function centsOf(dollars: string): number | null {
  const n = Number(dollars)
  return dollars.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}

/** Queues a Rev Ops report outside the Monday schedule. The result shows up in the approval inbox. */
function RunReportButton({ disabled }: Readonly<{ disabled: boolean }>) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function request() {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const result = await requestRevOpsReport()
      if (result.error) {
        setError(result.error)
        return
      }
      setMessage('Requested. The report appears in the approval inbox in a minute or two.')
      router.refresh()
    })
  }

  return (
    <div className="mt-3">
      <Button type="button" variant="secondary" disabled={disabled || pending} onClick={request}>
        Run report now
      </Button>
      {message && <output className="block text-xs mt-2" style={{ color: 'var(--accent-green)' }}>{message}</output>}
      {error && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </div>
  )
}

/** Asks Lead Gen which accounts to move to queued. The list appears in the approval inbox; approving only changes their stage. */
function SuggestQueueButton({ disabled }: Readonly<{ disabled: boolean }>) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function request() {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const result = await requestQueueProposal()
      if (result.error) {
        setError(result.error)
        return
      }
      setMessage('Requested. The suggestion appears in the approval inbox shortly.')
      router.refresh()
    })
  }

  return (
    <div className="mt-3">
      <Button type="button" variant="secondary" disabled={disabled || pending} onClick={request}>
        Suggest accounts to queue
      </Button>
      {message && <output className="block text-xs mt-2" style={{ color: 'var(--accent-green)' }}>{message}</output>}
      {error && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </div>
  )
}

export function TeamCard({ setting, masterOn }: Readonly<{ setting: TeamSetting; masterOn: boolean }>) {
  const { pending, error, run } = useSettingsAction()
  const uid = useId()
  const team: SettingsTeam = setting.team
  const [taskCap, setTaskCap] = useState(String(setting.daily_task_cap))
  const [dollarCap, setDollarCap] = useState(dollarsOf(setting.daily_cost_cap_cents))
  const [localError, setLocalError] = useState<string | null>(null)

  const parsedCents = centsOf(dollarCap)
  const dirty = taskCap !== String(setting.daily_task_cap) || dollarCap !== dollarsOf(setting.daily_cost_cap_cents)

  function saveCaps() {
    if (parsedCents === null || taskCap.trim() === '') {
      setLocalError('Enter a task count and a dollar amount.')
      return
    }
    setLocalError(null)
    run(() => updateTeamSettings(team, { daily_task_cap: Number(taskCap), daily_cost_cap_cents: parsedCents }))
  }

  const isManager = team === 'manager'

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{TEAM_LABELS[team]}</h3>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{TEAM_BLURBS[team]}</p>
        </div>
        {statusBadge(setting, masterOn)}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${uid}-tasks`} className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
            Tasks per day
          </label>
          <Input id={`${uid}-tasks`} inputMode="numeric" value={taskCap} onChange={(e) => setTaskCap(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${uid}-spend`} className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
            Spend per day ($)
          </label>
          <Input id={`${uid}-spend`} inputMode="decimal" value={dollarCap} onChange={(e) => setDollarCap(e.target.value)} />
        </div>
      </div>

      <div className="mt-3">
        <label htmlFor={`${uid}-autonomy`} className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
          Autonomy
        </label>
        <select
          id={`${uid}-autonomy`}
          className="input w-full"
          value={setting.autonomy}
          disabled={pending || isManager}
          onChange={(e) => {
            if (isAutonomy(e.target.value)) run(() => updateTeamSettings(team, { autonomy: e.target.value }))
          }}
        >
          {AUTONOMY_LEVELS.map((level) => (
            <option key={level} value={level}>{AUTONOMY_LABELS[level]}</option>
          ))}
        </select>
        {isManager && (
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Observe-only for now. It reports and proposes, and creates no tasks.
          </p>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          type="button"
          variant={setting.enabled ? 'secondary' : 'primary'}
          disabled={pending}
          onClick={() => run(() => updateTeamSettings(team, { enabled: !setting.enabled }))}
        >
          {setting.enabled ? 'Turn off' : 'Turn on'}
        </Button>
        {dirty && (
          <Button type="button" variant="secondary" disabled={pending} onClick={saveCaps}>
            Save limits
          </Button>
        )}
      </div>
      {team === 'rev_ops' && <RunReportButton disabled={!setting.enabled || !masterOn} />}
      {team === 'lead_gen' && <SuggestQueueButton disabled={!setting.enabled || !masterOn} />}
      {(localError ?? error) && (
        <p role="alert" className="text-xs mt-3" style={{ color: 'var(--accent-red)' }}>{localError ?? error}</p>
      )}
    </Card>
  )
}
