// Single load level for one step of a step-load (breakpoint-finding) run.
// Not meant to be run directly for a full test — see load-tests/step-load.sh,
// which invokes this once per VU level with --vus/--duration and aggregates
// the results into a table. Kept as a bare k6 script (no options block) so
// the orchestrator's CLI flags always win.
//
// Run one level manually: k6 run -e LOAD_BASE_URL=... -e LOAD_PATH=/ --vus 20 --duration 15s load-tests/k6/step-load.js
import http from 'k6/http'
import { check } from 'k6'

const BASE_URL = __ENV.LOAD_BASE_URL || 'http://localhost:3000'
const TARGET_PATH = __ENV.LOAD_PATH || '/'

export default function stepLoad() {
  const res = http.get(`${BASE_URL}${TARGET_PATH}`)
  check(res, { 'status is 200': (r) => r.status === 200 })
}
