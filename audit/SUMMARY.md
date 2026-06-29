# FieldStay Codebase Audit — Round 2 Coordinating Summary

Status: IN PROGRESS
Last checkpoint: round 2 kicked off after pulling latest fixes from main (commits aa3da30, 519381b, 65fd3f7, a03165f, a215f89, 466cfe7)
Next: waiting for domain agents to report in

This is a re-audit following fixes applied after round 1 (see audit/round1/ for the original findings — do not treat those as current state, they are historical snapshots only). Each agent appends a section here when it finishes its domain, with a link to its findings file and a 3-5 bullet summary of top issues: regressions, newly-introduced issues, anything missed in round 1, and confirmation of what was actually fixed.

---

## Schema Naming / API / Webhooks — Round 2 — by Schema/API/Webhooks Auditor
File: audit/03-schema-api-webhooks.md
Top issues:
- Telnyx webhook ed25519 signature verification (round 1 Finding 1) is correctly implemented: real `createVerify('ed25519')` over `timestamp|rawBody`, correct Telnyx header names, raw body read before parsing, fails closed with 401. No regression.
- wo_status cast smell in vendor work-order completion route (round 1 Finding 3) is fixed: now casts to the full `WoStatus` type instead of a hand-rolled 3-value union.
- NEW (Medium): a migration file named literally `new asset_type_standards_rls` (no timestamp, no `.sql` extension) sits in `supabase/migrations/` — violates the `YYYYMMDDHHMMSS_description.sql` convention and may be silently skipped by `supabase db push`; live DB state for `asset_type_standards` RLS not verified in this pass.
- NEW (Low): `TELNYX_WEBHOOK_PUBLIC_KEY` is not documented in `.env.example` despite being required by the new signature-verification code (fails closed if unset, so not a security bug, just a doc gap).
- All clean: `.from('memberships')`, `assigned_crew_id`, `work_order_notes`, `supabase.raw()/.modify()` — zero occurrences app-wide. All 6 most recent migrations (20260625–20260628) are fully reflected in `types/database.ts`. OwnerRez/Hostaway/Kroger webhook adapters all fail closed correctly (no stub returns `true`).
