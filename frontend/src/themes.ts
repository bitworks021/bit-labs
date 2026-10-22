import type { Monaco } from "@monaco-editor/react";

export type ThemeColors = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  surfaceRaised: string;
  control: string;
  border: string;
  controlBorder: string;
  controlBorderHover: string;
  text: string;
  textStrong: string;
  textSoft: string;
  textMuted: string;
  textSubtle: string;
  accent: string;
  warning: string;
  danger: string;
  shadow: string;
};

export type Theme = {
  id: string;
  name: string;
  description: string;
  monacoBase: "vs" | "vs-dark" | "hc-black";
  colors: ThemeColors;
};

export const themes: Theme[] = [
  {
    id: "midnight",
    name: "Midnight",
    description: "Default dark theme",
    monacoBase: "vs-dark",
    colors: {
      bg: "#111827",
      surface: "#161f2e",
      surfaceAlt: "#131c2a",
      surfaceRaised: "#1b2636",
      control: "#202b3b",
      border: "#283244",
      controlBorder: "#3b475a",
      controlBorderHover: "#4b5a70",
      text: "#e5e7eb",
      textStrong: "#f9fafb",
      textSoft: "#b7c3d2",
      textMuted: "#a8b2c2",
      textSubtle: "#8f9bad",
      accent: "#fb923c",
      warning: "#fbbf24",
      danger: "#fb7185",
      shadow: "rgb(0 0 0 / 35%)",
    },
  },
  {
    id: "dim",
    name: "Dim",
    description: "Softer, lower-contrast dark",
    monacoBase: "vs-dark",
    colors: {
      bg: "#22272e",
      surface: "#2d333b",
      surfaceAlt: "#272c33",
      surfaceRaised: "#2d333b",
      control: "#373e47",
      border: "#3d444d",
      controlBorder: "#4a525c",
      controlBorderHover: "#5b636e",
      text: "#cdd5de",
      textStrong: "#e6edf3",
      textSoft: "#b3bcc6",
      textMuted: "#9aa4ae",
      textSubtle: "#808a95",
      accent: "#6cb6ff",
      warning: "#e0b44a",
      danger: "#f47067",
      shadow: "rgb(0 0 0 / 30%)",
    },
  },
  {
    id: "light",
    name: "Light",
    description: "Bright, for well-lit rooms",
    monacoBase: "vs",
    colors: {
      bg: "#ffffff",
      surface: "#f5f7fa",
      surfaceAlt: "#eef1f5",
      surfaceRaised: "#e6eaf0",
      control: "#ffffff",
      border: "#d9dee6",
      controlBorder: "#c4cbd6",
      controlBorderHover: "#9aa5b4",
      text: "#1f2937",
      textStrong: "#0b1220",
      textSoft: "#374151",
      textMuted: "#4b5563",
      textSubtle: "#6b7280",
      accent: "#0f9b7a",
      warning: "#b45309",
      danger: "#be123c",
      shadow: "rgb(15 23 42 / 18%)",
    },
  },
  {
    id: "sepia",
    name: "Sepia",
    description: "Warm paper tones, easy on the eyes",
    monacoBase: "vs",
    colors: {
      bg: "#f4ecd8",
      surface: "#ede3cb",
      surfaceAlt: "#e8dcc0",
      surfaceRaised: "#e2d4b5",
      control: "#f8f2e3",
      border: "#d6c7a6",
      controlBorder: "#c4b38f",
      controlBorderHover: "#a8956f",
      text: "#433422",
      textStrong: "#2b2015",
      textSoft: "#5b4a35",
      textMuted: "#6e5c45",
      textSubtle: "#857258",
      accent: "#b5651d",
      warning: "#a15c00",
      danger: "#b3261e",
      shadow: "rgb(67 52 34 / 20%)",
    },
  },
  {
    id: "contrast",
    name: "High contrast",
    description: "Maximum legibility",
    monacoBase: "hc-black",
    colors: {
      bg: "#000000",
      surface: "#0a0a0a",
      surfaceAlt: "#050505",
      surfaceRaised: "#141414",
      control: "#000000",
      border: "#6b6b6b",
      controlBorder: "#ffffff",
      controlBorderHover: "#ffd400",
      text: "#ffffff",
      textStrong: "#ffffff",
      textSoft: "#f0f0f0",
      textMuted: "#e0e0e0",
      textSubtle: "#cfcfcf",
      accent: "#ffd400",
      warning: "#ffb000",
      danger: "#ff6b6b",
      shadow: "rgb(0 0 0 / 60%)",
    },
  },
];

export const accentSwatches = ["#fb923c", "#37c9a5", "#6cb6ff", "#a78bfa", "#f472b6", "#facc15"];

export type ThemeSettings = {
  themeId: string;
  // null keeps the theme's own accent.
  accent: string | null;
};

const storageKey = "bit-lab-theme";

export function loadThemeSettings(): ThemeSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as ThemeSettings | null;
    if (saved && themes.some((theme) => theme.id === saved.themeId)) {
      return { themeId: saved.themeId, accent: saved.accent ?? null };
    }
  } catch {
    // Storage can be unavailable or hold stale data; fall back to the default.
  }
  return { themeId: themes[0].id, accent: null };
}

export function saveThemeSettings(settings: ThemeSettings) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    // Not being able to remember the theme is harmless.
  }
}

export function findTheme(id: string) {
  return themes.find((theme) => theme.id === id) ?? themes[0];
}

// Dark text on light accents, white text on dark ones.
function readableOn(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.35 ? "#0b1220" : "#ffffff";
}

function kebab(name: string) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function applyTheme(settings: ThemeSettings) {
  const theme = findTheme(settings.themeId);
  const colors = { ...theme.colors, accent: settings.accent ?? theme.colors.accent };
  const root = document.documentElement;

  for (const [name, value] of Object.entries(colors)) {
    root.style.setProperty(`--${kebab(name)}`, value);
  }
  root.style.setProperty("--on-accent", readableOn(colors.accent));
  root.style.colorScheme = theme.monacoBase === "vs" ? "light" : "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colors.surface);
}

export function monacoThemeName(id: string) {
  return `bit-lab-${id}`;
}

export function defineMonacoThemes(monaco: Monaco) {
  for (const theme of themes) {
    monaco.editor.defineTheme(monacoThemeName(theme.id), {
      base: theme.monacoBase,
      inherit: true,
      rules: [],
      colors: {
        "editor.background": theme.colors.bg,
        "editor.lineHighlightBackground": theme.colors.surface,
        "editorLineNumber.foreground": theme.colors.textSubtle,
        "editorCursor.foreground": theme.colors.accent,
      },
    });
  }
}
