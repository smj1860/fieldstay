// Deliberately exceeds workOrderRatelimit (20 req/min/IP, lib/rate-limit.ts)
// on the public work-order token page (a TOKEN_ROUTE in proxy.ts) to confirm
// the 429 actually engages rather than letting the route accept unlimited
// traffic. The token is a well-formed but fake UUID — see
// load-tests/.env.load.example — so responses are expected to be a
// "not found" state, not real work order data.
//
// Only point this at an environment you control (local dev or a
// staging/preview deploy with its own Upstash instance). It is designed to
// trip the limiter, which is the point, but that also burns real Upstash
// request quota — do not run it against production.
//
// Run: k6 run load-tests/k6/token-route-rate-limit.js
import http from 'k6/http'
import { check } from 'k6'
import { Counter } from 'k6/metrics'
import { BASE_URL, WORK_ORDER_TOKEN } from './lib/config.js'

const rateLimited  = new Counter('rate_limited_responses')
const serverErrors = new Counter('server_errors')

export const options = {
  scenarios: {
    exceed_token_route_limit: {
      executor:        'constant-arrival-rate',
      rate:             40,   // 2x workOrderRatelimit's 20/min — from one source IP
      timeUnit:        '1m',
      duration:        '90s',
      preAllocatedVUs:  5,
      maxVUs:           10,
    },
  },
  thresholds: {
    server_errors:          ['count==0'],
    rate_limited_responses: ['count>0'],   // proves the limiter actually engaged
  },
}

export default function tokenRouteRateLimit() {
  const res = http.get(`${BASE_URL}/work-orders/${WORK_ORDER_TOKEN}`)

  if (res.status === 429) rateLimited.add(1)
  if (res.status >= 500)  serverErrors.add(1)

  check(res, {
    'status is 200, 404, or 429': (r) => [200, 404, 429].includes(r.status),
  })
}
