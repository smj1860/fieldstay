// lib/pwa/cache-names.ts
//
// The Cache Storage bucket names, in ONE place on the app side.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS MODULE EXISTS
//
// public/sw.js is served as a static file and cannot import from `lib/`, so the
// names are necessarily written twice. That duplication broke on 2026-08-23:
// sw.js was bumped to v3 when the offline allowlist changed, and
// lib/dexie/sync/warm-routes.ts — which carried its own copy and a comment
// saying "bump both together" — was left at v2.
//
// The failure is silent in the worst way. `caches.open('fieldstay-shell-v2')`
// CREATES the bucket if it is missing, so every warm still succeeded, wrote a
// real page document, and returned a healthy count. The service worker just
// read from a different bucket. The crew PWA's whole point — tap an assignment
// at a property with no signal — would have been quietly dead, with the warm
// reporting success the entire time.
//
// So: one constant here for every app-side reader, and
// `unit/guardrails/sw-cache-name-parity.test.ts` compares it to the literal in
// sw.js. Bumping the worker without bumping this now fails CI.

/** Page documents. Must equal SHELL_CACHE in public/sw.js. */
export const SHELL_CACHE = 'fieldstay-shell-v4'

/** Hashed build output. Must equal ASSET_CACHE in public/sw.js. */
export const ASSET_CACHE = 'fieldstay-assets-v4'
