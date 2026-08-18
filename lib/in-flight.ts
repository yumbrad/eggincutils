import { isUntargetedTargetAfxId, itemKeyToId } from "./item-utils";
import { loadLootData, type LootJson } from "./loot-data";
import { expectedInventoryFromTarget, hasEnoughMissionTargetSample, pickLevel } from "./mission-loot";
import type { InFlightMission, ShinyRaritySelection } from "./profile";
import { getNominalMissionCapacity, type DurationType } from "./ship-data";

const CANONICAL_UNTARGETED_TARGET_AFX_ID = 10000;
const DURATION_SUFFIX: Record<string, string> = {
  TUTORIAL: "tutorial",
  SHORT: "short",
  LONG: "standard",
  EPIC: "extended",
};

export type InFlightMissionRow = {
  missionId: string;
  ship: string;
  durationType: DurationType;
  level: number;
  targetAfxId: number;
  launches: number;
  durationSeconds: number;
  expectedYields: Array<{ itemId: string; quantity: number }>;
  /** Longest wait among the launches folded into this row. */
  secondsRemaining: number;
  /**
   * One entry per launch in this row, longest first. Grouped rows cover ships
   * that land at different times, and each frees its own slot, so scheduling
   * needs the individual waits rather than just the longest.
   */
  launchSecondsRemaining: number[];
};

export type InFlightProjection = {
  /** Expected drops still owed to the player, keyed by canonical item key. */
  yields: Record<string, number>;
  /** One row per ship+duration+level+target, matching the plan's mission rows. */
  rows: InFlightMissionRow[];
  /** Wall-clock seconds until the last outstanding mission lands. */
  secondsRemaining: number;
  missionCount: number;
};

const EMPTY_PROJECTION: InFlightProjection = {
  yields: {},
  rows: [],
  secondsRemaining: 0,
  missionCount: 0,
};

function missionIdFor(ship: string, durationType: string): string {
  const shipPrefix = ship.toLowerCase().replaceAll("_", "-");
  return `${shipPrefix}-${DURATION_SUFFIX[durationType] || durationType.toLowerCase()}`;
}

function normalizeDurationType(durationType: string): DurationType | null {
  return durationType === "SHORT" || durationType === "LONG" || durationType === "EPIC"
    ? durationType
    : null;
}

/**
 * Turn the player's outstanding missions into the drops they are expected to
 * deliver. The planner folds these into its supply so it stops re-planning
 * launches the player has already committed to, and the UI reports them as
 * expected mission drops rather than inventory the player does not have yet.
 */
export async function projectInFlightMissions(
  missions: InFlightMission[],
  options: {
    lootData?: LootJson;
    includeRarities: ShinyRaritySelection;
    includeStoneFragments: boolean;
  }
): Promise<InFlightProjection> {
  if (missions.length === 0) {
    return EMPTY_PROJECTION;
  }

  const loot = options.lootData || (await loadLootData());
  const lootByMissionId = new Map(loot.missions.map((mission) => [mission.missionId, mission]));
  const yields: Record<string, number> = {};
  const rowByKey = new Map<string, InFlightMissionRow>();
  let secondsRemaining = 0;
  let missionCount = 0;

  for (const mission of missions) {
    const durationType = normalizeDurationType(mission.durationType);
    if (!durationType) {
      continue;
    }
    missionCount += 1;
    secondsRemaining = Math.max(secondsRemaining, mission.secondsRemaining);

    const targetAfxId = mission.targetAfxId ?? CANONICAL_UNTARGETED_TARGET_AFX_ID;
    const missionId = missionIdFor(mission.ship, mission.durationType);
    const missionLoot = lootByMissionId.get(missionId);
    const levelLoot = missionLoot ? pickLevel(missionLoot.levels, mission.level) : null;
    const target =
      levelLoot?.targets.find((candidate) => candidate.targetAfxId === targetAfxId) ||
      (isUntargetedTargetAfxId(targetAfxId)
        ? null
        : levelLoot?.targets.find((candidate) => isUntargetedTargetAfxId(candidate.targetAfxId)) || null);

    // The recorded capacity already includes the player's Zero-G research; the
    // nominal one is only the yardstick for judging sample size.
    const capacity =
      mission.capacity || getNominalMissionCapacity(mission.ship, durationType, mission.level) || 0;
    const nominalCapacity =
      (levelLoot ? getNominalMissionCapacity(mission.ship, durationType, levelLoot.level) : 0) || capacity;

    const rowKey = `${mission.ship}|${durationType}|${mission.level}|${targetAfxId}`;
    const existing = rowByKey.get(rowKey);
    const row: InFlightMissionRow = existing || {
      missionId,
      ship: mission.ship,
      durationType,
      level: mission.level,
      targetAfxId,
      launches: 0,
      durationSeconds: 0,
      expectedYields: [],
      secondsRemaining: 0,
      launchSecondsRemaining: [],
    };
    row.launches += 1;
    row.secondsRemaining = Math.max(row.secondsRemaining, mission.secondsRemaining);
    row.launchSecondsRemaining.push(mission.secondsRemaining);
    rowByKey.set(rowKey, row);

    if (!target || !levelLoot || !hasEnoughMissionTargetSample(target, nominalCapacity)) {
      continue;
    }
    const missionYields = expectedInventoryFromTarget(
      target,
      capacity,
      options.includeRarities,
      options.includeStoneFragments
    );
    for (const [itemKey, quantity] of Object.entries(missionYields)) {
      if (quantity <= 0) {
        continue;
      }
      yields[itemKey] = (yields[itemKey] || 0) + quantity;
      const itemId = itemKeyToId(itemKey);
      const existingYield = row.expectedYields.find((entry) => entry.itemId === itemId);
      if (existingYield) {
        existingYield.quantity += quantity;
      } else {
        row.expectedYields.push({ itemId, quantity });
      }
    }
  }

  const rows = Array.from(rowByKey.values()).map((row) => ({
    ...row,
    expectedYields: [...row.expectedYields].sort((a, b) => b.quantity - a.quantity),
    launchSecondsRemaining: [...row.launchSecondsRemaining].sort((a, b) => b - a),
  }));
  rows.sort((a, b) => a.secondsRemaining - b.secondsRemaining || a.ship.localeCompare(b.ship));

  return { yields, rows, secondsRemaining, missionCount };
}
