"use client";

import { useEffect, useState } from "react";

type ThemeMode = "dark" | "light";

const STORAGE_KEY = "eggincutils-theme";

function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
}

export default function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    const resolved: ThemeMode = saved === "light" ? "light" : "dark";
    setTheme(resolved);
    applyTheme(resolved);
    setReady(true);
  }, []);

  function onThemeChange(nextTheme: ThemeMode): void {
    setTheme(nextTheme);
    applyTheme(nextTheme);
    window.localStorage.setItem(STORAGE_KEY, nextTheme);
  }

  return (
    <div className="theme-switcher" data-ready={ready ? "1" : "0"}>
      <label htmlFor="theme-mode">Theme</label>
      <select id="theme-mode" value={theme} onChange={(event) => onThemeChange(event.target.value as ThemeMode)}>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </div>
  );
}
