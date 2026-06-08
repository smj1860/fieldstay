import { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             'FieldStay Crew',
    short_name:       'FieldStay',
    description:      'FieldStay crew management — turnovers, checklists, messaging',
    start_url:        '/crew',
    scope:            '/crew',
    display:          'standalone',
    orientation:      'portrait',
    background_color: '#0a1628',
    theme_color:      '#0a1628',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable'},
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'},
    ],
  }
}
