import { createHash }          from 'node:crypto'
import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import {
  getClientToken,
  searchProducts,
  addItemsToKrogerCart,
  getBestProductImage,
  getBestPrice,
} from '@/lib/kroger/client'
import { getValidKrogerToken }             from '@/lib/integrations/providers/kroger-token'
import { reportError }                     from '@/lib/observability/report-error'
import { ANTHROPIC_TIMEOUT_MS, isTimeoutError } from '@/lib/http/timeout'
import { RateLimitError }                  from '@/lib/integrations/types'
import { NonRetriableError }               from 'inngest'
import { resend, FROM }                    from '@/lib/resend/client'
import { renderShoppingCartReadyEmail }    from '@/lib/resend/emails/shopping-cart-ready'
import type { MatchedItem, CartBuildResult } from '@/lib/kroger/types'

/**
 * Deterministic, locale-independent string ordering for CANONICALISATION.
 *
 * Sorting a list before hashing it is about producing one stable
 * representation of an unordered set — it is never shown to a user. Comparing
 * by UTF-16 code unit (what `<`/`>` do) gives the same answer on every
 * machine, in every locale, under every ICU version. `String.localeCompare`
 * does not, which is why it must not be used here even though it is the
 * conventional answer for an alphabetical *display* sort.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

// Bounded-concurrency map — runs `limit` items at a time instead of fully
// serial, while still letting each item apply its own rate-limit pacing.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  async function worker() {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export type ShoppingCartRequestedEvent = {
  name: 'inventory/cart_requested'
  data: {
    org_id:        string
    requested_by:  string
    property_ids?: string[]
    modality:      'PICKUP' | 'DELIVERY' | 'IN_STORE'
  }
}

/** Row shape returned by the inventory_below_par_items() RPC. */
type BelowParItem = {
  id:                      string
  name:                    string
  current_quantity:        number | null
  par_level:               number | null
  unit:                    string | null
  preferred_brand:         string | null
  property_id:             string
  first_count_recorded_at: string | null
  property_name:           string | null
  property_zip:            string | null
}

export const buildShoppingCart = inngest.createFunction(
  {
    id:      'build-shopping-cart',
    name:    'Build Kroger Shopping Cart from Below-Par Inventory',
    retries: 2,
    // A PM double-clicking "Build Cart" produced two concurrent runs, each of
    // which added the same items to the REAL Kroger cart — real duplicate
    // grocery spend. One run per org at a time, plus the content-keyed
    // milestone claim in step 6, makes that impossible rather than unlikely.
    concurrency: { limit: 1, key: 'event.data.org_id' },
  },
  { event: 'inventory/cart_requested' as const },
  async ({ event, step }) => {
    const { org_id, requested_by, property_ids, modality } = event.data

    const persistCartStatus = async (status: string, extra: Record<string, unknown> = {}) => {
      const supabase = createServiceClient({ system: 'inngest:build-shopping-cart' })
      await supabase.from('org_milestones').upsert({
        org_id,
        milestone: 'last_cart_build',
        value: { built_at: new Date().toISOString(), requested_by, status, ...extra },
      }, { onConflict: 'org_id,milestone' })
    }

    // ── Step 1: Load org settings + below-par items + Kroger connection ──
    const { orgSettings, belowParItems, connection } = await step.run('load-inventory-data', async () => {
      const supabase = createServiceClient({ system: 'inngest:build-shopping-cart' })

      // Below-par filtering happens in SQL (inventory_below_par_items RPC).
      // It cannot be expressed through the Supabase JS builder — there is no
      // column-to-column comparison and supabase.raw() does not exist — so
      // this previously fetched EVERY inventory_items row for the org and
      // filtered in JS. PostgREST caps that response at 1000 rows with no
      // error, so a 50-property org (50 x 115 catalog items = 5,750 rows) had
      // every below-par item past the cap silently dropped from the cart, with
      // no signal to the PM. Now only below-par rows cross the wire at all.
      const [{ data: org }, { data: items, error: itemsError }, { data: conn }] = await Promise.all([
        supabase
          .from('organizations')
          .select('id, preferred_retailer')
          .eq('id', org_id)
          .single(),

        // p_property_ids is DEFAULT NULL ("every property"), so omitting it
        // says the same thing as the explicit null this used to pass — and it
        // is what the generated `p_property_ids?: string[]` arg type accepts.
        supabase.rpc('inventory_below_par_items', {
          p_org_id: org_id,
          ...(property_ids?.length ? { p_property_ids: property_ids } : {}),
        }),

        supabase
          .from('integration_connections')
          .select('user_id, external_user_id, metadata, expires_at')
          .eq('org_id', org_id)
          .eq('provider_id', 'kroger')
          .eq('status', 'active')
          .maybeSingle(),
      ])

      if (!org) throw new Error(`Org ${org_id} not found`)
      if (itemsError) throw new Error(`inventory_below_par_items failed: ${itemsError.message}`)

      return {
        orgSettings:   org,
        belowParItems: (items ?? []) as unknown as BelowParItem[],
        connection:    conn,
      }
    })

    if (!belowParItems.length) {
      await persistCartStatus('nothing_below_par')
      return { status: 'nothing_below_par', items_checked: 0 }
    }

    if (orgSettings.preferred_retailer !== 'kroger') {
      await persistCartStatus('retailer_not_kroger')
      return { status: 'retailer_not_kroger', preferred: orgSettings.preferred_retailer }
    }

    const krogerLocationId   = (connection?.metadata as { location_id?: string } | null)?.location_id
    const krogerLocationName = (connection?.metadata as { location_name?: string } | null)?.location_name
    const supabase = createServiceClient({ system: 'inngest:build-shopping-cart' })

    if (!connection || !krogerLocationId) {
      await supabase.from('org_milestones').upsert({
        org_id,
        milestone: 'kroger_store_needed',
      }, { onConflict: 'org_id,milestone', ignoreDuplicates: true })
      await persistCartStatus('no_store_configured')
      return { status: 'no_store_configured', action_required: 'connect_kroger_store' }
    }

    // ── Step 2: Read customer token from Vault, refreshing if near expiry ──
    // Delegates to the same getValidKrogerToken/refreshKrogerToken used by
    // the proactive token-refresh cron — this used to be a second,
    // uncoordinated reimplementation of the refresh logic here, which could
    // race the cron's refresh for the same connection.
    const customerToken = await step.run('get-customer-token', async () => {
      try {
        return await getValidKrogerToken(connection.user_id)
      } catch (err) {
        if (err instanceof RateLimitError) {
          // Kroger's own API quota (or our proactive guard in front of it,
          // see lib/kroger/client.ts's krogerFetch) is exhausted. Rethrow
          // so Inngest retries this step with backoff instead of silently
          // degrading to the list-only fallback below — that would mask a
          // transient condition as a permanent one and skip a retry that
          // would likely succeed once the window resets.
          throw err
        }

        if (err instanceof NonRetriableError) {
          // Refresh token itself is revoked/expired — mark the connection so
          // the PM sees a reconnect prompt instead of the cart silently
          // degrading to list-only with no visible error state until the
          // next proactive-refresh cron tick.
          const supabase = createServiceClient({ system: 'inngest:build-shopping-cart' })
          await supabase
            .from('integration_connections')
            .update({ status: 'revoked' })
            .eq('user_id', connection.user_id)
            .eq('provider_id', 'kroger')
            .eq('org_id', org_id)
        }
        console.error('Kroger token refresh failed — falling back to list-only:', err instanceof Error ? err.message : err)
        reportError(err, { site: 'inngest.build-shopping-cart.kroger_token_refresh', orgId: org_id })
        return null
      }
    })

    // ── Step 3: Normalize item names via Claude API ───────────────
    const normalizedItems = await step.run('normalize-item-names', async () => {
      const itemBrandMap = new Map<string, string | null>()

      for (const item of belowParItems) {
        const key = item.name.toLowerCase().trim()
        if (!itemBrandMap.has(key)) {
          itemBrandMap.set(key, item.preferred_brand ?? null)
        }
      }

      const uniqueNames           = [...itemBrandMap.keys()]
      const itemsForNormalization = uniqueNames.map(name => ({
        name,
        brand: itemBrandMap.get(name) ?? null,
      }))

      // Deterministic fallback used for every failure mode below — a bad
      // response, unparseable JSON, or (now) giving up waiting. Normalization
      // is a search-quality optimisation, not a correctness requirement, so
      // degrading to "brand + name" is always better than failing the build.
      const fallbackNames = () => Object.fromEntries(
        uniqueNames.map(name => {
          const brand = itemBrandMap.get(name)
          return [name, brand ? `${brand} ${name}` : name]
        })
      )

      // A fetch() with no AbortSignal has no timeout at all: a hung Anthropic
      // request would burn this step's entire execution budget and take the
      // cart build down with it, three retries in a row.
      let res: Response
      try {
        res = await fetch('https://api.anthropic.com/v1/messages', {
        signal:  AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system:     'You return only valid JSON. No markdown. No explanation.',
          messages: [{
            role:    'user',
            content: `Normalize grocery/supply item names for a Kroger product search API.

Rules:
- If a brand is provided, ALWAYS include it in the search query
- Keep search queries to 3-5 words max
- Remove units (oz, pk, rolls, etc)
- Brand first: "Bounty paper towels" not "paper towels Bounty"
- No brand: use the most searchable generic term

Return ONLY a JSON object: { "original_name": "search_query" }

Items:
${JSON.stringify(itemsForNormalization, null, 2)}`,
          }],
        }),
        })
      } catch (err) {
        if (!isTimeoutError(err)) throw err
        reportError(err, {
          site:  'inngest.build-shopping-cart.normalize_item_names_timeout',
          orgId: org_id,
        })
        return fallbackNames()
      }

      if (!res.ok) return fallbackNames()

      const data = await res.json()
      const text = (data.content as { type: string; text: string }[])
        .find(c => c.type === 'text')?.text ?? '{}'

      try {
        return JSON.parse(text) as Record<string, string>
      } catch {
        return fallbackNames()
      }
    })

    // ── Step 4: Search Kroger for each item (batched to prevent step timeout) ──
    const SEARCH_BATCH_SIZE = 50
    const uniqueNames = [...new Set(belowParItems.map((i) => i.name.toLowerCase().trim()))]
    const searchBatches: string[][] = []
    for (let i = 0; i < uniqueNames.length; i += SEARCH_BATCH_SIZE) {
      searchBatches.push(uniqueNames.slice(i, i + SEARCH_BATCH_SIZE))
    }

    type KrogerProduct = {
      upc: string; productId: string; brand: string
      description: string; size?: string; price?: number; imageUrl?: string
    }
    const searchResults: Record<string, KrogerProduct | null> = {}

    for (let bIdx = 0; bIdx < searchBatches.length; bIdx++) {
      const batchNames = searchBatches[bIdx]!
      const batchResult = await step.run(`search-kroger-products-${bIdx}`, async () => {
        const clientToken = await getClientToken()
        const results: Record<string, KrogerProduct | null> = {}

        await mapWithConcurrency(batchNames, 3, async (originalName) => {
          const searchTerm = normalizedItems[originalName] ?? originalName
          const products   = await searchProducts(
            searchTerm,
            krogerLocationId,
            clientToken,
            3,
          )

          if (!products.length) {
            results[originalName] = null
          } else {
            const best = products.find(p =>
              p.items?.[0]?.inventory?.stockLevel === 'HIGH' && p.items?.[0]?.price
            ) ?? products[0]

            results[originalName] = {
              upc:         best.upc,
              productId:   best.productId,
              brand:       best.brand,
              description: best.description,
              size:        best.items?.[0]?.size,
              price:       getBestPrice(best),
              imageUrl:    getBestProductImage(best),
            }
          }

          await new Promise(r => setTimeout(r, 100))
        })

        return results
      })

      Object.assign(searchResults, batchResult)
    }

    // ── Step 5: Match products + compute quantities (pure — safe to retry) ──
    const matchResult = await step.run('build-cart', async () => {
      const matchedItems:   MatchedItem[] = []
      const unmatchedItems: string[]      = []
      const cartItems: { upc: string; quantity: number; modality: typeof modality }[] = []

      const quantityMap = new Map<string, number>()
      for (const item of belowParItems) {
        const key    = item.name.toLowerCase().trim()
        const deficit = Math.max(0, (item.par_level ?? 1) - (item.current_quantity ?? 0))
        quantityMap.set(key, (quantityMap.get(key) ?? 0) + deficit)
      }

      for (const [originalName, product] of Object.entries(searchResults)) {
        const quantity = Math.max(1, Math.ceil(quantityMap.get(originalName) ?? 1))

        if (!product) {
          unmatchedItems.push(originalName)
          continue
        }

        matchedItems.push({
          original_name:  originalName,
          product_id:     product.productId,
          upc:            product.upc,
          brand:          product.brand,
          description:    product.description,
          size:           product.size,
          price:          product.price,
          image_url:      product.imageUrl,
          quantity,
          added_to_cart:  false,
        })

        cartItems.push({ upc: product.upc, quantity, modality })
      }

      return { matchedItems, unmatchedItems, cartItems }
    })

    // ── Step 6: Add matched items to the customer's Kroger cart ─────────────
    // Split from build-cart so a step retry doesn't re-run product search/matching,
    // and guarded by an org_milestones flag (keyed on this function run) so a
    // retry of this step itself can't add the items to the cart twice.
    const cartAdded = await step.run('add-items-to-kroger-cart', async () => {
      const supabase = createServiceClient({ system: 'inngest:build-shopping-cart' })
      if (!customerToken || matchResult.cartItems.length === 0) return false

      // Idempotency key = org + day + exact cart contents. The old key was
      // `kroger_cart_added:${runId}`: runId is stable across STEP retries but
      // NOT across events, so two runs from a double-clicked "Build Cart"
      // minted two different keys and both added to the real Kroger cart. A
      // content hash means "we already added exactly this cart today" — while
      // still letting a PM legitimately rebuild after changing par levels.
      const cartFingerprint = createHash('sha256')
        .update(JSON.stringify(
          [...matchResult.cartItems]
            .map((i) => `${i.upc}:${i.quantity}:${i.modality}`)
            // Canonicalisation, not display ordering: this sort exists only so
            // the same set of cart lines hashes identically regardless of the
            // order product matching produced them. It must therefore be
            // locale-INDEPENDENT — String.localeCompare (what Sonar's
            // S2871/"provide a compare function" advice suggests) varies with
            // locale and ICU version, so the same cart could fingerprint
            // differently across environments and defeat the duplicate-charge
            // claim below. Plain code-unit comparison is stable everywhere.
            .sort(compareCodeUnits)
        ))
        .digest('hex')
        .slice(0, 32)
      const today = new Date().toISOString().split('T')[0]
      const milestoneKey = `kroger_cart_added:${today}:${cartFingerprint}`

      // CLAIM FIRST, then call Kroger. The previous order was
      // check → external call → mark, so a crash between the (irreversible)
      // cart addition and the mark re-added every item on retry. Inserting
      // with ignoreDuplicates makes the claim atomic: zero rows back means
      // some other run already owns this exact cart.
      const { data: claimed, error: claimError } = await supabase
        .from('org_milestones')
        .upsert(
          { org_id, milestone: milestoneKey },
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
        .select('id')

      if (claimError) throw new Error(`Failed to claim Kroger cart addition: ${claimError.message}`)
      if (!claimed?.length) {
        console.warn(`[build-shopping-cart] cart already claimed for org ${org_id} (${milestoneKey}) — skipping Kroger add`)
        return true
      }

      // The claim is deliberately NOT released if this throws. Kroger's cart
      // API is not transactional — a failure can land after some items were
      // already added — so retrying would risk real duplicate spend. Same
      // fail-closed stance as claimNudgeBudgetSlot's SMS spend ceiling
      // (CLAUDE.md): a skipped cart is recoverable, a double-ordered one is
      // the PM's money. The Inngest step still fails loudly, and the PM can
      // rebuild once par levels or contents change (different fingerprint).
      return await addItemsToKrogerCart(matchResult.cartItems, customerToken)
    })

    if (cartAdded) {
      for (const item of matchResult.matchedItems) item.added_to_cart = true
    }

    const totalEst = matchResult.matchedItems.reduce(
      (sum, i) => sum + (i.price ?? 0) * i.quantity, 0
    )

    const cartResult: CartBuildResult = {
      status:          cartAdded ? 'cart_added' : customerToken ? 'partial' : 'list_only',
      matched_items:   matchResult.matchedItems,
      unmatched_items: matchResult.unmatchedItems,
      cart_url:        cartAdded ? 'https://www.kroger.com/cart' : undefined,
      total_est:       totalEst > 0 ? Math.round(totalEst * 100) / 100 : undefined,
    }

    // ── Step 7: Persist result for dashboard UI ─────────────
    await step.run('persist-result', async () => {
      const supabase = createServiceClient({ system: 'inngest:build-shopping-cart' })
      await supabase.from('org_milestones').upsert({
        org_id,
        milestone: 'last_cart_build',
        value: {
          built_at:        new Date().toISOString(),
          requested_by,
          status:          cartResult.status,
          matched_count:   cartResult.matched_items.length,
          unmatched_count: cartResult.unmatched_items.length,
          total_est:       cartResult.total_est,
          cart_url:        cartResult.cart_url,
          matched_items:   cartResult.matched_items,
          unmatched_items: cartResult.unmatched_items,
          location_name:   krogerLocationName,
        },
      }, { onConflict: 'org_id,milestone' })

      if (cartResult.unmatched_items.length > 0) {
        console.warn(
          `[build-shopping-cart] ${cartResult.unmatched_items.length} unmatched items for org ${org_id}:`,
          cartResult.unmatched_items,
        )
      }
    })

    // ── Step 8: Email PM with cart summary ───────────────────────────────────
    await step.run('send-cart-ready-email', async () => {
      const admin = createServiceClient({ system: 'inngest:build-shopping-cart' })
      const { data: userRecord } = await admin.auth.admin.getUserById(requested_by)
      const pmEmail = userRecord?.user?.email
      if (!pmEmail || !userRecord.user) return

      const html = await renderShoppingCartReadyEmail({
        cartData: {
          ...cartResult,
          built_at:      new Date().toISOString(),
          location_name: krogerLocationName ?? 'your Kroger store',
        },
        recipientName: userRecord.user.user_metadata?.full_name ?? 'there',
      })

      await resend.emails.send({
        from:    FROM,
        to:      pmEmail,
        subject: `Your Kroger restock cart is ready (${cartResult.matched_items.length} items)`,
        html,
      })

      await logAuditEvent({
        orgId:      org_id,
        action:     'inventory.restock_cart.sent',
        targetType: 'organization',
        targetId:   org_id,
        metadata:   {
          matched_items:   cartResult.matched_items.length,
          unmatched_items: cartResult.unmatched_items.length,
          total_est:       cartResult.total_est ?? null,
          status:          cartResult.status,
          location_name:   krogerLocationName ?? null,
        },
      })
    })

    return {
      status:    cartResult.status,
      matched:   cartResult.matched_items.length,
      unmatched: cartResult.unmatched_items.length,
      total_est: cartResult.total_est,
    }
  },
)
