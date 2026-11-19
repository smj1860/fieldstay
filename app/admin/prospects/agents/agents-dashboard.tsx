import { requirePlatformAdmin } from '@/lib/auth'
import { WORKER_TEAMS, type SettingsTeam } from '@/lib/gtm/constants'
import { loadAgentsDashboard } from '@/lib/gtm/dashboard'
import { timeAgo } from '@/lib/gtm/format'
import { settingFor } from '@/lib/gtm/policy'
import { ApprovalInbox } from './approval-inbox'
import { DraftQualityPanel, FunnelSnapshot, KpiRow, QueueMatrix, RecentTasks } from './agents-panels'
import { ReadyCalls } from './ready-calls'
import { ReadyToSend } from './ready-to-send'
import { ManagerPanel } from './manager-panel'
import { MasterSwitch, TeamCard } from './team-controls'

const TEAM_ORDER: readonly SettingsTeam[] = ['manager', ...WORKER_TEAMS]

/**
 * The Agents view of the Prospecting Funnel: how the pipeline is doing, what the
 * agent teams are doing about it, and the controls that start, stop and cap them.
 *
 * Reads as the signed-in admin through RLS, never the service role, so the page
 * shows only what the policies allow and a regression there fails closed.
 */
export async function AgentsDashboard() {
  const { supabase } = await requirePlatformAdmin()
  const data = await loadAgentsDashboard(supabase)

  const now = new Date(data.now)
  // Ages are formatted once here, on the server, and passed down as text: a
  // client component that computed "5m ago" itself would disagree with the
  // server render by the time it hydrated.
  const ages: Record<string, string> = {}
  for (const a of data.approvals) ages[a.id] = timeAgo(a.createdAt, now)
  for (const d of data.decisions) ages[d.id] = timeAgo(d.createdAt, now)
  for (const r of data.readyDrafts) ages[r.id] = r.approvedAt ? timeAgo(r.approvedAt, now) : ''
  for (const c of data.readyCalls) ages[c.id] = c.approvedAt ? timeAgo(c.approvedAt, now) : ''

  const master = settingFor(data.settings, 'global')
  const masterOn = master?.enabled === true

  return (
    <div className="space-y-6">
      <KpiRow metrics={data.metrics} />

      <div className="grid gap-6 lg:grid-cols-2">
        <ApprovalInbox items={data.approvals} totalWaiting={data.metrics.needsApproval} ages={ages} />
        <ManagerPanel latest={data.decisions[0] ?? null} history={data.decisions} ages={ages} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ReadyToSend drafts={data.readyDrafts} ages={ages} />
        <DraftQualityPanel quality={data.draftQuality} />
      </div>

      <ReadyCalls calls={data.readyCalls} ages={ages} />

      <div className="grid gap-6 lg:grid-cols-2">
        <FunnelSnapshot funnel={data.rollup.funnel} />
        <QueueMatrix rollup={data.rollup} metrics={data.metrics} />
      </div>

      <section aria-labelledby="agent-controls">
        <h2 id="agent-controls" className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
          Teams and limits
        </h2>
        <div className="space-y-4">
          {master && <MasterSwitch setting={master} />}
          <div className="grid gap-4 md:grid-cols-2">
            {TEAM_ORDER.map((team) => {
              const setting = settingFor(data.settings, team)
              return setting ? <TeamCard key={`${team}-${setting.enabled}-${setting.autonomy}-${setting.daily_task_cap}-${setting.daily_cost_cap_cents}`} setting={setting} masterOn={masterOn} /> : null
            })}
          </div>
        </div>
      </section>

      <RecentTasks tasks={data.recent} now={now} />
    </div>
  )
}
