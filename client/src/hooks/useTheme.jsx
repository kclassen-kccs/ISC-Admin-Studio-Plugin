import { createContext, useContext, useEffect, useState } from "react";

const ThemeContext = createContext(null);

// The user's CHOICE: "system" | "light" | "dark". "system" follows the
// operating system's appearance, and is the default, so the app doesn't pin
// a theme on someone who never picked one.
//
// This replaced a plain "theme" string plus a server-side darkMode boolean.
// A boolean has no way to express "follow the environment", so its false
// default meant every user who had never touched the toggle had LIGHT forced
// on them at every load, overriding their device setting entirely.
const STORED_MODE = "theme-mode";
// Legacy key, still read once so an existing dark choice survives the change.
const LEGACY_THEME = "theme";

const MODES = new Set(["system", "light", "dark"]);

function prefersDark() {
  return typeof window !== "undefined"
    && window.matchMedia
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getInitialMode() {
  try {
    const stored = localStorage.getItem(STORED_MODE);
    if (MODES.has(stored)) return stored;
    // Only a deliberate dark choice carries over; the old code wrote "light"
    // on every load, so treating that as a choice would keep exactly the
    // people this change is meant to fix stuck in light.
    if (localStorage.getItem(LEGACY_THEME) === "dark") return "dark";
  } catch {
    // Private browsing / blocked storage — fall through to the default.
  }
  return "system";
}

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(getInitialMode);
  const [systemDark, setSystemDark] = useState(prefersDark);

  // Track the OS preference live, so switching the system to dark takes
  // effect without a reload.
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const theme = mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(STORED_MODE, mode);
      // Keep the legacy key roughly right for anything still reading it.
      localStorage.setItem(LEGACY_THEME, theme);
    } catch {
      // Storage unavailable — the theme still applies for this session.
    }
  }, [mode, theme]);

  function setMode(next) {
    if (MODES.has(next)) setModeState(next);
  }

  // Kept so existing callers that just want light/dark keep working; picking
  // one explicitly is by definition no longer "system".
  function setTheme(next) {
    setMode(next === "dark" ? "dark" : "light");
  }

  function toggleTheme() {
    setTheme(theme === "dark" ? "light" : "dark");
  }

  return (
    <ThemeContext.Provider value={{ theme, mode, setMode, setTheme, toggleTheme, systemDark }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
