import { useEffect, useRef, useState } from "react";
import { PaletteIcon } from "./icons";
import { accentSwatches, findTheme, themes, type ThemeSettings } from "./themes";

type ThemePickerProps = {
  settings: ThemeSettings;
  onChange: (settings: ThemeSettings) => void;
};

function ThemePicker({ settings, onChange }: ThemePickerProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const activeAccent = settings.accent ?? findTheme(settings.themeId).colors.accent;

  // Close when clicking elsewhere or pressing Escape.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="theme-picker" ref={container}>
      <button
        className={open ? "button button-ghost button-active" : "button button-ghost"}
        type="button"
        onClick={() => setOpen((shown) => !shown)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Theme"
      >
        <PaletteIcon />
        <span className="button-label">Theme</span>
      </button>

      {open && (
        <div className="theme-popover" role="dialog" aria-label="Theme settings">
          <div className="theme-section-label">Theme</div>
          <div className="theme-options">
            {themes.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className={theme.id === settings.themeId ? "theme-option active" : "theme-option"}
                onClick={() => onChange({ ...settings, themeId: theme.id })}
                aria-pressed={theme.id === settings.themeId}
              >
                <span
                  className="theme-preview"
                  style={{ background: theme.colors.bg, borderColor: theme.colors.controlBorder }}
                  aria-hidden="true"
                >
                  <span style={{ background: theme.colors.surface }} />
                  <span style={{ background: settings.accent ?? theme.colors.accent }} />
                </span>
                <span className="theme-option-text">
                  <span className="theme-option-name">{theme.name}</span>
                  <span className="theme-option-description">{theme.description}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="theme-section-label">Accent color</div>
          <div className="accent-options">
            <button
              type="button"
              className={settings.accent === null ? "accent-auto active" : "accent-auto"}
              onClick={() => onChange({ ...settings, accent: null })}
              aria-pressed={settings.accent === null}
            >
              Theme default
            </button>
            {accentSwatches.map((color) => (
              <button
                key={color}
                type="button"
                className={settings.accent === color ? "accent-swatch active" : "accent-swatch"}
                style={{ background: color }}
                onClick={() => onChange({ ...settings, accent: color })}
                aria-label={`Accent ${color}`}
                aria-pressed={settings.accent === color}
              />
            ))}
            <label className="accent-custom" title="Custom accent color">
              <input
                type="color"
                value={activeAccent}
                onChange={(event) => onChange({ ...settings, accent: event.target.value })}
                aria-label="Custom accent color"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

export default ThemePicker;
