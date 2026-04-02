/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Catppuccin Mocha-inspired dark palette
        base: {
          DEFAULT: '#1e1e2e',
          100: '#181825',
          200: '#1e1e2e',
          300: '#313244',
          400: '#45475a',
        },
        surface: {
          DEFAULT: '#313244',
          100: '#313244',
          200: '#45475a',
        },
        overlay: '#6c7086',
        text: {
          DEFAULT: '#cdd6f4',
          muted: '#a6adc8',
          subtle: '#6c7086',
        },
        accent: {
          blue: '#89b4fa',
          green: '#a6e3a1',
          yellow: '#f9e2af',
          red: '#f38ba8',
          teal: '#89dceb',
          lavender: '#b4befe',
          mauve: '#cba6f7',
          peach: '#fab387',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-fast': 'pulse 0.8s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
}
