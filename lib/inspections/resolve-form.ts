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
  PropertyFactKey,
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
  /**
   * Property-level facts the two item gates read (20260824194339).
   *
   * `null` means NEVER ASKED, which is what makes the capture item render, and
   * it is distinct from `false` ("asked, and there is no alarm"). An OMITTED
   * key is treated as null for the same reason `assets` defaults to empty: the
   * safe direction is asking a question one extra time, never silently dropping
   * one.
   */
  propertyFacts?: Readonly<Partial<Record<PropertyFactKey, boolean | null>>>
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

/**
 * A parent instance's identity, which its children MUST inherit.
 *
 * `answerKey` is `(formItemId, repeatIndex, assetId)`. A child built without
 * its parent's asset or repeat index therefore keys on the form item alone, so
 * EVERY instance of that child shares ONE answer.
 *
 * That was live: the generic per-asset sweep carries a `plate_photo` child, so
 * on a property with five uncovered assets all five rows shared a single photo
 * — photograph the generator's plate and the septic row shows a photo attached.
 * The same shape would merge extinguisher #1's follow-up with #2's.
 */
interface ParentInstance {
  asset?:       PropertyAsset
  repeatIndex?: number
}

function buildChildren(
  parent: InspectionFormItem,
  byParent: ReadonlyMap<string, InspectionFormItem[]>,
  inherit: ParentInstance = {},
): ResolvedItem[] {
  return (byParent.get(parent.id) ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((child) => ({
      formItem: child,
      ...(inherit.asset       !== undefined && { asset: inherit.asset }),
      ...(inherit.repeatIndex !== undefined && { repeatIndex: inherit.repeatIndex }),
      children: [],
    }))
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
      out.push({
        formItem: member,
        repeatIndex: i,
        children: buildChildren(member, byParent, { repeatIndex: i }),
      })
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

    const roots = (index.bySection.get(section.id) ?? [])
      .filter((item) => itemPassesFactGate(item, input.propertyFacts ?? {}))
      .slice().sort(bySortOrder)
    const items = roots.flatMap((root) =>
      resolveRoot(root, { index, activeAssets, sweepable, counts }))

    // A section that resolves to nothing is not a page. The assets section on a
    // property with no uncovered assets is the real case: rendering it would be
    // an empty page with a Next button and no explanation.
    if (items.length === 0) continue

    pages.push({ sectionId: section.id, sectionKey: section.key, name: section.name, items })
  }

  return pages
}

/**
 * The two property-fact gates (20260824194339).
 *
 * `asks_property_fact`       — the CAPTURE question. Shown only while the fact
 *                              is unknown; answering it is what sets the fact,
 *                              so it appears on a property's first walk and
 *                              never again.
 * `shown_when_property_fact` — the CONDITION question. Shown only where the
 *                              fact is TRUE, on every walk. It deliberately
 *                              does not drop off: a monitoring contract lapses
 *                              far more often than a panel is removed.
 *
 * An UNRECOGNISED key renders NOTHING, matching how `sectionIsShown` treats an
 * unrecognised `shown_when_asset` — a corrupt snapshot should degrade to a
 * missing question, not a crash. Reached only via a snapshot, since a live
 * write is rejected by inspection_form_items_known_property_facts.
 */
function itemPassesFactGate(
  item:  InspectionFormItem,
  facts: Readonly<Partial<Record<PropertyFactKey, boolean | null>>>,
): boolean {
  if (item.asks_property_fact) {
    return isKnownFact(item.asks_property_fact)
      && (facts[item.asks_property_fact] ?? null) === null
  }
  if (item.shown_when_property_fact) {
    return isKnownFact(item.shown_when_property_fact)
      && facts[item.shown_when_property_fact] === true
  }
  return true
}

/** Guards the snapshot path, where the column's CHECK constraint does not reach. */
function isKnownFact(key: string): key is PropertyFactKey {
  return key === 'has_security_system'
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

/**
 * Every asset type a NAMED item already asks about, anywhere on the form.
 *
 * No longer excludes `repeat_per_asset` items, because a named question can now
 * BE one (see resolveRoot). What makes a type "covered" is that some item names
 * it, not how that item renders — and with the old guard, flagging the fridge
 * question per-unit would have dropped refrigerators out of this set and let
 * the generic sweep ask about them a second time.
 */
function coveredAssetTypes(items: InspectionFormItem[]): ReadonlySet<string> {
  return new Set(
    items.filter((i) => i.asset_type).map((i) => i.asset_type as string),
  )
}

interface ResolveCtx {
  index:        ItemIndex
  /** Every active asset, for a NAMED per-unit question. */
  activeAssets: PropertyAsset[]
  /** Only those no named question covers, for the GENERIC sweep. */
  sweepable:    PropertyAsset[]
  counts:       Readonly<Record<string, number>>
}

/** One root item becomes one row, N per-asset rows, or a row plus its repeat group. */
function resolveRoot(root: InspectionFormItem, ctx: ResolveCtx): ResolvedItem[] {
  if (root.per_unit || root.repeat_per_asset) return resolvePerAsset(root, ctx)

  const self: ResolvedItem = { formItem: root, children: buildChildren(root, ctx.index.byParent) }
  const members = ctx.index.byRepeatSource.get(root.id)
  if (!members?.length) return [self]

  const count = Math.min(MAX_REPEAT_INSTANCES, Math.max(0, Math.floor(ctx.counts[root.id] ?? 0)))
  return [self, ...buildRepeatGroup(members, count, ctx.index.byParent)]
}

/**
 * The two per-asset modes. Different rules, not degrees of one.
 *
 * `per_unit` is a NAMED question about a kind of thing, rendered once per
 * active asset of that kind. "Refrigeration — clean, holding < 40°F" applies
 * to both refrigerators, and asking it once was asking about one of them and
 * silently not the other, with nothing on screen to say which.
 *
 * `repeat_per_asset` is the GENERIC sweep, covering every active asset no named
 * question already claims (§12.2 §7).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ZERO CASE IS DIFFERENT FOR THE TWO, AND DELIBERATELY SO.
 *
 * The generic sweep with nothing to sweep is no rows — there is no question to
 * ask, and the section collapses.
 *
 * A NAMED question with no matching asset still renders, ONCE, unattributed.
 * Most properties have not catalogued their appliances at all — 8 of 29 in
 * production have no assets on file — so gating these on the ledger would
 * silently delete most of the Indoor form from most properties. That is the
 * same failure the HOA gate taught: a gate on data nobody has populated does
 * not fail safe, it fails empty. The inspector answers it as they do today, and
 * marks it N/A where the property genuinely lacks the thing.
 */
function resolvePerAsset(root: InspectionFormItem, ctx: ResolveCtx): ResolvedItem[] {
  // `per_unit` is the named form and carries an asset_type by DB CHECK
  // (inspection_form_items_per_unit_needs_type). Reading the type rather than
  // the flag would silently turn a mis-seeded per_unit row into a full sweep.
  const named = !!root.per_unit && !!root.asset_type

  const targets = named
    ? ctx.activeAssets.filter((a) => a.asset_type === root.asset_type)
    : ctx.sweepable

  if (targets.length === 0) {
    return named ? [{ formItem: root, children: buildChildren(root, ctx.index.byParent) }] : []
  }

  return targets.map((asset) => ({
    formItem: root,
    asset,
    // The asset is inherited, so "→ which room?" under fridge #2 is its own
    // answer rather than one shared with fridge #1.
    children: buildChildren(root, ctx.index.byParent, { asset }),
  }))
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
