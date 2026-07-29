#!/usr/bin/env bash
# Step-load / breakpoint finder: runs k6/step-load.js at increasing VU
# levels, one k6 invocation per level (so each level gets a clean summary),
# and prints a table of throughput/latency/error-rate per level. Use this to
# answer "what breaks first, and at what point" — watch for the level where
# error_rate stops being 0, or where p95 latency crosses whatever you
# consider unusable, even if errors never appear (queuing, not crashing, is
# a valid answer too — see load-tests/README.md).
#
# Requires: k6 on PATH (https://grafana.com/docs/k6/latest/set-up/install-k6/),
# jq on PATH.
#
# Usage:
#   LOAD_BASE_URL=https://your-preview.vercel.app \
#   LOAD_PATH=/ \
#   ./load-tests/step-load.sh
#
# Config (env vars, all optional):
#   LOAD_BASE_URL   default http://localhost:3000
#   LOAD_PATH       default /
#   STEP_LEVELS     default "2 5 10 20 40 80 150 250" (space-separated VU counts)
#   STEP_DURATION   default 15s (k6 duration string, held per level)
#   STEP_SLEEP      default 2 (seconds between levels, lets the target settle)
set -euo pipefail

command -v k6 >/dev/null 2>&1 || { echo "k6 not found on PATH — see load-tests/README.md for install instructions" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq not found on PATH — install it (apt-get install -y jq / brew install jq)" >&2; exit 1; }

BASE_URL="${LOAD_BASE_URL:-http://localhost:3000}"
TARGET_PATH="${LOAD_PATH:-/}"
LEVELS="${STEP_LEVELS:-2 5 10 20 40 80 150 250}"
DURATION="${STEP_DURATION:-15s}"
SLEEP_BETWEEN="${STEP_SLEEP:-2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/results/step-load-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"
CSV="$OUT_DIR/summary.csv"

echo "Target:   $BASE_URL$TARGET_PATH"
echo "Levels:   $LEVELS"
echo "Duration: $DURATION per level"
echo "Output:   $OUT_DIR"
echo

echo "vus,requests,avg_ms,p95_ms,p99_ms,max_ms,error_rate,check_pass_rate" > "$CSV"

for VUS in $LEVELS; do
  echo "=== ${VUS} VUs ===" >&2
  JSON="$OUT_DIR/level_${VUS}.json"
  LOG="$OUT_DIR/level_${VUS}.log"

  if ! LOAD_BASE_URL="$BASE_URL" LOAD_PATH="$TARGET_PATH" k6 run \
      --vus "$VUS" --duration "$DURATION" \
      --summary-trend-stats "avg,min,med,max,p(90),p(95),p(99)" \
      --summary-export="$JSON" \
      "$SCRIPT_DIR/k6/step-load.js" > "$LOG" 2>&1; then
    echo "  k6 exited non-zero at ${VUS} VUs — see $LOG" >&2
  fi

  if [ -f "$JSON" ]; then
    # Round to whole ms / whole counts so the printed table stays readable;
    # each field falls back to "NA" independently rather than letting one
    # missing metric (e.g. no requests completed at all) blank the row.
    REQS=$(jq -r '(.metrics.http_reqs.count // null) as $v | if $v == null then "NA" else ($v|round) end' "$JSON")
    AVG=$(jq -r '(.metrics.http_req_duration.avg // null) as $v | if $v == null then "NA" else ($v|round) end' "$JSON")
    P95=$(jq -r '(.metrics.http_req_duration["p(95)"] // null) as $v | if $v == null then "NA" else ($v|round) end' "$JSON")
    P99=$(jq -r '(.metrics.http_req_duration["p(99)"] // null) as $v | if $v == null then "NA" else ($v|round) end' "$JSON")
    MAX=$(jq -r '(.metrics.http_req_duration.max // null) as $v | if $v == null then "NA" else ($v|round) end' "$JSON")
    ERR=$(jq -r '(.metrics.http_req_failed.value // null) as $v | if $v == null then "NA" else (($v*10000|round)/100 | tostring + "%") end' "$JSON")
    CHKPASS=$(jq -r '(.metrics.checks.value // null) as $v | if $v == null then "NA" else (($v*10000|round)/100 | tostring + "%") end' "$JSON")
  else
    REQS=CRASH; AVG=CRASH; P95=CRASH; P99=CRASH; MAX=CRASH; ERR=CRASH; CHKPASS=CRASH
  fi

  echo "$VUS,$REQS,$AVG,$P95,$P99,$MAX,$ERR,$CHKPASS" >> "$CSV"
  sleep "$SLEEP_BETWEEN"
done

echo
echo "=== Results ($CSV) ==="
column -s, -t "$CSV" 2>/dev/null || cat "$CSV"
