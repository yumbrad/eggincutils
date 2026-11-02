import targetFamilies from "../data/target-families.json";

/**
 * The ships, lengths and targets a hand-entered send can name: the Craft XP
 * planner's pre-plan sends and the attainment planner's locked launches.
 * Client-safe.
 */

export type SendDurationType = "SHORT" | "LONG" | "EPIC";

export const SEND_UNTARGETED_TARGET_AFX_ID = 10000;

/** Ships that can't pick a target: their sends are always untargeted. */
export const SEND_UNTARGETED_ONLY_SHIPS: ReadonlySet<string> = new Set(["CHICKEN_ONE", "CHICKEN_NINE", "CHICKEN_HEAVY", "BCR"]);

/** Newest ship first. */
export const SEND_SHIPS: readonly string[] = [
  "ATREGGIES",
  "HENERPRISE",
  "VOYEGGER",
  "CHICKFIANT",
  "GALEGGTICA",
  "CORELLIHEN_CORVETTE",
  "MILLENIUM_CHICKEN",
  "BCR",
  "CHICKEN_HEAVY",
  "CHICKEN_NINE",
  "CHICKEN_ONE",
];

export const SEND_DURATIONS: ReadonlyArray<{ value: SendDurationType; label: string }> = [
  { value: "SHORT", label: "Short" },
  { value: "LONG", label: "Standard" },
  { value: "EPIC", label: "Extended" },
];

/** Untargeted, then every target family by name. */
export const SEND_TARGET_OPTIONS: ReadonlyArray<{ afxId: number; label: string }> = [
  { afxId: SEND_UNTARGETED_TARGET_AFX_ID, label: "Untargeted" },
  ...Object.values(targetFamilies as Record<string, { afxId: number; name: string; representativeItemId: string | null }>)
    .filter((entry) => Number.isFinite(entry.afxId) && entry.representativeItemId)
    .map((entry) => ({ afxId: entry.afxId, label: entry.name }))
    .sort((a, b) => a.label.localeCompare(b.label)),
];

export function isSendDurationType(value: unknown): value is SendDurationType {
  return value === "SHORT" || value === "LONG" || value === "EPIC";
}
