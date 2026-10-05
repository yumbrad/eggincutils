import { isUntargetedTargetAfxId } from "./item-utils";
import { MAX_PRE_PLAN_LAUNCHES_PER_ROW } from "./preplan-import";
import { loadLootData, type LootJson, type MissionTargetLootStore } from "./loot-data";
import {
  expectedInventoryFromTarget,
  hasEnoughMissionTargetSample,
  pickLevel,
} from "./mission-loot";
import type { PlayerProfile, ShinyRaritySelection } from "./profile";
import {
  buildMissionOptions,
  computeShipLevelsFromLaunchCounts,
  type DurationType,
  getNominalMissionCapacity,
  getShipOrder,
  type MissionOption,
  type ShipLevelInfo,
  shipLevelsToLaunchCounts,
} from "./ship-data";

export type PrePlanSend = {
  ship: string;
  durationType: DurationType;
  targetAfxId: number;
  launches: number;
};

/** How one requested send row played out; stars are the ship's before and after the row. */
export type PrePlanSendRowResult = {
  startLevel: number;
  endLevel: number;
  maxLevel: number;
  appliedLaunches: number;
  /** Launches the ship couldn't make (locked, or no such mission/target). */
  skippedLaunches: number;
  /** Applied launches the loot data has too few samples for: they add stars but no items. */
  noLootLaunches: number;
};

export type AppliedPrePlanSends = {
  profile: PlayerProfile;
  addedInventory: Record<string, number>;
  appliedLaunches: number;
  skippedLaunches: number;
  noLootLaunches: number;
  /** One entry per requested send, in request order; null for a row that was invalid. */
  rows: Array<PrePlanSendRowResult | null>;
};

const UNTARGETED_ONLY_SHIPS = new Set(["CHICKEN_ONE", "CHICKEN_NINE", "CHICKEN_HEAVY", "BCR"]);

const DEFAULT_RARITY_SELECTION: ShinyRaritySelection = {
  rare: false,
  epic: false,
  legendary: false,
};

function missionTargetSampleIsUsable(
  target: MissionTargetLootStore,
  option: MissionOption,
  lootLevel: number
): boolean {
  const nominalCapacity = getNominalMissionCapacity(option.ship, option.durationType, lootLevel) || option.capacity;
  return hasEnoughMissionTargetSample(target, nominalCapacity);
}

function canMissionOptionUseLootTarget(option: MissionOption, targetAfxId: number): boolean {
  return !UNTARGETED_ONLY_SHIPS.has(option.ship) || isUntargetedTargetAfxId(targetAfxId);
}

/** The sends with each invalid row nulled, so results stay aligned with the request. */
function sanitizePrePlanSends(sends: PrePlanSend[]): Array<PrePlanSend | null> {
  const shipOrder = new Set(getShipOrder());
  return sends.map((raw) => {
    const send = {
      ship: String(raw.ship || ""),
      durationType: raw.durationType,
      targetAfxId: Math.round(Number(raw.targetAfxId)),
      launches: Math.max(0, Math.min(MAX_PRE_PLAN_LAUNCHES_PER_ROW, Math.round(Number(raw.launches) || 0))),
    };
    return shipOrder.has(send.ship) &&
      ["SHORT", "LONG", "EPIC"].includes(send.durationType) &&
      Number.isFinite(send.targetAfxId) &&
      send.launches > 0
      ? send
      : null;
  });
}

function shipLevelInfo(shipLevels: ShipLevelInfo[], ship: string): { level: number; maxLevel: number } {
  const info = shipLevels.find((entry) => entry.ship === ship);
  return { level: info?.level ?? 0, maxLevel: info?.maxLevel ?? 0 };
}

export async function applyPrePlanSendsToProfile(
  profile: PlayerProfile,
  sends: PrePlanSend[],
  options: {
    lootData?: LootJson;
    includeRarities?: Partial<ShinyRaritySelection>;
    includeStoneFragments?: boolean;
  } = {}
): Promise<AppliedPrePlanSends> {
  const sanitizedSends = sanitizePrePlanSends(sends);
  if (sanitizedSends.every((send) => send === null)) {
    return {
      profile,
      addedInventory: {},
      appliedLaunches: 0,
      skippedLaunches: 0,
      noLootLaunches: 0,
      rows: sanitizedSends.map(() => null),
    };
  }

  const loot = options.lootData || (await loadLootData());
  const lootByMissionId = new Map(loot.missions.map((mission) => [mission.missionId, mission]));
  const includeRarities = { ...DEFAULT_RARITY_SELECTION, ...(options.includeRarities || {}) };
  const includeStoneFragments = options.includeStoneFragments !== false;
  const launchCounts = shipLevelsToLaunchCounts(profile.shipLevels);
  const inventory = { ...profile.inventory };
  const addedInventory: Record<string, number> = {};
  let appliedLaunches = 0;
  let skippedLaunches = 0;
  let noLootLaunches = 0;
  const rows: Array<PrePlanSendRowResult | null> = [];

  const addYield = (itemKey: string, quantity: number): void => {
    if (quantity <= 0) {
      return;
    }
    inventory[itemKey] = (inventory[itemKey] || 0) + quantity;
    addedInventory[itemKey] = (addedInventory[itemKey] || 0) + quantity;
  };

  for (const send of sanitizedSends) {
    if (!send) {
      rows.push(null);
      continue;
    }
    const start = shipLevelInfo(computeShipLevelsFromLaunchCounts(launchCounts), send.ship);
    const row: PrePlanSendRowResult = {
      startLevel: start.level,
      endLevel: start.level,
      maxLevel: start.maxLevel,
      appliedLaunches: 0,
      skippedLaunches: 0,
      noLootLaunches: 0,
    };
    for (let launch = 0; launch < send.launches; launch += 1) {
      const currentShipLevels = computeShipLevelsFromLaunchCounts(launchCounts);
      const missionOptions = buildMissionOptions(
        currentShipLevels,
        profile.epicResearchFTLLevel,
        profile.epicResearchZerogLevel
      );
      const option = missionOptions.find(
        (candidate) => candidate.ship === send.ship && candidate.durationType === send.durationType
      );
      if (!option || !canMissionOptionUseLootTarget(option, send.targetAfxId)) {
        row.skippedLaunches += 1;
        continue;
      }

      const missionLoot = lootByMissionId.get(option.missionId);
      const levelLoot = missionLoot ? pickLevel(missionLoot.levels, option.level) : null;
      const target = levelLoot?.targets.find((candidate) => candidate.targetAfxId === send.targetAfxId) || null;
      if (target && levelLoot && missionTargetSampleIsUsable(target, option, levelLoot.level)) {
        const yields = expectedInventoryFromTarget(
          target,
          option.capacity,
          includeRarities,
          includeStoneFragments
        );
        for (const [itemKey, quantity] of Object.entries(yields)) {
          addYield(itemKey, quantity);
        }
      } else {
        row.noLootLaunches += 1;
      }

      launchCounts[send.ship][send.durationType] += 1;
      row.appliedLaunches += 1;
    }
    const end = shipLevelInfo(computeShipLevelsFromLaunchCounts(launchCounts), send.ship);
    row.endLevel = end.level;
    row.maxLevel = end.maxLevel;
    appliedLaunches += row.appliedLaunches;
    skippedLaunches += row.skippedLaunches;
    noLootLaunches += row.noLootLaunches;
    rows.push(row);
  }

  const shipLevels = computeShipLevelsFromLaunchCounts(launchCounts);
  return {
    profile: {
      ...profile,
      inventory,
      shipLevels,
      missionOptions: buildMissionOptions(shipLevels, profile.epicResearchFTLLevel, profile.epicResearchZerogLevel),
    },
    addedInventory,
    appliedLaunches,
    skippedLaunches,
    noLootLaunches,
    rows,
  };
}
