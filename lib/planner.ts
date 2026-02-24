import { loadLootData, MissionLevelLootStore, MissionTargetLootStore } from "./loot-data";
import { itemIdToKey, itemKeyToDisplayName, itemKeyToId } from "./item-utils";
import { getRecipe, recipes } from "./recipes";
import { MissionOption } from "./ship-data";
import { PlayerProfile } from "./profile";

type MissionAction = {
  key: string;
  missionId: string;
  ship: string;
  durationType: string;
  durationSeconds: number;
  targetAfxId: number;
  yields: Record<string, number>;
};

type PlanMissionRow = {
  missionId: string;
  ship: string;
  durationType: string;
  targetAfxId: number;
  launches: number;
  durationSeconds: number;
  expectedYields: Array<{ itemId: string; quantity: number }>;
};

type PlanCraftRow = {
  itemId: string;
  count: number;
};

export type PlannerResult = {
  targetItemId: string;
  quantity: number;
  priorityTime: number;
  geCost: number;
  expectedHours: number;
  weightedScore: number;
  crafts: PlanCraftRow[];
  missions: PlanMissionRow[];
  unmetItems: Array<{ itemId: string; quantity: number }>;
  notes: string[];
};

export class MissionCoverageError extends Error {
  readonly itemIds: string[];

  constructor(itemKeys: string[]) {
    const itemIds = itemKeys.map((itemKey) => itemKeyToId(itemKey));
    super(`no mission drop coverage for required items: ${itemIds.join(", ")}`);
    this.name = "MissionCoverageError";
    this.itemIds = itemIds;
  }
}

const MAX_GREEDY_ITERATIONS = 3000;
const SCORE_EPS = 1e-9;

function getDiscountedCost(baseCost: number, craftCount: number): number {
  const maxCraftCountForDiscount = 300;
  const maxDiscountFactor = 0.9;
  const discountCurveExponent = 0.2;
  const progress = Math.min(1, craftCount / maxCraftCountForDiscount);
  const multiplier = 1 - maxDiscountFactor * Math.pow(progress, discountCurveExponent);
  return Math.floor(baseCost * multiplier);
}

function normalizedScore(ge: number, timeSec: number, priorityTime: number, geRef: number, timeRef: number): number {
  const safeGeRef = Math.max(1, geRef);
  const safeTimeRef = Math.max(1, timeRef);
  return (1 - priorityTime) * (ge / safeGeRef) + priorityTime * (timeSec / safeTimeRef);
}

function collectClosure(itemKey: string, visited: Set<string>): void {
  if (visited.has(itemKey)) {
    return;
  }
  visited.add(itemKey);
  const recipe = getRecipe(itemKey);
  if (!recipe) {
    return;
  }
  for (const ingredient of Object.keys(recipe.ingredients)) {
    collectClosure(ingredient, visited);
  }
}

function pickLevel(levels: MissionLevelLootStore[], desiredLevel: number): MissionLevelLootStore | null {
  let best: MissionLevelLootStore | null = null;
  for (const level of levels) {
    if (level.level <= desiredLevel) {
      if (!best || level.level > best.level) {
        best = level;
      }
    }
  }
  if (best) {
    return best;
  }
  if (levels.length === 0) {
    return null;
  }
  return levels[0];
}

function yieldsFromTarget(target: MissionTargetLootStore, items: Set<string>, capacity: number): Record<string, number> {
  const yields: Record<string, number> = {};
  if (target.totalDrops <= 0) {
    return yields;
  }
  for (const item of target.items) {
    const itemKey = itemIdToKey(item.itemId);
    if (!items.has(itemKey)) {
      continue;
    }
    const totalItemDrops = item.counts.reduce((sum, count) => sum + count, 0);
    if (totalItemDrops <= 0) {
      continue;
    }
    yields[itemKey] = (totalItemDrops / target.totalDrops) * capacity;
  }
  return yields;
}

async function buildMissionActions(profile: PlayerProfile, relevantItems: Set<string>): Promise<MissionAction[]> {
  const loot = await loadLootData();
  const byMissionId = new Map(loot.missions.map((mission) => [mission.missionId, mission]));

  const actions: MissionAction[] = [];

  for (const option of profile.missionOptions) {
    const mission = byMissionId.get(option.missionId);
    if (!mission) {
      continue;
    }

    const levelLoot = pickLevel(mission.levels, option.level);
    if (!levelLoot) {
      continue;
    }

    for (const target of levelLoot.targets) {
      const yields = yieldsFromTarget(target, relevantItems, option.capacity);
      if (Object.keys(yields).length === 0) {
        continue;
      }
      actions.push({
        key: `${option.missionId}|${target.targetAfxId}`,
        missionId: option.missionId,
        ship: option.ship,
        durationType: option.durationType,
        durationSeconds: option.durationSeconds,
        targetAfxId: target.targetAfxId,
        yields,
      });
    }
  }

  return actions;
}

function bestTimePerUnit(itemKey: string, actions: MissionAction[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const action of actions) {
    const yieldPerMission = action.yields[itemKey] || 0;
    if (yieldPerMission <= 0) {
      continue;
    }
    const timePerItem = action.durationSeconds / (3 * yieldPerMission);
    if (timePerItem < best) {
      best = timePerItem;
    }
  }
  return best;
}

export async function planForTarget(
  profile: PlayerProfile,
  targetItemId: string,
  quantity: number,
  priorityTimeRaw: number
): Promise<PlannerResult> {
  const targetKey = itemIdToKey(targetItemId);
  const priorityTime = Math.max(0, Math.min(1, priorityTimeRaw));
  const quantityInt = Math.max(1, Math.round(quantity));

  const closure = new Set<string>();
  collectClosure(targetKey, closure);

  const actions = await buildMissionActions(profile, closure);

  const inventory: Record<string, number> = { ...profile.inventory };
  const craftCounts: Record<string, number> = { ...profile.craftCounts };
  const crafts: Record<string, number> = {};
  const demand: Record<string, number> = {};

  const geRef = Math.max(1, getRecipe(targetKey)?.cost || 1000);
  const fastestActionDuration = actions.length > 0 ? Math.min(...actions.map((action) => action.durationSeconds)) : 3600;
  const timeRef = Math.max(1, fastestActionDuration / 3);

  let geCost = 0;

  const fulfill = (itemKey: string, needed: number, depth = 0) => {
    const safeNeeded = Math.max(0, Math.round(needed));
    if (safeNeeded === 0) {
      return;
    }
    if (depth > 30) {
      demand[itemKey] = (demand[itemKey] || 0) + safeNeeded;
      return;
    }

    let remaining = safeNeeded;
    const available = Math.max(0, inventory[itemKey] || 0);
    const used = Math.min(available, remaining);
    inventory[itemKey] = available - used;
    remaining -= used;

    while (remaining > 0) {
      const recipe = getRecipe(itemKey);
      if (!recipe) {
        demand[itemKey] = (demand[itemKey] || 0) + remaining;
        remaining = 0;
        break;
      }

      const nextCraftCount = craftCounts[itemKey] || 0;
      const craftGe = getDiscountedCost(recipe.cost, nextCraftCount);
      const craftScore = normalizedScore(craftGe, 0, priorityTime, geRef, timeRef);

      const farmTpu = bestTimePerUnit(itemKey, actions);
      const farmScore = Number.isFinite(farmTpu)
        ? normalizedScore(0, farmTpu, priorityTime, geRef, timeRef)
        : Number.POSITIVE_INFINITY;

      const chooseFarm = farmScore + SCORE_EPS < craftScore;
      if (chooseFarm) {
        demand[itemKey] = (demand[itemKey] || 0) + 1;
        remaining -= 1;
        continue;
      }

      for (const [ingredientKey, ingredientQty] of Object.entries(recipe.ingredients)) {
        fulfill(ingredientKey, ingredientQty, depth + 1);
      }

      geCost += craftGe;
      craftCounts[itemKey] = nextCraftCount + 1;
      crafts[itemKey] = (crafts[itemKey] || 0) + 1;
      remaining -= 1;
    }
  };

  fulfill(targetKey, quantityInt);

  const remainingDemand: Record<string, number> = {};
  for (const [itemKey, qty] of Object.entries(demand)) {
    if (qty > 0) {
      remainingDemand[itemKey] = qty;
    }
  }

  const missionCounts: Record<string, number> = {};
  let totalSlotSeconds = 0;

  for (let iteration = 0; iteration < MAX_GREEDY_ITERATIONS; iteration += 1) {
    const unmetTotal = Object.values(remainingDemand).reduce((sum, value) => sum + value, 0);
    if (unmetTotal <= SCORE_EPS) {
      break;
    }

    let bestAction: MissionAction | null = null;
    let bestCoverageRate = 0;

    for (const action of actions) {
      let covered = 0;
      for (const [itemKey, remainingQty] of Object.entries(remainingDemand)) {
        if (remainingQty <= 0) {
          continue;
        }
        const yieldPerMission = action.yields[itemKey] || 0;
        if (yieldPerMission <= 0) {
          continue;
        }
        covered += Math.min(remainingQty, yieldPerMission);
      }
      if (covered <= 0) {
        continue;
      }

      const coverageRate = covered / action.durationSeconds;
      if (coverageRate > bestCoverageRate) {
        bestCoverageRate = coverageRate;
        bestAction = action;
      }
    }

    if (!bestAction) {
      break;
    }

    missionCounts[bestAction.key] = (missionCounts[bestAction.key] || 0) + 1;
    totalSlotSeconds += bestAction.durationSeconds;

    for (const [itemKey, yieldPerMission] of Object.entries(bestAction.yields)) {
      if (!remainingDemand[itemKey]) {
        continue;
      }
      remainingDemand[itemKey] = Math.max(0, remainingDemand[itemKey] - yieldPerMission);
    }
  }

  const expectedHours = totalSlotSeconds / 3 / 3600;
  const weightedScore = normalizedScore(geCost, totalSlotSeconds / 3, priorityTime, geRef, timeRef);

  const missionRows: PlanMissionRow[] = Object.entries(missionCounts)
    .map(([key, launches]) => {
      const action = actions.find((candidate) => candidate.key === key);
      if (!action) {
        return null;
      }
      const expectedYields = Object.entries(action.yields)
        .map(([itemKey, perMission]) => ({ itemId: itemKeyToId(itemKey), quantity: perMission * launches }))
        .filter((entry) => entry.quantity > 0)
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 6);

      return {
        missionId: action.missionId,
        ship: action.ship,
        durationType: action.durationType,
        targetAfxId: action.targetAfxId,
        launches,
        durationSeconds: action.durationSeconds,
        expectedYields,
      };
    })
    .filter((row): row is PlanMissionRow => row !== null)
    .sort((a, b) => b.launches - a.launches);

  const craftRows: PlanCraftRow[] = Object.entries(crafts)
    .map(([itemKey, count]) => ({ itemId: itemKeyToId(itemKey), count }))
    .sort((a, b) => b.count - a.count);

  const unmetItems = Object.entries(remainingDemand)
    .filter(([, qty]) => qty > 1e-6)
    .map(([itemKey, qty]) => ({ itemId: itemKeyToId(itemKey), quantity: qty }))
    .sort((a, b) => b.quantity - a.quantity);

  const uncoveredItemKeys = Object.entries(remainingDemand)
    .filter(
      ([itemKey, qty]) =>
        qty > 1e-6 &&
        !actions.some((action) => {
          const yieldPerMission = action.yields[itemKey] || 0;
          return yieldPerMission > 0;
        })
    )
    .map(([itemKey]) => itemKey);

  if (uncoveredItemKeys.length > 0 && missionRows.length === 0) {
    throw new MissionCoverageError(uncoveredItemKeys);
  }

  const notes: string[] = [];
  if (actions.length === 0) {
    notes.push("No eligible mission loot actions were found for your current mission options and loot dataset.");
  }
  if (unmetItems.length > 0) {
    notes.push("Some ingredient demand remains unmet by current mission options/dataset.");
  }
  if (uncoveredItemKeys.length > 0) {
    notes.push(
      `No mission drop coverage found for: ${uncoveredItemKeys
        .map((itemKey) => itemKeyToDisplayName(itemKey))
        .join(", ")}.`
    );
  }
  notes.push(
    "Planner currently uses expected-drop values and greedy mission allocation with 3 mission slots. Re-run after returns."
  );
  notes.push(
    "Rarity is treated as fungible for planning (shiny inventory counted toward craftable supply by item tier)."
  );

  return {
    targetItemId,
    quantity: quantityInt,
    priorityTime,
    geCost,
    expectedHours,
    weightedScore,
    crafts: craftRows,
    missions: missionRows,
    unmetItems,
    notes,
  };
}

export function summarizeCraftRows(rows: PlanCraftRow[]): string[] {
  return rows.slice(0, 6).map((row) => `${itemKeyToDisplayName(itemIdToKey(row.itemId))}: ${row.count.toLocaleString()}`);
}

export function missionDurationLabel(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const days = Math.floor(safe / 86400);
  const hours = Math.floor((safe % 86400) / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const parts: string[] = [];
  if (days) {
    parts.push(`${days}d`);
  }
  if (hours) {
    parts.push(`${hours}h`);
  }
  if (mins) {
    parts.push(`${mins}m`);
  }
  return parts.length > 0 ? parts.join(" ") : "0m";
}

export function isKnownItem(itemId: string): boolean {
  return Boolean(recipes[itemIdToKey(itemId)] !== undefined);
}
