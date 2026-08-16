#!/usr/bin/env bash
# scripts/run-rls-probe.sh
# ============================================================================
# Runs scripts/rls-isolation-probe.sql — the dynamic cross-tenant isolation
# probe — and turns its outcome into an exit code CI can gate on.
#
# WHY A SHELL WRAPPER AND NOT ANOTHER .mjs CHECK
#
# The db-invariants job's three sibling checks talk to PostgREST, which cannot
# hold a transaction across statements. The probe's whole method is a
# transaction: seed, SET ROLE, count, ROLLBACK. So it needs a real session, and
# the smallest thing that gives one is psql over a session-mode connection.
#
# That is also why this script is NOT in ci-gating.test.ts's INSTALL_FREE_SCRIPTS
# list — it is not a Node script and has its own assertions in that file.
#
# CONNECTION
#
# SUPABASE_DB_URL must be a SESSION-mode pooler URI:
#
#   postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
#
# Port 5432 on the pooler (session mode), not 6543 (transaction mode) and not
# db.<ref>.supabase.co (direct — IPv6 only, and GitHub runners are IPv4).
#
# The URI contains a password, so it is never echoed, never passed as an
# argument that would show up in `ps`, and never interpolated into a log line.
# ============================================================================
set -euo pipefail

SQL_FILE="$(dirname "$0")/rls-isolation-probe.sql"

# Production ref. The probe is read-only in effect — everything it writes is
# rolled back — but pointing a CI job at production is a decision someone
# should make on purpose, so it takes the same opt-in the sibling checks use.
PROD_REF='vpmznjktllhmmbfnxuvk'

# ── Self-disarm, same trade-off as the sibling checks ───────────────────────
# Absent secrets mean a fork PR or an unconfigured repo: warn loudly and pass,
# because a permanently red required check is one nobody looks at. On the
# canonical repo an absent secret is a misconfiguration instead, and
# RLS_PROBE_REQUIRE_ARMED is what tells the two apart.
if [ -z "${SUPABASE_DB_URL:-}" ]; then
  if [ "${RLS_PROBE_REQUIRE_ARMED:-0}" = '1' ]; then
    echo "::error title=RLS isolation probe UNARMED::SUPABASE_DB_URL is not set but RLS_PROBE_REQUIRE_ARMED=1. Cross-tenant isolation was NOT verified."
    exit 1
  fi
  echo "::warning title=RLS isolation probe UNARMED::SUPABASE_DB_URL is not set, so cross-tenant isolation was NOT dynamically verified. A well-formed policy expressing the wrong rule would not be caught. See scripts/rls-isolation-probe.sql."
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "::error title=RLS isolation probe cannot run::psql is not installed. Install postgresql-client."
  exit 1
fi

# Substring match on the ref only. Never print the URI itself — it holds the
# database password.
case "$SUPABASE_DB_URL" in
  *"$PROD_REF"*)
    if [ "${DB_INVARIANTS_ALLOW_PROD:-0}" != '1' ]; then
      echo "::error title=RLS isolation probe refused::SUPABASE_DB_URL points at PRODUCTION. Re-run with DB_INVARIANTS_ALLOW_PROD=1 if that is deliberate."
      exit 1
    fi
    echo "Running against PRODUCTION by explicit opt-in (DB_INVARIANTS_ALLOW_PROD=1)."
    ;;
esac

# Pin a specific tenant when investigating one. Unset, the probe picks the org
# with the most properties — see the file's probe_target block.
if [ -n "${FIELDSTAY_PROBE_USER:-}" ]; then
  export PGOPTIONS="-c fieldstay.probe_user=${FIELDSTAY_PROBE_USER}"
  echo "Probing as pinned user ${FIELDSTAY_PROBE_USER}."
fi

echo "Running dynamic cross-tenant isolation probe..."

# ON_ERROR_STOP=1 is what makes this a gate: every failure mode inside the SQL
# is a RAISE EXCEPTION, and without this flag psql reports the error, carries
# on to the next statement, and exits 0.
if psql "$SUPABASE_DB_URL" \
     --no-psqlrc \
     --set ON_ERROR_STOP=1 \
     --file "$SQL_FILE"; then
  echo "RLS isolation probe PASSED — no foreign-org rows visible to an authenticated user."
else
  echo "::error title=Cross-tenant isolation FAILED::scripts/rls-isolation-probe.sql reported a leak or could not verify isolation. Read the psql output above — an ABORTED message means the probe could not measure, a LEAK message means it did."
  exit 1
fi
