/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // WASHO Brand Colors
        washo: {
          blue: '#1248B8',      // Primary WASHO Blue
          dark: '#083A9B',      // Dark Blue
          navy: '#062F80',      // Deep Navy
          light: '#EAF2FF',     // Light Blue
          'lightest': '#F5F8FF', // Very Light Blue
        },
        // Neutral colors
        dark: '#111111',        // Dark text
        grey: '#555555',        // Secondary grey
        // Accent colors
        offer: '#FFD84D',       // Offer yellow
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
        heading: ['Montserrat', 'Poppins', 'ui-sans-serif', 'system-ui'],
      },
      borderRadius: {
        lg: '0.5rem',
        xl: '0.75rem',
      },
      boxShadow: {
        sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        DEFAULT: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
        md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
        lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -2px rgb(0 0 0 / 0.1)',
      },
    },
  },
  plugins: [],
}
