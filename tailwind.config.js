/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#0b0c10",
        surface: "#12141a",
        "surface-2": "#1a1d26",
        line: "#232733",
        "line-hover": "#2e3342",
        ink: "#dfe3ec",
        "ink-muted": "#9aa3b2",
        "ink-dim": "#8b93a3",
        primary: "#6d7bd6",
        "primary-strong": "#5a68c4",
        "primary-2": "#4f9fcf",
        ok: "#4fae7d",
        warn: "#c79545",
        bad: "#c96a6a",
        // مرادف surface-2 — كان مستخدماً في HealthTab بلا تعريف، فخلفياته لا تُرسم.
        panel: "#1a1d26",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};