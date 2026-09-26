#!/usr/bin/env bash
# scripts/run-plan-probe.sh
# ============================================================================
# Runs scripts/rls-plan-probe.sql — the RLS query-plan probe at multi-tenant
# volume — and turns its outcome into an exit code.
#
# MANUAL, like run-rls-probe.sh, and deliberately NOT a CI gate. Two reasons,
# and the second is the one that matters:
#
#   1. It needs a SESSION that can hold a transaction across statements (seed,
#      ANALYZE, SET ROLE, EXPLAIN, ROLLBACK), which PostgREST cannot give and
#      an RPC cannot either — Postgres rejects SET ROLE inside a SECURITY
#      DEFINER function. So it is psql over a session-mode connection, and the
#      connection string is a second secret this repo's CI does not hold.
#      run-rls-probe.sh was armed in CI before that secret existed and failed
#      three consecutive runs for a reason no code change could fix (see
#      CLAUDE.md, Structural Enforcement layer 4). Do not repeat that: add the
#      secret BEFORE arming anything.
#
#   2. Plan shape is not a property of the source tree. It moves when the data
#      distribution moves, when Postgres is upgraded, and when someone adds an
#      index — none of which a pull request necessarily touches. A red gate on
#      a green diff teaches people to ignore the gate. Run this when the
#      portfolio changes shape, not on every commit.
#
# CONNECTION — same requirement as run-rls-probe.sh:
#
#   SUPABASE_DB_URL must be a SESSION-mode pooler URI on port 5432
#   (not 6543 transaction mode, not db.<ref>.supabase.co which is IPv6-only).
#
# The URI contains a password, so it is never echoed and never passed as an
# argument that would show up in `ps`.
# ============================================================================
set -euo pipefail

SQL_FILE="$(dirname "$0")/rls-plan-probe.sql"
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
wrong tool anyway: it seeds ~40k rows and ANALYZEs six tables to manufacture
volume that production already has. There, run the same EXPLAIN (ANALYZE)
against the real rows with no seed at all.

Re-run with DB_INVARIANTS_ALLOW_PROD=1 if measuring the seeded shape against
production is genuinely what you want.
MSG
      exit 1
    fi
    echo "Running against PRODUCTION by explicit opt-in (DB_INVARIANTS_ALLOW_PROD=1)."
    ;;
esac

echo "Seeding 872 properties across 14 orgs and measuring RLS query plans..."
echo "(everything below is inside one transaction that ends in ROLLBACK)"
echo

# ON_ERROR_STOP=1 is what makes this a gate: every failure mode inside the SQL
# is a RAISE EXCEPTION, and without this psql reports it and still exits 0.
if psql "$SUPABASE_DB_URL" \
     --no-psqlrc \
     --set ON_ERROR_STOP=1 \
     --file "$SQL_FILE"; then
  echo
  echo "RLS plan probe PASSED — every probed dashboard read seeks an org_id index at 872 properties."
else
  echo "RLS plan probe FAILED. Read the psql output above: an ABORTED message means the probe could not measure (and a PASSED canary means it was measuring nothing), a REGRESSION message means a real read stopped seeking its index." >&2
  exit 1
fi
