import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(root, dir))) {
    if (name === 'node_modules' || name === '.next') continue
    const rel = `${dir}/${name}`
    if (statSync(join(root, rel)).isDirectory()) out.push(...sourceFiles(rel))
    else if (/\.tsx?$/.test(name)) out.push(rel)
  }
  return out
}

describe('Homepage OwnerRez launch bar', () => {
  const bar = read('components/landing/ownerrez-launch-bar.tsx')

  it('links to /ownerrez, not to ownerrez.com', () => {
    expect(bar).toContain('href="/ownerrez"')
    expect(bar).not.toContain('ownerrez.com')
  })

  it('does not show the promo code', () => {
    expect(bar).not.toContain('OWNERREZ50')
    expect(bar).not.toContain('OWNERREZ_PROMO_CODE')
    expect(bar).not.toContain('OWNERREZ_URL')
  })

  it('expires with the launch offer', () => {
    expect(bar).toContain('isOwnerRezOfferActive')
  })

  it('is a server component', () => {
    expect(bar).not.toContain("'use client'")
  })

  it('is imported only by the homepage', () => {
    const importers = [
      ...sourceFiles('app'),
      ...sourceFiles('components'),
      ...sourceFiles('lib'),
    ].filter((f) => /from\s+'[^']*ownerrez-launch-bar'/.test(read(f)))
    expect(importers).toEqual(['app/page.tsx'])
  })

  it('the homepage revalidates so the bar can expire on a prerendered page', () => {
    expect(read('app/page.tsx')).toMatch(/export const revalidate = 3600/)
  })
})

describe('Homepage integrations strip', () => {
  const strip = read('components/landing/homepage-content.tsx')

  it('links OwnerRez to /ownerrez and no other provider', () => {
    expect(strip).toMatch(/OwnerRez:\s*'\/ownerrez'/)
    expect(strip).not.toContain('ownerrez.com')
    const hrefs = /INTEGRATION_HREFS[^=]*=\s*\{([\s\S]*?)\}/.exec(strip)
    expect(hrefs).not.toBeNull()
    expect(hrefs![1].match(/'\//g)).toHaveLength(1)
  })
})
