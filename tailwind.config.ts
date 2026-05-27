import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#EEF1F7',
          100: '#D5DBE9',
          200: '#AAB7D4',
          300: '#7F93BE',
          400: '#546FA9',
          500: '#2A4B8D',
          600: '#1A3570',
          700: '#152C5C',
          800: '#102246',
          900: '#0B1830',
        },
        gold: {
          50:  '#FFFDE7',
          100: '#FFF8C2',
          200: '#FEF08A',
          300: '#FCD116',
          400: '#EAB800',
          500: '#CA9A00',
        },
        accent: {
          50:  '#F8F9FA',
          100: '#E9ECEF',
          200: '#DEE2E6',
          300: '#CED4DA',
          400: '#ADB5BD',
          500: '#6C757D',
          600: '#495057',
          700: '#343A40',
          800: '#1A1D20',
          900: '#0D0F11',
        },
        // Dark theme surface palette
        surface: {
          base:   '#0a1628',
          canvas: '#0e1e3e',
          card:   '#152b52',
          raised: '#1a3464',
        },
      },
      boxShadow: {
        'card':      '0 1px 3px 0 rgb(0 0 0 / 0.08), 0 1px 2px -1px rgb(0 0 0 / 0.05)',
        'card-md':   '0 4px 6px -1px rgb(0 0 0 / 0.08), 0 2px 4px -2px rgb(0 0 0 / 0.05)',
        'dark-card': '0 1px 4px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.3)',
        'dark-lg':   '0 8px 32px rgba(0,0,0,0.5)',
      },
      fontFamily: {
        display: ['var(--font-syne)', 'sans-serif'],
        sans:    ['var(--font-dm-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

export default config
