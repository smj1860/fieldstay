import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { logSystemCommunication } from '@/lib/comms-log'
import { createServiceClient } from '@/lib/supabase/server'

function makeSupabase() {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const insert = vi.fn((args: unknown) => {
    calls.push({ table: 'communication_logs', method: 'insert', args: [args] })
    return Promise.resolve({ data: null, error: null })
  })
  const from = vi.fn((_table: string) => ({ insert }))
  return { from, insert, calls }
}

describe('logSystemCommunication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T14:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('inserts a row into communication_logs scoped to org_id, with source "system" and no logged_by_user_id', async () => {
    const supabase = makeSupabase()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await logSystemCommunication({
      org_id:         'org_1',
      recipient_type: 'vendor',
      vendor_id:      'vendor_1',
      channel:        'email',
      subject:        'Work order assigned',
      body:           'You have been assigned WO-1042.',
      property_id:    'prop_1',
      work_order_id:  'wo_1',
    })

    expect(supabase.from).toHaveBeenCalledWith('communication_logs')
    expect(supabase.insert).toHaveBeenCalledWith({
      org_id:            'org_1',
      recipient_type:    'vendor',
      vendor_id:         'vendor_1',
      crew_member_id:    null,
      channel:           'email',
      subject:           'Work order assigned',
      body:              'You have been assigned WO-1042.',
      property_id:       'prop_1',
      work_order_id:     'wo_1',
      source:            'system',
      logged_by_user_id: null,
      communicated_at:   '2026-07-22T14:00:00.000Z',
    })
  })

  it('defaults every optional field to null when omitted', async () => {
    const supabase = makeSupabase()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await logSystemCommunication({
      org_id:         'org_1',
      recipient_type: 'crew',
      channel:        'note',
      subject:        'Auto-logged',
    })

    expect(supabase.insert).toHaveBeenCalledWith(expect.objectContaining({
      vendor_id:      null,
      crew_member_id: null,
      body:           null,
      property_id:    null,
      work_order_id:  null,
    }))
  })

  it('sets recipient_type/crew_member_id for a crew-directed communication', async () => {
    const supabase = makeSupabase()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await logSystemCommunication({
      org_id:          'org_1',
      recipient_type:  'crew',
      crew_member_id:  'crew_1',
      channel:         'sms',
      subject:         'Turnover reminder',
    })

    expect(supabase.insert).toHaveBeenCalledWith(expect.objectContaining({
      recipient_type: 'crew',
      crew_member_id: 'crew_1',
      vendor_id:      null,
      channel:        'sms',
    }))
  })

  it('stamps communicated_at with the current time in ISO format', async () => {
    const supabase = makeSupabase()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    await logSystemCommunication({
      org_id:         'org_1',
      recipient_type: 'vendor',
      channel:        'phone',
      subject:        'Called re: quote',
    })

    expect(supabase.insert).toHaveBeenCalledWith(expect.objectContaining({
      communicated_at: '2026-01-01T00:00:00.000Z',
    }))
  })
})
