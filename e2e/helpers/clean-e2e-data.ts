import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database }       from '../../types/database.generated'

type ServiceClient = SupabaseClient<Database>

/**
 * Delete every `[E2E]`-prefixed row in the test org, in FK-safe order.
 *
 * Shared by global-setup (pre-run clean slate) and global-teardown (post-run
 * sweep) so the two can never drift apart — they previously carried two
 * separate, subtly different copies of this list.
 *
 * ── Why the money-bearing tables come first, and why errors now throw ─────
 * `20260730107000_fk_on_delete_corrections.sql` deliberately moved
 * `owner_transactions.property_id`, `purchase_orders.property_id`, and all
 * three `work_order_invoices` FKs (property_id, vendor_id, work_order_id)
 * off CASCADE/RESTRICT onto ON DELETE NO ACTION: deleting a property or a
 * work order must never silently erase the financial record attached to it.
 * That is correct for the product — but it means these rows now BLOCK the
 * property/vendor/work-order deletes below instead of being swept along
 * with them, and this function used to ignore every delete's error result.
 *
 * The failure mode that produced was invisible and cumulative: from the
 * moment 21-work-order-offline.spec.ts first wrote a `work_order_invoices`
 * row, every subsequent run's cleanup failed silently, seed data piled up,
 * and ~17 specs started failing on Playwright strict-mode violations
 * (`resolved to 4 elements`) and `.single()` "Cannot coerce the result to a
 * single JSON object". So: delete the ledger rows explicitly first, and
 * throw on any error — a cleanup that cannot clean must fail the run loudly
 * rather than hand the next run a dirty database.
 */
export async function cleanE2EData(supabase: ServiceClient, orgId: string): Promise<void> {
  const propertyIds  = await e2eIds(supabase, orgId, 'properties',   'name')
  const vendorIds    = await e2eIds(supabase, orgId, 'vendors',      'name')
  const workOrderIds = await e2eIds(supabase, orgId, 'work_orders',  'title')

  // ── 1. Money-bearing children (ON DELETE NO ACTION — never cascaded) ────
  // Scoped by every FK that points at something this function is about to
  // delete, so a row attached to any one of them is cleared regardless of
  // which column links it.
  await del('work_order_invoices (by property)',   supabase.from('work_order_invoices').delete().eq('org_id', orgId).in('property_id',    propertyIds))
  await del('work_order_invoices (by vendor)',     supabase.from('work_order_invoices').delete().eq('org_id', orgId).in('vendor_id',      vendorIds))
  await del('work_order_invoices (by work order)', supabase.from('work_order_invoices').delete().eq('org_id', orgId).in('work_order_id',  workOrderIds))
  await del('owner_transactions',                  supabase.from('owner_transactions') .delete().eq('org_id', orgId).in('property_id',    propertyIds))
  await del('purchase_orders',                     supabase.from('purchase_orders')    .delete().eq('org_id', orgId).in('property_id',    propertyIds))

  // ── 2. The [E2E] records themselves, parents last ───────────────────────
  // communication_logs stays first (its vendor_id FK is ON DELETE SET NULL,
  // so a surviving row would silently lose its vendor link rather than be
  // removed) — 16-comms-log.spec.ts asserts on an empty log.
  await del('communication_logs', supabase.from('communication_logs').delete().eq('org_id', orgId).like('subject',    '[E2E]%'))
  await del('work_orders',        supabase.from('work_orders')       .delete().eq('org_id', orgId).like('title',      '[E2E]%'))
  await del('bookings',           supabase.from('bookings')          .delete().eq('org_id', orgId).like('guest_name', '[E2E]%'))
  await del('crew_members',       supabase.from('crew_members')      .delete().eq('org_id', orgId).like('name',       '[E2E]%'))
  await del('vendors',            supabase.from('vendors')           .delete().eq('org_id', orgId).like('name',       '[E2E]%'))
  // Properties cascade to bookings, turnovers, turnover_assignments,
  // checklist_instances/items, property_owners, maintenance_schedules and
  // the guidebook property configs.
  await del('properties',         supabase.from('properties')        .delete().eq('org_id', orgId).like('name',       '[E2E]%'))
}

/** Ids of every `[E2E]`-prefixed row in one table, for FK-scoped child deletes. */
async function e2eIds(
  supabase: ServiceClient,
  orgId:    string,
  table:    'properties' | 'vendors' | 'work_orders',
  labelCol: 'name' | 'title',
): Promise<string[]> {
  const { data, error } = await supabase
    .from(table)
    .select('id')
    .eq('org_id', orgId)
    .like(labelCol, '[E2E]%')

  if (error) throw new Error(`cleanE2EData: could not list [E2E] ${table}: ${error.message}`)
  // `.in('col', [])` is a valid no-op filter, but a sentinel keeps the
  // generated PostgREST query well-formed across client versions.
  const ids = (data ?? []).map((row) => row.id)
  return ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000']
}

async function del(label: string, query: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await query
  if (error) throw new Error(`cleanE2EData: failed to delete ${label}: ${error.message}`)
}
