import type { Config } from "tailwindcss";

// Amazon corporate design tokens per design.md
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#131A22",        // Amazon dark navy/ink (header)
        navy: "#232F3E",       // Amazon navy (secondary surfaces)
        orange: "#FF9900",     // Amazon orange (primary actions)
        "orange-dark": "#E88B00",
        link: "#007185",       // Amazon corporate link blue
        "link-dark": "#005A6E",
        surface: "#FFFFFF",
        canvas: "#F3F4F6",
        border: "#D5D9D9",
        success: "#067D62",
        warning: "#B45309",
        danger: "#B12704",
      },
      borderRadius: {
        DEFAULT: "6px",
        sm: "4px",
        md: "8px",
      },
      fontFamily: {
        sans: ["Amazon Ember", "Arial", "Helvetica", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
