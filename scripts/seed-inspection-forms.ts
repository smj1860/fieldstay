/**
 * Projects the three platform-owned inspection forms from the repo into
 * inspection_forms / _sections / _items.
 *
 * Usage:
 *   pnpm exec tsx scripts/seed-inspection-forms.ts --dry-run
 *   pnpm exec tsx scripts/seed-inspection-forms.ts
 *
 * --dry-run touches no database and needs no credentials: it flattens every
 * form, resolves every parent and repeat reference, and prints what would be
 * written. A malformed definition fails there rather than halfway through a
 * write.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPSERT ONLY. NEVER DELETE.
 *
 * docs/INSPECTIONS_SPEC.md §9: `inspection_items` rows carry a real FK to
 * `inspection_form_items`, so re-creating a form's rows with fresh ids would
 * orphan every answer ever recorded against it. `key` is the stable identity;
 * the row id is not. There is no delete anywhere in this file, and the orphan
 * check below fails the run rather than reaching for one.
 *
 * WHY IT IS SAFE TO RE-RUN AT ANY TIME
 *
 * Every write is an upsert on a real unique constraint — (key, version),
 * (form_id, key), (section_id, key) — so a re-run is a no-op when nothing
 * changed, and a partial run (a cancelled job, a network drop) is completed by
 * the next one. That is the difference from seed-support-kb.ts, which deletes
 * before inserting and therefore has a window where the data is gone.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { INSPECTION_FORMS } from '../lib/inspections/forms'
import type { FormDefinition, ItemDefinition } from '../lib/inspections/forms/types'

const DRY_RUN = process.argv.includes('--dry-run')

/**
 * The only two projects this may write to. Unlike the support KB — which is
 * production-only, because seeding it changes what Finn tells live customers —
 * the form definitions are needed on BOTH: the E2E project runs the inspection
 * flows, and a form missing there fails as a UI bug rather than a data one.
 *
 * An allowlist rather than a single guard, because "whatever URL the
 * environment happened to hold" is not an acceptable target for a service-role
 * write loop.
 */
const ALLOWED_PROJECT_REFS: Record<string, string> = {
  vpmznjktllhmmbfnxuvk: 'production',
  syhthijeqlnltufdawyb: 'E2E',
}

// ── Flatten the definitions into rows, resolving structure ──────────────────

interface FlatItem {
  section_key: string
  /** null for a root; the parent's key for a child or repeat-group member. */
  parent_key:  string | null
  relation:    'root' | 'child' | 'repeat'
  sort_order:  number
  def:         ItemDefinition
}

function flattenForm(form: FormDefinition): FlatItem[] {
  const out: FlatItem[] = []
  for (const section of form.sections) {
    section.items.forEach((root, rootIndex) => {
      out.push({ section_key: section.key, parent_key: null, relation: 'root', sort_order: rootIndex, def: root })

      ;(root.children ?? []).forEach((child, i) => {
        out.push({ section_key: section.key, parent_key: root.key, relation: 'child', sort_order: i, def: child })
      })
      ;(root.repeats ?? []).forEach((rep, i) => {
        out.push({ section_key: section.key, parent_key: root.key, relation: 'repeat', sort_order: i, def: rep })
      })
    })
  }
  return out
}

/** The row body shared by every pass — everything except the two self-FKs. */
function itemColumns(flat: FlatItem, sectionId: string) {
  const d = flat.def
  return {
    section_id:     sectionId,
    key:            d.key,
    prompt:         d.prompt,
    sort_order:     flat.sort_order,
    response_type:  d.response_type  ?? 'yes_no',
    is_required:    d.is_required    ?? true,
    photo_required: d.photo_required ?? false,
    show_when:          d.show_when          ?? null,
    repeat_per_asset:   d.repeat_per_asset   ?? false,
    na_reason_template: d.na_reason_template ?? null,
    na_asset_type:      d.na_asset_type      ?? null,
    asset_type:         d.asset_type         ?? null,
    concern_key:        d.concern_key        ?? null,
    remediation:        d.remediation,
    default_actions:    d.default_actions,
    wo_category:        d.wo_category ?? null,
    wo_priority:        d.wo_priority ?? null,
  }
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * `{ error }` destructured on every call, never a bare `await`. PostgREST
 * RESOLVES with an error rather than throwing, so a try/catch around these
 * would read as protection while never firing — and a seed that silently wrote
 * nothing leaves a form that renders as empty rather than as broken.
 */
function must<T>(what: string, res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  if (res.data === null) throw new Error(`${what}: returned no rows`)
  return res.data
}

async function seedForm(supabase: SupabaseClient, form: FormDefinition): Promise<void> {
  // 1. The form itself, keyed on (key, version). A reworded item ships as a NEW
  //    version, so this upsert only ever touches metadata within a version.
  const [formRow] = must('upsert form', await supabase
    .from('inspection_forms')
    .upsert(
      { key: form.key, name: form.name, description: form.description, version: form.version, is_active: true, updated_at: new Date().toISOString() },
      { onConflict: 'key,version' },
    )
    .select('id')) as { id: string }[]

  const formId = formRow!.id

  // 2. Sections, one batched upsert.
  const sectionRows = must('upsert sections', await supabase
    .from('inspection_form_sections')
    .upsert(
      form.sections.map((s, i) => ({
        form_id:    formId,
        key:        s.key,
        name:       s.name,
        sort_order: i,
        // Explicit null, not omission: this is an UPSERT, so a section that
        // loses its gate must actively clear the column rather than keep the
        // one written by the previous seed.
        shown_when_asset:          s.shown_when_asset          ?? null,
      })),
      { onConflict: 'form_id,key' },
    )
    .select('id, key')) as { id: string; key: string }[]

  const sectionIdByKey = new Map(sectionRows.map((r) => [r.key, r.id]))

  const flat = flattenForm(form)

  // 3. ROOTS FIRST, in one batch. Children and repeat-group members reference a
  //    root's id, and a root can never reference a child, so dependency order
  //    is one pass rather than insert-then-backfill. Batched, not looped: a
  //    query per item would be the N+1 shape unit/guardrails/n-plus-one-loops
  //    exists to catch, at ~137 round trips.
  const roots = flat.filter((f) => f.relation === 'root')
  const rootRows = must('upsert root items', await supabase
    .from('inspection_form_items')
    .upsert(
      roots.map((f) => ({
        ...itemColumns(f, sectionIdByKey.get(f.section_key)!),
        parent_item_id: null,
        repeat_source_item_id: null,
      })),
      { onConflict: 'section_id,key' },
    )
    .select('id, key')) as { id: string; key: string }[]

  const itemIdByKey = new Map(rootRows.map((r) => [r.key, r.id]))

  // 4. Children and repeat members, each in one batch, with the parent resolved.
  const children = flat.filter((f) => f.relation === 'child')
  if (children.length > 0) {
    must('upsert child items', await supabase
      .from('inspection_form_items')
      .upsert(
        children.map((f) => ({
          ...itemColumns(f, sectionIdByKey.get(f.section_key)!),
          parent_item_id: itemIdByKey.get(f.parent_key!)!,
          repeat_source_item_id: null,
        })),
        { onConflict: 'section_id,key' },
      )
      .select('id'))
  }

  const repeats = flat.filter((f) => f.relation === 'repeat')
  if (repeats.length > 0) {
    must('upsert repeat items', await supabase
      .from('inspection_form_items')
      .upsert(
        repeats.map((f) => ({
          ...itemColumns(f, sectionIdByKey.get(f.section_key)!),
          parent_item_id: null,
          repeat_source_item_id: itemIdByKey.get(f.parent_key!)!,
        })),
        { onConflict: 'section_id,key' },
      )
      .select('id'))
  }

  // 5. ORPHAN CHECK — a row in this version that the repo no longer defines.
  //
  //    Deleting it is not an option: answers point at it. Ignoring it is worse
  //    than it sounds, because the RENDERER reads the database, so a question
  //    the repo believes it removed would keep being asked with nobody able to
  //    find where it comes from. So: fail, and say what the remedy is.
  const liveRows = must('read back items', await supabase
    .from('inspection_form_items')
    .select('key, section_id')
    .in('section_id', [...sectionIdByKey.values()])
    .limit(1000)) as { key: string }[]

  const defined = new Set(flat.map((f) => f.def.key))
  const orphans = liveRows.filter((r) => !defined.has(r.key)).map((r) => r.key)
  if (orphans.length > 0) {
    throw new Error(
      `Form "${form.key}" v${form.version} has ${orphans.length} item(s) in the ` +
      `database that the repo no longer defines: ${orphans.join(', ')}.\n` +
      '  They were NOT deleted — inspection_items rows reference them, and ' +
      'removing them would orphan every answer ever recorded.\n' +
      '  Removing or renaming an item is a NEW form version, not an edit. Bump ' +
      `inspection_forms.version for "${form.key}" and re-run.`,
    )
  }

  console.log(`  ${form.key} v${form.version}: ${form.sections.length} sections, ${flat.length} items`)
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Structure and reference resolution first, with no credentials involved, so
  // a malformed definition fails before anything is written.
  let total = 0
  for (const form of INSPECTION_FORMS) {
    const flat = flattenForm(form)
    const keys = flat.map((f) => f.def.key)
    if (new Set(keys).size !== keys.length) {
      throw new Error(`Form "${form.key}" has duplicate item keys`)
    }
    for (const f of flat) {
      if (f.parent_key && !keys.includes(f.parent_key)) {
        throw new Error(`Item "${f.def.key}" references missing parent "${f.parent_key}"`)
      }
    }
    total += flat.length
    console.log(
      `${form.key} v${form.version}: ${form.sections.length} sections, ` +
      `${flat.filter((f) => f.relation === 'root').length} root + ` +
      `${flat.filter((f) => f.relation !== 'root').length} nested = ${flat.length} items`,
    )
  }
  console.log(`${total} items across ${INSPECTION_FORMS.length} forms.`)

  if (DRY_RUN) {
    console.log('\n--dry-run — nothing written.')
    return
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
    process.exit(1)
  }

  const ref   = Object.keys(ALLOWED_PROJECT_REFS).find((r) => url.includes(r))
  const label = ref ? ALLOWED_PROJECT_REFS[ref] : null
  if (!label) {
    console.error(
      'Refusing to run: NEXT_PUBLIC_SUPABASE_URL does not name a known FieldStay ' +
      `project. Expected one of: ${Object.keys(ALLOWED_PROJECT_REFS).join(', ')}.`,
    )
    process.exit(1)
  }

  console.log(`\nSeeding the ${label} project...`)
  const supabase = createClient(url, key)
  for (const form of INSPECTION_FORMS) await seedForm(supabase, form)
  console.log('Done.')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
