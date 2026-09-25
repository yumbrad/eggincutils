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

/**
 * Shown on a Path of Virtue replan that logged launches. The virtue tank is
 * kept exactly as the last backup had it: a logged launch carries no farm, so
 * its fuel can't be taken out of the tank, and refills since the backup are
 * unknown anyway.
 */
export const REPLAN_VIRTUE_TANK_NOTE =
  "Fuel tank contents are from your last backup: launches logged since then are not taken out of the tank. Refresh your profile for exact refuel amounts.";

/** REPLAN_VIRTUE_TANK_NOTE when these updates log launches against a profile with a virtue tank, else null. */
export function replanVirtueTankNote(profile: PlayerProfile, updates: ReplanProfileUpdates): string | null {
  const loggedLaunches = (updates.missionLaunches || []).some((update) => Math.round(update.launches) > 0);
  return profile.virtueTank && loggedLaunches ? REPLAN_VIRTUE_TANK_NOTE : null;
}

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

  // `virtueTank` rides along unchanged; see REPLAN_VIRTUE_TANK_NOTE.
  return {
    ...profile,
    inventory,
    shipLevels,
    missionOptions,
  };
}
