// Google Analytics 4 bootstrap. Loaded via <Script> in app/layout.tsx,
// immediately after the googletagmanager.com tag itself.
//
// EXTERNAL, not inline, for the same reason /theme-init.js is: an inline
// snippet would force 'unsafe-inline' into script-src on every nonce'd route
// (see buildCsp in proxy.ts). `'self'` already permits a same-origin external
// script under every CSP variant this app emits, so this costs nothing.
//
// The measurement id is duplicated in app/layout.tsx, which builds the tag
// URL. Both are the same public G- id — it ships in the HTML either way and is
// not a secret — and unit/lib/gtag-install.test.ts asserts the two agree.
//
// ONE property covers both fieldstay.app and app.fieldstay.app. They are
// aliases of the same deployment (see app/sitemap.ts), so this file is served
// on both, and GA4's default cookie scope is the registrable domain — the _ga
// cookie is written on .fieldstay.app and a visitor moving from the marketing
// site to the app stays one session. No cross-domain linker is needed or
// wanted here; linker params are for genuinely different registrable domains.
(function () {
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', 'G-S35S0LSCGD');
})();
