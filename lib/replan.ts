import { itemIdToKey } from "./item-utils";
import { PlayerProfile } from "./profile";
import {
  buildMissionOptions,
  computeShipLevelsFromLaunchCounts,
  DurationType,
  getShipOrder,
  shipLevelsToLaunchCounts,
} from "./ship-data";

export type InventoryReturn = {
  itemId: string;
  quantity: number;
};

export type MissionLaunchUpdate = {
  ship: string;
  durationType: DurationType;
  launches: number;
};

export type ReplanProfileUpdates = {
  observedReturns?: InventoryReturn[];
  missionLaunches?: MissionLaunchUpdate[];
};

export function applyReplanUpdates(profile: PlayerProfile, updates: ReplanProfileUpdates): PlayerProfile {
  const inventory = { ...profile.inventory };
  for (const update of updates.observedReturns || []) {
    const quantity = Math.max(0, update.quantity);
    if (quantity <= 0) {
      continue;
    }
    const itemKey = itemIdToKey(update.itemId);
    inventory[itemKey] = Math.max(0, (inventory[itemKey] || 0) + quantity);
  }

  const shipOrder = new Set(getShipOrder());
  const launchCounts = shipLevelsToLaunchCounts(profile.shipLevels);
  for (const launchUpdate of updates.missionLaunches || []) {
    if (!shipOrder.has(launchUpdate.ship)) {
      continue;
    }
    const launches = Math.max(0, Math.round(launchUpdate.launches));
    if (launches <= 0) {
      continue;
    }
    launchCounts[launchUpdate.ship][launchUpdate.durationType] += launches;
  }
  const shipLevels = computeShipLevelsFromLaunchCounts(launchCounts);
  const missionOptions = buildMissionOptions(shipLevels, profile.epicResearchFTLLevel, profile.epicResearchZerogLevel);

  return {
    ...profile,
    inventory,
    shipLevels,
    missionOptions,
  };
}
