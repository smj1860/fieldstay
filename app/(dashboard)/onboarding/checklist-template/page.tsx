import { requireOrgMember } from '@/lib/auth'
import { MasterChecklistBuilder } from './master-checklist-builder'
import { markStepComplete } from '../actions'

export default async function OnboardingChecklistTemplatePage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: existing } = await supabase
    .from('org_master_checklist_items')
    .select('*')
    .eq('org_id', membership.org_id)
    .order('section')
    .order('sort_order')

  async function continueAction() {
    'use server'
    await markStepComplete('checklist_template', '/onboarding/maintenance-template')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Master Cleaning Checklist
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Build your standard turnover checklist. Apply it to properties to create their cleaning templates.
        </p>
      </div>

      <MasterChecklistBuilder
        existingItems={(existing ?? []) as Array<{ id: string; section: string; task: string; sort_order: number; source: 'catalog' | 'custom' | 'upload' }>}
        continueAction={continueAction}
      />
    </div>
  )
}
