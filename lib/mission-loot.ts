import { isStoneFragmentKey, itemIdToKey } from "./item-utils";
import type { MissionLevelLootStore, MissionTargetLootStore } from "./loot-data";
import type { ShinyRaritySelection } from "./profile";

// A target's recorded drops are only trustworthy once enough launches fed into
// them; below this we treat the target as having no usable expectation.
export const MIN_MISSION_TARGET_SAMPLE_LAUNCHES = 10;
export const MIN_MISSION_TARGET_SAMPLE_DROPS = 500;

/** Highest recorded loot level at or below the ship's actual level. */
export function pickLevel(levels: MissionLevelLootStore[], desiredLevel: number): MissionLevelLootStore | null {
  let best: MissionLevelLootStore | null = null;
  for (const level of levels) {
    if (level.level <= desiredLevel && (!best || level.level > best.level)) {
      best = level;
    }
  }
  if (best) {
    return best;
  }
  return levels[0] || null;
}

export function hasEnoughMissionTargetSample(target: MissionTargetLootStore, nominalCapacity: number): boolean {
  if (target.totalDrops < MIN_MISSION_TARGET_SAMPLE_DROPS) {
    return false;
  }
  return nominalCapacity > 0 && target.totalDrops / nominalCapacity >= MIN_MISSION_TARGET_SAMPLE_LAUNCHES;
}

/** Expected item counts for a single launch of `capacity` against this target. */
export function expectedInventoryFromTarget(
  target: MissionTargetLootStore,
  capacity: number,
  includeRarities: ShinyRaritySelection,
  includeStoneFragments: boolean
): Record<string, number> {
  const yields: Record<string, number> = {};
  if (target.totalDrops <= 0 || capacity <= 0) {
    return yields;
  }

  for (const item of target.items) {
    const itemKey = itemIdToKey(item.itemId);
    if (!includeStoneFragments && isStoneFragmentKey(itemKey)) {
      continue;
    }
    const common = item.counts[0] || 0;
    const rare = includeRarities.rare ? item.counts[1] || 0 : 0;
    const epic = includeRarities.epic ? item.counts[2] || 0 : 0;
    const legendary = includeRarities.legendary ? item.counts[3] || 0 : 0;
    const totalItemDrops = common + rare + epic + legendary;
    if (totalItemDrops > 0) {
      yields[itemKey] = (totalItemDrops / target.totalDrops) * capacity;
    }
  }

  return yields;
}
