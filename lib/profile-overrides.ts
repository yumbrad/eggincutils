import { getCraftingLevelProgress, getCraftingLevelTotalXpForLevel } from "./crafting-levels";
import { LOCAL_PREF_KEYS, readFirstStoredString, writeStoredString } from "./local-preferences";
import { recipes } from "./recipes";
import { buildMissionOptions, shipStarRanges, withShipStars, type ShipLevelInfo } from "./ship-data";

/**
 * A customized profile: values set by hand over what the player's backup (or
 * the demo profile) says, shared by the attainment and XP planners. Each is
 * "set to", so anything not set follows the backup as it changes.
 */
export type ProfileOverrides = {
  epicResearchFTLLevel?: number;
  epicResearchZerogLevel?: number;
  /** Crafting level 1-30; the profile's XP becomes that level's start. */
  craftingLevel?: number;
  /** Ship -> stars (0 to its max). */
  shipStars?: Record<string, number>;
  /** Item key -> copies in the inventory. */
  inventory?: Record<string, number>;
  /** Item key -> all-time crafts. */
  craftCounts?: Record<string, number>;
};

const MAX_ITEM_COUNT = 10_000_000;

export const MAX_FTL_RESEARCH_LEVEL = 60;
export const MAX_ZEROG_RESEARCH_LEVEL = 10;
export const MAX_CRAFTING_LEVEL = 30;

/** Overrides are kept per EID; a blank EID is the demo profile. */
export function profileOverridesKey(eid: string): string {
  return eid.trim() || "DEMO";
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && value !== "" && value != null ? Math.max(min, Math.min(max, parsed)) : undefined;
}

/** Drop anything malformed or out of range, and unset fields. */
export function normalizeProfileOverrides(raw: unknown): ProfileOverrides {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const overrides: ProfileOverrides = {};
  const ftl = clampInt(record.epicResearchFTLLevel, 0, MAX_FTL_RESEARCH_LEVEL);
  const zerog = clampInt(record.epicResearchZerogLevel, 0, MAX_ZEROG_RESEARCH_LEVEL);
  const craftingLevel = clampInt(record.craftingLevel, 1, MAX_CRAFTING_LEVEL);
  if (ftl != null) overrides.epicResearchFTLLevel = ftl;
  if (zerog != null) overrides.epicResearchZerogLevel = zerog;
  if (craftingLevel != null) overrides.craftingLevel = craftingLevel;
  if (record.shipStars && typeof record.shipStars === "object") {
    const shipStars: Record<string, number> = {};
    for (const { ship, maxLevel } of shipStarRanges()) {
      const stars = clampInt((record.shipStars as Record<string, unknown>)[ship], 0, maxLevel);
      if (stars != null) {
        shipStars[ship] = stars;
      }
    }
    if (Object.keys(shipStars).length > 0) {
      overrides.shipStars = shipStars;
    }
  }
  const items = (value: unknown, craftableOnly: boolean): Record<string, number> | undefined => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const counts: Record<string, number> = {};
    for (const [itemKey, raw] of Object.entries(value as Record<string, unknown>)) {
      const count = clampInt(raw, 0, MAX_ITEM_COUNT);
      if (count != null && itemKey in recipes && (!craftableOnly || recipes[itemKey])) {
        counts[itemKey] = count;
      }
    }
    return Object.keys(counts).length > 0 ? counts : undefined;
  };
  const inventory = items(record.inventory, false);
  const craftCounts = items(record.craftCounts, true);
  if (inventory) overrides.inventory = inventory;
  if (craftCounts) overrides.craftCounts = craftCounts;
  return overrides;
}

/** How many values are set, for the "Customized profile · N changes" chip. */
export function profileOverrideCount(overrides: ProfileOverrides): number {
  return (
    (overrides.epicResearchFTLLevel != null ? 1 : 0) +
    (overrides.epicResearchZerogLevel != null ? 1 : 0) +
    (overrides.craftingLevel != null ? 1 : 0) +
    Object.keys(overrides.shipStars || {}).length +
    Object.keys(overrides.inventory || {}).length +
    Object.keys(overrides.craftCounts || {}).length
  );
}

function readAllOverrides(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFirstStoredString([LOCAL_PREF_KEYS.profileOverrides]) || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readProfileOverrides(eid: string): ProfileOverrides {
  return normalizeProfileOverrides(readAllOverrides()[profileOverridesKey(eid)]);
}

export function writeProfileOverrides(eid: string, overrides: ProfileOverrides): void {
  const all = readAllOverrides();
  const normalized = normalizeProfileOverrides(overrides);
  if (profileOverrideCount(normalized) === 0) {
    delete all[profileOverridesKey(eid)];
  } else {
    all[profileOverridesKey(eid)] = normalized;
  }
  writeStoredString([LOCAL_PREF_KEYS.profileOverrides], JSON.stringify(all));
}

type OverridableProfile = {
  inventory: Record<string, number>;
  craftCounts: Record<string, number>;
  craftingXp: number;
  epicResearchFTLLevel: number;
  epicResearchZerogLevel: number;
  shipLevels: ShipLevelInfo[];
  missionOptions: ReturnType<typeof buildMissionOptions>;
};

/** The profile with the overrides applied (mission options rebuilt for the new stars and research). */
export function applyProfileOverrides<T extends OverridableProfile>(profile: T, overrides: ProfileOverrides): T {
  if (profileOverrideCount(overrides) === 0) {
    return profile;
  }
  const ftl = overrides.epicResearchFTLLevel ?? profile.epicResearchFTLLevel;
  const zerog = overrides.epicResearchZerogLevel ?? profile.epicResearchZerogLevel;
  const shipLevels = overrides.shipStars ? withShipStars(profile.shipLevels, overrides.shipStars).shipLevels : profile.shipLevels;
  return {
    ...profile,
    epicResearchFTLLevel: ftl,
    epicResearchZerogLevel: zerog,
    craftingXp:
      overrides.craftingLevel != null
        ? getCraftingLevelTotalXpForLevel(overrides.craftingLevel)
        : profile.craftingXp,
    shipLevels,
    missionOptions: buildMissionOptions(shipLevels, ftl, zerog),
    ...(overrides.inventory ? { inventory: { ...profile.inventory, ...overrides.inventory } } : {}),
    ...(overrides.craftCounts ? { craftCounts: { ...profile.craftCounts, ...overrides.craftCounts } } : {}),
  };
}

/** What the customize dialog shows as the backup's values. */
export type ProfileSummary = {
  epicResearchFTLLevel: number;
  epicResearchZerogLevel: number;
  craftingLevel: number;
  ships: Array<{ ship: string; unlocked: boolean; level: number; maxLevel: number }>;
  inventory: Record<string, number>;
  craftCounts: Record<string, number>;
};

export function summarizeProfile(profile: OverridableProfile): ProfileSummary {
  return {
    epicResearchFTLLevel: profile.epicResearchFTLLevel,
    epicResearchZerogLevel: profile.epicResearchZerogLevel,
    craftingLevel: getCraftingLevelProgress(profile.craftingXp).level,
    ships: profile.shipLevels.map((entry) => ({
      ship: entry.ship,
      unlocked: entry.unlocked,
      level: entry.level,
      maxLevel: entry.maxLevel,
    })),
    inventory: profile.inventory,
    craftCounts: profile.craftCounts,
  };
}
