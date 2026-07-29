#!/usr/bin/env bash
# Artillery counterpart to step-load.sh. Runs artillery/step-load.yml at
# increasing arrival-rate levels (one clean `artillery run` per level) and
# prints a throughput/latency/error-rate table, same idea as step-load.sh.
#
# Levels here are ARRIVALS/SECOND (Artillery's open load model — new virtual
# users injected per second, independent of whether earlier ones finished),
# not held concurrent VUs like step-load.sh's k6 levels. The two aren't
# directly comparable number-for-number; run both if you want the closed-
# vs-open-model comparison, not just one.
#
# Requires: artillery (already a devDependency — npx artillery), jq on PATH.
#
# Usage:
#   LOAD_BASE_URL=https://your-preview.vercel.app \
#   LOAD_PATH=/ \
#   ./load-tests/step-load-artillery.sh
#
# Config (env vars, all optional):
#   LOAD_BASE_URL   default http://localhost:3000
#   LOAD_PATH       default /
#   STEP_LEVELS     default "2 5 10 20 40 80 150 250" (space-separated arrivals/sec)
#   STEP_DURATION   default 15 (seconds, held per level)
#   STEP_SLEEP      default 2 (seconds between levels, lets the target settle)
set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "jq not found on PATH — install it (apt-get install -y jq / brew install jq)" >&2; exit 1; }

BASE_URL="${LOAD_BASE_URL:-http://localhost:3000}"
TARGET_PATH="${LOAD_PATH:-/}"
LEVELS="${STEP_LEVELS:-2 5 10 20 40 80 150 250}"
DURATION="${STEP_DURATION:-15}"
SLEEP_BETWEEN="${STEP_SLEEP:-2}"

# DURATION is interpolated unquoted into --overrides JSON below (as a bare
# number, e.g. "duration":15) — a k6-style unit suffix like "20s" (valid for
# step-load.sh's k6 --duration flag) would produce invalid JSON here instead
# of a clear error. Numeric seconds only.
if ! [[ "$DURATION" =~ ^[0-9]+$ ]]; then
  echo "STEP_DURATION must be a plain number of seconds (got \"$DURATION\") — this script's phases are seconds, not a k6-style duration string like \"20s\"" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/results/step-load-artillery-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"
CSV="$OUT_DIR/summary.csv"

echo "Target:   $BASE_URL$TARGET_PATH"
echo "Levels:   $LEVELS (arrivals/sec)"
echo "Duration: ${DURATION}s per level"
echo "Output:   $OUT_DIR"
echo

echo "rate,requests,mean_ms,p95_ms,p99_ms,max_ms,pct_200,vusers_failed_rate" > "$CSV"

# Continue through every level even if one fails (a single bad level
# shouldn't abort the whole breakpoint scan), but still exit non-zero at the
# end if any level failed — otherwise a missing dependency, bad config, or
# genuinely failed run silently reports success.
RUN_FAILED=0

for RATE in $LEVELS; do
  echo "=== ${RATE} arrivals/sec ===" >&2
  JSON="$OUT_DIR/level_${RATE}.json"
  LOG="$OUT_DIR/level_${RATE}.log"

  if ! LOAD_BASE_URL="$BASE_URL" LOAD_PATH="$TARGET_PATH" npx artillery run \
      --overrides "{\"config\":{\"phases\":[{\"duration\":${DURATION},\"arrivalRate\":${RATE}}]}}" \
      --output "$JSON" \
      "$SCRIPT_DIR/artillery/step-load.yml" > "$LOG" 2>&1; then
    echo "  artillery exited non-zero at ${RATE} arrivals/sec — see $LOG" >&2
    RUN_FAILED=1
  fi

  if [[ -f "$JSON" ]]; then
    REQS=$(jq -r '(.aggregate.counters."http.requests" // null) as $v | if $v == null then "NA" else $v end' "$JSON")
    MEAN=$(jq -r '(.aggregate.summaries."http.response_time".mean // null) as $v | if $v == null then "NA" else ($v|round) end' "$JSON")
    P95=$(jq -r '(.aggregate.summaries."http.response_time".p95 // null) as $v | if $v == null then "NA" else ($v|round) end' "$JSON")
    P99=$(jq -r '(.aggregate.summaries."http.response_time".p99 // null) as $v | if $v == null then "NA" else ($v|round) end' "$JSON")
    MAX=$(jq -r '(.aggregate.summaries."http.response_time".max // null) as $v | if $v == null then "NA" else ($v|round) end' "$JSON")
    # vusers.failed only counts connection-level errors / failed `expect`
    # checks, not a plain 429 or 5xx status — pct_200 (from the raw status
    # code counters) is what actually shows a rate limiter or an overloaded
    # backend kicking in; vusers_failed_rate still matters for a route that
    # crashes/times out outright.
    PCT200=$(jq -r '
      (.aggregate.counters."http.requests" // 0) as $reqs |
      (.aggregate.counters."http.codes.200" // 0) as $ok |
      if $reqs == 0 then "NA" else (($ok / $reqs) * 10000 | round) / 100 | tostring + "%" end
    ' "$JSON")
    VFAILRATE=$(jq -r '
      (.aggregate.counters."vusers.created" // 0) as $created |
      (.aggregate.counters."vusers.failed" // 0) as $failed |
      if $created == 0 then "NA" else (($failed / $created) * 10000 | round) / 100 | tostring + "%" end
    ' "$JSON")
  else
    REQS=CRASH; MEAN=CRASH; P95=CRASH; P99=CRASH; MAX=CRASH; PCT200=CRASH; VFAILRATE=CRASH
  fi

  echo "$RATE,$REQS,$MEAN,$P95,$P99,$MAX,$PCT200,$VFAILRATE" >> "$CSV"
  sleep "$SLEEP_BETWEEN"
done

echo
echo "=== Results ($CSV) ==="
column -s, -t "$CSV" 2>/dev/null || cat "$CSV"

exit "$RUN_FAILED"
