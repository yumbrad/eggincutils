export const LOCAL_PREF_KEYS = {
  sharedEid: "eggincutils-eid",
  sharedIncludeSlotted: "eggincutils-include-slotted",
  sharedCraftingSale: "eggincutils-crafting-sale",
  legacyEid: "eid",
  legacyIncludeSlotted: "includeSlottedStones",
  plannerTargetItemId: "eggincutils-planner-target-item-id",
  plannerTargets: "eggincutils-planner-targets",
  plannerSourcePreferences: "eggincutils-planner-source-preferences",
  plannerQuantity: "eggincutils-planner-quantity",
  plannerTargetCraftedOnly: "eggincutils-planner-target-crafted-only",
  plannerPriorityTimePct: "eggincutils-planner-priority-time-pct",
  plannerVirtuePriorityTimePct: "eggincutils-planner-virtue-priority-time-pct",
  plannerFastMode: "eggincutils-planner-fast-mode",
  plannerInventorySource: "eggincutils-planner-inventory-source",
  craftInventorySource: "eggincutils-craft-inventory-source",
  craftIncludeInventoryFragments: "eggincutils-craft-include-inventory-fragments",
  craftMaxXpPlanView: "eggincutils-craft-max-xp-plan-view",
  craftStandaloneOpen: "eggincutils-craft-standalone-open",
  craftAllLimits: "eggincutils-craft-all-limits",
  craftPrePlanSends: "eggincutils-craft-pre-plan-sends",
  plannerIncludeInventoryRare: "eggincutils-planner-include-inventory-rare",
  plannerIncludeInventoryEpic: "eggincutils-planner-include-inventory-epic",
  plannerIncludeInventoryLegendary: "eggincutils-planner-include-inventory-legendary",
  plannerIncludeInventoryFragments: "eggincutils-planner-include-inventory-fragments",
  plannerIncludeDropRare: "eggincutils-planner-include-drop-rare",
  plannerIncludeDropEpic: "eggincutils-planner-include-drop-epic",
  plannerIncludeDropLegendary: "eggincutils-planner-include-drop-legendary",
  plannerIncludeDropFragments: "eggincutils-planner-include-drop-fragments",
  plannerDemoNoticeDismissed: "eggincutils-planner-demo-notice-dismissed",
  plannerShipDurations: "eggincutils-planner-ship-durations",
  plannerSession: "eggincutils-planner-session-v1",
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
