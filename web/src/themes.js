// Theme colours. Each one tints the whole interface (background, lines, code blocks)
// as well as the accent used for buttons, links and the selected cell, in light and dark.
// Teal is the original look; its values match the defaults in styles.css.

export const PALETTES = [
  {
    id: "teal",
    name: "Teal",
    light: { bg: "#F3F6F5", surface: "#FFFFFF", codeBg: "#E8EFED", ink: "#142224", muted: "#5B6C6D", line: "#D3DDDA", accent: "#0E6B70", accentWeak: "#D5EBEA", onAccent: "#FFFFFF" },
    dark: { bg: "#0F1819", surface: "#152224", codeBg: "#192B2D", ink: "#E1EBE9", muted: "#91A3A3", line: "#26393B", accent: "#5CC3C6", accentWeak: "#17393B", onAccent: "#042224" },
  },
  {
    id: "blue",
    name: "Blue",
    light: { bg: "#F3F5F9", surface: "#FFFFFF", codeBg: "#E7ECF4", ink: "#141C2B", muted: "#5A6577", line: "#D2D9E5", accent: "#1D5FBF", accentWeak: "#DCE6F7", onAccent: "#FFFFFF" },
    dark: { bg: "#0E1420", surface: "#141C2B", codeBg: "#182235", ink: "#E0E7F2", muted: "#909CB0", line: "#253248", accent: "#7EB0F7", accentWeak: "#1A2C4A", onAccent: "#071A36" },
  },
  {
    id: "purple",
    name: "Purple",
    light: { bg: "#F5F3F9", surface: "#FFFFFF", codeBg: "#ECE8F4", ink: "#1E1729", muted: "#675F76", line: "#DBD4E6", accent: "#6A3FC0", accentWeak: "#E6DDF7", onAccent: "#FFFFFF" },
    dark: { bg: "#13101C", surface: "#1B1726", codeBg: "#221C31", ink: "#E8E2F2", muted: "#A097B0", line: "#2F2741", accent: "#B79CF5", accentWeak: "#2C2245", onAccent: "#1A0D38" },
  },
  {
    id: "pink",
    name: "Pink",
    light: { bg: "#F9F3F6", surface: "#FFFFFF", codeBg: "#F3E7EE", ink: "#2A1722", muted: "#77606C", line: "#E6D3DE", accent: "#A62F78", accentWeak: "#F5DCEB", onAccent: "#FFFFFF" },
    dark: { bg: "#1A0F16", surface: "#24161F", codeBg: "#2D1B27", ink: "#F2E2EB", muted: "#B097A5", line: "#3C2634", accent: "#F0A0D0", accentWeak: "#45213A", onAccent: "#3A0B27" },
  },
  {
    id: "green",
    name: "Green",
    light: { bg: "#F3F7F3", surface: "#FFFFFF", codeBg: "#E7F0E8", ink: "#142316", muted: "#5C6E5F", line: "#D3DED5", accent: "#256E36", accentWeak: "#DAEEDD", onAccent: "#FFFFFF" },
    dark: { bg: "#0E170F", surface: "#142116", codeBg: "#18291B", ink: "#E1EEE3", muted: "#92A696", line: "#253A28", accent: "#7FD18E", accentWeak: "#1B3A21", onAccent: "#062410" },
  },
  {
    id: "graphite",
    name: "Graphite",
    light: { bg: "#F4F5F6", surface: "#FFFFFF", codeBg: "#EAECEF", ink: "#16191E", muted: "#626870", line: "#D7DADF", accent: "#3C4656", accentWeak: "#E1E4E9", onAccent: "#FFFFFF" },
    dark: { bg: "#111315", surface: "#181B1E", codeBg: "#1E2226", ink: "#E4E7EB", muted: "#9AA1A9", line: "#2B3036", accent: "#C3CBD6", accentWeak: "#2A3038", onAccent: "#14181D" },
  },
];

const VARS = {
  bg: "--bg", surface: "--surface", codeBg: "--code-bg", ink: "--ink", muted: "--muted",
  line: "--line", accent: "--accent", accentWeak: "--accent-weak", onAccent: "--on-accent",
};

export function palette(id) {
  return PALETTES.find((p) => p.id === id) || PALETTES[0];
}

// Sets the palette's colours on the page. Returns the background colour (for the
// browser's theme-color and Android's status bar).
export function applyPalette(id, dark) {
  const colours = palette(id)[dark ? "dark" : "light"];
  const style = document.documentElement.style;
  for (const [key, cssVar] of Object.entries(VARS)) style.setProperty(cssVar, colours[key]);
  document.documentElement.dataset.accent = palette(id).id;
  return colours.bg;
}
