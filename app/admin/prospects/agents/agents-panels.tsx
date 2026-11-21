import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import {
  TASK_STATUS_LABELS,
  TEAM_LABELS,
  WORKER_TEAMS,
  type TaskStatus,
} from '@/lib/gtm/constants'
import { formatCents, taskStatusTone, timeAgo } from '@/lib/gtm/format'
import { VOICE_GUIDE_STATUS, VOICE_GUIDE_VERSION } from '@/lib/gtm/brand/voice'
import { DRAFT_QUALITY_WINDOW_DAYS, type DraftQuality, type RecentTask } from '@/lib/gtm/dashboard'
import type { ManagerMetrics } from '@/lib/gtm/manager/brief'
import { taskCount, type GtmRollup } from '@/lib/gtm/rollup'
import { PROSPECT_STATUSES, PROSPECT_STATUS_LABELS } from '../constants'

/**
 * The read-only panels of the Agents view. Server Components: they take numbers
 * that are already computed and draw them, so they carry no state and no actions.
 */

function Kpi({ label, value, hint }: Readonly<{ label: string; value: number | string; hint?: string }>) {
  return (
    <Card>
      <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="text-2xl font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>{value}</p>
      {hint && <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{hint}</p>}
    </Card>
  )
}

export function KpiRow({ metrics }: Readonly<{ metrics: ManagerMetrics }>) {
  const emailed = metrics.touches7d.emailed ?? 0
  const replies = metrics.touches7d.replied ?? 0
  const replyHint = emailed > 0 ? `${replies} replies from ${emailed} emails, 7 days` : 'No emails in the last 7 days'

  return (
    <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
      <Kpi label="Accounts" value={metrics.funnelTotal} />
      <Kpi label="In play" value={metrics.funnelActive} hint="Not won, lost or disqualified" />
      <Kpi label="Replied" value={metrics.replied} hint={replyHint} />
      <Kpi label="Meetings" value={metrics.meetingSet} />
      <Kpi label="In trial" value={metrics.inTrial} />
      <Kpi label="Won" value={metrics.won} />
    </div>
  )
}

export function FunnelSnapshot({ funnel }: Readonly<{ funnel: Record<string, number> }>) {
  const max = Math.max(1, ...PROSPECT_STATUSES.map((s) => funnel[s] ?? 0))

  return (
    <Card>
      <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Funnel by stage</h3>
      <ul className="mt-3 space-y-2">
        {PROSPECT_STATUSES.map((status) => {
          const count = funnel[status] ?? 0
          return (
            <li key={status} className="flex items-center gap-3 text-xs">
              <span className="w-36 shrink-0" style={{ color: 'var(--text-secondary)' }}>
                {PROSPECT_STATUS_LABELS[status]}
              </span>
              <span className="grow h-2 rounded" style={{ background: 'var(--bg-base)' }} aria-hidden="true">
                <span
                  className="block h-2 rounded"
                  style={{ width: `${(count / max) * 100}%`, background: 'var(--accent-gold)' }}
                />
              </span>
              <span className="w-10 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{count}</span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

const MATRIX_COLUMNS: readonly TaskStatus[] = ['pending', 'in_progress', 'needs_approval', 'approved', 'done', 'failed']

export function QueueMatrix({ rollup, metrics }: Readonly<{ rollup: GtmRollup; metrics: ManagerMetrics }>) {
  const spendOf = (team: string) => metrics.spend.find((s) => s.team === team)

  return (
    <Card>
      <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Work queues</h3>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
        Open work, plus finished and failed work from the last 30 days. Spend is today, against each team&apos;s daily cap.
      </p>
      <div className="overflow-x-auto mt-3">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ color: 'var(--text-muted)' }}>
              <th scope="col" className="text-left font-medium py-1 pr-3">Team</th>
              {MATRIX_COLUMNS.map((s) => (
                <th key={s} scope="col" className="text-right font-medium py-1 px-2">{TASK_STATUS_LABELS[s]}</th>
              ))}
              <th scope="col" className="text-right font-medium py-1 pl-3">Spend today</th>
            </tr>
          </thead>
          <tbody>
            {WORKER_TEAMS.map((team) => {
              const spend = spendOf(team)
              return (
                <tr key={team} className="border-t" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                  <th scope="row" className="text-left font-medium py-2 pr-3">{TEAM_LABELS[team]}</th>
                  {MATRIX_COLUMNS.map((s) => (
                    <td key={s} className="text-right tabular-nums py-2 px-2">{taskCount(rollup, team, s)}</td>
                  ))}
                  <td className="text-right tabular-nums py-2 pl-3">
                    {formatCents(spend?.costCents ?? 0)} of {formatCents(spend?.capCents ?? 0)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function RecentTasks({ tasks, now }: Readonly<{ tasks: RecentTask[]; now: Date }>) {
  return (
    <Card>
      <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Recent activity</h3>
      {tasks.length === 0 ? (
        <p className="text-sm mt-3" style={{ color: 'var(--text-muted)' }}>
          No agent has done anything yet. Switch a team on to start the queue.
        </p>
      ) : (
        <ul className="mt-2">
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 py-2 border-t first:border-t-0 text-xs" style={{ borderColor: 'var(--border)' }}>
              <Badge tone={taskStatusTone(t.status)}>{TASK_STATUS_LABELS[t.status]}</Badge>
              <span style={{ color: 'var(--text-primary)' }}>{TEAM_LABELS[t.team]}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{t.taskType.replaceAll('_', ' ')}</span>
              {t.company && <span style={{ color: 'var(--text-muted)' }}>{t.company}</span>}
              {t.error && <span style={{ color: 'var(--accent-red)' }}>{t.error}</span>}
              <span className="ml-auto" style={{ color: 'var(--text-muted)' }}>{timeAgo(t.updatedAt, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/**
 * How the drafts have been received. This is the evidence for the question the
 * founder asked: when would sending from inside FieldStay be safe? It reports
 * only what happened (approved, rejected, sent) and the founder's own notes, and
 * draws no conclusion of its own.
 */
export function DraftQualityPanel({ quality }: Readonly<{ quality: DraftQuality }>) {
  const decided = quality.approved + quality.rejected
  const rate = decided > 0 ? `${Math.round((quality.approved / decided) * 100)}%` : 'no drafts reviewed yet'

  return (
    <Card>
      <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Draft quality</h3>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
        Last {DRAFT_QUALITY_WINDOW_DAYS} days. Sending from inside FieldStay is not built. This is the record to
        judge the voice by before it is.
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <div><dt style={{ color: 'var(--text-muted)' }}>Approved</dt><dd className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{quality.approved}</dd></div>
        <div><dt style={{ color: 'var(--text-muted)' }}>Rejected</dt><dd className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{quality.rejected}</dd></div>
        <div><dt style={{ color: 'var(--text-muted)' }}>Approval rate</dt><dd className="text-sm" style={{ color: 'var(--text-primary)' }}>{rate}</dd></div>
        <div><dt style={{ color: 'var(--text-muted)' }}>Marked sent</dt><dd className="text-sm" style={{ color: 'var(--text-primary)' }}>{quality.sent}</dd></div>
      </dl>

      <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
        Voice guide {VOICE_GUIDE_VERSION}. {VOICE_GUIDE_STATUS} Edit it in lib/gtm/brand/voice.ts.
      </p>

      {quality.notes.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Why recent drafts were rejected</p>
          <ul className="mt-1 space-y-1">
            {quality.notes.map((n) => (
              <li key={`${n.decidedAt}-${n.note}`} className="text-xs" style={{ color: 'var(--text-muted)' }}>{n.note}</li>
            ))}
          </ul>
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>These notes are passed to the next draft.</p>
        </div>
      )}
    </Card>
  )
}
