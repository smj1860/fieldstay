// Runs before first paint to apply the user's saved theme preference.
// Loaded via <Script strategy="beforeInteractive"> in app/layout.tsx.
// Dark is the default — only acts if the user explicitly chose light.
(function () {
  try {
    if (localStorage.getItem('fs-theme') === 'light') {
      document.documentElement.classList.add('light');
    }
  } catch {
    // localStorage may be unavailable in some environments — fail silently
  }
})();
