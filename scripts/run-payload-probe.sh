#!/usr/bin/env bash
# scripts/run-payload-probe.sh
# ============================================================================
# Runs scripts/payload-volume-probe.sql — how many rows and bytes each PM board
# and the crew device cache actually carry at 872 properties across 14 orgs —
# and turns its outcome into an exit code.
#
# MANUAL, and deliberately NOT a CI gate, for the same two reasons
# run-plan-probe.sh is not one:
#
#   1. It needs a SESSION that can hold a transaction across statements (seed,
#      ANALYZE, SET ROLE, measure, ROLLBACK). That is psql over a session-mode
#      pooler connection, and the connection string is a second secret this
#      repo's CI does not hold. run-rls-probe.sh was armed in CI before that
#      secret existed and failed three consecutive runs for a reason no code
#      change could fix. Add the secret BEFORE arming anything.
#
#   2. Payload size is not a property of the source tree. It moves when the
#      portfolio's shape moves and when a crew member accumulates another
#      year's assignments — neither of which a pull request touches. A red gate
#      on a green diff teaches people to ignore the gate. Run this when the
#      portfolio changes shape, not on every commit.
#
# CONNECTION — same requirement as run-plan-probe.sh:
#
#   SUPABASE_DB_URL must be a SESSION-mode pooler URI on port 5432
#   (not 6543 transaction mode, not db.<ref>.supabase.co which is IPv6-only).
#
# The URI contains a password, so it is never echoed and never passed as an
# argument that would show up in `ps`.
# ============================================================================
set -euo pipefail

SQL_FILE="$(dirname "$0")/payload-volume-probe.sql"
PROD_REF='vpmznjktllhmmbfnxuvk'

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  echo "SUPABASE_DB_URL is not set. This probe needs a session-mode pooler URI on port 5432." >&2
  echo "See docs/E2E_SETUP.md section 4a for where that connection string comes from." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is not installed. Install postgresql-client." >&2
  exit 1
fi

# Substring match on the ref only — never print the URI, it holds the password.
case "$SUPABASE_DB_URL" in
  *"$PROD_REF"*)
    if [[ "${DB_INVARIANTS_ALLOW_PROD:-0}" != '1' ]]; then
      cat >&2 <<'MSG'
REFUSED: SUPABASE_DB_URL points at PRODUCTION.

Everything this probe does is rolled back, but on production it is usually the
wrong tool anyway: it seeds ~200k rows to manufacture volume, and production
either already has that volume (measure it directly) or does not (in which
case the seeded answer is the one this file already records).

Re-run with DB_INVARIANTS_ALLOW_PROD=1 if measuring the seeded shape against
production is genuinely what you want.
MSG
      exit 1
    fi
    echo "Running against PRODUCTION by explicit opt-in (DB_INVARIANTS_ALLOW_PROD=1)."
    ;;
esac

echo "Seeding 872 properties across 14 orgs plus two years of one crew member's"
echo "assignment history, and measuring what each surface ships..."
echo "(everything below is inside one transaction that ends in ROLLBACK)"
echo

# ON_ERROR_STOP=1 is what makes this a gate: every failure mode inside the SQL
# is a RAISE EXCEPTION, and without this psql reports it and still exits 0.
if psql "$SUPABASE_DB_URL" \
     --no-psqlrc \
     --set ON_ERROR_STOP=1 \
     --file "$SQL_FILE"; then
  echo
  echo "Payload probe PASSED — every measured surface is inside its ceiling."
  echo "Read projected_ceiling_years on the crew device row: that cache has no"
  echo "retention horizon, so passing today is a statement about tenure, not a"
  echo "statement about the design."
else
  echo "Payload probe FAILED. Read the psql output above: an ABORTED message means the probe could not measure (and a passing CANARY means it was measuring nothing), a CEILING EXCEEDED message means a surface genuinely outgrew its budget." >&2
  exit 1
fi
