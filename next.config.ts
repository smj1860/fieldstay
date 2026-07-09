import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: '/crew/accept-invite/:token',
        destination: '/crew-invite/:token',
        permanent: false,
      },
    ]
  },

  async headers() {
    // Turbopack's dev-mode hydration relies on inline <script> tags and
    // eval()-based module wrapping — a strict script-src blocks React from
    // ever mounting under `next dev` (self.__next_r invariant, page never
    // hydrates). Production builds don't need either, so this only relaxes
    // the dev server, never a deployed build.
    const isDev = process.env.NODE_ENV !== 'production'

    return [
      {
        // Apply these headers to all routes in the application
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              // Locked-down default — no blanket https: source
              "default-src 'self'",

              // Scripts: no 'unsafe-inline'/'unsafe-eval' in production —
              // inline theme script is a static file; wasm-unsafe-eval
              // required by Supabase JS client. Dev mode needs both relaxed
              // for Turbopack's hydration script and HMR to work at all.
              isDev
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
                : "script-src 'self' 'wasm-unsafe-eval'",

              // Styles: 'unsafe-inline' required for the codebase's established
              // style={{ ... }} convention with CSS variables. Inline styles
              // are CSS, not JS — no code-execution XSS risk from this directive.
              "style-src 'self' 'unsafe-inline'",

              // Images: data: for base64, blob: for canvas/crop/file preview
              "img-src 'self' data: blob: https:",

              // Fonts: self + Google Fonts CDN if used
              "font-src 'self' data: https://fonts.gstatic.com",

              // Frames: Stripe hosted elements only
              "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",

              // Workers: blob: required for Supabase Realtime and some WASM usage
              "worker-src 'self' blob:",

              // API + WebSocket connections — preserved from previous config
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://js.stripe.com https://auth.hospitable.com https://public.api.hospitable.com http://localhost:* ws://localhost:* wss://localhost:*",

              // Object/media: locked down entirely
              "object-src 'none'",
              "media-src 'self'",

              // Base URI: prevent base tag injection attacks
              "base-uri 'self'",

              // Form submissions: self only
              "form-action 'self'",
            ].join('; ')
          }
        ]
      }
    ]
  }
}

export default nextConfig
