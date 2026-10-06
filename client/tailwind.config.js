/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "-apple-system", "BlinkMacSystemFont", '"Segoe UI"',
          "Roboto", "Helvetica", "Arial", "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
