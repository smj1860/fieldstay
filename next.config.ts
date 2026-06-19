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
    return [
      {
        // Apply these headers to all routes in the application
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self' https: localhost:* =>*; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://*.powersync.journeyapps.com wss://*.powersync.journeyapps.com http://localhost:* ws://localhost:*;"
          }
        ]
      }
    ]
  }
}

export default nextConfig
