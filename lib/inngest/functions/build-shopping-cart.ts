// inngest/functions/build-shopping-cart.ts
// Place at: inngest/functions/build-shopping-cart.ts
// Register in: app/api/inngest/route.ts

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import {
  getClientToken,
  searchProducts,
  addItemsToKrogerCart,
  getBestProductImage,
  getBestPrice,
  refreshCustomerToken,
} from '@/lib/kroger/client'
import type { MatchedItem, CartBuildResult } from '@/lib/kroger/types'

export type ShoppingCartRequestedEvent = {
  name: 'inventory/cart_requested'
  data: {
    org_id:        string
    requested_by:  string
    property_ids?: string[]
    modality:      'PICKUP' | 'DELIVERY' | 'IN_STORE'
  }
}

export const buildShoppingCart = inngest.createFunction(
  {
    id:      'build-shopping-cart',
    name:    'Build Kroger Shopping Cart from Below-Par Inventory',
    retries: 2,
  },
  { event: 'inventory/cart_requested' as const },
  async ({ event, step }) => {
    const { org_id, requested_by, property_ids, modality } = event.data
    const supabase = createServiceClient()

    // ── Step 1: Load org settings + below-par items ─────────────
    const { orgSettings, belowParItems } = await step.run('load-inventory-data', async () => {
      const [{ data: org }, { data: items }] = await Promise.all([
        supabase
          .from('organizations')
          .select(`
            id, preferred_retailer, kroger_location_id, kroger_location_name,
            kroger_customer_token, kroger_token_expires_at, kroger_refresh_token
          `)
          .eq('id', org_id)
          .single(),

        supabase
          .from('inventory_items')
          .select(`
            id, name, current_quantity, par_level, unit,
            preferred_brand,
            property_id,
            properties!inner ( id, name, zip )
          `)
          .eq('org_id', org_id)
          .lt('current_quantity', supabase.raw('par_level'))
          .modify((q: any) => {
            if (property_ids?.length) q.in('property_id', property_ids)
          }),
      ])

      if (!org) throw new Error(`Org ${org_id} not found`)
      if (!items?.length) return { orgSettings: org, belowParItems: [] }

      return { orgSettings: org, belowParItems: items }
    })

    if (!belowParItems.length) {
      return { status: 'nothing_below_par', items_checked: 0 }
    }

    if (orgSettings.preferred_retailer !== 'kroger') {
      return { status: 'retailer_not_kroger', preferred: orgSettings.preferred_retailer }
    }

    if (!orgSettings.kroger_location_id) {
      await supabase.from('org_milestones').upsert({
        org_id,
        key:   'kroger_store_needed',
        value: { requested_at: new Date().toISOString() },
      }, { onConflict: 'org_id,key' })
      return { status: 'no_store_configured', action_required: 'connect_kroger_store' }
    }

    // ── Step 2: Refresh customer token if needed ─────────────────
    const customerToken = await step.run('refresh-customer-token', async () => {
      if (!orgSettings.kroger_customer_token) return null

      const expiresAt    = orgSettings.kroger_token_expires_at
        ? new Date(orgSettings.kroger_token_expires_at)
        : null
      const needsRefresh = !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60 * 1000

      if (!needsRefresh) return orgSettings.kroger_customer_token
      if (!orgSettings.kroger_refresh_token) return null

      try {
        const refreshed = await refreshCustomerToken(orgSettings.kroger_refresh_token)
        await supabase
          .from('organizations')
          .update({
            kroger_customer_token:   refreshed.access_token,
            kroger_refresh_token:    refreshed.refresh_token ?? orgSettings.kroger_refresh_token,
            kroger_token_expires_at: new Date(
              Date.now() + refreshed.expires_in * 1000
            ).toISOString(),
          })
          .eq('id', org_id)
        return refreshed.access_token
      } catch (err) {
        console.error('Kroger token refresh failed — falling back to list-only:', err)
        return null
      }
    })

    // ── Step 3: Normalize item names via Claude API ───────────────
    const normalizedItems = await step.run('normalize-item-names', async () => {
      const itemBrandMap = new Map<string, string | null>()

      for (const item of belowParItems) {
        const key = item.name.toLowerCase().trim()
        if (!itemBrandMap.has(key)) {
          itemBrandMap.set(key, (item as any).preferred_brand ?? null)
        }
      }

      const uniqueNames         = [...itemBrandMap.keys()]
      const itemsForNormalization = uniqueNames.map(name => ({
        name,
        brand: itemBrandMap.get(name) ?? null,
      }))

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
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

      if (!res.ok) {
        return Object.fromEntries(
          uniqueNames.map(name => {
            const brand = itemBrandMap.get(name)
            return [name, brand ? `${brand} ${name}` : name]
          })
        )
      }

      const data = await res.json()
      const text = (data.content as { type: string; text: string }[])
        .find(c => c.type === 'text')?.text ?? '{}'

      try {
        return JSON.parse(text) as Record<string, string>
      } catch {
        return Object.fromEntries(
          uniqueNames.map(name => {
            const brand = itemBrandMap.get(name)
            return [name, brand ? `${brand} ${name}` : name]
          })
        )
      }
    })

    // ── Step 4: Search Kroger for each item ──────────────────────
    const searchResults = await step.run('search-kroger-products', async () => {
      const clientToken = await getClientToken()
      const results: Record<string, {
        upc: string; productId: string; brand: string
        description: string; size?: string; price?: number; imageUrl?: string
      } | null> = {}

      const uniqueNames = [...new Set(belowParItems.map((i: any) => i.name.toLowerCase().trim()))]

      for (const originalName of uniqueNames) {
        const searchTerm = normalizedItems[originalName] ?? originalName
        const products   = await searchProducts(
          searchTerm,
          orgSettings.kroger_location_id!,
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
      }

      return results
    })

    // ── Step 5: Build cart ───────────────────────────────────────
    const cartResult = await step.run('build-cart', async () => {
      const matchedItems:   MatchedItem[] = []
      const unmatchedItems: string[]      = []
      const cartItems: { upc: string; quantity: number; modality: typeof modality }[] = []

      // Aggregate deficits across properties for the same item
      const quantityMap = new Map<string, number>()
      for (const item of belowParItems) {
        const key    = item.name.toLowerCase().trim()
        const deficit = Math.max(0, ((item as any).par_level ?? 1) - ((item as any).current_quantity ?? 0))
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

      let cartAdded = false
      if (customerToken && cartItems.length > 0) {
        cartAdded = await addItemsToKrogerCart(cartItems, customerToken)
        if (cartAdded) {
          for (const item of matchedItems) item.added_to_cart = true
        }
      }

      const totalEst = matchedItems.reduce(
        (sum, i) => sum + (i.price ?? 0) * i.quantity, 0
      )

      const result: CartBuildResult = {
        status:          cartAdded ? 'cart_added' : customerToken ? 'partial' : 'list_only',
        matched_items:   matchedItems,
        unmatched_items: unmatchedItems,
        cart_url:        cartAdded ? 'https://www.kroger.com/cart' : undefined,
        total_est:       totalEst > 0 ? Math.round(totalEst * 100) / 100 : undefined,
      }

      return result
    })

    // ── Step 6: Persist result for PowerSync UI sync ─────────────
    await step.run('persist-result', async () => {
      await supabase.from('org_milestones').upsert({
        org_id,
        key:   'last_cart_build',
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
          location_name:   orgSettings.kroger_location_name,
        },
      }, { onConflict: 'org_id,key' })

      if (cartResult.unmatched_items.length > 0) {
        console.warn(
          `[build-shopping-cart] ${cartResult.unmatched_items.length} unmatched items for org ${org_id}:`,
          cartResult.unmatched_items,
        )
      }
    })

    return {
      status:    cartResult.status,
      matched:   cartResult.matched_items.length,
      unmatched: cartResult.unmatched_items.length,
      total_est: cartResult.total_est,
    }
  },
)
