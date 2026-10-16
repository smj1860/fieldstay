import { describe, it, expect, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { loadPacketModel, MAX_PACKET_WORK_ORDERS, type PacketModel, type RepairRecord } from '@/lib/evidence/packet/model'
import { renderClaimPacket, money } from '@/lib/evidence/packet/render'
import { createSupabaseDouble } from '../stubs/supabase-query-double'

const ORG = '11111111-1111-4111-8111-111111111111'
const BOOKING = '22222222-2222-4222-8222-222222222222'
const PROP = '33333333-3333-4333-8333-333333333333'
const wo = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`

const photo = (workOrderId: string | null) => ({
  id: 'e1', kind: 'photo_sealed', bucket: 'turnover-photos', storage_path: `${ORG}/a.jpg`, sha256: 'a'.repeat(64),
  hash_verified: true, byte_size: 10, captured_at: '2026-10-10T15:00:00Z', captured_at_source: 'server',
  device_captured_at: null, device_clock_offset_seconds: null, received_at: '2026-10-10T15:00:00Z',
  lat: null, lng: null, gps_accuracy_m: null, captured_by_kind: 'crew', captured_by_label: null,
  refers_to_event_id: null, work_order_id: workOrderId, metadata: { section_name: 'Kitchen', evidence_role: 'room_condition' },
})

interface Seed {
  photoWo?:     string | null
  byTurnover:   string[]
  details:      Record<string, unknown>[]
  lineItems?:   Record<string, unknown>[]
  invoices?:    Record<string, unknown>[]
}

function db(seed: Seed) {
  return createSupabaseDouble({
    bookings:      { data: { id: BOOKING, property_id: PROP, checkin_date: '2026-10-07', checkout_date: '2026-10-10', source: 'airbnb', external_id: 'HMABC' }, error: null },
    properties:    { data: { name: 'Lake House', address: '1 Lake Rd', city: 'Nashville', state: 'TN', timezone: 'America/Chicago' }, error: null },
    organizations: { data: { name: 'Acme Stays' }, error: null },
    evidence_stay_brackets: { data: [{ evidence_event_id: 'e1', position: 'post_stay' }], error: null },
    evidence_events: [
      { data: [photo(seed.photoWo ?? null)], error: null },   // the sealed photos
      { data: [], error: null },                              // withdrawals
    ],
    turnovers: { data: seed.byTurnover.length > 0 ? [{ id: 't1' }] : [], error: null },
    work_orders: [
      { data: seed.byTurnover.map((id) => ({ id })), error: null },
      { data: seed.details, error: null },
    ],
    work_order_line_items: { data: seed.lineItems ?? [], error: null },
    work_order_invoices:   { data: seed.invoices ?? [], error: null },
  }) as unknown as Parameters<typeof loadPacketModel>[0]
}

const detail = (id: string, over: Record<string, unknown> = {}) => ({
  id, wo_number: `WO-${id.slice(-3)}`, title: 'Fix the oven', status: 'completed', vendor_id: 'v1',
  completed_date: '2026-10-12', needed_by_date: null, vendors: { name: 'Acme Appliance LLC' }, ...over,
})

const load = (d: Parameters<typeof loadPacketModel>[0]) =>
  loadPacketModel(d, { orgId: ORG, bookingId: BOOKING, packetId: 'p1', eventIds: null, nowMs: Date.parse('2026-10-14T12:00:00Z') })

describe('claim packet repairs', () => {
  it('lists a work order found through a photo and one found through the turnover, each with how it was linked', async () => {
    const model = await load(db({
      photoWo: wo(1), byTurnover: [wo(2)],
      details: [detail(wo(1)), detail(wo(2), { title: 'Replace the lamp', completed_date: '2026-10-13', vendors: [{ name: 'Lamp Co' }] })],
      lineItems: [
        { work_order_id: wo(1), description: 'Oven element', line_type: 'material', quantity: '2', unit: 'ea', unit_cost: '40.00', line_total: '80.00', sort_order: 0 },
        { work_order_id: wo(1), description: 'Labor', line_type: 'labor', quantity: '1.5', unit: 'hr', unit_cost: '90.00', line_total: '135.00', sort_order: 1 },
      ],
      invoices: [{ work_order_id: wo(1), invoice_number: 'INV-77', total: '215.00', status: 'paid', paid_at: '2026-10-14T10:00:00Z' }],
    }))
    const byId = new Map<string, RepairRecord>(model!.repairs.map((r) => [r.work_order_id, r]))
    expect(byId.get(wo(1))).toMatchObject({ linked_via: 'photo', vendor_name: 'Acme Appliance LLC' })
    expect(byId.get(wo(2))).toMatchObject({ linked_via: 'turnover', vendor_name: 'Lamp Co' })   // array-shaped embed unwrapped
    expect(byId.get(wo(1))!.line_items.map((l) => l.line_total)).toEqual([80, 135])             // stored values, not recomputed
    expect(byId.get(wo(1))!.invoice).toMatchObject({ invoice_number: 'INV-77', total: 215, status: 'paid' })
    expect(model!.repairs.map((r) => r.work_order_id)).toEqual([wo(1), wo(2)])                  // oldest completion first
    expect(model!.repairsCapNote).toBeNull()
  })

  it('has no repairs, and no cap note, when nothing is tied to the stay', async () => {
    const model = await load(db({ byTurnover: [], details: [] }))
    expect(model!.repairs).toEqual([])
    expect(model!.repairsCapNote).toBeNull()
  })

  it('lists a work order with no line items and no invoice, and names no vendor when none is assigned', async () => {
    const model = await load(db({ byTurnover: [wo(3)], details: [detail(wo(3), { vendor_id: null, vendors: null })] }))
    expect(model!.repairs[0]).toMatchObject({ line_items: [], invoice: null, vendor_name: null, linked_via: 'turnover' })
  })

  it('lists at most MAX_PACKET_WORK_ORDERS and says how many were left out', async () => {
    const ids = Array.from({ length: MAX_PACKET_WORK_ORDERS + 1 }, (_, i) => wo(i + 1))
    const model = await load(db({ byTurnover: ids, details: ids.slice(0, MAX_PACKET_WORK_ORDERS).map((id) => detail(id)) }))
    expect(model!.repairs).toHaveLength(MAX_PACKET_WORK_ORDERS)
    expect(model!.repairsCapNote).toContain('1 further work order(s)')
  })

  it('rejects a booking id that is not a UUID before it reaches a filter string', async () => {
    const d = db({ byTurnover: [], details: [] })
    await expect(loadPacketModel(d, { orgId: ORG, bookingId: 'x,or(1=1)', packetId: 'p', eventIds: null, nowMs: 0 }))
      .rejects.toThrow(/UUID/)
  })
})

describe('money', () => {
  it('formats stored amounts with thousands separators and two decimals', () => {
    expect(money(1234.5)).toBe('$1,234.50')
    expect(money(0)).toBe('$0.00')
    expect(money(1234567.891)).toBe('$1,234,567.89')
  })
})

describe('Repairs section rendering', () => {
  const base = (repairs: RepairRecord[]): PacketModel => ({
    packetId: 'p1', generatedAt: '2026-10-14T12:00:00Z', org: { name: 'Acme Stays' },
    property: { name: 'Lake House', address: null, timezone: 'America/Chicago' },
    stay: { bookingId: BOOKING, checkin: '2026-10-07', checkout: '2026-10-10', source: 'airbnb', reservationRef: 'HMABC' },
    pairs: [], others: [], omittedCount: 0, capNote: null, custody: [], repairs, repairsCapNote: null,
  })
  const repair = (over: Partial<RepairRecord> = {}): RepairRecord => ({
    work_order_id: wo(1), wo_number: 'WO-0001', title: 'Fix the oven', status: 'completed', vendor_name: 'Acme Appliance LLC',
    completed_date: '2026-10-12', needed_by_date: null, line_items: [], invoice: null, linked_via: 'photo', ...over,
  })

  it('adds pages for repairs and survives a very long description and non-WinAnsi text', async () => {
    const without = await PDFDocument.load(await renderClaimPacket(base([]), async () => null))
    const long = 'Replace the entire oven control board and wiring harness '.repeat(8)
    const bytes = await renderClaimPacket(base([repair({
      title: 'Oven 🔥', line_items: [{ description: long, line_type: 'labor', quantity: 1, unit: 'ea', unit_cost: 1234.5, line_total: 1234.5 }],
      invoice: { invoice_number: null, total: 1234.5, status: 'sent', paid_at: null },
    })]), async () => null)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(without.getPageCount())
  })

  it('renders a work order with no line items without throwing', async () => {
    await expect(renderClaimPacket(base([repair()]), async () => null)).resolves.toBeInstanceOf(Uint8Array)
  })

  it('paginates many work orders instead of running off the page', async () => {
    const many = Array.from({ length: 20 }, (_, i) => repair({
      work_order_id: wo(i + 1),
      line_items: Array.from({ length: 6 }, () => ({ description: 'Part', line_type: 'material', quantity: 1, unit: null, unit_cost: 10, line_total: 10 })),
    }))
    const doc = await PDFDocument.load(await renderClaimPacket(base(many), async () => null))
    expect(doc.getPageCount()).toBeGreaterThan(3)
  })
})
