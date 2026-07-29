// Shared config for every k6 script in this directory. k6 doesn't read
// dotenv files itself — export LOAD_BASE_URL etc. into the shell before
// running (see load-tests/README.md), or pass with `k6 run -e KEY=value`.
export const BASE_URL = __ENV.LOAD_BASE_URL || 'http://localhost:3000'

export const WORK_ORDER_TOKEN =
  __ENV.LOAD_WORK_ORDER_TOKEN || '00000000-0000-0000-0000-000000000000'
export const OWNER_PORTAL_TOKEN =
  __ENV.LOAD_OWNER_PORTAL_TOKEN || '00000000-0000-0000-0000-000000000000'
export const VENDOR_CONNECT_TOKEN =
  __ENV.LOAD_VENDOR_CONNECT_TOKEN || '00000000-0000-0000-0000-000000000000'

// Shared thresholds so a run fails loudly (non-zero exit code) instead of
// just printing a summary nobody reads.
export const DEFAULT_THRESHOLDS = {
  http_req_failed:   ['rate<0.01'],
  http_req_duration: ['p(95)<1000'],
}
