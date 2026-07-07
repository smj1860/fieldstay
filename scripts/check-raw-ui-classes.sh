#!/usr/bin/env bash
# Fails if new raw btn-*/badge-* classes appear outside components/ui.
# Use Button/Badge from components/ui instead of hand-rolling these class names.
#
# card/input are intentionally excluded — those strings are common enough
# English words (e.g. card-grid, input-group) that a blunt grep would
# false-positive constantly. Review those two by eye in code review.
set -euo pipefail

HITS=$(grep -rlE 'className="[^"]*\b(btn-primary|btn-secondary|btn-cta|btn-danger|btn-ghost|badge-green|badge-amber|badge-red|badge-blue|badge-gold|badge-slate)\b' \
  app components --include="*.tsx" 2>/dev/null | grep -v "components/ui/" || true)

if [ -n "$HITS" ]; then
  echo "Raw UI classes found outside components/ui/ — use the Button/Badge components instead:"
  echo "$HITS"
  exit 1
fi

echo "No raw UI classes found outside components/ui/."
