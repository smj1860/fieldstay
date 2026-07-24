# Security Policy

## Supported Versions

FieldStay is a continuously deployed SaaS application. Only the current production deployment (latest `main`) receives security fixes. There are no versioned release branches to patch.

---

## Reporting a Vulnerability

**Do not open a GitHub issue for security vulnerabilities.** Issues are public.

Report security vulnerabilities by emailing:

**security@fieldstay.app**

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept is helpful but not required)
- Whether you believe it to be exploitable against production

You will receive an acknowledgement within **48 hours** and a resolution timeline within **5 business days**. We do not currently operate a formal bug bounty program, but we take all reports seriously and will credit researchers who disclose responsibly.

---

## Security Architecture

### Multi-Tenant Isolation

FieldStay is a multi-tenant application. Every PostgreSQL table has Row Level Security (RLS) enabled — no exceptions. Tenant isolation is enforced at the database layer via two Postgres functions:

- `get_user_org_ids()` — returns all org IDs the authenticated user belongs to; used in SELECT policies
- `is_org_member(org_id, roles[])` — used in write policies; the `owner` role always passes

No application-level code should be trusted as the sole enforcement mechanism for tenant boundaries. The database is the authoritative boundary.

### Authentication

- Supabase Auth with email + password
- Session tokens managed by `@supabase/ssr` — HTTP-only cookies, never exposed to JavaScript
- Auth middleware (`proxy.ts`) enforces authentication on all routes except those explicitly listed in `PUBLIC_ROUTES`, `TOKEN_ROUTES`, and `BYPASS_ROUTES`

### Service Role Key

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. Its use is restricted to:
- Inngest background job steps
- Specific server-side Route Handlers where RLS bypass is explicitly required

It is never passed to client components, never returned in API responses, and never logged.

### Crew PWA Local-First Sync Layer

The crew PWA (`app/crew/*`) reads only from a local Dexie (IndexedDB) cache, never Supabase directly — see `lib/dexie/*`. `DexieProvider` pulls the current user's data (turnovers, properties, inventory, checklists, messages) from Supabase into Dexie on an interval and on reconnect, so a user's local database only ever contains their organization's data. Writes go through a local mutation outbox (`enqueueMutation()`) that drains to Supabase in the background. Direct Supabase reads from client components in the crew PWA are prohibited. (This replaced an earlier PowerSync-based design; PowerSync is fully removed — the `powersync_crew_*` tables no longer exist in the schema at all.)

### Webhook Verification

All inbound webhooks are verified before processing:

- **Stripe / Stripe Connect:** `stripe.webhooks.constructEvent()` with the raw request body and `STRIPE_WEBHOOK_SECRET` (`app/api/webhooks/stripe/route.ts`, `app/api/webhooks/stripe-connect/route.ts`)
- **Telnyx:** Ed25519 signature verification (`verifyTelnyxSignature()` in `app/api/webhooks/telnyx/route.ts`) plus a timestamp-freshness check so a valid-but-old signature can't be replayed
- **Generic provider webhooks** (`app/api/webhooks/[provider]/route.ts` — currently OwnerRez, Hospitable, Hostaway, Kroger): each provider adapter implements its own `validateWebhook()` — OwnerRez uses HTTP Basic Auth (`OWNERREZ_WEBHOOK_USER` / `OWNERREZ_WEBHOOK_PASSWORD`), Hospitable uses an IP-range allowlist plus an HMAC-SHA256 `Signature` header (`HOSPITABLE_WEBHOOK_SECRET`), Kroger has no inbound webhooks at all. Every event is also deduped against a content-hash keyed row in `processed_webhooks` — not `payload.id`, whose semantics vary by provider

Webhook handlers are in the `BYPASS_ROUTES` list so they are reachable by external services without a session, but they authenticate themselves.

### Secrets Management

- All secrets are environment variables, never committed to the repository
- `.env.local` is in `.gitignore`
- `.env.example` contains placeholder values only — it is safe to commit
- Vercel project settings hold production secrets

### Rate Limiting

AI-powered endpoints (data plate OCR, RepuGuard response generation) are rate-limited via Upstash Redis to prevent abuse.

### HTTP Security Headers

Set globally in `vercel.json`:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Content-Security-Policy` — restricts script, style, connect, and frame sources

### PII and Financial Data

- No PII (email addresses, names, phone numbers) is written to application logs
- No Stripe tokens, `actual_cost` values, or financial data is logged
- Raw error messages from third-party APIs are never returned to the client — only sanitized user-facing strings

---

## Dependency Management

GitHub Dependabot is configured to open weekly pull requests for npm dependency updates. Tailwind CSS major version updates are excluded from auto-updates due to breaking change risk.

Security advisories from npm audit should be reviewed and addressed promptly. Critical and high-severity advisories in direct dependencies must be resolved within 7 days of disclosure.

---

## Compliance Notes

FieldStay handles financial data on behalf of property management businesses and their clients. The following compliance considerations apply:

| Standard | Scope | Approach |
|---|---|---|
| PCI-DSS | Payment card data | Stripe Checkout handles all card data. FieldStay is SAQ A-level — no card data touches our servers. |
| GDPR / CPRA | EU/California resident PII | Tenant data deletion is supported via account deletion flow. Data processing agreements are available on request. |
| SOC 2 | Organizational security controls | Architecture is designed for SOC 2 Type II readiness. Formal audit not yet completed. |
