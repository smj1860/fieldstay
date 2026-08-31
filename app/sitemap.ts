import type { MetadataRoute } from 'next'

import { marketingOrigin } from '@/lib/marketing'

// ============================================================================
// There was no sitemap at all before /strops, which is a real gap for a page
// whose entire purpose is organic search: a brand-new URL with no inbound
// links can wait weeks for a crawler to stumble on it.
//
// URLs use the APEX (fieldstay.app), not NEXT_PUBLIC_APP_URL. The apex and
// app.fieldstay.app are aliases of the same deployment, so every page below
// exists at two URLs; listing the apex — and matching that with an absolute
// canonical on each page — is what stops Google choosing between them itself.
//
// PUBLIC, INDEXABLE pages only. Everything else in app/ is either behind auth
// (the dashboard, /crew), token-gated (owner portal, vendor portal,
// /accept-invite), or an endpoint — none of which belong in a sitemap, and
// several of which would be an information leak if listed. app/robots.ts
// disallows those prefixes explicitly; this file is the allowlist half of the
// same decision, and the two are meant to be read together.
// ============================================================================

const PAGES: ReadonlyArray<{
  path:       string
  priority:   number
  changeFreq: MetadataRoute.Sitemap[number]['changeFrequency']
}> = [
  { path: '/',                      priority: 1.0, changeFreq: 'weekly'  },
  { path: '/pricing',               priority: 0.9, changeFreq: 'monthly' },
  { path: '/strops',                priority: 0.9, changeFreq: 'monthly' },
  { path: '/ownerrez',              priority: 0.8, changeFreq: 'monthly' },
  { path: '/hospitable',            priority: 0.8, changeFreq: 'monthly' },
  { path: '/hosts',                 priority: 0.8, changeFreq: 'monthly' },
  { path: '/breezeway-alternative', priority: 0.8, changeFreq: 'monthly' },
  { path: '/enterprise',            priority: 0.7, changeFreq: 'monthly' },
  { path: '/for-vendors',           priority: 0.6, changeFreq: 'monthly' },
  { path: '/privacy',               priority: 0.3, changeFreq: 'yearly'  },
  { path: '/terms',                 priority: 0.3, changeFreq: 'yearly'  },
  { path: '/dpa',                   priority: 0.3, changeFreq: 'yearly'  },
]

export default function sitemap(): MetadataRoute.Sitemap {
  const base = marketingOrigin()
  // One timestamp for the whole run, so every entry agrees. Per-page dates
  // would need real content-change tracking; a build date that claims every
  // page changed today is worse than honest coarse granularity.
  const lastModified = new Date()

  return PAGES.map((p) => ({
    url:              `${base}${p.path}`,
    lastModified,
    changeFrequency:  p.changeFreq,
    priority:         p.priority,
  }))
}
