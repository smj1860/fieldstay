// The ownerrez landing page's FAQ content. The accordion itself is
// components/faq/FaqSection.tsx — this file and its Hospitable twin used to
// carry byte-identical copies of that markup, which is what SonarCloud kept
// flagging. Shared answers come from lib/faq-content.ts.
//
// MARKETING_FAQ itself now lives in app/ownerrez/json-ld.ts, not here — see
// that file's header comment. This component (a 'use client' boundary)
// imports it back rather than defining it, so the same array feeds both the
// rendered accordion and the FAQPage structured data with no risk of drift.

'use client'

import { MARKETING_FAQ } from '@/app/ownerrez/json-ld'
import FaqSection from '@/components/faq/FaqSection'

export default function OwnerrezFaqSection() {
  return <FaqSection items={MARKETING_FAQ} />
}
