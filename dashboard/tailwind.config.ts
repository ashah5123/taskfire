import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', '"Cascadia Code"', 'Menlo', 'monospace'],
      },
      colors: {
        gray: {
          925: '#111118',
          950: '#0a0a10',
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-down': 'slideDown 0.15s ease-out',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideDown: { from: { opacity: '0', transform: 'translateY(-4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
    },
  },
  plugins: [],
} satisfies Config
