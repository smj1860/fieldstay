import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PLANS, type PlanKey } from '@/lib/stripe/client'
import type { OrgPlan } from '@/types/database'

// ============================================================================
// The plan price table is duplicated across FOUR files, and nothing else in CI
// compares them:
//
//   lib/stripe/client.ts                      PLANS          (the source of truth)
//   app/(dashboard)/settings/settings-tabs.tsx PLAN_INFO + DISPLAY_PLANS
//   components/ownerrez/PricingSection.tsx     PLANS
//   components/hospitable/PricingSection.tsx   PLANS
//
// The two PricingSections are 'use client' marketing pages and settings-tabs
// is a client component, so none of them can import lib/stripe/client (it
// constructs the Stripe SDK). That is why the duplication exists — but it
// means a price that is right in Stripe and right in PLANS can be wrong on a
// landing page indefinitely, and the landing page is what a prospect reads
// BEFORE paying. Exactly the class of defect as the hardcoded `reviewCount: 3`
// in the day-7 onboarding email: a number shown to a customer that no code
// path keeps honest.
//
// So this test reads the three copies as TEXT and checks the numbers against
// PLANS. It is deliberately a string scan rather than an import: importing a
// .tsx client component into a node test drags in React/Next internals for no
// benefit, and the failure mode being guarded is "someone edited one file and
// not the others", which text catches perfectly well.
// ============================================================================

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const SETTINGS_TABS = 'app/(dashboard)/settings/settings-tabs.tsx'
const PRICING_SECTIONS = [
  'components/ownerrez/PricingSection.tsx',
  'components/hospitable/PricingSection.tsx',
]

/** Every plan a customer can actually buy — enterprise is contact-for-pricing. */
const PURCHASABLE = (Object.keys(PLANS) as PlanKey[]).filter((k) => k !== 'enterprise')

describe('PLANS is the single source of truth for plan pricing', () => {
  it('every purchasable plan has both a monthly and an annual price env var declared', () => {
    // priceId() returns null when the var is unset, which is the normal state
    // in a test environment — so this asserts the KEYS exist on the object,
    // not that they resolved. lib/env.ts is what fails a production deploy
    // that is missing the value; env-schema-coverage guards that.
    for (const key of PURCHASABLE) {
      const plan = PLANS[key]
      expect(plan, `PLANS.${key}`).toHaveProperty('monthlyPriceId')
      expect(plan, `PLANS.${key}`).toHaveProperty('annualPriceId')
      expect(plan.monthlyPrice, `PLANS.${key}.monthlyPrice`).toBeTypeOf('number')
      expect(plan.annualPrice, `PLANS.${key}.annualPrice`).toBeTypeOf('number')
    }
  })

  it('annual price is exactly 10x monthly — the advertised "2 months free"', () => {
    // Every landing page renders a "Save 2 months" badge and a computed
    // savings figure. If a plan is ever priced off that ratio, those badges
    // become false advertising rather than a rounding quirk.
    for (const key of PURCHASABLE) {
      const { monthlyPrice, annualPrice } = PLANS[key]
      expect(annualPrice, `PLANS.${key}: annual should be monthly x 10`).toBe(monthlyPrice! * 10)
    }
  })

  it('maxProperties strictly increases with price, so the ladder has no dead rung', () => {
    const ladder = PURCHASABLE.map((k) => ({ k, price: PLANS[k].monthlyPrice!, cap: PLANS[k].maxProperties }))
      .sort((a, b) => a.price - b.price)

    for (let i = 1; i < ladder.length; i++) {
      expect(
        ladder[i]!.cap,
        `${ladder[i]!.k} costs more than ${ladder[i - 1]!.k} but does not raise the property cap`,
      ).toBeGreaterThan(ladder[i - 1]!.cap)
    }
  })

  it('every PLANS key is a real org_plan enum value', () => {
    // OrgPlan mirrors the Postgres enum; check-type-drift.mjs keeps that
    // honest against the live DB. This catches a PLANS key added without the
    // migration, which would fail only at the moment a customer checks out.
    const validPlans: Record<OrgPlan, true> = {
      hosts: true, starter: true, growth: true, pro: true, portfolio: true, enterprise: true,
    }
    for (const key of Object.keys(PLANS)) {
      expect(validPlans[key as OrgPlan], `PLANS.${key} is not an org_plan enum value`).toBe(true)
    }
  })
})

describe('the duplicated plan tables agree with PLANS', () => {
  it('settings-tabs renders every purchasable plan at the right monthly and annual price', () => {
    const src = read(SETTINGS_TABS)

    for (const key of PURCHASABLE) {
      const { name, monthlyPrice, annualPrice } = PLANS[key]

      // The upgrade card: `key: '<key>' as const` ... monthly / annual.
      const card = new RegExp(
        `key:\\s*'${key}'\\s*as const[\\s\\S]{0,400}?monthly:\\s*(\\d+)[\\s\\S]{0,200}?annual:\\s*(\\d+)`,
      ).exec(src)

      expect(card, `settings-tabs DISPLAY_PLANS has no card for '${key}'`).not.toBeNull()
      expect(Number(card![1]), `settings-tabs '${key}' monthly`).toBe(monthlyPrice)
      expect(Number(card![2]), `settings-tabs '${key}' annual`).toBe(annualPrice)
      expect(src, `settings-tabs PLAN_INFO is missing '${name}'`).toContain(`name: '${name}'`)
    }
  })

  it('settings-tabs PLAN_INFO caps match PLANS.maxProperties', () => {
    const src = read(SETTINGS_TABS)

    for (const key of Object.keys(PLANS) as PlanKey[]) {
      const row = new RegExp(`^\\s*${key}:\\s*\\{[^}]*maxProperties:\\s*(\\d+)`, 'm').exec(src)
      expect(row, `settings-tabs PLAN_INFO has no row for '${key}'`).not.toBeNull()
      expect(Number(row![1]), `settings-tabs PLAN_INFO.${key}.maxProperties`).toBe(PLANS[key].maxProperties)
    }
  })

  it.each(PRICING_SECTIONS)('%s prices every purchasable plan the same as PLANS', (file) => {
    const src = read(file)

    for (const key of PURCHASABLE) {
      const { name, monthlyPrice, annualPrice } = PLANS[key]

      const card = new RegExp(
        `name:\\s*"${name}"[\\s\\S]{0,300}?monthly:\\s*(\\d+),[\\s\\S]{0,120}?annual:\\s*(\\d+),`,
      ).exec(src)

      expect(card, `${file} has no pricing card for '${name}'`).not.toBeNull()
      expect(Number(card![1]), `${file} '${name}' monthly`).toBe(monthlyPrice)
      expect(Number(card![2]), `${file} '${name}' annual`).toBe(annualPrice)
    }
  })

  it.each(PRICING_SECTIONS)('%s advertises a savings figure equal to two months', (file) => {
    const src = read(file)

    for (const key of PURCHASABLE) {
      const { name, monthlyPrice } = PLANS[key]
      const card = new RegExp(`name:\\s*"${name}"[\\s\\S]{0,400}?annualSavings:\\s*(\\d+),`).exec(src)

      expect(card, `${file} has no annualSavings for '${name}'`).not.toBeNull()
      expect(Number(card![1]), `${file} '${name}' annualSavings should be 2 x monthly`).toBe(monthlyPrice! * 2)
    }
  })
})

describe('the Hosts tier as specified', () => {
  it('is $89/mo, $890/yr, capped at 4 properties, and sits below Starter', () => {
    expect(PLANS.hosts.name).toBe('Hosts')
    expect(PLANS.hosts.monthlyPrice).toBe(89)
    expect(PLANS.hosts.annualPrice).toBe(890)
    expect(PLANS.hosts.maxProperties).toBe(4)
    expect(PLANS.hosts.monthlyPrice!).toBeLessThan(PLANS.starter.monthlyPrice!)
  })

  it('does not change Starter\'s cap — only its floor moved, so no org needs a backfill', () => {
    expect(PLANS.starter.maxProperties).toBe(15)
  })

  it('leaves no gap in the property ladder between Hosts and Starter', () => {
    // Hosts tops out at 4 and Starter is advertised as starting at 5. A gap
    // here would mean a 5-property customer has no plan that describes them.
    expect(PLANS.starter.description).toContain(String(PLANS.hosts.maxProperties + 1))
  })
})
