/**
 * Mapping a spreadsheet's headers onto prospect_accounts columns.
 *
 * A LEAF module (imports nothing) so the admin import wizard can run it in
 * the browser and scripts/import-prospects.ts in node.
 *
 * Header names differ between the queue CSVs and the master sheet ("Owner /
 * Decision Maker" vs contact_name, pms_f vs pms_n vs PMS). Each target column
 * lists its accepted source names in priority order, so one importer reads
 * every file the scorer produces — and the admin wizard starts from the same
 * guess and lets a person correct it.
 */

/** Every column an import can write, in the order the wizard lists them. */
export const IMPORT_FIELDS = [
  'company', 'domain', 'website', 'comparent_url',
  'city', 'state', 'market', 'region',
  'portfolio_size', 'portfolio_size_method',
  'pms', 'pms_note', 'ops_software',
  'score_a', 'score_b', 'track', 'bucket', 'gate',
  'contact_name', 'contact_title', 'email', 'phone', 'linkedin_url',
  'source', 'source_url',
] as const

export type ImportField = (typeof IMPORT_FIELDS)[number]

/** How the wizard names each field. */
export const FIELD_LABELS: Readonly<Record<ImportField, string>> = {
  company:               'Company name',
  domain:                'Domain',
  website:               'Website',
  comparent_url:         'Comparent URL',
  city:                  'City',
  state:                 'State',
  market:                'Market',
  region:                'Region',
  portfolio_size:        'Doors (portfolio size)',
  portfolio_size_method: 'How the door count was determined',
  pms:                   'PMS',
  pms_note:              'PMS evidence',
  ops_software:          'Ops software (Breezeway etc.)',
  score_a:               'Score A',
  score_b:               'Score B',
  track:                 'Track',
  bucket:                'Bucket',
  gate:                  'Gate',
  contact_name:          'Contact name',
  contact_title:         'Contact title',
  email:                 'Email',
  phone:                 'Phone',
  linkedin_url:          'LinkedIn URL',
  source:                'Source label',
  source_url:            'Source URL',
}

/**
 * The one field an import cannot proceed without. Everything else is
 * optional — a file of nothing but company names is a legitimate list.
 */
export const REQUIRED_FIELD: ImportField = 'company'

export const HEADER_ALIASES: Readonly<Record<ImportField, readonly string[]>> = {
  company:               ['company', 'Company'],
  domain:                ['domain', 'root_domain'],
  website:               ['website', 'Website'],
  comparent_url:         ['comparent_url'],
  city:                  ['city', 'City'],
  state:                 ['state', 'State'],
  market:                ['market', 'Market'],
  region:                ['region', 'Region'],
  portfolio_size:        ['ps', 'portfolio_size', 'Portfolio Size (est.)'],
  portfolio_size_method: ['portfolio_size_method', 'ps_src'],
  pms:                   ['pms_f', 'pms_n', 'pms', 'PMS'],
  // 'Notes' is deliberately NOT an alias here. The master sheet's Notes
  // column is general prose about the company, and an earlier import already
  // packed it (plus confidence and source_url) into `notes` — every one of
  // the 3,399 live rows has it. Copying the same blob into pms_note, whose
  // stated job is HOW the PMS was determined, duplicates it under a label
  // that lies about what it is.
  pms_note:              ['pms_note'],
  // Which ops platform the prospect already runs (Breezeway et al). No column
  // of its own, and it is real competitive-displacement signal, so it is
  // folded into pms_note where PMS evidence already lives.
  ops_software:          ['Ops Software (Breezeway etc.)', 'ops_software'],
  score_a:               ['score_A', 'sA', 'score_a'],
  score_b:               ['score_B', 'sB', 'score_b'],
  track:                 ['track'],
  bucket:                ['bucket'],
  gate:                  ['gate'],
  contact_name:          ['Owner / Decision Maker', 'contact_name'],
  contact_title:         ['Title', 'contact_title'],
  email:                 ['Email', 'email'],
  phone:                 ['Phone', 'phone'],
  linkedin_url:          ['linkedin_url', 'LinkedIn'],
  source:                ['source'],
  // Where the row was found. On the master sheet this is a URL, and where it
  // points at comparent.com it IS the comparent_url the crawler needs.
  source_url:            ['Source', 'source_url'],
}

/** Which column index feeds each field. Absent means "not mapped". */
export type ColumnIndex = Partial<Record<ImportField, number>>

/**
 * The wizard's starting guess, and the CLI's only mapping.
 *
 * Exact header match rather than fuzzy matching: the scorer's own files are
 * the input, their headers are known, and a fuzzy match that silently picks
 * the wrong column writes plausible-looking data into the wrong field — a
 * failure nobody notices until they email the wrong person.
 */
export function autoMapColumns(header: readonly string[]): ColumnIndex {
  const index: ColumnIndex = {}
  const trimmed = header.map((h) => h.trim())
  for (const field of IMPORT_FIELDS) {
    for (const alias of HEADER_ALIASES[field]) {
      const at = trimmed.indexOf(alias)
      if (at !== -1) { index[field] = at; break }
    }
  }
  return index
}
