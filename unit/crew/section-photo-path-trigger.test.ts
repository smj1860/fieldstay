import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The crew PWA uploads a section photo to Storage and then PATCHes
// checklist_instances.section_photo_path from the crew session. The trigger
// used to reject ANY crew change to that column, so every section photo
// uploaded fine and then dead-lettered on the path write. Crew may now SET or
// REPLACE the path; removing evidence stays a PM action, so they may not CLEAR it.
const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261014090100_crew_section_photo_path_allowed.sql'), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')

describe('protect_checklist_instances_crew_columns (crew section photo path)', () => {
  it('only rejects a crew change to section_photo_path when it CLEARS the path', () => {
    expect(sql).toMatch(/NEW\.section_photo_path IS DISTINCT FROM OLD\.section_photo_path AND NEW\.section_photo_path IS NULL/)
  })
  it('no longer rejects every change to it', () => {
    expect(sql).not.toMatch(/OR NEW\.section_photo_path IS DISTINCT FROM OLD\.section_photo_path\s*\n\s*THEN/)
  })
  it('still guards the other columns and still lets a PM through', () => {
    for (const col of ['org_id', 'turnover_id', 'template_id', 'template_snapshot', 'status']) {
      expect(sql).toContain(`NEW.${col}`)
    }
    expect(sql).toContain("'admin'::public.member_role, 'manager'::public.member_role, 'owner'::public.member_role")
    expect(sql).toContain('pg_trigger_depth() <= 1')
  })
})
