import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

import { getRoomTemplatesForOrg } from '@/lib/room-templates/get-room-templates'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(response: Resp) {
  const calls: { method: string; args: unknown[] }[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  for (const m of ['select', 'eq', 'order']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push({ method: m, args })
      return chain
    })
  }
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(response).then(resolve)
  return { from: vi.fn(() => chain), calls }
}

describe('getRoomTemplatesForOrg', () => {
  beforeEach(() => vi.clearAllMocks())

  it('scopes the query to the given org and orders by name', async () => {
    const supabase = makeSupabase({ data: [], error: null })

    await getRoomTemplatesForOrg(supabase as never, 'org_1')

    expect(supabase.calls.some((c) => c.method === 'eq' && c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
    expect(supabase.calls.some((c) => c.method === 'order' && c.args[0] === 'name')).toBe(true)
  })

  it('reshapes the nested join into RoomLibraryBuilder camelCase shape', async () => {
    const supabase = makeSupabase({
      data: [{
        id: 'room_1', name: 'Kitchen', auto_include: true,
        room_template_items: [
          { id: 'item_2', task: 'Wipe counters', requires_photo: false, notes: null, sort_order: 2 },
          { id: 'item_1', task: 'Check fridge temp', requires_photo: true, notes: 'Use the probe thermometer', sort_order: 1 },
        ],
      }],
      error: null,
    })

    const result = await getRoomTemplatesForOrg(supabase as never, 'org_1')

    expect(result).toEqual([{
      id: 'room_1',
      name: 'Kitchen',
      autoInclude: true,
      items: [
        { id: 'item_1', task: 'Check fridge temp', requires_photo: true, notes: 'Use the probe thermometer' },
        { id: 'item_2', task: 'Wipe counters', requires_photo: false, notes: '' },
      ],
    }])
  })

  it('sorts items by sort_order regardless of the order returned by the query', async () => {
    const supabase = makeSupabase({
      data: [{
        id: 'room_1', name: 'Bath', auto_include: false,
        room_template_items: [
          { id: 'c', task: 'Task C', requires_photo: false, notes: null, sort_order: 3 },
          { id: 'a', task: 'Task A', requires_photo: false, notes: null, sort_order: 1 },
          { id: 'b', task: 'Task B', requires_photo: false, notes: null, sort_order: 2 },
        ],
      }],
      error: null,
    })

    const result = await getRoomTemplatesForOrg(supabase as never, 'org_1')

    expect(result[0]!.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('coerces a null notes field to an empty string', async () => {
    const supabase = makeSupabase({
      data: [{
        id: 'room_1', name: 'Bath', auto_include: false,
        room_template_items: [{ id: 'a', task: 'Task', requires_photo: false, notes: null, sort_order: 0 }],
      }],
      error: null,
    })

    const result = await getRoomTemplatesForOrg(supabase as never, 'org_1')
    expect(result[0]!.items[0]!.notes).toBe('')
  })

  it('returns an empty array when the query errors, and logs the error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = makeSupabase({ data: null, error: { message: 'boom' } })

    const result = await getRoomTemplatesForOrg(supabase as never, 'org_1')

    expect(result).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith('[getRoomTemplatesForOrg]', { message: 'boom' })
    errorSpy.mockRestore()
  })

  it('returns an empty array when rooms is null with no error', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    const result = await getRoomTemplatesForOrg(supabase as never, 'org_1')
    expect(result).toEqual([])
  })

  it('handles a room with no room_template_items (null join result) as an empty items array', async () => {
    const supabase = makeSupabase({
      data: [{ id: 'room_1', name: 'Empty Room', auto_include: false, room_template_items: null }],
      error: null,
    })

    const result = await getRoomTemplatesForOrg(supabase as never, 'org_1')
    expect(result[0]!.items).toEqual([])
  })
})
