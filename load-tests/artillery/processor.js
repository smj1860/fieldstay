// Emits both custom counters at 0 once per scenario so they exist in the
// final report even on a run with zero 429s/500s — an `ensure` condition
// referencing a counter that was never emitted evaluates as failed, not as
// zero, so "no errors occurred" needs an explicit zero rather than silence.
// Signature for a scenario-level `function`/`beforeScenario` hook:
// (context, ee, next) — see @artilleryio/int-core/lib/engine_http.js.
function initCounters(context, ee, next) {
  ee.emit('counter', 'custom.rate_limited_responses', 0)
  ee.emit('counter', 'custom.server_errors', 0)
  return next()
}

// Referenced via config.processor / scenario afterResponse hooks below.
// Signature is fixed by Artillery's HTTP engine: (requestParams, response,
// context, ee, next) — see @artilleryio/int-core/lib/engine_http.js.
function trackRateLimitResponses(requestParams, response, context, ee, next) {
  if (response.statusCode === 429) {
    ee.emit('counter', 'custom.rate_limited_responses', 1)
  }
  if (response.statusCode >= 500) {
    ee.emit('counter', 'custom.server_errors', 1)
  }
  return next()
}

module.exports = { initCounters, trackRateLimitResponses }
