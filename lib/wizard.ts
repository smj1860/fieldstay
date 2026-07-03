export const WIZARD_STEPS = [
  {
    key:         'details',
    label:       'Property Details',
    description: 'Name, address, and access info',
    href:        'details',
  },
  {
    key:         'ical',
    label:       'Calendar Feeds',
    description: 'Airbnb, VRBO, and other booking sources',
    href:        'ical',
  },
  {
    key:         'inventory',
    label:       'Inventory',
    description: 'Items to stock and par levels',
    href:        'inventory',
  },
  {
    key:         'checklist',
    label:       'Turnover Checklist',
    description: 'Tasks for your cleaning crew',
    href:        'checklist',
  },
  {
    key:         'maintenance',
    label:       'Maintenance',
    description: 'Routine and seasonal schedules',
    href:        'maintenance',
  },
] as const

export type WizardStepKey = (typeof WIZARD_STEPS)[number]['key']

export function getStepIndex(key: WizardStepKey): number {
  return WIZARD_STEPS.findIndex((s) => s.key === key)
}

export function getNextStep(key: WizardStepKey): WizardStepKey | null {
  const idx = getStepIndex(key)
  return idx < WIZARD_STEPS.length - 1 ? WIZARD_STEPS[idx + 1].key : null
}

export function getPrevStep(key: WizardStepKey): WizardStepKey | null {
  const idx = getStepIndex(key)
  return idx > 0 ? WIZARD_STEPS[idx - 1].key : null
}

export function calcSetupProgress(completed: Record<string, boolean>): number {
  const done = WIZARD_STEPS.filter((s) => completed[s.key]).length
  return Math.round((done / WIZARD_STEPS.length) * 100)
}

export function firstIncompleteStep(
  completed: Record<string, boolean>
): WizardStepKey {
  return (
    WIZARD_STEPS.find((s) => !completed[s.key])?.key ?? WIZARD_STEPS[0].key
  )
}
