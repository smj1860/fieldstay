// Ramping load against the app's unauthenticated marketing/entry pages
// (PUBLIC_ROUTES in proxy.ts) — none of these carry a per-IP rate limiter,
// so this exercises Next.js rendering + middleware under sustained
// concurrency rather than any throttle.
//
// Run: k6 run load-tests/k6/public-pages.js
import http from 'k6/http'
import { check, group, sleep } from 'k6'
import { BASE_URL, DEFAULT_THRESHOLDS } from './lib/config.js'

const PAGES = ['/', '/login', '/signup']

export const options = {
  scenarios: {
    ramping_public_pages: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m',  target: 20 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: DEFAULT_THRESHOLDS,
}

export default function publicPages() {
  const page = PAGES[Math.floor(Math.random() * PAGES.length)]
  group(`GET ${page}`, () => {
    const res = http.get(`${BASE_URL}${page}`)
    check(res, { 'status is 200': (r) => r.status === 200 })
  })
  sleep(Math.random() * 2 + 1)
}
