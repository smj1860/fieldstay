import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Ratchet for CLAUDE.md's color rule: CSS variables only — Tailwind's own
// color utilities (text-red-500, bg-blue-500, hover:text-red-600...) are
// hardcoded hex under a Tailwind name, not an exception.
//
// 46 files predate enforcement and are baselined below. The ratchet only
// tightens: a file NOT on the baseline may never introduce a color utility,
// and a baselined file that gets cleaned up must be REMOVED from the list
// (the stale-entry check below forces that). Delete entries as you migrate
// files to var(--accent-*) tokens; never add entries.
// ============================================================================

const COLOR_UTILITY = /(?:text|bg|border|ring)-(?:red|blue|green|amber|yellow|slate|gray|gold)-[0-9]{3}/

const BASELINE = new Set<string>([
  'app/(auth)/forgot-password/forgot-password-form.tsx',
  'app/(auth)/login/login-form.tsx',
  'app/(auth)/reset-password/reset-password-form.tsx',
  'app/(auth)/signup/signup-form.tsx',
  'app/(dashboard)/crew-manage/crew-manage-client.tsx',
  'app/(dashboard)/inventory/inventory-manager.tsx',
  'app/(dashboard)/maintenance/maintenance-board.tsx',
  'app/(dashboard)/owners/owners-manager.tsx',
  'app/(dashboard)/properties/[id]/setup/checklist/checklist-builder.tsx',
  'app/(dashboard)/properties/[id]/setup/ical/ical-form.tsx',
  'app/(dashboard)/properties/[id]/setup/layout.tsx',
  'app/(dashboard)/turnovers/turnover-board.tsx',
  'app/(dashboard)/vendors/[id]/compliance-section.tsx',
  'app/(dashboard)/vendors/vendors-client.tsx',
  'app/accept-invite/[token]/accept-form.tsx',
  'app/accept-invite/[token]/error.tsx',
  'app/admin/inventory-catalog/inventory-catalog-editor.tsx',
  'app/admin/seed-templates/seed-template-builder.tsx',
  'app/crew-invite/[token]/accept-invite-form.tsx',
  'app/crew/assets/[propertyId]/page.tsx',
  'app/crew/crew-shell.tsx',
  'app/crew/error.tsx',
  'app/crew/messages/page.tsx',
  'app/crew/page.tsx',
  'app/crew/work-orders/[id]/page.tsx',
  'app/dpa/page.tsx',
  'app/hospitable/page.tsx',
  'app/owner/[token]/page.tsx',
  'app/ownerrez/page.tsx',
  'app/privacy/page.tsx',
  'app/terms/page.tsx',
  'app/work-orders/[token]/vendor-portal.tsx',
  'components/crew/time-off-request.tsx',
  'components/hospitable/PricingSection.tsx',
  'components/hospitable/faq-section.tsx',
  'components/landing/homepage-content.tsx',
  'components/ownerrez/PricingSection.tsx',
  'components/ownerrez/faq-section.tsx',
  'components/property/PropertyMaintenanceManager.tsx',
  'components/review-prompt.tsx',
  'components/ui/InlineAlert.tsx',
  'components/ui/RequiredMark.tsx',
  'components/work-orders/VendorDispatchDialog.tsx',
  'components/work-orders/VendorRatingPanel.tsx',
  'components/work-orders/line-items-editor.tsx',
  'components/work-orders/work-order-detail.tsx',
])

describe('guardrail: Tailwind color-utility ratchet', () => {
  const files = collectSourceFiles(['app', 'components', 'lib'], ['.tsx'])
  const violating = new Set(files.filter((f) => COLOR_UTILITY.test(read(f))).map(rel))

  it('no file outside the baseline uses Tailwind color utilities', () => {
    const newOffenders = [...violating].filter((p) => !BASELINE.has(p)).sort()
    expect(
      newOffenders,
      'New hardcoded Tailwind color utilities. Use CSS variables — ' +
      "style={{ color: 'var(--accent-red)' }} or the bracket form " +
      'hover:text-[var(--accent-red)] (CLAUDE.md → Styling Conventions). ' +
      'Never add files to the baseline.'
    ).toEqual([])
  })

  it('baseline entries whose files are now clean are removed (the ratchet tightens)', () => {
    const stale = [...BASELINE].filter((p) => !violating.has(p)).sort()
    expect(
      stale,
      'These baselined files no longer contain color utilities — delete their entries so the cleanup is locked in.'
    ).toEqual([])
  })
})
