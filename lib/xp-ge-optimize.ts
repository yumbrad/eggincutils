import { recipes, Recipes } from "./recipes";

export type Inventory = Record<string, number>;
export type CraftCounts = Record<string, number>;

export interface Highs {
  solve: (problem: string, options?: Record<string, string | number | boolean>) => {
    Status?: string;
    Columns: Record<string, { Primal: number }>;
  };
}

/** What a plan must do on top of maximizing XP (the XP planner's goals). */
export interface CraftRequirements {
  /** Copies of each item the plan must end with: the item's balance row keeps them back. */
  keepCopies?: Record<string, number>;
  /** Least crafts of each artifact (craft-count goals): a lower bound on its craft count. */
  minCrafts?: Record<string, number>;
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
  saleApplied: boolean;
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
  /** Set when the requirements (with the craft limits) can't all be met: nothing is planned. */
  infeasible?: boolean;
}

export type CraftLimits = Record<string, number>;

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

export interface MaxXpUsageSummary {
  artifact: string;
  startingInventory: number;
  inventoryConsumed: number;
  manualCrafts: number;
  autoCrafts: number;
  consumedBy: Record<string, number>;
  remaining: number;
}

export interface MaxXpExecutionPlan {
  steps: MaxXpExecutionPlanNode[];
  totalXp: number;
  totalCost: number;
  totalTopLevelRows: number;
  totalTopLevelCrafts: number;
  remainingInventory: Inventory;
  finalCraftCounts: CraftCounts;
  usage: Record<string, MaxXpUsageSummary>;
}

const MAX_CRAFT_COUNT_FOR_DISCOUNT = 300;
const MAX_DISCOUNT_FACTOR = 0.9;
const DISCOUNT_CURVE_EXPONENT = 0.2;
const CRAFTING_SALE_FACTOR = 0.7;
const ZERO_TOLERANCE = 1e-9;
const HIGHS_SOLVE_OPTIONS = {
  presolve: "on",
};

export function optimizeCrafts(
  highs: Highs,
  inventory: Inventory,
  craftCounts: CraftCounts = {},
  saleEnabled: boolean = false,
  craftLimits: CraftLimits = {},
  requirements: CraftRequirements = {}
): Solution {
  const problem = getProblem(inventory, craftLimits, requirements);
  const solution = highs.solve(problem, HIGHS_SOLVE_OPTIONS);

  const result: Solution = {
    crafts: {},
    totalXp: 0,
    totalCost: 0,
  };
  if (/infeasible/i.test(solution.Status || "")) {
    result.infeasible = true;
    return result;
  }

  for (const artifact of Object.keys(solution.Columns || {})) {
    if (!recipes[artifact]) {
      continue;
    }
    const count = normalizeCount(solution.Columns[artifact].Primal);
    const xpPerCraft = recipes[artifact]!.xp;
    const xp = count * xpPerCraft;
    const costDetails = getCostDetails(recipes, craftCounts, artifact, count, saleEnabled);
    const cost = costDetails.totalDirectCost;
    const xpPerGe = cost > 0 ? xp / cost : 0;
    const modeComparison = getCraftModeComparison(recipes, inventory, craftCounts, artifact, saleEnabled);

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
  minXpPerGe: number,
  saleEnabled: boolean = false
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
      row.mode === "auto",
      saleEnabled
    );

    simulationInventory = simulated.inventory;
    simulationCraftCounts = simulated.craftCounts;

    const xp = simulated.xp;
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

export interface GoalCraftStep {
  artifact: string;
  /** Copies goals: copies to have at the end (set aside from inventory). Craft-count goals: crafts to make. */
  amount: number;
  craftGoal: boolean;
}

export interface GoalCraftSimulation {
  /** Inventory left for the rest of the plan (copies goals' copies set aside). */
  inventory: Inventory;
  craftCounts: CraftCounts;
  /** Copies set aside for copies goals. */
  setAside: Inventory;
  /** Every craft the goals made, auto-crafted ingredients included. */
  crafts: Record<string, number>;
  xp: number;
  cost: number;
}

/**
 * Craft goals in order before anything else (the Max GE Efficiency Plan does
 * this first): a copies goal keeps owned copies and crafts the rest, auto-
 * crafting missing ingredients from inventory first; a craft-count goal crafts
 * its count the same way and leaves the copies in inventory. Every craft earns
 * its XP. A goal stops early if inventory runs out.
 */
export function simulateGoalCrafts(
  inventory: Inventory,
  craftCounts: CraftCounts,
  steps: GoalCraftStep[],
  saleEnabled: boolean = false
): GoalCraftSimulation {
  let simulationInventory = cloneCountMap(inventory);
  let simulationCraftCounts = cloneCountMap(craftCounts);
  // Keep fractional expected drops (pre-plan sends) that cloneCountMap rounds.
  for (const [itemKey, quantity] of Object.entries(inventory)) {
    simulationInventory[itemKey] = Math.max(0, Number(quantity) || 0);
  }
  const setAside: Inventory = {};
  let cost = 0;
  const craftOneInto = (artifact: string): boolean => {
    const attemptInventory = { ...simulationInventory };
    const attemptCraftCounts = { ...simulationCraftCounts };
    let attemptCost = 0;
    const didCraft = craftOne(recipes, attemptInventory, attemptCraftCounts, artifact, true, saleEnabled, (craftCost) => {
      attemptCost += craftCost;
    });
    if (didCraft) {
      simulationInventory = attemptInventory;
      simulationCraftCounts = attemptCraftCounts;
      cost += attemptCost;
    }
    return didCraft;
  };

  for (const step of steps) {
    const amount = Math.max(0, Math.round(step.amount));
    if (amount <= 0 || !(step.artifact in recipes)) {
      continue;
    }
    if (step.craftGoal) {
      for (let index = 0; index < amount && craftOneInto(step.artifact); index += 1) {
        // Craft-count goal: the copies stay in inventory.
      }
      continue;
    }
    const owned = Math.min(Math.floor(simulationInventory[step.artifact] || 0), amount);
    let kept = owned;
    simulationInventory[step.artifact] = (simulationInventory[step.artifact] || 0) - owned;
    while (kept < amount && craftOneInto(step.artifact)) {
      simulationInventory[step.artifact] -= 1;
      kept += 1;
    }
    setAside[step.artifact] = (setAside[step.artifact] || 0) + kept;
  }

  const crafts: Record<string, number> = {};
  let xp = 0;
  for (const [artifact, count] of Object.entries(simulationCraftCounts)) {
    const made = count - Math.max(0, Math.round(craftCounts[artifact] || 0));
    if (made > 0) {
      crafts[artifact] = made;
      xp += made * (recipes[artifact]?.xp || 0);
    }
  }
  return { inventory: simulationInventory, craftCounts: simulationCraftCounts, setAside, crafts, xp, cost };
}

/**
 * The solution with its standalone comparisons (direct / auto-craft counts per
 * artifact) read from another inventory: what is left once goals are crafted.
 */
export function withStandaloneComparisons(
  solution: Solution,
  inventory: Inventory,
  craftCounts: CraftCounts = {},
  saleEnabled: boolean = false
): Solution {
  const crafts: Record<string, SolutionCraftRow> = {};
  for (const [artifact, craft] of Object.entries(solution.crafts)) {
    crafts[artifact] = {
      ...craft,
      modeComparison: getCraftModeComparison(recipes, inventory, craftCounts, artifact, saleEnabled),
    };
  }
  return { ...solution, crafts };
}

export function buildMaxXpExecutionPlan(
  solution: Solution,
  inventory: Inventory,
  craftCounts: CraftCounts = {},
  artifactOrder: string[] = [],
  saleEnabled: boolean = false
): MaxXpExecutionPlan {
  const plannedCounts = getPlannedCraftCounts(solution);
  const initialInventory = cloneCountMap(inventory);
  const projectedCraftCounts = cloneCountMap(craftCounts);
  const remainingPlannedCounts = { ...plannedCounts };
  const usage = createUsageMap(inventory);
  const steps: MaxXpExecutionPlanNode[] = [];
  let totalTopLevelCrafts = 0;

  const appendManualCrafts = (artifact: string, count: number) => {
    const manualCount = Math.max(0, Math.round(count));
    if (manualCount <= 0) {
      return;
    }

    totalTopLevelCrafts += manualCount;
    const step = createExecutionPlanNode(artifact, "click");
    for (let index = 0; index < manualCount; index += 1) {
      const node = executePlannedCraft(
        recipes,
        initialInventory,
        projectedCraftCounts,
        remainingPlannedCounts,
        usage,
        artifact,
        "click",
        saleEnabled
      );
      mergeExecutionPlanNode(step, node);
    }
    if (step.count > 0) {
      steps.push(step);
    }
  };

  while (true) {
    const remainingCounts = Object.fromEntries(
      Object.entries(remainingPlannedCounts).filter(([, count]) => count > 0)
    );
    const remainingDemandCounts = getIngredientDemandCounts(recipes, remainingCounts);
    const remainingTopLevelCounts = getTopLevelCraftCounts(remainingCounts, remainingDemandCounts);
    const orderedRemainingArtifacts = getOrderedTopLevelArtifacts(remainingTopLevelCounts, artifactOrder);
    if (orderedRemainingArtifacts.length === 0) {
      break;
    }

    const artifact = orderedRemainingArtifacts[0];
    appendManualCrafts(artifact, remainingTopLevelCounts[artifact] || 0);
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
    remainingInventory: initialInventory,
    finalCraftCounts: projectedCraftCounts,
    usage: finalizeUsageMap(usage, initialInventory),
  };
}

function createUsageMap(inventory: Inventory): Record<string, MaxXpUsageSummary> {
  const usage: Record<string, MaxXpUsageSummary> = {};
  for (const [artifact, quantity] of Object.entries(inventory)) {
    usage[artifact] = {
      artifact,
      startingInventory: Math.max(0, Math.round(quantity || 0)),
      inventoryConsumed: 0,
      manualCrafts: 0,
      autoCrafts: 0,
      consumedBy: {},
      remaining: Math.max(0, Math.round(quantity || 0)),
    };
  }
  return usage;
}

function ensureUsage(
  usage: Record<string, MaxXpUsageSummary>,
  artifact: string
): MaxXpUsageSummary {
  if (!usage[artifact]) {
    usage[artifact] = {
      artifact,
      startingInventory: 0,
      inventoryConsumed: 0,
      manualCrafts: 0,
      autoCrafts: 0,
      consumedBy: {},
      remaining: 0,
    };
  }
  return usage[artifact];
}

function recordCraft(
  usage: Record<string, MaxXpUsageSummary>,
  artifact: string,
  mode: "click" | "auto"
): void {
  const summary = ensureUsage(usage, artifact);
  if (mode === "click") {
    summary.manualCrafts += 1;
  } else {
    summary.autoCrafts += 1;
  }
}

function recordConsumption(
  usage: Record<string, MaxXpUsageSummary>,
  artifact: string,
  consumer: string,
  fromInventory: boolean
): void {
  const summary = ensureUsage(usage, artifact);
  if (fromInventory) {
    summary.inventoryConsumed += 1;
  }
  summary.consumedBy[consumer] = (summary.consumedBy[consumer] || 0) + 1;
}

function finalizeUsageMap(
  usage: Record<string, MaxXpUsageSummary>,
  remainingInventory: Inventory
): Record<string, MaxXpUsageSummary> {
  for (const artifact of new Set([...Object.keys(usage), ...Object.keys(remainingInventory)])) {
    const summary = ensureUsage(usage, artifact);
    summary.remaining = Math.max(0, Math.round(remainingInventory[artifact] || 0));
  }
  return usage;
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
  inventory: Record<string, number>,
  craftCounts: Record<string, number>,
  remainingPlannedCounts: Record<string, number>,
  usage: Record<string, MaxXpUsageSummary>,
  artifact: string,
  mode: "click" | "auto",
  saleEnabled: boolean,
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
          if ((inventory[ingredient] || 0) <= 0) {
            throw new Error(`Max-XP click order ran out of ${ingredient}`);
          }
          inventory[ingredient] -= 1;
          recordConsumption(usage, ingredient, artifact, true);
          continue;
        }

        consumeCraftableIngredient(
          recipeMap,
          inventory,
          craftCounts,
          remainingPlannedCounts,
          usage,
          ingredient,
          artifact,
          node,
          saleEnabled,
          stack
        );
      }
    }

    const craftCount = craftCounts[artifact] || 0;
    const { discountedCost } = getDiscountedCost(recipe.cost, craftCount, saleEnabled);
    craftCounts[artifact] = craftCount + 1;
    remainingPlannedCounts[artifact] = Math.max(0, (remainingPlannedCounts[artifact] || 0) - 1);
    inventory[artifact] = (inventory[artifact] || 0) + 1;
    recordCraft(usage, artifact, mode);
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
  inventory: Record<string, number>,
  craftCounts: Record<string, number>,
  remainingPlannedCounts: Record<string, number>,
  usage: Record<string, MaxXpUsageSummary>,
  ingredient: string,
  consumer: string,
  parentNode: MaxXpExecutionPlanNode,
  saleEnabled: boolean,
  stack: Set<string>
): void {
  if ((inventory[ingredient] || 0) > 0) {
    inventory[ingredient] -= 1;
    recordConsumption(usage, ingredient, consumer, true);
    return;
  }

  if ((remainingPlannedCounts[ingredient] || 0) <= 0) {
    throw new Error(`Max-XP click order could not supply ${ingredient} from planned crafts or inventory`);
  }
  const childNode = executePlannedCraft(
    recipeMap,
    inventory,
    craftCounts,
    remainingPlannedCounts,
    usage,
    ingredient,
    "auto",
    saleEnabled,
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

  if ((inventory[ingredient] || 0) <= 0) {
    throw new Error(`Max-XP click order failed to consume crafted ${ingredient}`);
  }
  inventory[ingredient] -= 1;
  recordConsumption(usage, ingredient, consumer, false);
}

function getCostDetails(
  recipeMap: Recipes,
  craftCounts: CraftCounts,
  artifact: string,
  plannedCrafts: number,
  saleEnabled: boolean
): CostDetails {
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
      saleApplied: saleEnabled,
    };
  }

  const craftCount = craftCounts[artifact] || 0;
  const { discountedCost, discountPercent } = getDiscountedCost(recipe.cost, craftCount, saleEnabled);
  return {
    baseCost: recipe.cost,
    discountedCost,
    totalDirectCost: getBatchDirectCost(recipe.cost, craftCount, plannedCrafts, saleEnabled),
    craftCount,
    discountPercent,
    recursiveCost: getRecursiveCost(recipeMap, craftCounts, artifact, saleEnabled),
    ingredients: getIngredientCosts(recipeMap, craftCounts, artifact, saleEnabled),
    saleApplied: saleEnabled,
  };
}

function getIngredientCosts(
  recipeMap: Recipes,
  craftCounts: CraftCounts,
  artifact: string,
  saleEnabled: boolean
): IngredientCost[] {
  const recipe = recipeMap[artifact];
  if (!recipe) {
    return [];
  }
  return Object.entries(recipe.ingredients).map(([name, quantity]) => {
    const ingredientRecipe = recipeMap[name];
    const baseCost = ingredientRecipe ? ingredientRecipe.cost : 0;
    const craftCount = craftCounts[name] || 0;
    const { discountedCost, discountPercent } = getDiscountedCost(baseCost, craftCount, saleEnabled);
    return {
      name,
      quantity,
      baseCost,
      discountedCost,
      totalCost: getBatchDirectCost(baseCost, craftCount, quantity, saleEnabled),
      craftCount,
      discountPercent,
    };
  });
}

function getRecursiveCost(recipeMap: Recipes, craftCounts: CraftCounts, artifact: string, saleEnabled: boolean): number {
  const projectedCraftCounts = { ...craftCounts };
  return getRecursiveCraftCost(recipeMap, projectedCraftCounts, artifact, saleEnabled);
}

function getRecursiveCraftCost(
  recipeMap: Recipes,
  projectedCraftCounts: CraftCounts,
  artifact: string,
  saleEnabled: boolean
): number {
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
      totalCost += getRecursiveCraftCost(recipeMap, projectedCraftCounts, ingredient, saleEnabled);
    }
  }

  const craftCount = projectedCraftCounts[artifact] || 0;
  const { discountedCost } = getDiscountedCost(recipe.cost, craftCount, saleEnabled);
  totalCost += discountedCost;
  projectedCraftCounts[artifact] = craftCount + 1;
  return totalCost;
}

function getBatchDirectCost(baseCost: number, craftCount: number, quantity: number, saleEnabled: boolean): number {
  if (baseCost <= 0 || quantity <= 0) {
    return 0;
  }
  const craftTotal = Math.max(0, Math.round(quantity));
  let totalCost = 0;
  for (let index = 0; index < craftTotal; index += 1) {
    totalCost += getDiscountedCost(baseCost, craftCount + index, saleEnabled).discountedCost;
  }
  return totalCost;
}

function getCraftModeComparison(
  recipeMap: Recipes,
  inventory: Inventory,
  craftCounts: CraftCounts,
  artifact: string,
  saleEnabled: boolean
): CraftModeComparison {
  const directResult = simulateCraftMode(recipeMap, inventory, craftCounts, artifact, false, saleEnabled);
  const direct: CraftModeMetrics = {
    count: directResult.count,
    xp: directResult.xp,
    cost: directResult.cost,
    xpPerGe: directResult.cost > 0 ? directResult.xp / directResult.cost : 0,
  };

  const recipe = recipeMap[artifact];
  if (!recipe) {
    return { direct, auto: null };
  }

  const hasCraftableIngredient = Object.keys(recipe.ingredients).some((ingredient) => Boolean(recipeMap[ingredient]));
  if (!hasCraftableIngredient) {
    return { direct, auto: null };
  }

  const autoResult = simulateCraftMode(recipeMap, inventory, craftCounts, artifact, true, saleEnabled);
  // XP of every craft auto mode makes, the auto-crafted ingredients included:
  // their GE is in the cost, so their XP belongs in the XP.
  const auto: CraftModeMetrics = {
    count: autoResult.count,
    xp: autoResult.xp,
    cost: autoResult.cost,
    xpPerGe: autoResult.cost > 0 ? autoResult.xp / autoResult.cost : 0,
  };
  return { direct, auto };
}

function simulateCraftMode(
  recipeMap: Recipes,
  inventory: Inventory,
  craftCounts: CraftCounts,
  artifact: string,
  allowAutocraft: boolean,
  saleEnabled: boolean
): { count: number; cost: number; xp: number } {
  let simulationInventory = cloneCountMap(inventory);
  let simulationCraftCounts = cloneCountMap(craftCounts);
  let totalCost = 0;
  let totalXp = 0;
  let craftedCount = 0;
  while (true) {
    const attemptInventory = cloneCountMap(simulationInventory);
    const attemptCraftCounts = cloneCountMap(simulationCraftCounts);
    let attemptCost = 0;
    let attemptXp = 0;
    const didCraft = craftOne(
      recipeMap,
      attemptInventory,
      attemptCraftCounts,
      artifact,
      allowAutocraft,
      saleEnabled,
      (cost, xp) => {
        attemptCost += cost;
        attemptXp += xp;
      }
    );
    if (!didCraft) {
      break;
    }
    simulationInventory = attemptInventory;
    simulationCraftCounts = attemptCraftCounts;
    totalCost += attemptCost;
    totalXp += attemptXp;
    craftedCount += 1;
  }
  return {
    count: craftedCount,
    cost: totalCost,
    xp: totalXp,
  };
}

function simulateCraftModeWithState(
  recipeMap: Recipes,
  inventory: Record<string, number>,
  craftCounts: Record<string, number>,
  artifact: string,
  allowAutocraft: boolean,
  saleEnabled: boolean
): {
  count: number;
  cost: number;
  /** Every craft's XP, auto-crafted ingredients included. */
  xp: number;
  inventory: Record<string, number>;
  craftCounts: Record<string, number>;
} {
  let simulationInventory = cloneCountMap(inventory);
  let simulationCraftCounts = cloneCountMap(craftCounts);
  let totalCost = 0;
  let totalXp = 0;
  let craftedCount = 0;

  while (true) {
    const attemptInventory = cloneCountMap(simulationInventory);
    const attemptCraftCounts = cloneCountMap(simulationCraftCounts);
    let attemptCost = 0;
    let attemptXp = 0;
    const didCraft = craftOne(
      recipeMap,
      attemptInventory,
      attemptCraftCounts,
      artifact,
      allowAutocraft,
      saleEnabled,
      (cost, xp) => {
        attemptCost += cost;
        attemptXp += xp;
      }
    );
    if (!didCraft) {
      break;
    }
    simulationInventory = attemptInventory;
    simulationCraftCounts = attemptCraftCounts;
    totalCost += attemptCost;
    totalXp += attemptXp;
    craftedCount += 1;
  }

  return {
    count: craftedCount,
    cost: totalCost,
    xp: totalXp,
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
  saleEnabled: boolean,
  /** Called once per craft, auto-crafted ingredients included: each is a real craft with its own GE cost and XP. */
  onCraft: (cost: number, xp: number) => void,
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
      const didCraftIngredient = craftOne(recipeMap, inventory, craftCounts, ingredient, true, saleEnabled, onCraft, stack);
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
  const { discountedCost } = getDiscountedCost(recipe.cost, craftCount, saleEnabled);
  onCraft(discountedCost, recipe.xp);
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

function getDiscountedCost(
  baseCost: number,
  craftCount: number,
  saleEnabled: boolean = false
): { discountedCost: number; discountPercent: number } {
  if (baseCost <= 0) {
    return { discountedCost: 0, discountPercent: 0 };
  }
  const progress = Math.min(1, craftCount / MAX_CRAFT_COUNT_FOR_DISCOUNT);
  const multiplier = 1 - MAX_DISCOUNT_FACTOR * Math.pow(progress, DISCOUNT_CURVE_EXPONENT);
  const discountedCost = applyCraftingSale(Math.floor(baseCost * multiplier), saleEnabled);
  const discountPercent = baseCost > 0 ? 1 - discountedCost / baseCost : 0;
  return { discountedCost, discountPercent };
}

function applyCraftingSale(cost: number, saleEnabled: boolean): number {
  if (!saleEnabled || cost <= 0) {
    return Math.max(0, Math.floor(cost));
  }
  return Math.max(0, Math.floor(cost * CRAFTING_SALE_FACTOR));
}

function getProblem(inventory: Inventory, craftLimits: CraftLimits = {}, requirements: CraftRequirements = {}): string {
  const lines: string[] = [];
  const artifacts = Object.keys(recipes).sort();
  const cappedArtifacts = Object.entries(craftLimits)
    .filter(([artifact, limit]) => Boolean(recipes[artifact]) && Number.isFinite(limit) && limit >= 0)
    .map(([artifact, limit]) => [artifact, Math.max(0, Math.round(limit))] as const);
  const keepCopies = positiveWholeCounts(requirements.keepCopies);
  const minCrafts = positiveWholeCounts(requirements.minCrafts);

  lines.push("Maximize");
  lines.push(`  obj: ${getObjective(recipes, artifacts)}`);

  lines.push("Subject To");
  for (const artifact of artifacts) {
    const constraint = getConstraint(recipes, inventory, artifact, keepCopies[artifact] || 0);
    if (constraint) {
      lines.push(`  c_${artifact}: ${constraint}`);
    }
  }
  for (const [artifact, limit] of cappedArtifacts) {
    lines.push(`  craft_limit_${artifact}: ${artifact} <= ${limit}`);
  }

  lines.push("Bounds");
  for (const artifact of artifacts) {
    lines.push(`  ${artifact} >= ${recipes[artifact] ? minCrafts[artifact] || 0 : 0}`);
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

function positiveWholeCounts(counts: Record<string, number> | undefined): Record<string, number> {
  const whole: Record<string, number> = {};
  for (const [itemKey, count] of Object.entries(counts || {})) {
    const rounded = Math.round(Number(count) || 0);
    if (rounded > 0) {
      whole[itemKey] = rounded;
    }
  }
  return whole;
}

/**
 * The balance row for an item: what parent crafts use, net of what is crafted,
 * can't exceed what is owned. `keep` copies must still be there at the end.
 */
function getConstraint(recipeMap: Recipes, inventory: Inventory, artifact: string, keep = 0): string | null {
  const used = getDemandTerms(recipeMap, artifact);
  const available = inventory[artifact] || 0;
  const limit = keep > 0 ? available - keep : available;
  if (used.length === 0) {
    // Nothing consumes the item, so only crafting it can make up kept copies.
    return keep > 0 && recipeMap[artifact] ? `${artifact} >= ${keep - available}` : null;
  }

  if (recipeMap[artifact]) {
    return `${used.join(" + ")} - ${artifact} <= ${limit}`;
  }
  return `${used.join(" + ")} <= ${limit}`;
}

function getDemandTerms(recipeMap: Recipes, artifact: string): string[] {
  const used: string[] = [];
  for (const parent of Object.keys(recipeMap)) {
    if (recipeMap[parent] && artifact in recipeMap[parent]!.ingredients) {
      used.push(`${recipeMap[parent]!.ingredients[artifact]} ${parent}`);
    }
  }
  return used;
}
