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
    step-load.js          single load level, driven by ../step-load.sh
  artillery/
    smoke.yml             same coverage as k6/smoke.js
    public-pages.yml       same coverage as k6/public-pages.js
    token-route-rate-limit.yml   same coverage as k6/token-route-rate-limit.js
    processor.js           custom counters used by the rate-limit scenario
  step-load.sh             finds the breaking point — see "Finding the
                            breaking point" below
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

## Finding the breaking point

`step-load.sh` runs `k6/step-load.js` once per VU level (2 → 5 → 10 → 20 →
40 → 80 → 150 → 250 by default), each a clean k6 invocation, and prints a
table of throughput/latency/error-rate per level so you can see exactly
where things degrade — and whether "breaking" means real errors, or just
latency collapsing while everything still returns 200 (queuing, not
crashing, is a real and common answer — see the Results section of
whatever run you're comparing against).

```bash
LOAD_BASE_URL=https://your-preview.vercel.app \
LOAD_PATH=/ \
pnpm run load:k6:step
# or directly: bash load-tests/step-load.sh

# Override the level list / duration per level / target path:
STEP_LEVELS="10 25 50 100 200 400" STEP_DURATION=20s LOAD_PATH=/login \
  bash load-tests/step-load.sh
```

Needs `k6` and `jq` on PATH. Output goes to
`load-tests/results/step-load-<timestamp>/` (gitignored) — a CSV plus each
level's raw k6 JSON summary and log, in case you need to dig into one level.

### Running this from a GitHub Codespace

If you're testing a Vercel preview URL and this sandbox's network policy
won't reach it, running from a Codespace on this repo works the same way —
Codespaces get normal outbound internet access.

```bash
# k6 isn't preinstalled in the default Codespaces image. The apt repo setup
# (see https://grafana.com/docs/k6/latest/set-up/install-k6/) works too, but
# a pinned binary from GitHub releases is simplest and doesn't need a new
# apt source — check https://github.com/grafana/k6/releases for the current
# version if v0.55.0 has moved on:
curl -sSL "https://github.com/grafana/k6/releases/download/v0.55.0/k6-v0.55.0-linux-amd64.tar.gz" -o /tmp/k6.tar.gz
tar xzf /tmp/k6.tar.gz -C /tmp
sudo mv /tmp/k6-v0.55.0-linux-amd64/k6 /usr/local/bin/k6
k6 version

sudo apt-get install -y jq   # usually already present in Codespaces

LOAD_BASE_URL=https://your-preview.vercel.app pnpm run load:k6:step
```

Before running, check the preview deployment doesn't have Vercel's
**Deployment Protection** (password/SSO) turned on — if it does, every
request bounces off that auth wall before reaching the app, and the results
measure the wall, not FieldStay.

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
