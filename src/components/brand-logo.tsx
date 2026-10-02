"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { animateBrand } from "./brand-motion";

type Motion = "full" | "still";
const preferenceKey = "reversing-all-logo-motion";
const letters = Array.from("Reversing All");

export function BrandLogo() {
  const root = useRef<HTMLDivElement>(null);
  const [motion, setMotion] = useState<Motion | null>(null);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(preferenceKey);
    } catch {
      // Storage can be unavailable; the logo still works for this visit.
    }
    setMotion(saved === "still" ? "still" : "full");
  }, []);

  useEffect(() => {
    if (!root.current || !motion || motion === "still") return;
    const tracks = animateBrand(root.current);
    const visibility = () => {
      tracks.forEach((track) =>
        document.hidden ? track.pause() : track.play(),
      );
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      tracks.forEach((track) => track.cancel());
    };
  }, [motion]);

  const still = motion === "still";
  const label = still ? "로고 전체 연출 재생" : "로고 움직임 정지";

  function toggleMotion() {
    const next = still ? "full" : "still";
    setMotion(next);
    try {
      localStorage.setItem(preferenceKey, next);
    } catch {
      // Preference remains in React state without persistent storage.
    }
  }

  return (
    <div className="brand-lockup" ref={root}>
      <button
        className="brand-motion-toggle"
        type="button"
        onClick={toggleMotion}
        aria-label={label}
        title={label}
      >
        <svg
          className="brand-mark"
          viewBox="0 0 28 28"
          width="24"
          height="24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        >
          <path className="brand-route" d="M7 9v5h14M21 9v10" />
          <path
            className="brand-trace"
            d="M7 9v5h14v5"
            strokeDasharray="7 32"
          />
          <rect x="4" y="3" width="6" height="6" rx="1" />
          <rect x="18" y="3" width="6" height="6" rx="1" />
          <rect x="18" y="19" width="6" height="6" rx="1" />
        </svg>
        <svg
          className="brand-motion-control"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          {still ? (
            <path d="M5 3.5 12 8l-7 4.5Z" fill="currentColor" />
          ) : (
            <path d="M5 4v8M11 4v8" stroke="currentColor" strokeWidth="2" />
          )}
        </svg>
      </button>
      <Link className="brand" href="/" aria-label="Reversing All 홈">
        <span className="brand-wordmark" aria-hidden="true">
          <span className="brand-text">
            {letters.map((letter, index) => (
              <span className="brand-slot" key={index}>
                <span className="brand-letter">
                  <span className="brand-face brand-front">{letter}</span>
                  <span className="brand-face brand-back">
                    {letters[letters.length - index - 1]}
                  </span>
                </span>
              </span>
            ))}
            <span className="brand-scan" />
          </span>
        </span>
      </Link>
    </div>
  );
}
