import eiafxConfig from "../data/eiafx-config.json";
import { getCraftingLevelProgress } from "./crafting-levels";
import { itemIdToCanonicalKey, itemIdToKey, itemKeyToId } from "./item-utils";
import type { LootJson } from "./loot-data";
import { hasEnoughMissionTargetSample, pickLevel } from "./mission-loot";
import { getRecipe, itemIdTakesCraftCountGoal } from "./recipes";
import { getNominalMissionCapacity, type DurationType } from "./ship-data";

/**
 * Shiny (rarity) odds: the chance of ending a plan with at least one copy of
 * an artifact at a rarity or better, from its planned crafts and from mission
 * drops. The crafting formula is the game's, as wasmegg has it
 * (lib/artifacts/inventory.ts craftChance in the egg repo):
 *
 *   base  = common odds / rarity odds          (the tier's config)
 *   rate  = max(10, base / crafting level's rarity multiplier)
 *   μ     = min(1, crafts so far / 400)
 *   P(this rarity or better) = min(10%, (1 / rate) ^ (1 - 0.3μ))
 *
 * The exact chance of a rarity is its "or better" chance minus the next
 * rarity up's, so once epic also reaches the 10% cap, an exactly-rare craft
 * has no chance left. Goals use "or better", which never hits that wall.
 */

export const SHINY_RARITIES = ["rare", "epic", "legendary"] as const;
export type ShinyRarity = (typeof SHINY_RARITIES)[number];

export const SHINY_RARITY_LABELS: Record<ShinyRarity, string> = {
  rare: "Rare+",
  epic: "Epic+",
  legendary: "Legendary",
};

/** Most crafts a shiny goal asks for. */
export const MAX_SHINY_GOAL_CRAFTS = 9999;
/** Shiny goal chances run from 1% to 99%. */
export const MIN_SHINY_GOAL_PERCENT = 1;
export const MAX_SHINY_GOAL_PERCENT = 99;
export const DEFAULT_SHINY_GOAL_PERCENT = 50;
// Legendary drop counts below this per loot bucket are noise (often a single
// drop in tens of thousands), so they count as none. wasmegg's artifact
// explorer uses the same floor (MIN_LEGENDARY_OBSERVATIONS).
const MIN_LEGENDARY_OBSERVATIONS = 5;
const PER_CRAFT_CAP = 0.1;

const RARITY_INDEX: Record<ShinyRarity, number> = { rare: 1, epic: 2, legendary: 3 };
const SPEC_LEVEL_TIER: Record<string, number> = { INFERIOR: 1, LESSER: 2, NORMAL: 3, GREATER: 4 };

type ArtifactParameter = {
  spec: { name: string; level: string; rarity: string };
  oddsMultiplier: number;
};
type CraftingLevelInfo = { rarityMult?: number };

type TierOdds = { common: number } & Partial<Record<ShinyRarity, number>>;

let oddsByItemKey: Map<string, TierOdds> | null = null;

function tierOdds(itemKey: string): TierOdds | null {
  if (!oddsByItemKey) {
    oddsByItemKey = new Map();
    for (const parameter of eiafxConfig.artifactParameters as ArtifactParameter[]) {
      const tier = SPEC_LEVEL_TIER[parameter.spec.level];
      if (!tier) {
        continue;
      }
      const key = `${parameter.spec.name.toLowerCase()}_${tier}`;
      const entry = oddsByItemKey.get(key) || { common: 0 };
      const rarity = parameter.spec.rarity.toLowerCase();
      if (rarity === "common") {
        entry.common = parameter.oddsMultiplier;
      } else if ((SHINY_RARITIES as readonly string[]).includes(rarity)) {
        entry[rarity as ShinyRarity] = parameter.oddsMultiplier;
      }
      oddsByItemKey.set(key, entry);
    }
  }
  return oddsByItemKey.get(itemKey) || null;
}

/** The shiny rarities an item comes in, lowest first (none for stones and ingredients). */
export function shinyRaritiesFor(itemKey: string): ShinyRarity[] {
  const odds = tierOdds(itemKey);
  return odds ? SHINY_RARITIES.filter((rarity) => (odds[rarity] || 0) > 0) : [];
}

/** Whether a goal row on this item can aim for a shiny chance: a craftable artifact with shiny rarities. */
export function itemIdTakesShinyGoal(itemId: string): boolean {
  return itemIdTakesCraftCountGoal(itemId) && shinyRaritiesFor(itemIdToCanonicalKey(itemId)).length > 0;
}

/** The best rarity an item comes in, for a new shiny goal. */
export function defaultShinyRarity(itemKey: string): ShinyRarity | null {
  const rarities = shinyRaritiesFor(itemKey);
  return rarities[rarities.length - 1] ?? null;
}

const craftingLevelInfos = (eiafxConfig.craftingLevelInfos || []) as CraftingLevelInfo[];

export function craftingLevelForXp(craftingXp: number): number {
  return getCraftingLevelProgress(craftingXp).level;
}

/** The crafting level's rarity multiplier (1 at level 1, 10 at level 30). */
export function craftingRarityMult(level: number): number {
  return craftingLevelInfos[Math.max(0, Math.min(craftingLevelInfos.length - 1, level - 1))]?.rarityMult || 1;
}

/** One craft's chance of this rarity or better, from 0 to 0.1. */
export function craftChanceOrBetter(
  itemKey: string,
  rarity: ShinyRarity,
  rarityMult: number,
  craftedBefore: number
): number {
  const odds = tierOdds(itemKey);
  const rarityOdds = odds?.[rarity] || 0;
  if (!odds || odds.common <= 0 || rarityOdds <= 0) {
    return 0;
  }
  const rate = Math.max(10, odds.common / rarityOdds / Math.max(1, rarityMult));
  const mu = Math.min(1, Math.max(0, craftedBefore) / 400);
  return Math.min(PER_CRAFT_CAP, (1 / rate) ** (1 - 0.3 * mu));
}

/** One craft's chance of exactly this rarity: its "or better" chance less the next rarity up's. */
export function craftChanceExactly(
  itemKey: string,
  rarity: ShinyRarity,
  rarityMult: number,
  craftedBefore: number
): number {
  const orBetter = craftChanceOrBetter(itemKey, rarity, rarityMult, craftedBefore);
  const higher = shinyRaritiesFor(itemKey).find((candidate) => RARITY_INDEX[candidate] > RARITY_INDEX[rarity]);
  return higher ? Math.max(0, orBetter - craftChanceOrBetter(itemKey, higher, rarityMult, craftedBefore)) : orBetter;
}

export type CraftRolls = {
  crafts: number;
  /** Chance at least one of the crafts lands this rarity or better. */
  chance: number;
  /** The first and last craft's chance. */
  firstChance: number;
  lastChance: number;
  startLevel: number;
  endLevel: number;
  craftedBefore: number;
};

/**
 * Crafts made one after another. Each craft's chance uses the craft count
 * before it and the crafting level from the XP earned so far: `ingredientXp`
 * (crafting what the crafts eat) arrives in step with them, as the game's
 * auto-craft makes ingredients just before each craft, and each craft adds
 * its own XP after it rolls.
 */
function rollCrafts(options: {
  itemKey: string;
  rarity: ShinyRarity;
  craftedBefore: number;
  craftingXp: number;
  ingredientXp: number;
  /** Stop at this many crafts, or earlier once `targetChance` is reached. */
  maxCrafts: number;
  targetChance?: number;
}): CraftRolls {
  const { itemKey, rarity, maxCrafts, targetChance } = options;
  const craftedBefore = Math.max(0, Math.round(options.craftedBefore));
  const ownXp = getRecipe(itemKey)?.xp || 0;
  const startLevel = craftingLevelForXp(options.craftingXp);
  let miss = 1;
  let firstChance = 0;
  let lastChance = 0;
  let level = startLevel;
  let crafts = 0;
  while (crafts < maxCrafts && (targetChance == null || 1 - miss < targetChance)) {
    const xp = options.craftingXp + (options.ingredientXp * (crafts + 1)) / Math.max(1, maxCrafts) + ownXp * crafts;
    level = craftingLevelForXp(xp);
    const chance = craftChanceOrBetter(itemKey, rarity, craftingRarityMult(level), craftedBefore + crafts);
    if (chance <= 0) {
      break;
    }
    if (crafts === 0) {
      firstChance = chance;
    }
    lastChance = chance;
    miss *= 1 - chance;
    crafts += 1;
  }
  const endLevel = crafts > 0 ? craftingLevelForXp(options.craftingXp + options.ingredientXp + ownXp * crafts) : startLevel;
  return { crafts, chance: 1 - miss, firstChance, lastChance, startLevel, endLevel, craftedBefore };
}

/**
 * Fewest crafts that reach `targetChance` of this rarity or better from
 * crafting alone. Drops are left out and only the crafts' own XP raises the
 * crafting level, so the plan gets at least the chance asked for; the plan's
 * odds show what drops and ingredient crafts add on top. `reached` is false
 * when even MAX_SHINY_GOAL_CRAFTS crafts fall short, or the item has no such
 * rarity.
 */
export function craftsForShinyChance(options: {
  itemKey: string;
  rarity: ShinyRarity;
  targetChance: number;
  craftedBefore: number;
  craftingXp: number;
}): CraftRolls & { reached: boolean } {
  const targetChance = Math.max(0.01, Math.min(0.99, options.targetChance));
  const rolls = rollCrafts({
    itemKey: options.itemKey,
    rarity: options.rarity,
    craftedBefore: options.craftedBefore,
    craftingXp: options.craftingXp,
    ingredientXp: 0,
    maxCrafts: MAX_SHINY_GOAL_CRAFTS,
    targetChance,
  });
  return { ...rolls, reached: rolls.chance >= targetChance };
}

/** What a shiny goal became for the solver: a craft-count goal of crafted so far + crafts. */
export type ShinyGoalPlan = {
  itemId: string;
  rarity: ShinyRarity;
  /** 0.01 to 0.99. */
  targetChance: number;
  craftedBefore: number;
  crafts: number;
  reached: boolean;
};

type GoalTarget = { targetItemId: string; quantity: number; craftGoal?: boolean; shinyRarity?: ShinyRarity };

/**
 * Turn shiny goals (quantity = the percent chance) into craft-count goals the
 * solver already understands. Other goals pass through unchanged.
 */
export function resolveShinyGoalTargets<T extends GoalTarget>(
  targets: T[],
  profile: { craftCounts: Record<string, number>; craftingXp: number }
): { targets: Array<Omit<T, "shinyRarity">>; shinyGoals: ShinyGoalPlan[] } {
  const shinyGoals: ShinyGoalPlan[] = [];
  const resolved = targets.map((target) => {
    const { shinyRarity, ...rest } = target;
    if (!shinyRarity) {
      return rest;
    }
    const itemKey = itemIdToCanonicalKey(target.targetItemId);
    const craftedBefore = Math.max(0, Math.round(profile.craftCounts[itemKey] || 0));
    const targetChance =
      Math.max(MIN_SHINY_GOAL_PERCENT, Math.min(MAX_SHINY_GOAL_PERCENT, Math.round(target.quantity))) / 100;
    const needed = itemIdTakesShinyGoal(target.targetItemId)
      ? craftsForShinyChance({ itemKey, rarity: shinyRarity, targetChance, craftedBefore, craftingXp: profile.craftingXp })
      : null;
    const crafts = needed?.crafts ?? 0;
    shinyGoals.push({
      itemId: itemKeyToId(itemKey),
      rarity: shinyRarity,
      targetChance,
      craftedBefore,
      crafts,
      reached: needed?.reached ?? false,
    });
    // An item that can't take the goal asks for no crafts (crafted so far).
    return { ...rest, quantity: Math.max(1, craftedBefore + crafts), craftGoal: true };
  });
  return { targets: resolved, shinyGoals };
}

export type ShinyDropMission = {
  missionId: string;
  ship: string;
  durationType: string;
  level: number;
  targetAfxId: number;
  launches: number;
};

/** Expected copies of this item at this rarity or better that the missions drop, in total and per mission row. */
export function expectedShinyDrops(options: {
  itemKey: string;
  rarity: ShinyRarity;
  missions: ShinyDropMission[];
  loot: LootJson;
  zerogLevel: number;
}): { total: number; byMission: number[] } {
  const { itemKey, rarity, loot } = options;
  const lootByMissionId = new Map(loot.missions.map((mission) => [mission.missionId, mission]));
  const byMission = options.missions.map((mission) => {
    const levelLoot = pickLevel(lootByMissionId.get(mission.missionId)?.levels || [], mission.level);
    const target = levelLoot?.targets.find((candidate) => candidate.targetAfxId === mission.targetAfxId);
    const durationType = mission.durationType as DurationType;
    const sampleCapacity = levelLoot ? getNominalMissionCapacity(mission.ship, durationType, levelLoot.level) || 0 : 0;
    if (!target || !hasEnoughMissionTargetSample(target, sampleCapacity) || mission.launches <= 0) {
      return 0;
    }
    const item = target.items.find((candidate) => itemIdToKey(candidate.itemId) === itemKey);
    if (!item) {
      return 0;
    }
    let shinyDrops = 0;
    for (let index = RARITY_INDEX[rarity]; index <= 3; index += 1) {
      const count = item.counts[index] || 0;
      shinyDrops += index === 3 && count < MIN_LEGENDARY_OBSERVATIONS ? 0 : count;
    }
    const nominal = getNominalMissionCapacity(mission.ship, durationType, mission.level) || 0;
    const capacity = Math.floor(nominal * (1 + 0.05 * Math.max(0, options.zerogLevel)));
    return (shinyDrops / target.totalDrops) * capacity * mission.launches;
  });
  return { total: byMission.reduce((sum, quantity) => sum + quantity, 0), byMission };
}

export type ShinyOdds = {
  rarity: ShinyRarity;
  /** Chance of at least one of this rarity or better by the end of the plan. */
  chance: number;
  crafts: CraftRolls;
  /** Expected drops of this rarity or better. */
  drops: number;
  /** The last craft's chance of exactly this rarity (0 when higher rarities take its share). */
  lastExactChance: number;
};

/** XP from the plan's crafts of everything an item is made from (its whole recipe tree). */
export function ingredientCraftXp(itemKey: string, plannedCrafts: Record<string, number>): number {
  const seen = new Set<string>();
  const stack = Object.keys(getRecipe(itemKey)?.ingredients || {});
  let xp = 0;
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const recipe = getRecipe(key);
    if (!recipe) {
      continue;
    }
    xp += (plannedCrafts[key] || 0) * recipe.xp;
    stack.push(...Object.keys(recipe.ingredients));
  }
  return xp;
}

/** An item's odds for each of its shiny rarities at the end of a plan. */
export function shinyOddsForPlan(options: {
  itemKey: string;
  craftedBefore: number;
  craftingXp: number;
  /** Planned crafts by item key. */
  plannedCrafts: Record<string, number>;
  missions: ShinyDropMission[];
  loot: LootJson | null;
  zerogLevel: number;
}): ShinyOdds[] {
  const { itemKey } = options;
  const crafts = Math.max(0, Math.round(options.plannedCrafts[itemKey] || 0));
  const ingredientXp = crafts > 0 ? ingredientCraftXp(itemKey, options.plannedCrafts) : 0;
  return shinyRaritiesFor(itemKey).map((rarity) => {
    const rolls = rollCrafts({
      itemKey,
      rarity,
      craftedBefore: options.craftedBefore,
      craftingXp: options.craftingXp,
      ingredientXp,
      maxCrafts: crafts,
    });
    const drops = options.loot
      ? expectedShinyDrops({ itemKey, rarity, missions: options.missions, loot: options.loot, zerogLevel: options.zerogLevel })
          .total
      : 0;
    const lastCraftedBefore = options.craftedBefore + Math.max(0, crafts - 1);
    return {
      rarity,
      chance: 1 - (1 - rolls.chance) * Math.exp(-drops),
      crafts: rolls,
      drops,
      lastExactChance: craftChanceExactly(itemKey, rarity, craftingRarityMult(rolls.endLevel), lastCraftedBefore),
    };
  });
}
