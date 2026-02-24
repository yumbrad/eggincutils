import artifactDisplay from "../data/artifact-display.json";
import namesData from "../data/names.json";

export type ArtifactDisplayEntry = {
  id: string;
  name: string;
  tierNumber: number;
  tierName: string;
  iconFilename: string;
};

export const artifactDisplayMap = artifactDisplay as Record<string, ArtifactDisplayEntry>;
const namesMap = namesData as Record<string, string>;
const ICON_CDN_BASE_URL = "https://eggincassets.tcl.sh";

export function itemIdToKey(itemId: string): string {
  return itemId.replaceAll("-", "_");
}

export function itemKeyToId(itemKey: string): string {
  return itemKey.replaceAll("_", "-");
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

export function afxIdToItemKey(afxId: number): string | null {
  const itemKey = namesMap[String(afxId)];
  return typeof itemKey === "string" ? itemKey : null;
}

export function afxIdToDisplayName(afxId: number): string {
  if (afxId === 10000) {
    return "No target";
  }
  const itemKey = afxIdToItemKey(afxId);
  if (!itemKey) {
    return String(afxId);
  }
  return itemKeyToDisplayName(itemKey);
}

export function allArtifactKeys(): string[] {
  return Object.keys(artifactDisplayMap);
}
