"use client";

import { useEffect } from "react";

export default function InfoDisclosureDismiss() {
  useEffect(() => {
    const DISCLOSURE_SELECTOR = "details.info-disclosure";
    const OPEN_DISCLOSURE_SELECTOR = `${DISCLOSURE_SELECTOR}[open]`;
    const VIEWPORT_MARGIN_PX = 8;

    const disclosureBody = (disclosure: HTMLDetailsElement) => disclosure.querySelector<HTMLElement>(":scope > p");

    const clearDisclosureShift = (disclosure: HTMLDetailsElement) => {
      const body = disclosureBody(disclosure);
      body?.style.removeProperty("--info-disclosure-shift");
    };

    const clampDisclosureToViewport = (disclosure: HTMLDetailsElement) => {
      const body = disclosureBody(disclosure);
      if (!body) {
        return;
      }
      body.style.setProperty("--info-disclosure-shift", "0px");
      const rect = body.getBoundingClientRect();
      let shiftPx = 0;
      const maxRight = window.innerWidth - VIEWPORT_MARGIN_PX;
      if (rect.right > maxRight) {
        shiftPx -= rect.right - maxRight;
      }
      if (rect.left + shiftPx < VIEWPORT_MARGIN_PX) {
        shiftPx += VIEWPORT_MARGIN_PX - (rect.left + shiftPx);
      }
      body.style.setProperty("--info-disclosure-shift", `${Math.round(shiftPx)}px`);
    };

    const getOpenDisclosures = () =>
      Array.from(document.querySelectorAll<HTMLDetailsElement>(OPEN_DISCLOSURE_SELECTOR));

    const closeDisclosure = (disclosure: HTMLDetailsElement) => {
      disclosure.removeAttribute("open");
      clearDisclosureShift(disclosure);
    };

    const closeOutsideDisclosures = (target: Node | null) => {
      if (!target) {
        return;
      }
      for (const disclosure of getOpenDisclosures()) {
        if (!disclosure.contains(target)) {
          closeDisclosure(disclosure);
        }
      }
    };

    let relayoutRaf = 0;
    const scheduleRelayout = () => {
      if (relayoutRaf) {
        return;
      }
      relayoutRaf = window.requestAnimationFrame(() => {
        relayoutRaf = 0;
        for (const disclosure of getOpenDisclosures()) {
          clampDisclosureToViewport(disclosure);
        }
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      closeOutsideDisclosures(event.target as Node | null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      for (const disclosure of getOpenDisclosures()) {
        closeDisclosure(disclosure);
      }
    };

    const onToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement) || !target.matches(DISCLOSURE_SELECTOR)) {
        return;
      }
      if (!target.open) {
        clearDisclosureShift(target);
        return;
      }
      scheduleRelayout();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("toggle", onToggle, true);
    window.addEventListener("resize", scheduleRelayout);
    window.addEventListener("scroll", scheduleRelayout, true);
    scheduleRelayout();

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("toggle", onToggle, true);
      window.removeEventListener("resize", scheduleRelayout);
      window.removeEventListener("scroll", scheduleRelayout, true);
      if (relayoutRaf) {
        window.cancelAnimationFrame(relayoutRaf);
      }
    };
  }, []);

  return null;
}
