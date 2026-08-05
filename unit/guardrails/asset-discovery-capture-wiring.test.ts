import { describe, it, expect } from 'vitest'
import { read } from './scan'
import { resolve } from 'node:path'

// ============================================================================
// Progressive Asset Discovery: the prompt must reach the capture form.
//
// The generator writes one checklist_instance_items row per undiscovered asset
// type, each carrying `asset_discovery_type`. Every part of that shipped and
// worked. The crew side then rendered those rows as ORDINARY TICK-BOXES,
// because nothing read the column — so ticking one wrote nothing to
// property_assets, and lib/asset-discovery/engine.ts (which recomputes from
// property_assets, not from the checklist) handed the identical prompt out on
// the next turnover. Production at the time this was written: 660 asset-
// discovery items issued, ZERO ever ticked, ZERO assets ever captured by crew.
//
// The failure is invisible in every way that matters. It type-checks, the
// items render, the checklist completes, and the only symptom is a survey that
// never finishes. That is what makes it worth a guardrail rather than a
// comment: the chain below is four links long, spans four files, and breaking
// ANY link silently restores the original bug.
//
//   1. the column survives the crew sync SELECT           (lib/dexie/sync)
//   2. it survives into the Dexie row type                (lib/dexie/schema)
//   3. the checklist routes those rows to capture         (ChecklistView)
//   4. the item is ticked BY the capture, not by hand     (onCaptured)
//
// Link 4 is the one that carries the actual invariant. A completed discovery
// item must have a property_assets row behind it, or the prompt is a lie: the
// crew member believes the asset is surveyed and the engine reissues it
// forever. Ticking it by hand is precisely the pre-fix behaviour.
// ============================================================================

const SYNC_FILE      = 'lib/dexie/sync/turnovers.ts'
const SCHEMA_FILE    = 'lib/dexie/schema.ts'
const CHECKLIST_VIEW = 'app/crew/turnovers/[id]/ChecklistView.tsx'
const ACTIONS_HOOK   = 'app/crew/turnovers/[id]/use-turnover-actions.ts'
const ENGINE_FILE    = 'lib/asset-discovery/engine.ts'

const src = (rel: string) => read(resolve(process.cwd(), rel))

describe('guardrail: asset-discovery prompts reach the capture form', () => {
  it('the generator still stamps asset_discovery_type on each prompt', () => {
    expect(
      src(ENGINE_FILE),
      'buildAssetDiscoveryItems must keep writing asset_discovery_type — it is ' +
      'the only thing tying a checklist row back to the asset it prompts for.',
    ).toContain('asset_discovery_type')
  })

  it('the crew sync SELECT pulls asset_discovery_type', () => {
    const sync = src(SYNC_FILE)
    // The column has to be named in the checklist_instance_items select string.
    // Dropping it from that list is a one-word edit that turns every discovery
    // prompt back into an inert tick-box, with nothing failing anywhere.
    const selectLine = sync
      .split('\n')
      .find((l) => l.includes('is_section_final_item') && l.includes('id, instance_id'))
    expect(selectLine, 'checklist_instance_items select string not found in ' + SYNC_FILE).toBeDefined()
    expect(
      selectLine,
      'asset_discovery_type must stay in the crew checklist-item SELECT, or the ' +
      'discovery prompt arrives on-device with no asset type and renders as a ' +
      'plain task again.',
    ).toContain('asset_discovery_type')
  })

  it('the Dexie row type carries asset_discovery_type', () => {
    expect(
      src(SCHEMA_FILE),
      'ChecklistInstanceItemRow must declare asset_discovery_type — the sync ' +
      'normalizer writes it and ChecklistView reads it.',
    ).toContain('asset_discovery_type')
  })

  it('ChecklistView routes a discovery row to the capture modal, not the toggle', () => {
    const view = src(CHECKLIST_VIEW)
    expect(view).toContain('asset_discovery_type')
    expect(
      view,
      'ChecklistView must open DiscoveryCaptureModal for an asset-discovery ' +
      'item. Without it the row is an ordinary tick-box and the survey never ' +
      'completes.',
    ).toContain('DiscoveryCaptureModal')
    expect(
      view,
      'The discovery row must call startAssetCapture rather than toggleItem.',
    ).toContain('startAssetCapture')
  })

  it('the checklist item is completed BY the capture, never by a bare toggle', () => {
    const view = src(CHECKLIST_VIEW)
    const hook = src(ACTIONS_HOOK)

    // The modal's onCaptured is what ticks the row. If a future edit wires the
    // capture up but leaves the item completed by hand, the prompt and the
    // captured data can disagree — which is the original bug wearing a modal.
    expect(
      view,
      'DiscoveryCaptureModal must be given onCaptured, so the checklist item is ' +
      'ticked only once the asset has actually been written and queued.',
    ).toMatch(/onCaptured=\{[^}]*completeCapturedItem/)

    expect(
      hook,
      'completeCapturedItem must exist in use-turnover-actions and mark the item ' +
      'complete.',
    ).toMatch(/completeCapturedItem[\s\S]{0,200}?updateChecklistItem/)
  })

  it('the capture modal is shared, not re-implemented per screen', () => {
    // Two capture forms would drift into capturing different things, and the
    // engine only drops a type off when the columns it checks are set.
    const view   = src(CHECKLIST_VIEW)
    const assets = src('app/crew/assets/[propertyId]/page.tsx')
    const shared = '@/app/crew/_components/discovery-capture-modal'

    expect(view,   `${CHECKLIST_VIEW} must import the shared modal`).toContain(shared)
    expect(assets, 'the standalone crew assets screen must import the same modal').toContain(shared)
  })
})
