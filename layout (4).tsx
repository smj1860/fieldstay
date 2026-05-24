@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222 47% 11%;
  }

  * {
    @apply border-accent-200;
  }

  body {
    @apply bg-accent-50 text-accent-900 antialiased;
    font-feature-settings: "rlig" 1, "calt" 1;
  }

  /* Scrollbar styling */
  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  ::-webkit-scrollbar-track {
    @apply bg-transparent;
  }
  ::-webkit-scrollbar-thumb {
    @apply bg-accent-300 rounded-full;
  }
  ::-webkit-scrollbar-thumb:hover {
    @apply bg-accent-400;
  }
}

@layer components {
  /* Card */
  .card {
    @apply bg-white rounded-xl shadow-card border border-accent-100 p-6;
  }

  /* Section header */
  .section-header {
    @apply text-sm font-semibold text-accent-500 uppercase tracking-wider mb-3;
  }

  /* Status badges */
  .badge {
    @apply inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium;
  }

  .badge-green  { @apply bg-green-50 text-green-700; }
  .badge-amber  { @apply bg-amber-50 text-amber-700; }
  .badge-red    { @apply bg-red-50 text-red-700; }
  .badge-blue   { @apply bg-blue-50 text-blue-700; }
  .badge-slate  { @apply bg-accent-100 text-accent-600; }

  /* Buttons */
  .btn {
    @apply inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg
           text-sm font-medium transition-all duration-150 disabled:opacity-50
           disabled:cursor-not-allowed focus:outline-none focus:ring-2
           focus:ring-offset-2;
  }

  .btn-primary {
    @apply btn bg-brand-800 text-white hover:bg-brand-700
           focus:ring-brand-500;
  }

  .btn-secondary {
    @apply btn bg-white text-accent-700 border border-accent-200
           hover:bg-accent-50 focus:ring-accent-300;
  }

  .btn-danger {
    @apply btn bg-red-600 text-white hover:bg-red-700 focus:ring-red-500;
  }

  .btn-ghost {
    @apply btn text-accent-600 hover:bg-accent-100 hover:text-accent-900
           focus:ring-accent-300;
  }

  /* Form inputs */
  .input {
    @apply w-full px-3 py-2 rounded-lg border border-accent-200 bg-white
           text-sm text-accent-900 placeholder:text-accent-400
           focus:outline-none focus:ring-2 focus:ring-brand-500
           focus:border-transparent transition-shadow;
  }

  .label {
    @apply block text-sm font-medium text-accent-700 mb-1;
  }

  /* Page shell */
  .page-header {
    @apply mb-6;
  }

  .page-title {
    @apply text-2xl font-bold text-accent-900;
  }

  .page-subtitle {
    @apply text-sm text-accent-500 mt-1;
  }
}
