"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

const options = [
  { value: "system", label: "시스템" },
  { value: "light", label: "밝게" },
  { value: "dark", label: "어둡게" },
] as const;

export function ThemeSelector() {
  const [theme, setTheme] = useState<Theme>("system");
  const [storageFailed, setStorageFailed] = useState(false);

  useEffect(() => {
    let selected: Theme = "system";
    try {
      const saved = localStorage.getItem("reversing-all:theme");
      if (saved === "system" || saved === "light" || saved === "dark") {
        selected = saved;
      }
    } catch {
      setStorageFailed(true);
    }
    document.documentElement.dataset.theme = selected;
    setTheme(selected);
  }, []);

  function selectTheme(selected: Theme) {
    try {
      localStorage.setItem("reversing-all:theme", selected);
      setStorageFailed(false);
    } catch {
      selected = "system";
      setStorageFailed(true);
    }
    document.documentElement.dataset.theme = selected;
    setTheme(selected);
  }

  return (
    <div className="theme-selector">
      <div
        className="theme-selector-controls"
        role="group"
        aria-label="화면 색"
      >
        <span aria-hidden="true">화면 색</span>
        {options.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-label={`화면 색: ${label}`}
            aria-pressed={theme === value}
            onClick={() => selectTheme(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="theme-selector-status" role="status">
        {storageFailed && "화면 색을 저장하지 못했어요. 시스템 설정을 따라요."}
      </p>
    </div>
  );
}
