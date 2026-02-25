export const LOCAL_PREF_KEYS = {
  sharedEid: "eggincutils-eid",
  sharedIncludeSlotted: "eggincutils-include-slotted",
  legacyEid: "eid",
  legacyIncludeSlotted: "includeSlottedStones",
  plannerTargetItemId: "eggincutils-planner-target-item-id",
  plannerQuantity: "eggincutils-planner-quantity",
  plannerPriorityTimePct: "eggincutils-planner-priority-time-pct",
  plannerFastMode: "eggincutils-planner-fast-mode",
} as const;

export function readFirstStoredString(keys: readonly string[]): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    for (const key of keys) {
      const value = window.localStorage.getItem(key);
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function readStoredBoolean(keys: readonly string[]): boolean | null {
  const raw = readFirstStoredString(keys);
  if (raw == null) {
    return null;
  }
  if (raw === "true" || raw === "1") {
    return true;
  }
  if (raw === "false" || raw === "0") {
    return false;
  }
  return null;
}

export function readStoredInteger(keys: readonly string[], min: number, max: number): number | null {
  const raw = readFirstStoredString(keys);
  if (raw == null) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) {
    return null;
  }
  return rounded;
}

export function writeStoredString(keys: readonly string[], value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    for (const key of keys) {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Ignore browser storage write failures.
  }
}

export function writeStoredBoolean(keys: readonly string[], value: boolean): void {
  writeStoredString(keys, value ? "true" : "false");
}
