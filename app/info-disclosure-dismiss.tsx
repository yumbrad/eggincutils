"use client";

import { useEffect } from "react";

export default function InfoDisclosureDismiss() {
  useEffect(() => {
    const getOpenDisclosures = () =>
      Array.from(document.querySelectorAll<HTMLDetailsElement>("details.info-disclosure[open]"));

    const closeOutsideDisclosures = (target: Node | null) => {
      if (!target) {
        return;
      }
      for (const disclosure of getOpenDisclosures()) {
        if (!disclosure.contains(target)) {
          disclosure.removeAttribute("open");
        }
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      closeOutsideDisclosures(event.target as Node | null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      for (const disclosure of getOpenDisclosures()) {
        disclosure.removeAttribute("open");
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return null;
}

