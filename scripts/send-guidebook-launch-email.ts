// scripts/send-guidebook-launch-email.ts
//
// One-time batch script to send the Guidebook feature announcement email
// to all active PM accounts (one per org admin/owner).
//
// Usage:
//   npx tsx scripts/send-guidebook-launch-email.ts
//
// Set LAUNCH_DATE in the env before running:
//   LAUNCH_DATE="July 14th" npx tsx scripts/send-guidebook-launch-email.ts
//
// Dry-run mode (logs recipients without sending):
//   DRY_RUN=true npx tsx scripts/send-guidebook-launch-email.ts
//
// Email lives on auth.users, not a public profiles column — resolved via
// supabase.auth.admin.getUserById per unique org admin/owner, same pattern
// as lib/inngest/helpers.ts.

import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { renderGuidebookFeatureAnnouncementEmail } from '../emails/guidebook-feature-announcement'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const resend      = new Resend(process.env.RESEND_API_KEY!)
const FROM        = `${process.env.RESEND_FROM_NAME} <${process.env.RESEND_FROM_EMAIL}>`
const DRY_RUN     = process.env.DRY_RUN === 'true'
const LAUNCH_DATE = process.env.LAUNCH_DATE ?? '[LAUNCH_DATE]'
const APP_URL      = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'

// Resend batch limit per call
const BATCH_SIZE = 100

interface EmailPayload {
  from:    string
  to:      string
  subject: string
  html:    string
}

async function main() {
  console.log(`\n── FieldStay Guidebook Launch Email ──`)
  console.log(`   Dry run:     ${DRY_RUN}`)
  console.log(`   Launch date: ${LAUNCH_DATE}\n`)

  const { data: members, error } = await admin
    .from('organization_members')
    .select('user_id, role')
    .in('role', ['owner', 'admin'])
    .not('user_id', 'is', null)

  if (error) {
    console.error('Failed to fetch org members:', error.message)
    process.exit(1)
  }

  if (!members?.length) {
    console.log('No members found. Exiting.')
    process.exit(0)
  }

  // Deduplicate by user_id — one send per person regardless of org count
  const seen = new Set<string>()
  const allEmails: EmailPayload[] = []

  for (const member of members) {
    const userId = member.user_id as string | null
    if (!userId || seen.has(userId)) continue
    seen.add(userId)

    const { data: { user } } = await admin.auth.admin.getUserById(userId)
    if (!user?.email) continue

    const fullName = user.user_metadata?.full_name as string | undefined
    const firstName = fullName?.split(' ')[0] ?? 'there'

    const html = await renderGuidebookFeatureAnnouncementEmail({
      pmFirstName:  firstName,
      dashboardUrl: `${APP_URL}/guidebook`,
      launchDate:   LAUNCH_DATE,
    })

    allEmails.push({
      from:    FROM,
      to:      user.email,
      subject: `Introducing the FieldStay Guidebook — it's already in your dashboard`,
      html,
    })
  }

  console.log(`Prepared ${allEmails.length} unique recipient(s)\n`)

  if (DRY_RUN) {
    console.log('DRY RUN — recipients that would receive the email:')
    allEmails.forEach((e) => console.log(`  → ${e.to}`))
    console.log('\nSet DRY_RUN=false to send.')
    process.exit(0)
  }

  let sent   = 0
  let failed = 0

  for (let i = 0; i < allEmails.length; i += BATCH_SIZE) {
    const batch = allEmails.slice(i, i + BATCH_SIZE)

    try {
      const result = await resend.batch.send(batch)
      sent += batch.length
      console.log(
        `Batch ${Math.floor(i / BATCH_SIZE) + 1}: sent ${batch.length} emails`,
        result
      )
    } catch (err) {
      failed += batch.length
      console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err)
    }

    if (i + BATCH_SIZE < allEmails.length) {
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  console.log(`\n── Complete ──`)
  console.log(`   Sent:   ${sent}`)
  console.log(`   Failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
