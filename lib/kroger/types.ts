// lib/kroger/types.ts
// Place at: lib/kroger/types.ts

export interface KrogerTokenResponse {
  access_token:   string
  token_type:     'Bearer'
  expires_in:     number
  scope?:         string
  refresh_token?: string
}

export interface KrogerProduct {
  productId:  string
  upc:        string
  brand:      string
  description: string
  images:     { perspective: string; sizes: { size: string; url: string }[] }[]
  items: {
    itemId:   string
    size?:    string
    price?: {
      regular: number
      promo?:  number
    }
    inventory?: { stockLevel: 'HIGH' | 'LOW' | 'TEMPORARILY_OUT_OF_STOCK' }
  }[]
  categories: string[]
}

export interface KrogerProductSearchResponse {
  data: KrogerProduct[]
  meta: { pagination: { total: number; start: number; limit: number } }
}

export interface KrogerLocation {
  locationId: string
  chain:      string
  name:       string
  address: {
    addressLine1: string
    city:         string
    state:        string
    zipCode:      string
  }
  phone: string
}

export interface KrogerCartItem {
  upc:       string
  quantity:  number
  modality?: 'PICKUP' | 'DELIVERY' | 'IN_STORE'
}

export interface CartBuildResult {
  status:          'cart_added' | 'list_only' | 'partial' | 'nothing_below_par' | 'retailer_not_kroger' | 'no_store_configured'
  matched_items:   MatchedItem[]
  unmatched_items: string[]
  cart_url?:       string
  total_est?:      number
}

export interface MatchedItem {
  original_name:  string
  product_id:     string
  upc:            string
  brand:          string
  description:    string
  size?:          string
  price?:         number
  image_url?:     string
  quantity:       number
  added_to_cart:  boolean
}
