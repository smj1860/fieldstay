/**
 * Shared between the server action and the client table. Kept out of
 * actions.ts because that file is 'use server' — every export there has to be
 * an async function, so plain constants and types cannot live in it.
 *
 * PROSPECT_STATUSES must stay in sync with the prospect_accounts_status_check
 * constraint in 20260919120000_prospect_accounts.sql. Adding a stage means
 * editing both; the CHECK is what actually enforces it, this is what the
 * dropdown offers.
 */
export const PROSPECT_STATUSES = [
  'new',
  'researching',
  'needs_contact_info',
  'queued',
  'emailed',
  'called',
  'texted',
  'visited_no_contact',
  'replied',
  'meeting_set',
  'in_trial',
  'won',
  'lost',
  'disqualified',
] as const

export type ProspectStatus = (typeof PROSPECT_STATUSES)[number]

export const PROSPECT_STATUS_LABELS: Record<ProspectStatus, string> = {
  new:                'New',
  researching:        'Researching',
  needs_contact_info: 'Needs contact info',
  queued:             'Queued to send',
  emailed:            'Emailed',
  called:             'Called',
  texted:             'Texted',
  visited_no_contact: 'Visited — no contact',
  replied:            'Replied',
  meeting_set:        'Meeting set',
  in_trial:           'In trial',
  won:                'Won',
  lost:               'Lost',
  disqualified:       'Disqualified',
}

/** Rows in these stages are done; the default view hides them. */
export const CLOSED_STATUSES: readonly ProspectStatus[] = ['won', 'lost', 'disqualified']

export interface ProspectRow {
  id:                    string
  company:               string
  domain:                string | null
  website:               string | null
  city:                  string | null
  state:                 string | null
  market:                string | null
  portfolio_size:        number | null
  pms:                   string | null
  pms_note:              string | null
  score_a:               number | null
  score_b:               number | null
  track:                 string | null
  bucket:                string | null
  contact_name:          string | null
  contact_title:         string | null
  email:                 string | null
  email_is_generic:      boolean | null
  phone:                 string | null
  linkedin_url:          string | null
  status:                ProspectStatus
  status_note:           string | null
  notes:                 string | null
  last_touch_at:         string | null
  next_action_at:        string | null
  comparent_url:         string | null
  last_crawled_at:       string | null
  crawl_status:          string | null
}

/**
 * One row of prospect_touches — an append-only outreach log entry, distinct
 * from status (which only ever remembers the CURRENT stage) and from
 * last_touch_at (which only ever remembers the MOST RECENT touch).
 */
export const TOUCH_TYPES = [
  'emailed',
  'called',
  'texted',
  'visited_no_contact',
  'replied',
  'meeting_set',
  'note',
] as const

export type TouchType = (typeof TOUCH_TYPES)[number]

export const TOUCH_TYPE_LABELS: Record<TouchType, string> = {
  emailed:             'Emailed',
  called:              'Called',
  texted:              'Texted',
  visited_no_contact:  'Visited — no contact',
  replied:             'Replied',
  meeting_set:         'Meeting set',
  note:                'Note',
}

/**
 * The subset of statuses that represent an actual interaction event (either
 * we reached out, or the prospect did something) — the statuses this list
 * logs a prospect_touches row for. Administrative funnel moves ('new' ->
 * 'researching' -> 'queued', etc.) are not touches and are not logged.
 */
export const TOUCH_LOGGING_STATUSES: ReadonlySet<ProspectStatus> = new Set([
  'emailed', 'called', 'texted', 'visited_no_contact', 'replied', 'meeting_set',
])

export interface ProspectTouch {
  id:          string
  prospect_id: string
  touch_type:  TouchType
  note:        string | null
  occurred_at: string
}

export type ProspectEditableFields = Pick<
  ProspectRow,
  | 'company' | 'domain' | 'website' | 'city' | 'state' | 'market'
  | 'pms' | 'pms_note' | 'contact_name' | 'contact_title' | 'email'
  | 'phone' | 'linkedin_url' | 'status' | 'status_note' | 'notes'
  | 'next_action_at'
>
