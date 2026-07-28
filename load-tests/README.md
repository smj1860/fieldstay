# Load Testing — k6 + Artillery

Two independent load-testing setups against the same target routes, so
results can be cross-checked between tools. Both are safe to point at a
local dev server by default; read the "Where to point these" section before
running against anything else.

## What's here

```
load-tests/
  .env.load.example      copy to .env.load (gitignored) and fill in
  k6/
    lib/config.js        shared BASE_URL / token config, reads __ENV
    smoke.js             GET /api/health — unauthenticated, unthrottled
    public-pages.js      ramping load against /, /login, /signup
    token-route-rate-limit.js   exceeds workOrderRatelimit on purpose
  artillery/
    smoke.yml             same coverage as k6/smoke.js
    public-pages.yml       same coverage as k6/public-pages.js
    token-route-rate-limit.yml   same coverage as k6/token-route-rate-limit.js
    processor.js           custom counters used by the rate-limit scenario
```

Each pair (`k6/x.js` / `artillery/x.yml`) targets the same route(s) with a
roughly equivalent load profile — pick whichever tool you prefer, or run
both to compare.

## Install

**k6** is a standalone Go binary, not an npm package — install one of:

```bash
# macOS
brew install k6

# Debian/Ubuntu — see https://grafana.com/docs/k6/latest/set-up/install-k6/
# for the current apt repo + signing key setup

# Or grab a binary directly from https://github.com/grafana/k6/releases,
# or run via Docker: docker run --rm -i --network=host grafana/k6 run - < load-tests/k6/smoke.js
```

**Artillery** is already a devDependency (`pnpm install` pulls it in) — run
it via `npx artillery` or `pnpm run load:artillery:*`.

## Configure

```bash
cp load-tests/.env.load.example load-tests/.env.load
# edit LOAD_BASE_URL if not testing against localhost:3000
export $(grep -v '^#' load-tests/.env.load | xargs)
```

k6 also accepts `-e KEY=value` flags directly if you'd rather not export
anything (`k6 run -e LOAD_BASE_URL=http://localhost:3000 load-tests/k6/smoke.js`).

## Run

Start the app first (`pnpm dev`), then in another terminal:

```bash
# k6
pnpm run load:k6:smoke
pnpm run load:k6:pages
pnpm run load:k6:ratelimit

# Artillery
pnpm run load:artillery:smoke
pnpm run load:artillery:pages
pnpm run load:artillery:ratelimit
```

## What each scenario checks

- **smoke** — a few requests/sec against `/api/health`
  (`app/api/health/route.ts`). Confirms the app and its Supabase connection
  are reachable. Not rate-limited (health isn't in `TOKEN_ROUTES` in
  `proxy.ts`), so this is safe against any environment.
- **public-pages** — ramping concurrent load against the unauthenticated
  `PUBLIC_ROUTES` (`/`, `/login`, `/signup`). No per-IP limiter on these
  either; this exercises Next.js rendering + middleware under load.
- **token-route-rate-limit** — deliberately exceeds `workOrderRatelimit`
  (20 req/min/IP, `lib/rate-limit.ts`) against `/work-orders/<fake-token>`,
  a `TOKEN_ROUTES` entry in `proxy.ts`. Asserts that 429s actually show up
  (proving the limiter engages) and that nothing 500s under the burst. This
  one is deliberately abusive to a single route — see the warning below.

## Where to point these

- **Local dev (`http://localhost:3000`) is the default and always safe.**
- Pointing at a **preview/staging deployment** is fine as long as it has its
  own Upstash instance — check before running, since these scripts generate
  sustained concurrent traffic and the rate-limit scenario is designed to
  trip a real limiter (burning real Upstash request quota against whatever
  `LOAD_BASE_URL` you set).
- **Never point these at production** without checking with whoever owns
  Vercel/Upstash/Supabase usage first — `token-route-rate-limit` in
  particular exists to intentionally abuse a route.

## Extending

- Both tools' `smoke`/`public-pages` scripts are unauthenticated only. There
  is currently no scripted login flow for either tool — Supabase's SSR
  cookie session (`@supabase/ssr`) isn't a plain bearer token, so scripting
  an authenticated PM/crew session here means replicating that cookie
  exchange, which hasn't been built yet. If you add one, follow the same
  `.env.load`-driven config pattern as `LOAD_WORK_ORDER_TOKEN` etc., and
  never commit real credentials into a `.yml`/`.js` file — only into the
  gitignored `.env.load`.
- Each of the three `TOKEN_ROUTES` limiter prefixes (`rl:wo`,
  `rl:vendor-connect`, `rl:owner-portal`, `rl:guidebook` — see
  `lib/rate-limit.ts`) is independent, so `token-route-rate-limit.js`/`.yml`
  only exercises the work-order one. Copy the pattern for the others if you
  need to verify them too.
