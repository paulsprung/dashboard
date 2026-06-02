import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        glow: '0 0 0 1px rgb(56 189 248 / 0.3), 0 0 22px rgb(56 189 248 / 0.35)',
      },
      backgroundImage: {
        grid: 'linear-gradient(to right, rgb(148 163 184 / 0.06) 1px, transparent 1px), linear-gradient(to bottom, rgb(148 163 184 / 0.06) 1px, transparent 1px)',
      },
    },
  },
  plugins: [],
} satisfies Config;
