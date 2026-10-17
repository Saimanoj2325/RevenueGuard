import type { Config } from 'tailwindcss';

// "Khata book" design tokens (docs/UX_V2_SPEC.txt). Status colours are only for money state.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: '#F5F2EA', 2: '#ECE8DD' },
        card: '#FFFEFA',
        ink: { DEFAULT: '#1A1A17', 2: '#55534C', 3: '#8A877D' },
        rule: { DEFAULT: '#E3DED1', 2: '#CFC8B6' },
        red: { DEFAULT: '#B23A26', bg: '#F6E3DD' },
        amber: { DEFAULT: '#9A6A12', bg: '#F4EBD6' },
        green: { DEFAULT: '#1E5A3C', bg: '#E4EEE6' },
        flash: '#FFF3C4',
        hl: '#FFE9A8',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', '"Noto Sans Telugu"', '"Noto Sans Devanagari"', 'system-ui', 'sans-serif'],
        serif: ['"Fraunces Variable"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { DEFAULT: '3px', sm: '2px', md: '4px', lg: '4px' },
      boxShadow: { card: '0 1px 0 rgba(26,26,23,.04)', lift: '0 1px 0 rgba(26,26,23,.08)' },
      keyframes: {
        ring: { '0%': { boxShadow: '0 0 0 0 rgba(26,26,23,.35)' }, '100%': { boxShadow: '0 0 0 12px rgba(26,26,23,0)' } },
        ringgreen: { '0%': { boxShadow: '0 0 0 0 rgba(30,90,60,.5)' }, '100%': { boxShadow: '0 0 0 10px rgba(30,90,60,0)' } },
        flash: { '0%': { backgroundColor: '#FFF3C4' }, '100%': { backgroundColor: 'transparent' } },
        slidein: { '0%': { opacity: '0', transform: 'translateX(30px)' }, '100%': { opacity: '1', transform: 'none' } },
        caret: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0' } },
      },
      animation: {
        ring: 'ring 1.2s ease-out infinite',
        ringgreen: 'ringgreen 1.4s ease-out infinite',
        flash: 'flash 1s ease-out',
        slidein: 'slidein .5s cubic-bezier(.2,.8,.2,1)',
        caret: 'caret 1s step-end infinite',
        pulsering: 'ring 1.2s ease-out infinite',
      },
    },
  },
  plugins: [],
};
export default config;
