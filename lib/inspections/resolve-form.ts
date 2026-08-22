// lib/inspections/resolve-form.ts
//
// Turns a platform form definition into the PAGES one specific property gets.
//
// A form definition is the same for every tenant; a performance of it is not.
// Three things vary by property, and all three are structural rather than
// cosmetic — they change how many pages there are and how many rows each holds:
//
//   1. CONDITIONAL SECTIONS. Outdoor's well section renders only where the
//      property has an active `well_pump` asset, and its HOA section only where
//      `properties.hoa_name` is set. A municipal-water property never sees the
//      well questions, and the skip is ledger-backed rather than something the
//      inspector asserts (§12.3).
//   2. PER-ASSET ITEMS. `repeat_per_asset` renders one row per ACTIVE
//      property_assets row, so three HVAC units are asked three times and a
//      property with no generator is never asked about a generator (§5).
//   3. REPEAT GROUPS. `repeat_source_item_id` sizes a group from a COUNT the
//      inspector gives during the walk — N extinguishers, N groups of
//      location/charged/expiry/photo. That beats a fixed cap, which is wrong in
//      both directions: wasted rows at most properties, a silently lost fourth
//      extinguisher at a large one.
//
// (3) is why this is a function of the ANSWERS so far and not only of the
// property. It is pure and cheap, so the caller re-runs it on every change.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS DELIBERATELY DOES NOT DO: `show_when`.
//
// A child item ("→ which room needs a smoke detector?") is returned in the tree
// with its `show_when` intact, and the item renderer decides whether to display
// it. That is not an oversight — the renderer already holds the parent's
// current answer, and resolving visibility here would mean this module owning
// half of one decision while the renderer owns the other half. Structure here,
// visibility there.
//
// It also does not read the database. It takes rows, so it works identically
// against a live pull, the Dexie cache offline, and a completed inspection's
// frozen `form_snapshot` — which is what lets a historical report re-render
// exactly the form that was asked.

import type {
  InspectionFormItem,
  InspectionFormSection,
  PropertyAsset,
} from '@/types/database'

/** One rendered instance of a form item. */
export interface ResolvedItem {
  /** The definition row. Its `key` is the stable identity; `id` is the FK target. */
  formItem: InspectionFormItem
  /** Set only for a `repeat_per_asset` instance — which asset this row is about. */
  asset?:   PropertyAsset
  /** 1..N for a repeat-group member; matches `inspection_items.repeat_index`. */
  repeatIndex?: number
  /** Conditional follow-ups, carrying their own `show_when` for the renderer. */
  children: ResolvedItem[]
}

/** One page of the pager. */
export interface ResolvedPage {
  sectionId:  string
  sectionKey: string
  name:       string
  items:      ResolvedItem[]
}

export interface ResolveInput {
  sections: InspectionFormSection[]
  items:    InspectionFormItem[]
  /** ACTIVE assets only is enforced here, not assumed of the caller. */
  assets:   PropertyAsset[]
  /** `properties.hoa_name` — the gate for Outdoor's HOA section. */
  hoaName:  string | null
  /**
   * Counts answered so far, keyed by the COUNT item's id. A missing or zero
   * entry yields no repeat rows, which is the correct state before the
   * inspector has counted anything.
   */
  countsByItemId?: Readonly<Record<string, number>>
}

/**
 * Sections whose gate is an asset type the property does not have are dropped
 * entirely — they are not rendered as an empty page or an N/A prompt. §12.3 is
 * explicit that this skip is ledger-backed precisely so it is not an assertion
 * the inspector makes, and showing the section at all would invite one.
 */
function sectionIsShown(
  section: InspectionFormSection,
  activeTypes: ReadonlySet<string>,
  hoaName: string | null,
): boolean {
  if (section.shown_when_asset && !activeTypes.has(section.shown_when_asset)) return false
  if (section.shown_when_property_field === 'hoa_name' && !hoaName) return false
  return true
}

/**
 * Assets a `repeat_per_asset` row should generate a question for.
 *
 * §12.2 §7: "every ACTIVE property_assets row whose asset_type is not already
 * covered above". An HVAC unit already has a named HVAC question earlier in the
 * form, so asking the generic "operational, no visible damage?" about it again
 * would be a second question about one thing — and, worse, a second row for the
 * inspector to disagree with themselves on.
 *
 * `coveredTypes` is derived from the form itself rather than hand-listed, so
 * adding a named question for an asset type automatically removes it from the
 * generic sweep instead of silently duplicating it.
 */
function assetsForGenericSweep(
  assets: PropertyAsset[],
  coveredTypes: ReadonlySet<string>,
): PropertyAsset[] {
  return assets.filter((a) => !coveredTypes.has(a.asset_type))
}

function buildChildren(
  parent: InspectionFormItem,
  byParent: ReadonlyMap<string, InspectionFormItem[]>,
): ResolvedItem[] {
  return (byParent.get(parent.id) ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((child) => ({ formItem: child, children: [] }))
}

function buildRepeatGroup(
  members:  InspectionFormItem[],
  count:    number,
  byParent: ReadonlyMap<string, InspectionFormItem[]>,
): ResolvedItem[] {
  const out: ResolvedItem[] = []
  // Grouped per instance rather than per member: the inspector works through
  // ONE extinguisher's location, charge, expiry and tag photo together, not
  // every location followed by every charge.
  for (let i = 1; i <= count; i++) {
    for (const member of members) {
      out.push({ formItem: member, repeatIndex: i, children: buildChildren(member, byParent) })
    }
  }
  return out
}

/**
 * The pages one property gets, in order.
 *
 * Pure: same inputs, same output. That is what lets the pager recompute on
 * every keystroke without a cache, and what makes the whole thing testable
 * without a database or a browser.
 */
export function resolveFormPages(input: ResolveInput): ResolvedPage[] {
  const counts = input.countsByItemId ?? {}

  // ACTIVE only, enforced here rather than assumed of the caller. A replaced
  // water heater must not resurrect the well section or generate a question
  // about itself.
  const activeAssets = input.assets.filter((a) => a.is_active)
  const activeTypes  = new Set(activeAssets.map((a) => a.asset_type))

  const index      = indexItems(input.items)
  const sweepable  = assetsForGenericSweep(activeAssets, coveredAssetTypes(input.items))

  const pages: ResolvedPage[] = []

  for (const section of [...input.sections].sort(bySortOrder)) {
    if (!sectionIsShown(section, activeTypes, input.hoaName)) continue

    const roots = (index.bySection.get(section.id) ?? []).slice().sort(bySortOrder)
    const items = roots.flatMap((root) => resolveRoot(root, { index, sweepable, counts }))

    // A section that resolves to nothing is not a page. The assets section on a
    // property with no uncovered assets is the real case: rendering it would be
    // an empty page with a Next button and no explanation.
    if (items.length === 0) continue

    pages.push({ sectionId: section.id, sectionKey: section.key, name: section.name, items })
  }

  return pages
}

const bySortOrder = (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order

interface ItemIndex {
  bySection:      Map<string, InspectionFormItem[]>
  byParent:       Map<string, InspectionFormItem[]>
  byRepeatSource: Map<string, InspectionFormItem[]>
}

/** One pass over the flat item list, bucketed by the three ways an item hangs. */
function indexItems(items: InspectionFormItem[]): ItemIndex {
  const index: ItemIndex = { bySection: new Map(), byParent: new Map(), byRepeatSource: new Map() }

  const push = (map: Map<string, InspectionFormItem[]>, key: string, item: InspectionFormItem) => {
    map.set(key, [...(map.get(key) ?? []), item])
  }

  for (const item of items) {
    if (item.parent_item_id)             push(index.byParent, item.parent_item_id, item)
    else if (item.repeat_source_item_id) push(index.byRepeatSource, item.repeat_source_item_id, item)
    else                                 push(index.bySection, item.section_id, item)
  }

  for (const list of index.byRepeatSource.values()) list.sort(bySortOrder)
  return index
}

/** Every asset type a NAMED item already asks about, anywhere on the form. */
function coveredAssetTypes(items: InspectionFormItem[]): ReadonlySet<string> {
  return new Set(
    items.filter((i) => !i.repeat_per_asset && i.asset_type).map((i) => i.asset_type as string),
  )
}

interface ResolveCtx {
  index:     ItemIndex
  sweepable: PropertyAsset[]
  counts:    Readonly<Record<string, number>>
}

/** One root item becomes one row, N per-asset rows, or a row plus its repeat group. */
function resolveRoot(root: InspectionFormItem, ctx: ResolveCtx): ResolvedItem[] {
  if (root.repeat_per_asset) {
    return ctx.sweepable.map((asset) => ({
      formItem: root,
      asset,
      children: buildChildren(root, ctx.index.byParent),
    }))
  }

  const self: ResolvedItem = { formItem: root, children: buildChildren(root, ctx.index.byParent) }
  const members = ctx.index.byRepeatSource.get(root.id)
  if (!members?.length) return [self]

  return [self, ...buildRepeatGroup(members, Math.max(0, ctx.counts[root.id] ?? 0), ctx.index.byParent)]
}


/**
 * Required items with no answer, and fails missing the description or photo the
 * form demands — what the Review page lists before sign-off.
 *
 * This exists BECAUSE Next is deliberately never blocked. A walk is not linear:
 * an inspector skips the locked utility room and comes back, so trapping them
 * on a page fights the job. The cost of that decision is that the linear path
 * can reach the signature with a section quietly unanswered, and this is what
 * pays it — the pager ends in a list of exactly what the walk missed, each
 * entry a tap away from the page it is on.
 */
export interface OutstandingItem {
  pageIndex:   number
  sectionName: string
  itemKey:     string
  prompt:      string
  reason:      'unanswered' | 'fail_needs_description' | 'fail_needs_photo'
  repeatIndex?: number
  assetId?:     string
}

export interface AnswerState {
  result?:      'pass' | 'fail' | 'na' | null
  note?:        string | null
  photoPath?:   string | null
  photoUnavailableReason?: string | null
}

/** Key an answer by the identity that makes it unique: item + repeat + asset. */
export function answerKey(item: ResolvedItem): string {
  return [item.formItem.id, item.repeatIndex ?? '', item.asset?.id ?? ''].join('|')
}

export function findOutstanding(
  pages: ResolvedPage[],
  answers: Readonly<Record<string, AnswerState>>,
): OutstandingItem[] {
  const out: OutstandingItem[] = []

  pages.forEach((page, pageIndex) => {
    for (const item of page.items) {
      for (const node of [item, ...item.children]) {
        const reason = outstandingReason(node, answers[answerKey(node)])
        if (!reason) continue
        out.push({
          pageIndex,
          sectionName: page.name,
          itemKey:     node.formItem.key,
          prompt:      node.formItem.prompt,
          reason,
          ...(node.repeatIndex !== undefined && { repeatIndex: node.repeatIndex }),
          ...(node.asset      !== undefined && { assetId: node.asset.id }),
        })
      }
    }
  })

  return out
}

function outstandingReason(
  node:   ResolvedItem,
  answer: AnswerState | undefined,
): OutstandingItem['reason'] | null {
  const def = node.formItem

  // A child is only outstanding once its condition is actually met — otherwise
  // every unshown follow-up on the form would be listed as missing.
  if (def.show_when && def.show_when !== 'fail') return null

  if (def.is_required && (answer?.result === undefined || answer?.result === null)) {
    return 'unanswered'
  }
  if (answer?.result !== 'fail') return null

  // §5: "A description is REQUIRED on fail" — it becomes the work order's
  // title, and is the one place free text beats structure.
  if (!answer.note?.trim()) return 'fail_needs_description'

  // The photo escape hatch is a REASON, never a silent skip: an unenforceable
  // rule produces a photograph of the floor, which is worse evidence than an
  // honest "camera failed".
  if (def.photo_required && !answer.photoPath && !answer.photoUnavailableReason?.trim()) {
    return 'fail_needs_photo'
  }
  return null
}
