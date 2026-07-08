import { requireOrgMember } from '@/lib/auth'
import { TemplateManager } from '../../inventory/template-manager'
import { markStepComplete } from '../actions'
import { Button } from '@/components/ui/Button'

export default async function OnboardingInventoryTemplatePage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: template },
    { data: properties },
    { data: catalogItems },
  ] = await Promise.all([
    supabase
      .from('inventory_templates')
      .select('id, name, inventory_template_items(*)')
      .eq('org_id', membership.org_id)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('inventory_catalog')
      .select('id, name, category, default_unit')
      .eq('is_active', true)
      .order('name'),
  ])

  async function continueAction() {
    'use server'
    await markStepComplete('inventory_template', '/setup/checklist-template')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Master Inventory Template
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Build your master supply list with par levels. Apply it to any property in one click.
        </p>
      </div>

      <TemplateManager
        template={template as never}
        properties={properties ?? []}
        catalogItems={catalogItems ?? []}
      />

      <div className="pt-4 border-t border-themed">
        <form action={continueAction}>
          <Button type="submit">
            Save &amp; Continue →
          </Button>
        </form>
      </div>
    </div>
  )
}
