// lib/inspections/resolve-form.ts
//
// Turns a platform form definition into the PAGES one specific property gets.
//
// A form definition is the same for every tenant; a performance of it is not.
// Three things vary by property, and all three are structural rather than
// cosmetic — they change how many pages there are and how many rows each holds:
//
//   1. CONDITIONAL SECTIONS. Outdoor's well section renders only where the
//      property has an active `well_pump` asset. A municipal-water property
//      never sees the nine well questions, and the skip is ledger-backed rather
//      than something the inspector asserts (§12.3) — which matters because the
//      party who benefits from skipping them is the one who would be asserting.
//
//      The HOA section used to be gated the same way, on `properties.hoa_name`.
//      It is not: FieldStay does not hold HOA membership and will not collect
//      it, so the column was dropped (20260822230000) and the fact is asked
//      in-form instead. A gate on a column nothing populates is a silent
//      deletion, not a conservative default.
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

/**
 * The section fields resolution actually needs.
 *
 * A `Pick` rather than the whole row, because the second caller is a COMPLETED
 * inspection's frozen `form_snapshot`, which stores these five fields and not
 * `form_id`/`created_at`. Widening the parameter is honest; fabricating the two
 * missing fields to satisfy the full interface would put invented values into
 * the one code path whose entire job is to re-render what was really asked.
 */
export type ResolvableSection =
  Pick<InspectionFormSection, 'id' | 'key' | 'name' | 'sort_order'>
  & {
    /**
     * `string`, not `AssetType`, and only here. The DB row keeps the enum; a
     * snapshot read back out of jsonb cannot be trusted to hold one, and
     * asserting it would be claiming a check that never ran. Widening costs
     * nothing because this value is only ever tested for membership in the
     * property's active asset types — an unrecognised gate matches nothing and
     * the section is skipped, which is the right answer for a corrupt snapshot.
     */
    shown_when_asset: string | null
  }

export interface ResolveInput {
  sections: ResolvableSection[]
  items:    InspectionFormItem[]
  /** ACTIVE assets only is enforced here, not assumed of the caller. */
  assets:   PropertyAsset[]
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
  section: ResolvableSection,
  activeTypes: ReadonlySet<string>,
): boolean {
  return !section.shown_when_asset || activeTypes.has(section.shown_when_asset)
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

/**
 * The most repeat instances one count may produce.
 *
 * A count sizes its group, so the number the inspector types decides how many
 * rows render. A fat-fingered "1000" on the extinguisher count becomes four
 * thousand rendered rows and a tablet that stops responding in the middle of an
 * inspection — the one moment there is no way to recover. Matched by the
 * `inspection_items_value_number_range` CHECK (20260823001839) so a write that
 * did not come through here is bounded too.
 */
export const MAX_REPEAT_INSTANCES = 999

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
    if (!sectionIsShown(section, activeTypes)) continue

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

  const count = Math.min(MAX_REPEAT_INSTANCES, Math.max(0, Math.floor(ctx.counts[root.id] ?? 0)))
  return [self, ...buildRepeatGroup(members, count, ctx.index.byParent)]
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
  reason:      'unanswered' | 'fail_needs_description' | 'needs_photo'
  repeatIndex?: number
  assetId?:     string
}

export interface AnswerState {
  /** The answer to a `yes_no` item. The other four types answer with a VALUE. */
  result?:      'pass' | 'fail' | 'na' | null
  /** The FAILURE DESCRIPTION — never a text item's answer. See `valueText`. */
  note?:        string | null
  photoPath?:   string | null
  photoUnavailableReason?: string | null

  /** `count`. Sizes the repeat group hanging off the item. */
  valueNumber?: number | null
  /** `text`. Distinct from `note`, which becomes a work order's title. */
  valueText?:   string | null
  /** `date`, as ISO `YYYY-MM-DD`. */
  valueDate?:   string | null
}

/** Key an answer by the identity that makes it unique: item + repeat + asset. */
export function answerKey(item: ResolvedItem): string {
  return [item.formItem.id, item.repeatIndex ?? '', item.asset?.id ?? ''].join('|')
}

/** A node that is actually on screen, and how deep it renders. */
export interface VisibleNode {
  item:    ResolvedItem
  /** 0 for a root, 1 for a conditional follow-up. */
  depth:   number
}

/**
 * The nodes a page shows right now, in render order, given the answers so far.
 *
 * ONE definition, deliberately — the renderer and the Review gate must agree
 * about what is on screen or the gate is judging a different form than the
 * inspector filled. They disagreed once already: an earlier `findOutstanding`
 * hardcoded `show_when !== 'fail'` on the assumption that every child was a
 * "→ which room failed?" follow-up. Outdoor's HOA items are `show_when: 'pass'`
 * children of "Property is subject to an HOA", so on a property that IS in an
 * HOA they rendered, were required, and could never be reported — the gate
 * would pass with all three blank.
 */
export function visibleNodes(
  page: ResolvedPage,
  answers: Readonly<Record<string, AnswerState>>,
): VisibleNode[] {
  const out: VisibleNode[] = []

  for (const item of page.items) {
    out.push({ item, depth: 0 })

    // A child counts only when its condition is ACTUALLY MET, which needs the
    // parent's answer — so visibility is decided here, where that answer is.
    const parentResult = answers[answerKey(item)]?.result ?? null
    for (const child of item.children) {
      if (child.formItem.show_when && child.formItem.show_when !== parentResult) continue
      out.push({ item: child, depth: 1 })
    }
  }

  return out
}

export function findOutstanding(
  pages: ResolvedPage[],
  answers: Readonly<Record<string, AnswerState>>,
): OutstandingItem[] {
  const out: OutstandingItem[] = []

  pages.forEach((page, pageIndex) => {
    for (const { item: node } of visibleNodes(page, answers)) {
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
  })

  return out
}

/**
 * Answered / total for one page, counting only what is on screen.
 *
 * Drives the section index. Counting hidden conditional children would make a
 * page permanently short of complete, which reads as "you missed something" for
 * a question the inspector was never shown.
 */
export function pageProgress(
  page: ResolvedPage,
  answers: Readonly<Record<string, AnswerState>>,
): { answered: number; total: number } {
  const nodes = visibleNodes(page, answers)
  const answered = nodes.filter(({ item }) => {
    const r = answers[answerKey(item)]?.result
    return r !== undefined && r !== null
  }).length
  return { answered, total: nodes.length }
}

/**
 * Whether an item has been answered AT ALL — which depends entirely on what
 * kind of question it is.
 *
 * Only `yes_no` answers with a pass/fail. The other four answer with a VALUE,
 * and treating a missing pass/fail as "unanswered" for those made the Review
 * gate demand a verdict on "Number of fire extinguishers" — a question with no
 * verdict to give, and so a gate no inspector could ever satisfy.
 */
function hasAnswer(def: InspectionFormItem, answer: AnswerState | undefined): boolean {
  switch (def.response_type) {
    case 'count': return answer?.valueNumber !== undefined && answer?.valueNumber !== null
    case 'text':  return !!answer?.valueText?.trim()
    case 'date':  return !!answer?.valueDate?.trim()
    // A photo item's answer IS the photo — or an honest reason there isn't one.
    case 'photo': return !!answer?.photoPath || !!answer?.photoUnavailableReason?.trim()
    default:      return answer?.result !== undefined && answer?.result !== null
  }
}

function photoSatisfied(answer: AnswerState | undefined): boolean {
  return !!answer?.photoPath || !!answer?.photoUnavailableReason?.trim()
}

function outstandingReason(
  node:   ResolvedItem,
  answer: AnswerState | undefined,
): OutstandingItem['reason'] | null {
  const def = node.formItem

  // Visibility is the CALLER's decision — it holds the parent's answer. This
  // function only judges an item it has already been told is on screen.
  if (def.is_required && !hasAnswer(def, answer)) {
    return def.response_type === 'photo' ? 'needs_photo' : 'unanswered'
  }

  // §5: "A description is REQUIRED on fail" — it becomes the work order's
  // title, and is the one place free text beats structure.
  //
  // Checked BEFORE the photo, so a fail missing both surfaces the description
  // first. Reporting one reason per item either way, and this is the one that
  // has to be typed rather than tapped.
  if (answer?.result === 'fail' && !answer.note?.trim()) return 'fail_needs_description'

  // photo_required no longer sits behind `if (result !== 'fail') return`, which
  // is the fix to a second defect: every photo_required item in all three forms
  // is a `photo`-type item that never receives a pass/fail at all, so the rule
  // was unreachable — including on the one item §12.1 argues hardest for, the
  // extinguisher tag, where "the tag IS the record and a claim about it is
  // worth less than the picture" and the photo is taken on a PASS.
  //
  // N/A is exempt. An item that does not apply has nothing to photograph, and
  // demanding a picture of an absent pool gate is a gate nobody can pass.
  //
  // The escape hatch stays a REASON, never a silent skip: an unenforceable rule
  // produces a photograph of the floor, which is worse evidence than an honest
  // "camera failed".
  if (def.photo_required && answer?.result !== 'na' && !photoSatisfied(answer)) {
    return 'needs_photo'
  }

  return null
}
