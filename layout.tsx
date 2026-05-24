import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // --------------------------------------------------------
      // FieldStay brand tokens
      // Update these once final brand palette is confirmed.
      // --------------------------------------------------------
      colors: {
        brand: {
          // Primary — deep forest green
          900: '#052820',
          800: '#093b31',  // primary
          700: '#0d4e40',
          600: '#126251',
          500: '#1a5c4a',  // mid
          400: '#2a7a65',
          300: '#3d9880',
          200: '#7dc4b4',
          100: '#c0e6de',
          50:  '#edf7f5',
        },
        accent: {
          // Warm slate for UI chrome
          900: '#1a1f2e',
          800: '#252b3b',
          700: '#323a4f',
          600: '#434c65',
          500: '#566079',
          400: '#7a8599',
          300: '#a3adb8',
          200: '#cbd0d9',
          100: '#eceef2',
          50:  '#f7f8fa',
        },
      },
      fontFamily: {
        // Swap these once FieldStay brand fonts are confirmed
        sans:    ['Inter', 'system-ui', 'sans-serif'],
        display: ['Inter', 'system-ui', 'sans-serif'],
        mono:    ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        '4xl': '2rem',
      },
      boxShadow: {
        'card':    '0 1px 3px 0 rgb(0 0 0 / 0.08), 0 1px 2px -1px rgb(0 0 0 / 0.06)',
        'card-md': '0 4px 6px -1px rgb(0 0 0 / 0.08), 0 2px 4px -2px rgb(0 0 0 / 0.06)',
        'card-lg': '0 10px 15px -3px rgb(0 0 0 / 0.08), 0 4px 6px -4px rgb(0 0 0 / 0.06)',
      },
      animation: {
        'fade-in':    'fadeIn 0.2s ease-out',
        'slide-up':   'slideUp 0.3s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          from: { opacity: '0', transform: 'translateY(-8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}

export default config
