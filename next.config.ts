import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source:      '/crew/accept-invite/:token',
        destination: '/crew-invite/:token',
        permanent:   false,
      },
    ]
  },
}

export default nextConfig
