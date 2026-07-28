// Smoke test — a handful of VUs hitting the unauthenticated health check
// (app/api/health/route.ts). Confirms the app and its DB connection are up
// before running anything heavier. Not rate-limited (health isn't a
// TOKEN_ROUTE in proxy.ts), so this is safe to point at any environment.
//
// Run: k6 run load-tests/k6/smoke.js
import http from 'k6/http'
import { check, sleep } from 'k6'
import { BASE_URL } from './lib/config.js'

export const options = {
  vus:      3,
  duration: '30s',
  thresholds: {
    http_req_failed:   ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
}

export default function smoke() {
  const res = http.get(`${BASE_URL}/api/health`)
  check(res, {
    'status is 200':      (r) => r.status === 200,
    'reports status ok':  (r) => r.json('status') === 'ok',
  })
  sleep(1)
}
