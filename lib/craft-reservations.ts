import { itemIdToCanonicalKey } from "./item-utils";
import { recipes as defaultRecipes, type Recipes } from "./recipes";

/**
 * Keeping inventory back for a player's crafting goals, so the XP planner can
 * optimize over what is left without eating into it.
 *
 * - A copies goal "X ×N" means "have N of X": owned copies of X are kept
 *   first, and each copy still missing keeps one recipe's worth of ingredients
 *   (each ingredient again from owned copies first, then its own recipe).
 * - A craft-count goal "X, craft count N" means "reach N all-time crafts of
 *   X": owned copies of X do not count, so it keeps the ingredients for the
 *   N − (crafts so far) crafts still to make.
 * - Goals take from one shared pool in row order, so two goals never keep the
 *   same copies.
 * - When owned items can't cover a goal, everything owned along its recipe
 *   tree stays kept anyway (never released). The goal reports how much of it
 *   inventory can finish (`finishable` of `needed`), and the uncraftable items
 *   still missing (`short`).
 */

export type CraftReservationGoal = {
  /** UI item id ("gusset-3") or canonical key ("ornate_gusset_3"). */
  itemId: string;
  quantity: number;
  /** Read `quantity` as an all-time craft count. Ignored for items with no recipe. */
  craftGoal?: boolean;
};

export type CraftGoalReservation = {
  /** Canonical item key, or "" when the goal's item is unknown. */
  itemKey: string;
  quantity: number;
  /** Whether the goal was read as a craft count (only for craftable items). */
  craftGoal: boolean;
  /** Craft-count goals: crafts still to make; null for copies goals. */
  craftsToGo: number | null;
  /** What the goal still asks of inventory: copies to have, or crafts still to go. */
  needed: number;
  /** How much of `needed` the inventory left for this goal can finish (all of it when covered). */
  finishable: number;
  /** Owned items this goal keeps, canonical key → count, in the order its recipe tree reached them. */
  keeps: Record<string, number>;
  /** Uncraftable items the goal still needs beyond everything owned, canonical key → count. */
  short: Record<string, number>;
};

export type CraftReservations = {
  goals: CraftGoalReservation[];
  /** Total kept per canonical key across all goals. */
  reserved: Record<string, number>;
  /** The inventory with everything kept taken out (never below 0). */
  available: Record<string, number>;
  /** Number of items kept across all goals. */
  totalReserved: number;
};

type PoolTake = {
  keeps: Record<string, number>;
  short: Record<string, number>;
};

/**
 * Take `amount` of an item from the pool (or, with `asCrafts`, the
 * ingredients for `amount` crafts of it): owned copies first, then each
 * missing copy's recipe, recursively. Mutates the pool.
 */
function takeFromPool(
  pool: Map<string, number>,
  recipeMap: Recipes,
  itemKey: string,
  amount: number,
  asCrafts: boolean
): PoolTake {
  const taken: PoolTake = { keeps: {}, short: {} };
  const keep = (key: string, needed: number, path: Set<string>): void => {
    if (needed <= 0) {
      return;
    }
    const owned = pool.get(key) || 0;
    const fromPool = Math.min(owned, needed);
    if (fromPool > 0) {
      pool.set(key, owned - fromPool);
      taken.keeps[key] = (taken.keeps[key] || 0) + fromPool;
    }
    const missing = needed - fromPool;
    if (missing <= 0) {
      return;
    }
    if (!recipeMap[key] || path.has(key)) {
      taken.short[key] = (taken.short[key] || 0) + missing;
      return;
    }
    keepIngredients(key, missing, path);
  };
  const keepIngredients = (key: string, crafts: number, path: Set<string>): void => {
    const recipe = recipeMap[key];
    if (!recipe || crafts <= 0) {
      return;
    }
    const nextPath = new Set(path).add(key);
    for (const [ingredient, perCraft] of Object.entries(recipe.ingredients)) {
      keep(ingredient, crafts * Math.max(0, Math.round(perCraft)), nextPath);
    }
  };
  if (asCrafts) {
    keepIngredients(itemKey, amount, new Set());
  } else {
    keep(itemKey, amount, new Set());
  }
  return taken;
}

/**
 * The most of `needed` (copies, or crafts with `asCrafts`) the pool can fully
 * cover, given it can't cover all of it. Coverage only gets harder as the
 * amount grows, so a binary search finds it.
 */
function finishableFromPool(
  pool: Map<string, number>,
  recipeMap: Recipes,
  itemKey: string,
  needed: number,
  asCrafts: boolean
): number {
  const covers = (amount: number) =>
    Object.keys(takeFromPool(new Map(pool), recipeMap, itemKey, amount, asCrafts).short).length === 0;
  let low = 0;
  let high = needed - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (covers(mid)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

export function reserveInventoryForGoals(
  inventory: Record<string, number>,
  craftCounts: Record<string, number>,
  goals: CraftReservationGoal[],
  recipeMap: Recipes = defaultRecipes
): CraftReservations {
  // Only whole copies can be kept. Pre-plan sends add fractional expected
  // drops, and that fraction stays available to the optimizer.
  const pool = new Map<string, number>();
  for (const [itemKey, quantity] of Object.entries(inventory)) {
    const whole = Math.floor(Number(quantity) || 0);
    if (whole > 0) {
      pool.set(itemKey, whole);
    }
  }
  const reserved: Record<string, number> = {};
  // Crafts earlier craft-count rows already keep ingredients for, so a second
  // row for the same artifact only adds what the first doesn't cover.
  const plannedGoalCrafts = new Map<string, number>();

  const results = goals.map((goal): CraftGoalReservation => {
    const itemKey = goal.itemId ? itemIdToCanonicalKey(goal.itemId) : "";
    const quantity = Math.max(0, Math.round(Number(goal.quantity) || 0));
    if (!itemKey || !(itemKey in recipeMap)) {
      return { itemKey: "", quantity, craftGoal: false, craftsToGo: null, needed: 0, finishable: 0, keeps: {}, short: {} };
    }

    const craftGoal = Boolean(goal.craftGoal && recipeMap[itemKey]);
    let craftsToGo: number | null = null;
    if (craftGoal) {
      const craftedSoFar = Math.max(0, Math.round(Number(craftCounts[itemKey]) || 0));
      const alreadyPlanned = plannedGoalCrafts.get(itemKey) || 0;
      craftsToGo = Math.max(0, quantity - craftedSoFar - alreadyPlanned);
      plannedGoalCrafts.set(itemKey, alreadyPlanned + craftsToGo);
    }
    const needed = craftsToGo ?? quantity;
    const poolBefore = new Map(pool);
    const { keeps, short } = takeFromPool(pool, recipeMap, itemKey, needed, craftGoal);
    for (const [key, count] of Object.entries(keeps)) {
      reserved[key] = (reserved[key] || 0) + count;
    }
    const finishable =
      Object.keys(short).length === 0 ? needed : finishableFromPool(poolBefore, recipeMap, itemKey, needed, craftGoal);
    return { itemKey, quantity, craftGoal, craftsToGo, needed, finishable, keeps, short };
  });

  const available: Record<string, number> = {};
  for (const [itemKey, quantity] of Object.entries(inventory)) {
    available[itemKey] = Math.max(0, (Number(quantity) || 0) - (reserved[itemKey] || 0));
  }
  const totalReserved = Object.values(reserved).reduce((sum, count) => sum + count, 0);
  return { goals: results, reserved, available, totalReserved };
}

/** Whether a goal is fully covered by owned items (nothing short). */
export function goalReservationCovered(goal: CraftGoalReservation): boolean {
  return Object.keys(goal.short).length === 0;
}

/**
 * Whether a plan leaves every kept item in place: inventory plus what the plan
 * crafts minus what its crafts consume, per item, is at least what is kept.
 */
export function planLeavesReserved(
  plannedCrafts: Record<string, number>,
  inventory: Record<string, number>,
  reserved: Record<string, number>,
  recipeMap: Recipes = defaultRecipes
): boolean {
  const net: Record<string, number> = {};
  for (const [artifact, rawCount] of Object.entries(plannedCrafts)) {
    const count = Math.max(0, Math.round(rawCount));
    const recipe = recipeMap[artifact];
    if (count <= 0 || !recipe) {
      continue;
    }
    net[artifact] = (net[artifact] || 0) + count;
    for (const [ingredient, perCraft] of Object.entries(recipe.ingredients)) {
      net[ingredient] = (net[ingredient] || 0) - perCraft * count;
    }
  }
  return Object.entries(reserved).every(
    ([itemKey, kept]) => (Number(inventory[itemKey]) || 0) + (net[itemKey] || 0) >= kept - 1e-6
  );
}
