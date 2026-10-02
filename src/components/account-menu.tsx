"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export function AccountMenu({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        if (root.current) root.current.open = false;
      }
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !root.current?.open) return;
      root.current.open = false;
      root.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);
  return (
    <details
      className="account-menu"
      ref={root}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="account-link">
        계정 <span aria-hidden="true">⌄</span>
      </summary>
      <div
        className="account-menu-panel"
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("a") &&
            root.current
          )
            root.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
