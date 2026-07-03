import { LifeBuoy } from 'lucide-react'
import type { Metadata } from 'next'
import { FAQ_CATEGORIES } from '@/lib/faq-content'
import { FaqAccordion } from '@/components/help/faq-accordion'
import { HelpContactCard } from '@/components/help/help-contact-card'

export const metadata: Metadata = {
  title: 'Help & Support — FieldStay',
}

export default function HelpPage() {
  return (
    <div className="max-w-2xl mx-auto">

      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-2.5 mb-2">
          <LifeBuoy
            className="w-5 h-5"
            style={{ color: 'var(--accent-gold)' }}
          />
          <h1
            className="text-xl font-bold tracking-tight"
            style={{ color: 'var(--text-primary)' }}
          >
            Help &amp; Support
          </h1>
        </div>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Answers to the most common questions. Can&apos;t find what you
          need?{' '}
          <a
            href="mailto:support@fieldstay.app"
            className="underline underline-offset-2 transition-opacity
                       hover:opacity-70"
            style={{ color: 'var(--accent-gold)' }}
          >
            Email us directly
          </a>
          .
        </p>
      </div>

      {/* Searchable accordion */}
      <FaqAccordion categories={FAQ_CATEGORIES} />

      {/* Contact card */}
      <HelpContactCard />

    </div>
  )
}
