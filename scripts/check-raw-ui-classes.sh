#!/usr/bin/env bash
# Fails if new raw btn-*/badge-* classes appear outside components/ui.
# Use Button/Badge from components/ui instead of hand-rolling these class names.
#
# Exception: a real navigational link (<Link>/<a>) or a non-interactive
# disabled-looking <span> styled like a button can't use the <Button>
# component itself — <Button> renders a <button>, and a link must stay an
# <a> (right-click/open-in-new-tab, no client-side-only onClick navigation,
# and in some cases deliberately NOT using next/link's prefetch — e.g. an
# OAuth-connect or file-download href). Those call buttonVariantClass()
# from components/ui/Button.tsx instead, which returns the class name from a
# JS expression (className={...}) rather than a literal className="..."
# string — this check's regex only matches the literal-string form, so it
# never flags them. Never hand-write "btn-primary" etc. as a literal string
# outside components/ui/ even for this exception; always go through
# buttonVariantClass().
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
