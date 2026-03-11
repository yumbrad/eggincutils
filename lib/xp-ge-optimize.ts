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

export type SequentialMode = "direct" | "auto";

export interface GeEfficiencyPlanRowInput {
  artifact: string;
  mode: SequentialMode;
  referenceXpPerGe: number;
}

export interface GeEfficiencyPlanRowResult {
  artifact: string;
  mode: SequentialMode;
  referenceXpPerGe: number;
  craftedCount: number;
  xp: number;
  cost: number;
  effectiveXpPerGe: number;
}

export interface GeEfficiencyPlanResult {
  rows: GeEfficiencyPlanRowResult[];
  totalXp: number;
  totalCost: number;
  processedRowCount: number;
  craftedRowCount: number;
  stopReason: "threshold" | "exhausted";
  finalInventory: Inventory;
  finalCraftCounts: CraftCounts;
}

export interface MaxXpExecutionPlanNode {
  artifact: string;
  mode: "click" | "auto";
  count: number;
  xp: number;
  cost: number;
  children: MaxXpExecutionPlanNode[];
}

export interface MaxXpExecutionPlan {
  steps: MaxXpExecutionPlanNode[];
  totalXp: number;
  totalCost: number;
  totalTopLevelRows: number;
  totalTopLevelCrafts: number;
  remainingInventory: Inventory;
  finalCraftCounts: CraftCounts;
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

export function simulateGeEfficiencyPlan(
  inventory: Inventory,
  craftCounts: CraftCounts = {},
  rows: GeEfficiencyPlanRowInput[],
  minXpPerGe: number
): GeEfficiencyPlanResult {
  let simulationInventory = cloneCountMap(inventory);
  let simulationCraftCounts = cloneCountMap(craftCounts);
  const safeMinXpPerGe = Math.max(0, Number.isFinite(minXpPerGe) ? minXpPerGe : 0);

  const results: GeEfficiencyPlanRowResult[] = [];
  let totalXp = 0;
  let totalCost = 0;
  let processedRowCount = 0;
  let craftedRowCount = 0;
  let stopReason: "threshold" | "exhausted" = "exhausted";

  for (const row of rows) {
    if (row.referenceXpPerGe + ZERO_TOLERANCE < safeMinXpPerGe) {
      stopReason = "threshold";
      break;
    }

    const recipe = recipes[row.artifact];
    if (!recipe) {
      continue;
    }

    const simulated = simulateCraftModeWithState(
      recipes,
      simulationInventory,
      simulationCraftCounts,
      row.artifact,
      row.mode === "auto"
    );

    simulationInventory = simulated.inventory;
    simulationCraftCounts = simulated.craftCounts;

    const xp = simulated.count * recipe.xp;
    const effectiveXpPerGe = simulated.cost > 0 ? xp / simulated.cost : 0;
    results.push({
      artifact: row.artifact,
      mode: row.mode,
      referenceXpPerGe: row.referenceXpPerGe,
      craftedCount: simulated.count,
      xp,
      cost: simulated.cost,
      effectiveXpPerGe,
    });
    processedRowCount += 1;
    if (simulated.count > 0) {
      craftedRowCount += 1;
    }
    totalXp += xp;
    totalCost += simulated.cost;
  }

  return {
    rows: results,
    totalXp,
    totalCost,
    processedRowCount,
    craftedRowCount,
    stopReason,
    finalInventory: simulationInventory,
    finalCraftCounts: simulationCraftCounts,
  };
}

export function buildMaxXpExecutionPlan(
  solution: Solution,
  inventory: Inventory,
  craftCounts: CraftCounts = {},
  artifactOrder: string[] = []
): MaxXpExecutionPlan {
  const plannedCounts = getPlannedCraftCounts(solution);
  const demandCounts = getIngredientDemandCounts(recipes, plannedCounts);
  const topLevelCounts = getTopLevelCraftCounts(plannedCounts, demandCounts);
  const initialInventory = cloneCountMap(inventory);
  const craftedInventory = {} as Record<string, number>;
  const projectedCraftCounts = cloneCountMap(craftCounts);
  const remainingPlannedCounts = { ...plannedCounts };
  const initialConsumptionBudget = getInitialConsumptionBudget(plannedCounts, demandCounts);
  const orderedTopLevelArtifacts = getOrderedTopLevelArtifacts(topLevelCounts, artifactOrder);
  const steps: MaxXpExecutionPlanNode[] = [];
  let totalTopLevelCrafts = 0;

  for (const artifact of orderedTopLevelArtifacts) {
    const topLevelCount = topLevelCounts[artifact] || 0;
    if (topLevelCount <= 0) {
      continue;
    }

    totalTopLevelCrafts += topLevelCount;
    const step = createExecutionPlanNode(artifact, "click");
    for (let index = 0; index < topLevelCount; index += 1) {
      const node = executePlannedCraft(
        recipes,
        initialInventory,
        craftedInventory,
        projectedCraftCounts,
        remainingPlannedCounts,
        initialConsumptionBudget,
        artifact,
        "click"
      );
      mergeExecutionPlanNode(step, node);
    }
    steps.push(step);
  }

  const remainingArtifacts = Object.entries(remainingPlannedCounts).filter(([, count]) => count > 0);
  if (remainingArtifacts.length > 0) {
    const remainingList = remainingArtifacts
      .map(([artifact, count]) => `${artifact} x${count.toLocaleString()}`)
      .join(", ");
    throw new Error(`Unable to derive a complete Max-XP click order; leftover planned crafts remain: ${remainingList}`);
  }

  return {
    steps,
    totalXp: solution.totalXp,
    totalCost: solution.totalCost,
    totalTopLevelRows: steps.length,
    totalTopLevelCrafts,
    remainingInventory: combineInventories(initialInventory, craftedInventory),
    finalCraftCounts: projectedCraftCounts,
  };
}

function normalizeCount(value: number): number {
  if (Math.abs(value) < ZERO_TOLERANCE) {
    return 0;
  }
  return value < 0 ? 0 : value;
}

function getPlannedCraftCounts(solution: Solution): Record<string, number> {
  const counts = {} as Record<string, number>;
  for (const [artifact, craft] of Object.entries(solution.crafts)) {
    counts[artifact] = Math.max(0, Math.round(craft.count));
  }
  return counts;
}

function getIngredientDemandCounts(recipeMap: Recipes, plannedCounts: Record<string, number>): Record<string, number> {
  const demandCounts = {} as Record<string, number>;
  for (const [artifact, craftCount] of Object.entries(plannedCounts)) {
    if (craftCount <= 0) {
      continue;
    }
    const recipe = recipeMap[artifact];
    if (!recipe) {
      continue;
    }
    for (const [ingredient, rawQuantity] of Object.entries(recipe.ingredients)) {
      const quantity = Math.max(0, Math.round(rawQuantity));
      if (quantity <= 0 || !recipeMap[ingredient]) {
        continue;
      }
      demandCounts[ingredient] = (demandCounts[ingredient] || 0) + craftCount * quantity;
    }
  }
  return demandCounts;
}

function getTopLevelCraftCounts(
  plannedCounts: Record<string, number>,
  demandCounts: Record<string, number>
): Record<string, number> {
  const topLevelCounts = {} as Record<string, number>;
  for (const [artifact, craftCount] of Object.entries(plannedCounts)) {
    const topLevelCount = Math.max(0, craftCount - (demandCounts[artifact] || 0));
    if (topLevelCount > 0) {
      topLevelCounts[artifact] = topLevelCount;
    }
  }
  return topLevelCounts;
}

function getInitialConsumptionBudget(
  plannedCounts: Record<string, number>,
  demandCounts: Record<string, number>
): Record<string, number> {
  const budget = {} as Record<string, number>;
  for (const artifact of Object.keys(demandCounts)) {
    budget[artifact] = Math.max(0, (demandCounts[artifact] || 0) - (plannedCounts[artifact] || 0));
  }
  return budget;
}

function getOrderedTopLevelArtifacts(topLevelCounts: Record<string, number>, artifactOrder: string[]): string[] {
  const preferredIndex = new Map<string, number>();
  artifactOrder.forEach((artifact, index) => {
    preferredIndex.set(artifact, index);
  });

  return Object.keys(topLevelCounts).sort((left, right) => {
    const depthDifference = getRecipeDepth(recipes, right) - getRecipeDepth(recipes, left);
    if (depthDifference !== 0) {
      return depthDifference;
    }

    const leftIndex = preferredIndex.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = preferredIndex.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.localeCompare(right);
  });
}

const recipeDepthCache = new Map<string, number>();

function getRecipeDepth(recipeMap: Recipes, artifact: string): number {
  const cachedDepth = recipeDepthCache.get(artifact);
  if (cachedDepth != null) {
    return cachedDepth;
  }

  const recipe = recipeMap[artifact];
  if (!recipe) {
    recipeDepthCache.set(artifact, 0);
    return 0;
  }

  let depth = 0;
  for (const ingredient of Object.keys(recipe.ingredients)) {
    if (!recipeMap[ingredient]) {
      continue;
    }
    depth = Math.max(depth, 1 + getRecipeDepth(recipeMap, ingredient));
  }
  recipeDepthCache.set(artifact, depth);
  return depth;
}

function createExecutionPlanNode(artifact: string, mode: "click" | "auto"): MaxXpExecutionPlanNode {
  return {
    artifact,
    mode,
    count: 0,
    xp: 0,
    cost: 0,
    children: [],
  };
}

function mergeExecutionPlanNode(target: MaxXpExecutionPlanNode, source: MaxXpExecutionPlanNode): void {
  target.count += source.count;
  target.xp += source.xp;
  target.cost += source.cost;
  for (const child of source.children) {
    const existingChild = target.children.find(
      (candidate) => candidate.artifact === child.artifact && candidate.mode === child.mode
    );
    if (existingChild) {
      mergeExecutionPlanNode(existingChild, child);
      continue;
    }
    target.children.push(child);
  }
}

function executePlannedCraft(
  recipeMap: Recipes,
  initialInventory: Record<string, number>,
  craftedInventory: Record<string, number>,
  craftCounts: Record<string, number>,
  remainingPlannedCounts: Record<string, number>,
  initialConsumptionBudget: Record<string, number>,
  artifact: string,
  mode: "click" | "auto",
  stack: Set<string> = new Set()
): MaxXpExecutionPlanNode {
  const recipe = recipeMap[artifact];
  if (!recipe) {
    throw new Error(`No recipe found while building Max-XP click order for ${artifact}`);
  }

  if ((remainingPlannedCounts[artifact] || 0) <= 0) {
    throw new Error(`Max-XP click order exceeded the planned craft count for ${artifact}`);
  }

  if (stack.has(artifact)) {
    throw new Error(`Cycle detected while building Max-XP click order for ${artifact}`);
  }

  stack.add(artifact);
  try {
    const node = createExecutionPlanNode(artifact, mode);

    for (const [ingredient, rawQuantity] of Object.entries(recipe.ingredients)) {
      const requiredQuantity = Math.max(0, Math.round(rawQuantity));
      for (let index = 0; index < requiredQuantity; index += 1) {
        if (!recipeMap[ingredient]) {
          if ((initialInventory[ingredient] || 0) <= 0) {
            throw new Error(`Max-XP click order ran out of ${ingredient}`);
          }
          initialInventory[ingredient] -= 1;
          continue;
        }

        consumeCraftableIngredient(
          recipeMap,
          initialInventory,
          craftedInventory,
          craftCounts,
          remainingPlannedCounts,
          initialConsumptionBudget,
          ingredient,
          node,
          stack
        );
      }
    }

    const craftCount = craftCounts[artifact] || 0;
    const { discountedCost } = getDiscountedCost(recipe.cost, craftCount);
    craftCounts[artifact] = craftCount + 1;
    remainingPlannedCounts[artifact] = Math.max(0, (remainingPlannedCounts[artifact] || 0) - 1);
    craftedInventory[artifact] = (craftedInventory[artifact] || 0) + 1;
    node.count = 1;
    node.xp = recipe.xp;
    node.cost = discountedCost;
    return node;
  } finally {
    stack.delete(artifact);
  }
}

function consumeCraftableIngredient(
  recipeMap: Recipes,
  initialInventory: Record<string, number>,
  craftedInventory: Record<string, number>,
  craftCounts: Record<string, number>,
  remainingPlannedCounts: Record<string, number>,
  initialConsumptionBudget: Record<string, number>,
  ingredient: string,
  parentNode: MaxXpExecutionPlanNode,
  stack: Set<string>
): void {
  const remainingBudget = initialConsumptionBudget[ingredient] || 0;
  if (remainingBudget > 0 && (initialInventory[ingredient] || 0) > 0) {
    initialInventory[ingredient] -= 1;
    initialConsumptionBudget[ingredient] = remainingBudget - 1;
    return;
  }

  if ((craftedInventory[ingredient] || 0) <= 0) {
    if ((remainingPlannedCounts[ingredient] || 0) <= 0) {
      throw new Error(`Max-XP click order could not supply ${ingredient} from planned crafts or inventory`);
    }
    const childNode = executePlannedCraft(
      recipeMap,
      initialInventory,
      craftedInventory,
      craftCounts,
      remainingPlannedCounts,
      initialConsumptionBudget,
      ingredient,
      "auto",
      stack
    );
    const existingChild = parentNode.children.find(
      (candidate) => candidate.artifact === childNode.artifact && candidate.mode === childNode.mode
    );
    if (existingChild) {
      mergeExecutionPlanNode(existingChild, childNode);
    } else {
      parentNode.children.push(childNode);
    }
  }

  if ((craftedInventory[ingredient] || 0) <= 0) {
    throw new Error(`Max-XP click order failed to consume crafted ${ingredient}`);
  }
  craftedInventory[ingredient] -= 1;
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

function simulateCraftModeWithState(
  recipeMap: Recipes,
  inventory: Record<string, number>,
  craftCounts: Record<string, number>,
  artifact: string,
  allowAutocraft: boolean
): {
  count: number;
  cost: number;
  inventory: Record<string, number>;
  craftCounts: Record<string, number>;
} {
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
    inventory: simulationInventory,
    craftCounts: simulationCraftCounts,
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

function combineInventories(
  left: Record<string, number>,
  right: Record<string, number>
): Record<string, number> {
  const combined = cloneCountMap(left);
  for (const [key, value] of Object.entries(right)) {
    const quantity = Math.max(0, Math.round(value || 0));
    if (quantity <= 0) {
      continue;
    }
    combined[key] = (combined[key] || 0) + quantity;
  }
  return combined;
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
