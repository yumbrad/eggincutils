import { isUntargetedTargetAfxId } from "./item-utils";
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
  shipLevelsToLaunchCounts,
} from "./ship-data";

export type PrePlanSend = {
  ship: string;
  durationType: DurationType;
  targetAfxId: number;
  launches: number;
};

export type AppliedPrePlanSends = {
  profile: PlayerProfile;
  addedInventory: Record<string, number>;
  appliedLaunches: number;
  skippedLaunches: number;
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

function sanitizePrePlanSends(sends: PrePlanSend[]): PrePlanSend[] {
  const shipOrder = new Set(getShipOrder());
  return sends
    .map((send) => ({
      ship: String(send.ship || ""),
      durationType: send.durationType,
      targetAfxId: Math.round(Number(send.targetAfxId)),
      launches: Math.max(0, Math.min(10_000, Math.round(Number(send.launches) || 0))),
    }))
    .filter((send) =>
      shipOrder.has(send.ship) &&
      ["SHORT", "LONG", "EPIC"].includes(send.durationType) &&
      Number.isFinite(send.targetAfxId) &&
      send.launches > 0
    );
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
  if (sanitizedSends.length === 0) {
    return {
      profile,
      addedInventory: {},
      appliedLaunches: 0,
      skippedLaunches: 0,
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

  const addYield = (itemKey: string, quantity: number): void => {
    if (quantity <= 0) {
      return;
    }
    inventory[itemKey] = (inventory[itemKey] || 0) + quantity;
    addedInventory[itemKey] = (addedInventory[itemKey] || 0) + quantity;
  };

  for (const send of sanitizedSends) {
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
        skippedLaunches += 1;
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
      }

      launchCounts[send.ship][send.durationType] += 1;
      appliedLaunches += 1;
    }
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
  };
}
