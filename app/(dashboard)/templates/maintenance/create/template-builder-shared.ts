import type { ScheduleFrequency, VendorSpecialty } from '@/types/database'

export const SPECIALTY_LABELS: Record<string, string> = {
  plumbing: 'Plumbing', electrical: 'Electrical', hvac: 'HVAC',
  landscaping: 'Landscaping', cleaning: 'Cleaning', pest_control: 'Pest Control',
  pool: 'Pool', roofing: 'Roofing', general: 'General', other: 'Other',
}

export const FREQUENCY_LABELS: Partial<Record<ScheduleFrequency, string>> = {
  weekly:      'Weekly',
  biweekly:    'Bi-weekly',
  monthly:     'Monthly',
  quarterly:   'Quarterly',
  semi_annual: 'Semi-annual',
  annual:      'Annual',
}

export const FREQUENCIES: { value: ScheduleFrequency; label: string }[] = [
  { value: 'weekly',      label: 'Weekly'      },
  { value: 'biweekly',    label: 'Bi-weekly'   },
  { value: 'monthly',     label: 'Monthly'     },
  { value: 'quarterly',   label: 'Quarterly'   },
  { value: 'semi_annual', label: 'Semi-annual' },
  { value: 'annual',      label: 'Annual'      },
]

export interface CatalogItem {
  id:                    string
  name:                  string
  description:           string | null
  schedule_frequency:    ScheduleFrequency
  vendor_specialty_hint: VendorSpecialty | null
  estimated_cost:        number | null
  is_optional_flag:      string | null
  sort_order:            number
}

export interface Property { id: string; name: string }

export interface NewTemplateItem {
  name:                  string
  description:           string
  schedule_frequency:    ScheduleFrequency
  vendor_specialty_hint: VendorSpecialty | ''
  estimated_cost:        string
  catalogId?:            string
}

export const EMPTY_TEMPLATE_ITEM: NewTemplateItem = {
  name: '', description: '', schedule_frequency: 'quarterly', vendor_specialty_hint: '', estimated_cost: '',
}

export function catalogItemToTemplateItem(ci: CatalogItem): NewTemplateItem {
  return {
    name:                  ci.name,
    description:           ci.description ?? '',
    schedule_frequency:    ci.schedule_frequency,
    vendor_specialty_hint: (ci.vendor_specialty_hint ?? '') as VendorSpecialty | '',
    estimated_cost:        ci.estimated_cost !== null && ci.estimated_cost !== undefined ? String(ci.estimated_cost) : '',
    catalogId:             ci.id,
  }
}
