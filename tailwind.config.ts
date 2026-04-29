import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        accent: '#fdd905'
      },
      boxShadow: {
        glow: '0 0 40px rgba(253, 217, 5, 0.15)'
      }
    }
  },
  plugins: []
} satisfies Config;
