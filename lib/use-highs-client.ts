"use client";

import { useEffect, useState } from "react";

import type { Highs } from "./xp-ge-optimize";

type WindowWithHighsFactory = Window & {
  Module?: () => Promise<Highs>;
};

const SCRIPT_SELECTOR = 'script[src$="/highs.js"],script[src*="/highs.js?"]';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function ensureHighsScriptLoaded(): Promise<void> {
  const existingScript = document.querySelector(SCRIPT_SELECTOR) as HTMLScriptElement | null;
  if (existingScript) {
    if ((window as WindowWithHighsFactory).Module) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("failed to load highs.js")), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/highs.js";
    script.async = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("failed to load highs.js")), { once: true });
    document.head.appendChild(script);
  });
}

export default function useHighsClient(): Highs | null {
  const [highs, setHighs] = useState<Highs | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadHighs(): Promise<void> {
      for (let attempt = 0; attempt < 80 && !cancelled; attempt++) {
        const factory = (window as WindowWithHighsFactory).Module;
        if (typeof factory === "function") {
          const module = await factory();
          if (!cancelled) {
            setHighs(module);
          }
          return;
        }

        if (attempt === 0) {
          try {
            await ensureHighsScriptLoaded();
          } catch {
            // Keep polling for a short time to handle delayed script insertion.
          }
        }

        await wait(75);
      }
    }

    loadHighs().catch(() => {
      // Error handling is surfaced by caller when trying to calculate.
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return highs;
}
