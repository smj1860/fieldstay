export interface OnboardingStep {
  key:         string
  label:       string
  href:        string
  description: string
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    key:         'pms',
    label:       'Connect PMS',
    href:        'pms',
    description: 'Import your properties from your PMS',
  },
  {
    key:         'crew',
    label:       'Add Crew',
    href:        'crew',
    description: 'Add your cleaning and maintenance team',
  },
  {
    key:         'auto_assign',
    label:       'Auto-Assign',
    href:        'auto-assign',
    description: 'Choose how FieldStay assigns crew to turnovers',
  },
  {
    key:         'vendors',
    label:       'Add Vendors',
    href:        'vendors',
    description: 'Add your service vendors and contractors',
  },
  {
    key:         'inventory_template',
    label:       'Inventory Template',
    href:        'inventory-template',
    description: 'Build your master supply list with par levels',
  },
  {
    key:         'checklist_template',
    label:       'Turnover Checklist',
    href:        'checklist-template',
    description: 'Review your auto-built checklist — add any extra rooms your properties need',
  },
  {
    key:         'maintenance_template',
    label:       'Maintenance Schedule',
    href:        'maintenance-template',
    description: 'Set up recurring maintenance tasks',
  },
  {
    key:         'power_ups',
    label:       'Power-Ups',
    href:        'power-ups',
    description: 'Optional integrations that add more automation',
  },
]

export function firstIncompleteOnboardingStep(
  completed: Record<string, boolean>
): string {
  const step = ONBOARDING_STEPS.find((s) => !completed[s.key])
  return step?.href ?? ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]!.href
}

export function calcOnboardingProgress(
  completed: Record<string, boolean>
): number {
  const done = ONBOARDING_STEPS.filter((s) => completed[s.key]).length
  return Math.round((done / ONBOARDING_STEPS.length) * 100)
}
