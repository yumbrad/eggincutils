import { recipes, Recipes } from "./recipes";

export type Inventory = Record<string, number>;
export type CraftCounts = Record<string, number>;

export interface Highs {
  solve: (problem: string, options?: Record<string, string | number | boolean>) => {
    Columns: Record<string, { Primal: number }>;
  };
}

export interface CraftModeMetrics {
  count: number;
  xp: number;
  cost: number;
  xpPerGe: number;
}

export interface CraftModeComparison {
  direct: CraftModeMetrics;
  auto: CraftModeMetrics | null;
}

export interface IngredientCost {
  name: string;
  quantity: number;
  baseCost: number;
  discountedCost: number;
  totalCost: number;
  craftCount: number;
  discountPercent: number;
}

export interface CostDetails {
  baseCost: number;
  discountedCost: number;
  totalDirectCost: number;
  craftCount: number;
  discountPercent: number;
  recursiveCost: number;
  ingredients: IngredientCost[];
}

export interface SolutionCraftRow {
  count: number;
  xp: number;
  cost: number;
  xpPerGe: number;
  xpPerCraft: number;
  costDetails: CostDetails;
  modeComparison: CraftModeComparison;
}

export interface Solution {
  crafts: Record<string, SolutionCraftRow>;
  totalXp: number;
  totalCost: number;
}

const MAX_CRAFT_COUNT_FOR_DISCOUNT = 300;
const MAX_DISCOUNT_FACTOR = 0.9;
const DISCOUNT_CURVE_EXPONENT = 0.2;
const ZERO_TOLERANCE = 1e-9;
const HIGHS_SOLVE_OPTIONS = {
  presolve: "on",
};

export function optimizeCrafts(highs: Highs, inventory: Inventory, craftCounts: CraftCounts = {}): Solution {
  const problem = getProblem(inventory);
  const solution = highs.solve(problem, HIGHS_SOLVE_OPTIONS);

  const result: Solution = {
    crafts: {},
    totalXp: 0,
    totalCost: 0,
  };

  for (const artifact of Object.keys(solution.Columns || {})) {
    if (!recipes[artifact]) {
      continue;
    }
    const count = normalizeCount(solution.Columns[artifact].Primal);
    const xpPerCraft = recipes[artifact]!.xp;
    const xp = count * xpPerCraft;
    const costDetails = getCostDetails(recipes, craftCounts, artifact, count);
    const cost = costDetails.totalDirectCost;
    const xpPerGe = cost > 0 ? xp / cost : 0;
    const modeComparison = getCraftModeComparison(recipes, inventory, craftCounts, artifact, xpPerCraft);

    result.crafts[artifact] = { count, xp, cost, xpPerGe, xpPerCraft, costDetails, modeComparison };
    result.totalXp += xp;
    result.totalCost += cost;
  }

  return result;
}

function normalizeCount(value: number): number {
  if (Math.abs(value) < ZERO_TOLERANCE) {
    return 0;
  }
  return value < 0 ? 0 : value;
}

function getCostDetails(recipeMap: Recipes, craftCounts: CraftCounts, artifact: string, plannedCrafts: number): CostDetails {
  const recipe = recipeMap[artifact];
  if (!recipe) {
    return {
      baseCost: 0,
      discountedCost: 0,
      totalDirectCost: 0,
      craftCount: 0,
      discountPercent: 0,
      recursiveCost: 0,
      ingredients: [],
    };
  }

  const craftCount = craftCounts[artifact] || 0;
  const { discountedCost, discountPercent } = getDiscountedCost(recipe.cost, craftCount);
  return {
    baseCost: recipe.cost,
    discountedCost,
    totalDirectCost: getBatchDirectCost(recipe.cost, craftCount, plannedCrafts),
    craftCount,
    discountPercent,
    recursiveCost: getRecursiveCost(recipeMap, craftCounts, artifact),
    ingredients: getIngredientCosts(recipeMap, craftCounts, artifact),
  };
}

function getIngredientCosts(recipeMap: Recipes, craftCounts: CraftCounts, artifact: string): IngredientCost[] {
  const recipe = recipeMap[artifact];
  if (!recipe) {
    return [];
  }
  return Object.entries(recipe.ingredients).map(([name, quantity]) => {
    const ingredientRecipe = recipeMap[name];
    const baseCost = ingredientRecipe ? ingredientRecipe.cost : 0;
    const craftCount = craftCounts[name] || 0;
    const { discountedCost, discountPercent } = getDiscountedCost(baseCost, craftCount);
    return {
      name,
      quantity,
      baseCost,
      discountedCost,
      totalCost: getBatchDirectCost(baseCost, craftCount, quantity),
      craftCount,
      discountPercent,
    };
  });
}

function getRecursiveCost(recipeMap: Recipes, craftCounts: CraftCounts, artifact: string): number {
  const projectedCraftCounts = { ...craftCounts };
  return getRecursiveCraftCost(recipeMap, projectedCraftCounts, artifact);
}

function getRecursiveCraftCost(recipeMap: Recipes, projectedCraftCounts: CraftCounts, artifact: string): number {
  const recipe = recipeMap[artifact];
  if (!recipe) {
    return 0;
  }

  let totalCost = 0;
  for (const [ingredient, quantity] of Object.entries(recipe.ingredients)) {
    if (!recipeMap[ingredient]) {
      continue;
    }
    for (let index = 0; index < quantity; index += 1) {
      totalCost += getRecursiveCraftCost(recipeMap, projectedCraftCounts, ingredient);
    }
  }

  const craftCount = projectedCraftCounts[artifact] || 0;
  const { discountedCost } = getDiscountedCost(recipe.cost, craftCount);
  totalCost += discountedCost;
  projectedCraftCounts[artifact] = craftCount + 1;
  return totalCost;
}

function getBatchDirectCost(baseCost: number, craftCount: number, quantity: number): number {
  if (baseCost <= 0 || quantity <= 0) {
    return 0;
  }
  const craftTotal = Math.max(0, Math.round(quantity));
  let totalCost = 0;
  for (let index = 0; index < craftTotal; index += 1) {
    totalCost += getDiscountedCost(baseCost, craftCount + index).discountedCost;
  }
  return totalCost;
}

function getCraftModeComparison(
  recipeMap: Recipes,
  inventory: Inventory,
  craftCounts: CraftCounts,
  artifact: string,
  xpPerCraft: number
): CraftModeComparison {
  const directResult = simulateCraftMode(recipeMap, inventory, craftCounts, artifact, false);
  const direct: CraftModeMetrics = {
    count: directResult.count,
    xp: directResult.count * xpPerCraft,
    cost: directResult.cost,
    xpPerGe: directResult.cost > 0 ? (directResult.count * xpPerCraft) / directResult.cost : 0,
  };

  const recipe = recipeMap[artifact];
  if (!recipe) {
    return { direct, auto: null };
  }

  const hasCraftableIngredient = Object.keys(recipe.ingredients).some((ingredient) => Boolean(recipeMap[ingredient]));
  if (!hasCraftableIngredient) {
    return { direct, auto: null };
  }

  const autoResult = simulateCraftMode(recipeMap, inventory, craftCounts, artifact, true);
  const auto: CraftModeMetrics = {
    count: autoResult.count,
    xp: autoResult.count * xpPerCraft,
    cost: autoResult.cost,
    xpPerGe: autoResult.cost > 0 ? (autoResult.count * xpPerCraft) / autoResult.cost : 0,
  };
  return { direct, auto };
}

function simulateCraftMode(
  recipeMap: Recipes,
  inventory: Inventory,
  craftCounts: CraftCounts,
  artifact: string,
  allowAutocraft: boolean
): { count: number; cost: number } {
  let simulationInventory = cloneCountMap(inventory);
  let simulationCraftCounts = cloneCountMap(craftCounts);
  let totalCost = 0;
  let craftedCount = 0;
  while (true) {
    const attemptInventory = cloneCountMap(simulationInventory);
    const attemptCraftCounts = cloneCountMap(simulationCraftCounts);
    let attemptCost = 0;
    const didCraft = craftOne(
      recipeMap,
      attemptInventory,
      attemptCraftCounts,
      artifact,
      allowAutocraft,
      (cost) => {
        attemptCost += cost;
      }
    );
    if (!didCraft) {
      break;
    }
    simulationInventory = attemptInventory;
    simulationCraftCounts = attemptCraftCounts;
    totalCost += attemptCost;
    craftedCount += 1;
  }
  return {
    count: craftedCount,
    cost: totalCost,
  };
}

function craftOne(
  recipeMap: Recipes,
  inventory: Record<string, number>,
  craftCounts: Record<string, number>,
  artifact: string,
  allowAutocraft: boolean,
  onCost: (cost: number) => void,
  stack: Set<string> = new Set()
): boolean {
  const recipe = recipeMap[artifact];
  if (!recipe) {
    return false;
  }
  if (stack.has(artifact)) {
    throw new Error(`Cycle detected while simulating recipe for ${artifact}`);
  }
  stack.add(artifact);

  for (const [ingredient, rawQuantity] of Object.entries(recipe.ingredients)) {
    const requiredQuantity = Math.max(0, Math.round(rawQuantity));
    while ((inventory[ingredient] || 0) < requiredQuantity) {
      if (!allowAutocraft || !recipeMap[ingredient]) {
        stack.delete(artifact);
        return false;
      }
      const didCraftIngredient = craftOne(recipeMap, inventory, craftCounts, ingredient, true, onCost, stack);
      if (!didCraftIngredient) {
        stack.delete(artifact);
        return false;
      }
    }
  }

  for (const [ingredient, rawQuantity] of Object.entries(recipe.ingredients)) {
    const requiredQuantity = Math.max(0, Math.round(rawQuantity));
    inventory[ingredient] = Math.max(0, (inventory[ingredient] || 0) - requiredQuantity);
  }

  const craftCount = craftCounts[artifact] || 0;
  const { discountedCost } = getDiscountedCost(recipe.cost, craftCount);
  onCost(discountedCost);
  craftCounts[artifact] = craftCount + 1;
  inventory[artifact] = (inventory[artifact] || 0) + 1;
  stack.delete(artifact);
  return true;
}

function cloneCountMap(values: Record<string, number>): Record<string, number> {
  const clone = {} as Record<string, number>;
  for (const [key, value] of Object.entries(values)) {
    clone[key] = Math.max(0, Math.round(value || 0));
  }
  return clone;
}

function getDiscountedCost(baseCost: number, craftCount: number): { discountedCost: number; discountPercent: number } {
  if (baseCost <= 0) {
    return { discountedCost: 0, discountPercent: 0 };
  }
  const progress = Math.min(1, craftCount / MAX_CRAFT_COUNT_FOR_DISCOUNT);
  const multiplier = 1 - MAX_DISCOUNT_FACTOR * Math.pow(progress, DISCOUNT_CURVE_EXPONENT);
  const discountedCost = Math.floor(baseCost * multiplier);
  const discountPercent = baseCost > 0 ? 1 - discountedCost / baseCost : 0;
  return { discountedCost, discountPercent };
}

function getProblem(inventory: Inventory): string {
  const lines: string[] = [];
  const artifacts = Object.keys(recipes).sort();

  lines.push("Maximize");
  lines.push(`  obj: ${getObjective(recipes, artifacts)}`);

  lines.push("Subject To");
  for (const artifact of artifacts) {
    const constraint = getConstraint(recipes, inventory, artifact);
    if (constraint) {
      lines.push(`  c_${artifact}: ${constraint}`);
    }
  }

  lines.push("Bounds");
  for (const artifact of artifacts) {
    lines.push(`  ${artifact} >= 0`);
  }

  lines.push("General");
  lines.push(`  ${artifacts.join(" ")}`);
  lines.push("End");

  return lines.join("\n");
}

function getObjective(recipeMap: Recipes, artifacts: string[]): string {
  const crafts: string[] = [];
  for (const artifact of artifacts) {
    if (recipeMap[artifact]) {
      crafts.push(`${recipeMap[artifact]!.xp} ${artifact}`);
    }
  }
  return crafts.join(" + ");
}

function getConstraint(recipeMap: Recipes, inventory: Inventory, artifact: string): string | null {
  const used: string[] = [];
  for (const parent of Object.keys(recipeMap)) {
    if (recipeMap[parent] && artifact in recipeMap[parent]!.ingredients) {
      used.push(`${recipeMap[parent]!.ingredients[artifact]} ${parent}`);
    }
  }
  if (used.length === 0) {
    return null;
  }

  const available = inventory[artifact] || 0;
  if (recipeMap[artifact]) {
    return `${used.join(" + ")} - ${artifact} <= ${available}`;
  }
  return `${used.join(" + ")} <= ${available}`;
}
