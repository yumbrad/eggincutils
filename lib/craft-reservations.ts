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
 *   tree stays kept anyway (never released), and the uncraftable items still
 *   missing are reported as `short`.
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
    const result: CraftGoalReservation = {
      itemKey,
      quantity,
      craftGoal: false,
      craftsToGo: null,
      keeps: {},
      short: {},
    };
    if (!itemKey || !(itemKey in recipeMap)) {
      result.itemKey = "";
      return result;
    }

    const keep = (key: string, amount: number, path: Set<string>): void => {
      if (amount <= 0) {
        return;
      }
      const owned = pool.get(key) || 0;
      const taken = Math.min(owned, amount);
      if (taken > 0) {
        pool.set(key, owned - taken);
        result.keeps[key] = (result.keeps[key] || 0) + taken;
        reserved[key] = (reserved[key] || 0) + taken;
      }
      const missing = amount - taken;
      if (missing <= 0) {
        return;
      }
      const recipe = recipeMap[key];
      if (!recipe || path.has(key)) {
        result.short[key] = (result.short[key] || 0) + missing;
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

    if (goal.craftGoal && recipeMap[itemKey]) {
      const craftedSoFar = Math.max(0, Math.round(Number(craftCounts[itemKey]) || 0));
      const alreadyPlanned = plannedGoalCrafts.get(itemKey) || 0;
      const craftsToGo = Math.max(0, quantity - craftedSoFar - alreadyPlanned);
      plannedGoalCrafts.set(itemKey, alreadyPlanned + craftsToGo);
      result.craftGoal = true;
      result.craftsToGo = craftsToGo;
      keepIngredients(itemKey, craftsToGo, new Set());
    } else {
      keep(itemKey, quantity, new Set());
    }
    return result;
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
