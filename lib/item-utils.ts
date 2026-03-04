import artifactDisplay from "../data/artifact-display.json";
import namesData from "../data/names.json";
import targetFamilies from "../data/target-families.json";

export type ArtifactDisplayEntry = {
  id: string;
  name: string;
  tierNumber: number;
  tierName: string;
  iconFilename: string;
};

export const artifactDisplayMap = artifactDisplay as Record<string, ArtifactDisplayEntry>;
const namesMap = namesData as Record<string, string>;
const targetFamilyMap = targetFamilies as Record<
  string,
  {
    afxId: number;
    id: string;
    name: string;
    type: string;
    representativeItemId: string | null;
  }
>;
const ICON_CDN_BASE_URL = "https://eggincassets.tcl.sh";
const CANONICAL_UNTARGETED_TARGET_AFX_ID = 10000;
const UNTARGETED_TARGET_AFX_IDS = new Set([CANONICAL_UNTARGETED_TARGET_AFX_ID]);

export function itemIdToKey(itemId: string): string {
  return itemId.replaceAll("-", "_");
}

export function itemKeyToId(itemKey: string): string {
  return itemKey.replaceAll("_", "-");
}

// Lazy-built reverse map from display entry ID → canonical artifact key.
// Needed because some artifact-display.json entries have `id` fields that
// differ from the canonical key (e.g. id="gusset-4" for key="ornate_gusset_4",
// id="vial-of-martian-dust-2" for key="vial_martian_dust_2").
let _displayIdToKey: Map<string, string> | null = null;
function displayIdToKeyMap(): Map<string, string> {
  if (!_displayIdToKey) {
    _displayIdToKey = new Map();
    for (const [key, entry] of Object.entries(artifactDisplayMap)) {
      _displayIdToKey.set(entry.id, key);
    }
  }
  return _displayIdToKey;
}

/**
 * Convert an arbitrary item ID (from the UI, API, or legacy data) to the
 * canonical artifact key used by recipes and loot data.
 *
 * Handles two known mismatch cases in artifact-display.json:
 *   - "gusset-{n}"             → "ornate_gusset_{n}"
 *   - "vial-of-martian-dust-{n}" → "vial_martian_dust_{n}"
 *
 * Falls back to plain `itemIdToKey(itemId)` for all normal cases.
 */
export function itemIdToCanonicalKey(itemId: string): string {
  const simpleKey = itemIdToKey(itemId);
  if (artifactDisplayMap[simpleKey]) {
    return simpleKey; // Already canonical (normal case).
  }
  // Try reverse lookup via the display entry's `id` field.
  return displayIdToKeyMap().get(itemId) ?? simpleKey;
}

export function itemKeyToDisplayName(itemKey: string): string {
  const entry = artifactDisplayMap[itemKey];
  if (!entry) {
    return itemKey;
  }
  return `${entry.name} (${entry.tierName})`;
}

export function itemKeyToIconFilename(itemKey: string): string | null {
  return artifactDisplayMap[itemKey]?.iconFilename || null;
}

export function itemKeyToIconUrl(itemKey: string, size = 32): string | null {
  const iconFilename = itemKeyToIconFilename(itemKey);
  if (!iconFilename) {
    return null;
  }
  return `${ICON_CDN_BASE_URL}/${size}/egginc/${iconFilename}`;
}

export function isUntargetedTargetAfxId(afxId: number): boolean {
  return UNTARGETED_TARGET_AFX_IDS.has(afxId);
}

export function afxIdToItemKey(afxId: number): string | null {
  if (isUntargetedTargetAfxId(afxId)) {
    return null;
  }
  const targetFamily = targetFamilyMap[String(afxId)];
  if (targetFamily?.representativeItemId) {
    return itemIdToKey(targetFamily.representativeItemId);
  }
  const itemKey = namesMap[String(afxId)];
  return typeof itemKey === "string" ? itemKey : null;
}

export function afxIdToDisplayName(afxId: number): string {
  if (isUntargetedTargetAfxId(afxId)) {
    return "Untargeted";
  }
  const targetFamily = targetFamilyMap[String(afxId)];
  if (targetFamily?.name) {
    return targetFamily.name;
  }
  const itemKey = afxIdToItemKey(afxId);
  if (!itemKey) {
    return String(afxId);
  }
  return itemKeyToDisplayName(itemKey);
}

function itemKeyToFamilyKey(itemKey: string): string {
  const match = itemKey.match(/^(.*)_\d+$/);
  return match ? match[1] : itemKey;
}

function titleCaseWords(text: string): string {
  return text
    .split("_")
    .map((chunk) => (chunk.length > 0 ? chunk.charAt(0).toUpperCase() + chunk.slice(1) : chunk))
    .join(" ");
}

export function afxIdToTargetFamilyName(afxId: number): string {
  if (isUntargetedTargetAfxId(afxId)) {
    return "Untargeted";
  }
  const targetFamily = targetFamilyMap[String(afxId)];
  if (targetFamily?.name) {
    return targetFamily.name;
  }
  const fallback = afxIdToItemKey(afxId);
  return fallback ? titleCaseWords(itemKeyToFamilyKey(fallback)) : String(afxId);
}

export function allArtifactKeys(): string[] {
  return Object.keys(artifactDisplayMap);
}
