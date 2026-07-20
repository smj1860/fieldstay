// lib/assets/manual-lookup.ts
// ============================================================
// Finds a link to the manufacturer's own service/repair manual or support
// page for an asset's make/model — we store a LINK, never a copy of the
// file. See supabase/migrations/20260711120000_asset_manuals.sql for why.
//
// ⚠️ Unconfirmed: uses Anthropic's web_search server tool (tool type
// "web_search_20250305") to have Claude perform a real, live web search —
// a genuinely different capability from the single-turn vision-only call
// app/api/assets/scan-data-plate/route.ts uses elsewhere in this codebase,
// and this specific tool has not been exercised against a live account
// here before. If the tool type string is wrong for this SDK/account, or
// web search isn't enabled on this API plan, the call throws — caught
// below and treated the same as "nothing found," never as a crash. Confirm
// this returns real results before treating an empty asset_manuals table
// as "no manuals exist" rather than "the lookup itself isn't working."
//
// Model: Haiku, deliberately — this is a bounded lookup-and-filter task
// (invoke web_search, pick the one URL that's the manufacturer's own
// manual/support page, reject resellers/forums), not something that needs
// Sonnet-level reasoning. Same "unconfirmed until a live run proves it"
// caveat applies doubly here: if Haiku's picks turn out unreliable (wrong
// domain, picks a reseller despite the instruction), bump MODEL back to a
// Sonnet tier — this is a single-line change, not a redesign.
// ============================================================

import Anthropic from '@anthropic-ai/sdk'
import type { DBClient } from '@/lib/supabase/server'
import type { AssetType } from '@/types/database'

const MODEL = 'claude-haiku-4-5-20251001'

export interface ManualLookupResult {
  sourceUrl: string | null
  foundVia:  'search' | null
}

export async function findManualUrl(
  assetType: AssetType,
  make:      string,
  model:     string
): Promise<ManualLookupResult> {
  try {
    const client = new Anthropic()

    const message = await client.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      ],
      messages: [
        {
          role: 'user',
          content:
            `Find the official manufacturer's service/repair manual or ` +
            `support page for this ${assetType.replace(/_/g, ' ')}: ` +
            `make "${make}", model "${model}". Search the manufacturer's ` +
            `own website only — not a reseller, forum, or third-party ` +
            `parts site. Reply with ONLY the single best URL, nothing ` +
            `else. If you can't find one with reasonable confidence, ` +
            `reply with exactly: NONE`,
        },
      ],
    })

    const url = extractUrlFromResponse(message)
    if (!url) return { sourceUrl: null, foundVia: null }

    const isLive = await validateUrl(url)
    return isLive
      ? { sourceUrl: url, foundVia: 'search' }
      : { sourceUrl: null, foundVia: null }
  } catch (err) {
    console.error('[findManualUrl] lookup failed', {
      assetType, make, model,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sourceUrl: null, foundVia: null }
  }
}

function extractUrlFromResponse(message: Anthropic.Message): string | null {
  for (const block of message.content) {
    if (block.type !== 'text') continue
    if (block.text.trim() === 'NONE') continue
    const match = block.text.match(/https?:\/\/[^\s)"'\]]+/)
    if (match) return match[0].replace(/[.,;]+$/, '')
  }
  return null
}

// Some manufacturer sites don't support HEAD — falls back to GET before
// giving up, so a real live page isn't discarded on a technicality.
async function validateUrl(url: string): Promise<boolean> {
  try {
    const headRes = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
    if (headRes.ok) return true

    const getRes = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) })
    return getRes.ok
  } catch {
    return false
  }
}

// Retrieval side — looks up an already-found manual link for a work
// order's asset. Never triggers a new search (that only happens via
// asset/manual_lookup.requested when the asset itself is saved); this is
// a plain read, safe to call on every WO page load / dispatch.
export async function getManualUrlForAsset(
  supabase: DBClient,
  orgId:    string,
  assetId:  string | null
): Promise<string | null> {
  if (!assetId) return null

  // Scoped to orgId even though assetId should already belong to this org —
  // this runs via the service-role client (bypasses RLS), so it's the only
  // guard against a cross-org leak if an org_id/asset_id pair were ever
  // mismatched elsewhere.
  const { data: asset, error: assetError } = await supabase
    .from('property_assets')
    .select('asset_type, make, model')
    .eq('id', assetId)
    .eq('org_id', orgId)
    .maybeSingle()

  if (assetError) {
    console.error('[getManualUrlForAsset] asset lookup failed', { orgId, assetId, error: assetError.message })
    return null
  }
  if (!asset?.make || !asset?.model) return null

  const { data: manual, error: manualError } = await supabase
    .from('asset_manuals')
    .select('source_url')
    .eq('org_id', orgId)
    .eq('asset_type', asset.asset_type)
    .eq('make', asset.make.trim().toLowerCase())
    .eq('model', asset.model.trim().toLowerCase())
    .maybeSingle()

  if (manualError) {
    console.error('[getManualUrlForAsset] manual lookup failed', { orgId, assetId, error: manualError.message })
    return null
  }

  return manual?.source_url ?? null
}
