import { loadLootData, LootJson, MissionLevelLootStore, MissionTargetLootStore } from "./loot-data";
import { solveWithHighs } from "./highs";
import { itemIdToKey, itemKeyToDisplayName, itemKeyToId } from "./item-utils";
import { getRecipe, recipes } from "./recipes";
import {
  buildMissionOptions,
  computeShipLevelsFromLaunchCounts,
  DurationType,
  getShipOrder,
  MissionOption,
  ShipLaunchCounts,
  ShipLevelInfo,
  shipLevelsToLaunchCounts,
} from "./ship-data";
import { PlayerProfile } from "./profile";

type MissionAction = {
  key: string;
  optionKey: string;
  missionId: string;
  ship: string;
  durationType: DurationType;
  durationSeconds: number;
  targetAfxId: number;
  yields: Record<string, number>;
};

type PlanMissionRow = {
  missionId: string;
  ship: string;
  durationType: DurationType;
  targetAfxId: number;
  launches: number;
  durationSeconds: number;
  expectedYields: Array<{ itemId: string; quantity: number }>;
};

type PlanCraftRow = {
  itemId: string;
  count: number;
};

type ProgressionLaunchRow = {
  ship: string;
  durationType: DurationType;
  launches: number;
  durationSeconds: number;
  reason: string;
};

type PrepProgressionStep = ProgressionLaunchRow & {
  option: MissionOption;
};

type ProgressionShipRow = {
  ship: string;
  unlocked: boolean;
  level: number;
  maxLevel: number;
  launches: number;
  launchPoints: number;
};

type TargetBreakdown = {
  requested: number;
  fromInventory: number;
  fromCraft: number;
  fromMissionsExpected: number;
  shortfall: number;
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
  targetBreakdown: TargetBreakdown;
  progression: {
    prepHours: number;
    prepLaunches: ProgressionLaunchRow[];
    projectedShipLevels: ProgressionShipRow[];
  };
  notes: string[];
};

export type PlannerOptions = {
  fastMode?: boolean;
  maxSolveMs?: number;
  onProgress?: (event: PlannerProgressEvent) => void;
};

export type PlannerProgressEvent = {
  phase: "init" | "candidates" | "candidate" | "refinement" | "finalize" | "fallback";
  message: string;
  elapsedMs: number;
  completed?: number;
  total?: number;
  etaMs?: number | null;
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
const MAX_CRAFT_COUNT_FOR_DISCOUNT = 300;
const MAX_DISCOUNT_FACTOR = 0.9;
const DISCOUNT_CURVE_EXPONENT = 0.2;
const MISSION_SOLVER_UNMET_PENALTY_FACTOR = 1000;
const SCORE_EPS = 1e-9;
const PROGRESSION_MAX_DEPTH = 2;
const PROGRESSION_BEAM_WIDTH = 6;
const PROGRESSION_MAX_LAUNCHES_PER_ACTION = 600;
const FAST_MODE_MAX_CANDIDATES = 8;
const MIN_MISSION_TIME_OBJECTIVE_WEIGHT = 1e-5;
const REFINEMENT_MAX_PHASES_PER_OPTION = 3;

function getDiscountedCost(baseCost: number, craftCount: number): number {
  const progress = Math.min(1, craftCount / MAX_CRAFT_COUNT_FOR_DISCOUNT);
  const multiplier = 1 - MAX_DISCOUNT_FACTOR * Math.pow(progress, DISCOUNT_CURVE_EXPONENT);
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

function collectCraftUpperBounds(
  itemKey: string,
  quantity: number,
  totals: Record<string, number>,
  depth = 0
): void {
  if (quantity <= 0 || depth > 60) {
    return;
  }
  const recipe = getRecipe(itemKey);
  if (!recipe) {
    return;
  }
  totals[itemKey] = (totals[itemKey] || 0) + quantity;
  for (const [ingredientKey, ingredientQty] of Object.entries(recipe.ingredients)) {
    collectCraftUpperBounds(ingredientKey, quantity * ingredientQty, totals, depth + 1);
  }
}

function estimateCraftUpperBounds(targetKey: string, quantity: number): Record<string, number> {
  const totals: Record<string, number> = {};
  collectCraftUpperBounds(targetKey, Math.max(0, Math.round(quantity)), totals);
  return totals;
}

function getBatchDiscountedCost(baseCost: number, initialCraftCount: number, craftsToAdd: number): number {
  const safeCount = Math.max(0, Math.round(craftsToAdd));
  if (safeCount <= 0 || baseCost <= 0) {
    return 0;
  }
  const start = Math.max(0, initialCraftCount);
  const varyingCount = Math.max(0, Math.min(safeCount, MAX_CRAFT_COUNT_FOR_DISCOUNT - start));
  let total = 0;
  for (let index = 0; index < varyingCount; index += 1) {
    total += getDiscountedCost(baseCost, start + index);
  }
  const tailCount = safeCount - varyingCount;
  if (tailCount > 0) {
    total += tailCount * getDiscountedCost(baseCost, start + varyingCount);
  }
  return total;
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

function missionOptionKey(option: MissionOption): string {
  return [
    option.ship,
    option.missionId,
    option.durationType,
    String(option.level),
    String(option.durationSeconds),
    String(option.capacity),
  ].join("|");
}

function yieldsFromTarget(
  target: MissionTargetLootStore,
  items: Set<string>,
  capacity: number
): Record<string, number> {
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

async function buildMissionActionsForOptions(
  missionOptions: MissionOption[],
  relevantItems: Set<string>,
  lootData?: LootJson
): Promise<MissionAction[]> {
  const loot = lootData || (await loadLootData());
  const byMissionId = new Map(loot.missions.map((mission) => [mission.missionId, mission]));

  const actions: MissionAction[] = [];

  for (const option of missionOptions) {
    const optionKey = missionOptionKey(option);
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
        key: `${optionKey}|${target.targetAfxId}`,
        optionKey,
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

async function buildMissionActions(
  profile: PlayerProfile,
  relevantItems: Set<string>
): Promise<MissionAction[]> {
  return buildMissionActionsForOptions(profile.missionOptions, relevantItems);
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

function computeObjectiveReferences(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  actions: MissionAction[];
}): { geRef: number; timeRef: number } {
  const { profile, targetKey, quantity, actions } = options;
  const quantityInt = Math.max(1, Math.round(quantity));
  const craftUpperBounds = estimateCraftUpperBounds(targetKey, quantityInt);

  let geUpperBound = 0;
  for (const [itemKey, craftCount] of Object.entries(craftUpperBounds)) {
    const recipe = getRecipe(itemKey);
    if (!recipe) {
      continue;
    }
    geUpperBound += getBatchDiscountedCost(
      recipe.cost,
      Math.max(0, profile.craftCounts[itemKey] || 0),
      Math.max(0, Math.ceil(craftCount))
    );
  }
  const geRef = Math.max(1, geUpperBound, getRecipe(targetKey)?.cost || 1);

  const targetTimePerUnit = bestTimePerUnit(targetKey, actions);
  let timeRef = Number.isFinite(targetTimePerUnit) ? targetTimePerUnit * quantityInt : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(timeRef)) {
    const fastestActionDuration = actions.length > 0 ? Math.min(...actions.map((action) => action.durationSeconds)) : 3600;
    timeRef = fastestActionDuration / 3;
  }
  return {
    geRef,
    timeRef: Math.max(1, timeRef),
  };
}

type MissionAllocation = {
  missionCounts: Record<string, number>;
  totalSlotSeconds: number;
  remainingDemand: Record<string, number>;
  notes: string[];
};

type RequiredMissionLaunchConstraint = {
  launches: number;
  exact: boolean;
};

function formatLpNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`invalid LP coefficient: ${value}`);
  }
  const normalized = Math.abs(value) < SCORE_EPS ? 0 : value;
  if (Number.isInteger(normalized)) {
    return String(normalized);
  }
  return normalized.toFixed(9).replace(/\.?0+$/, "");
}

function applyMissionCountsToDemand(
  demand: Record<string, number>,
  actions: MissionAction[],
  missionCounts: Record<string, number>
): Record<string, number> {
  const remaining: Record<string, number> = { ...demand };
  const byActionKey = new Map(actions.map((action) => [action.key, action]));

  for (const [actionKey, launchesRaw] of Object.entries(missionCounts)) {
    const launches = Math.max(0, Math.round(launchesRaw));
    if (launches <= 0) {
      continue;
    }
    const action = byActionKey.get(actionKey);
    if (!action) {
      continue;
    }
    for (const [itemKey, yieldPerMission] of Object.entries(action.yields)) {
      if (!remaining[itemKey] || yieldPerMission <= 0) {
        continue;
      }
      remaining[itemKey] = Math.max(0, remaining[itemKey] - yieldPerMission * launches);
    }
  }

  return remaining;
}

function allocateMissionsGreedy(
  actions: MissionAction[],
  initialDemand: Record<string, number>
): MissionAllocation {
  const remainingDemand: Record<string, number> = { ...initialDemand };
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

  return {
    missionCounts,
    totalSlotSeconds,
    remainingDemand,
    notes: ["Mission allocation fell back to greedy selection."],
  };
}

async function allocateMissionsWithSolver(
  actions: MissionAction[],
  initialDemand: Record<string, number>
): Promise<MissionAllocation> {
  const demandEntries = Object.entries(initialDemand).filter(([, qty]) => qty > SCORE_EPS);
  if (demandEntries.length === 0 || actions.length === 0) {
    return {
      missionCounts: {},
      totalSlotSeconds: 0,
      remainingDemand: { ...initialDemand },
      notes: [],
    };
  }

  const missionVars = actions.map((_, index) => `m_${index}`);
  const unmetVars = demandEntries.map((_, index) => `u_${index}`);
  const maxMissionDuration = Math.max(...actions.map((action) => action.durationSeconds));
  const unmetPenalty = Math.max(1_000_000, maxMissionDuration * MISSION_SOLVER_UNMET_PENALTY_FACTOR);

  const lines: string[] = [];
  lines.push("Minimize");
  const objectiveTerms = [
    ...missionVars.map(
      (variable, index) => `${formatLpNumber(actions[index].durationSeconds)} ${variable}`
    ),
    ...unmetVars.map((variable) => `${formatLpNumber(unmetPenalty)} ${variable}`),
  ];
  lines.push(`  obj: ${objectiveTerms.join(" + ")}`);

  lines.push("Subject To");
  for (let demandIndex = 0; demandIndex < demandEntries.length; demandIndex += 1) {
    const [itemKey, demandQty] = demandEntries[demandIndex];
    const lhsTerms: string[] = [];
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const yieldPerMission = actions[actionIndex].yields[itemKey] || 0;
      if (yieldPerMission <= SCORE_EPS) {
        continue;
      }
      lhsTerms.push(`${formatLpNumber(yieldPerMission)} ${missionVars[actionIndex]}`);
    }
    lhsTerms.push(unmetVars[demandIndex]);
    lines.push(`  d_${demandIndex}: ${lhsTerms.join(" + ")} >= ${formatLpNumber(demandQty)}`);
  }

  lines.push("Bounds");
  for (const variable of missionVars) {
    lines.push(`  ${variable} >= 0`);
  }
  for (const variable of unmetVars) {
    lines.push(`  ${variable} >= 0`);
  }

  lines.push("General");
  const chunkSize = 24;
  for (let index = 0; index < missionVars.length; index += chunkSize) {
    lines.push(`  ${missionVars.slice(index, index + chunkSize).join(" ")}`);
  }
  lines.push("End");

  try {
    const solution = await solveWithHighs(lines.join("\n"));
    const status = solution.Status || "Unknown";
    if (status !== "Optimal") {
      const greedy = allocateMissionsGreedy(actions, initialDemand);
      return {
        ...greedy,
        notes: [`HiGHS mission allocation returned status '${status}'; using greedy fallback.`, ...greedy.notes],
      };
    }

    const missionCounts: Record<string, number> = {};
    let totalSlotSeconds = 0;
    let hadFractionalLaunches = false;

    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const rawLaunches = solution.Columns?.[missionVars[actionIndex]]?.Primal || 0;
      const launches = Math.max(0, Math.round(rawLaunches));
      if (Math.abs(rawLaunches - launches) > 1e-6) {
        hadFractionalLaunches = true;
      }
      if (launches <= 0) {
        continue;
      }
      const action = actions[actionIndex];
      missionCounts[action.key] = launches;
      totalSlotSeconds += launches * action.durationSeconds;
    }

    const remainingDemand = applyMissionCountsToDemand(initialDemand, actions, missionCounts);
    const notes = ["Mission allocation solved with HiGHS MILP."];
    if (hadFractionalLaunches) {
      notes.push("Solver produced fractional launch values; rounded to nearest integer launches.");
    }

    return {
      missionCounts,
      totalSlotSeconds,
      remainingDemand,
      notes,
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    const greedy = allocateMissionsGreedy(actions, initialDemand);
    return {
      ...greedy,
      notes: [`HiGHS mission allocation unavailable (${details}); using greedy fallback.`, ...greedy.notes],
    };
  }
}

type UnifiedPlan = {
  crafts: Record<string, number>;
  missionCounts: Record<string, number>;
  remainingDemand: Record<string, number>;
  geCost: number;
  totalSlotSeconds: number;
  notes: string[];
};

function formatLinearExpression(terms: Array<{ coefficient: number; variable: string }>): string {
  const filtered = terms.filter((term) => Math.abs(term.coefficient) > SCORE_EPS);
  if (filtered.length === 0) {
    return "0";
  }

  let expression = "";
  for (let index = 0; index < filtered.length; index += 1) {
    const term = filtered[index];
    const absCoeff = Math.abs(term.coefficient);
    const coeffText = formatLpNumber(absCoeff);
    if (index === 0) {
      expression += term.coefficient < 0 ? `- ${coeffText} ${term.variable}` : `${coeffText} ${term.variable}`;
      continue;
    }
    expression += term.coefficient < 0 ? ` - ${coeffText} ${term.variable}` : ` + ${coeffText} ${term.variable}`;
  }
  return expression;
}

async function solveUnifiedCraftMissionPlan(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  priorityTime: number;
  closure: Set<string>;
  actions: MissionAction[];
  geRef: number;
  timeRef: number;
  requiredMissionLaunches?: Record<string, RequiredMissionLaunchConstraint>;
  maxMissionLaunchesByOption?: Record<string, number>;
  optionLaunchPrecedenceChains?: string[][];
}): Promise<UnifiedPlan> {
  const {
    profile,
    targetKey,
    quantity,
    priorityTime,
    closure,
    actions,
    geRef,
    timeRef,
    requiredMissionLaunches = {},
    maxMissionLaunchesByOption = {},
    optionLaunchPrecedenceChains = [],
  } = options;
  const itemKeys = Array.from(closure).sort();
  const missionVars = actions.map((_, index) => `m_${index}`);
  const unmetVarByItem = new Map<string, string>();
  for (let index = 0; index < itemKeys.length; index += 1) {
    unmetVarByItem.set(itemKeys[index], `u_${index}`);
  }

  type CraftCostModel = {
    itemKey: string;
    craftVar: string;
    craftBound: number;
    baseCost: number;
    initialCraftCount: number;
    preDiscountUnitVars: string[];
    preDiscountUnitCosts: number[];
    tailVar: string | null;
    tailCap: number;
  };

  const craftUpperBounds = estimateCraftUpperBounds(targetKey, quantity);
  const craftModels: CraftCostModel[] = [];
  const craftModelByItem = new Map<string, CraftCostModel>();

  let craftVarCounter = 0;
  let craftUnitCounter = 0;
  let craftTailCounter = 0;
  for (const itemKey of itemKeys) {
    const recipe = getRecipe(itemKey);
    if (!recipe) {
      continue;
    }
    const craftBound = Math.max(0, Math.ceil(craftUpperBounds[itemKey] || 0));
    if (craftBound <= 0) {
      continue;
    }
    const initialCraftCount = Math.max(0, profile.craftCounts[itemKey] || 0);
    const preDiscountSlots = Math.max(
      0,
      Math.min(craftBound, MAX_CRAFT_COUNT_FOR_DISCOUNT - initialCraftCount)
    );
    const preDiscountUnitVars: string[] = [];
    const preDiscountUnitCosts: number[] = [];
    for (let slot = 0; slot < preDiscountSlots; slot += 1) {
      preDiscountUnitVars.push(`cy_${craftUnitCounter}`);
      preDiscountUnitCosts.push(getDiscountedCost(recipe.cost, initialCraftCount + slot));
      craftUnitCounter += 1;
    }
    const tailCap = Math.max(0, craftBound - preDiscountSlots);
    const tailVar = tailCap > 0 ? `ct_${craftTailCounter++}` : null;

    const model: CraftCostModel = {
      itemKey,
      craftVar: `c_${craftVarCounter++}`,
      craftBound,
      baseCost: recipe.cost,
      initialCraftCount,
      preDiscountUnitVars,
      preDiscountUnitCosts,
      tailVar,
      tailCap,
    };
    craftModels.push(model);
    craftModelByItem.set(itemKey, model);
  }

  const demandByItem = new Map<string, number>(itemKeys.map((itemKey) => [itemKey, itemKey === targetKey ? quantity : 0]));
  const normalizedGeRef = Math.max(1, geRef);
  const normalizedTimeRef = Math.max(1, timeRef);

  const lines: string[] = [];
  lines.push("Minimize");
  const objectiveTerms: Array<{ coefficient: number; variable: string }> = [];
  let maxObjectiveCoeff = 1;

  for (const model of craftModels) {
    for (let index = 0; index < model.preDiscountUnitVars.length; index += 1) {
      const coefficient = ((1 - priorityTime) * model.preDiscountUnitCosts[index]) / normalizedGeRef;
      objectiveTerms.push({
        coefficient,
        variable: model.preDiscountUnitVars[index],
      });
      maxObjectiveCoeff = Math.max(maxObjectiveCoeff, Math.abs(coefficient));
    }
    if (model.tailVar && model.tailCap > 0) {
      const tailCost = getDiscountedCost(
        model.baseCost,
        model.initialCraftCount + model.preDiscountUnitVars.length
      );
      const coefficient = ((1 - priorityTime) * tailCost) / normalizedGeRef;
      objectiveTerms.push({
        coefficient,
        variable: model.tailVar,
      });
      maxObjectiveCoeff = Math.max(maxObjectiveCoeff, Math.abs(coefficient));
    }
  }

  const missionObjectiveWeight = Math.max(priorityTime, MIN_MISSION_TIME_OBJECTIVE_WEIGHT);
  for (let index = 0; index < actions.length; index += 1) {
    const coefficient = (missionObjectiveWeight * (actions[index].durationSeconds / 3)) / normalizedTimeRef;
    objectiveTerms.push({
      coefficient,
      variable: missionVars[index],
    });
    maxObjectiveCoeff = Math.max(maxObjectiveCoeff, Math.abs(coefficient));
  }

  const unmetPenaltyCoeff = maxObjectiveCoeff * 1_000_000;
  for (const itemKey of itemKeys) {
    objectiveTerms.push({
      coefficient: unmetPenaltyCoeff,
      variable: unmetVarByItem.get(itemKey)!,
    });
  }
  lines.push(`  obj: ${formatLinearExpression(objectiveTerms)}`);

  lines.push("Subject To");
  for (let itemIndex = 0; itemIndex < itemKeys.length; itemIndex += 1) {
    const itemKey = itemKeys[itemIndex];
    const inventoryQty = Math.max(0, profile.inventory[itemKey] || 0);
    const demandQty = demandByItem.get(itemKey) || 0;
    const terms: Array<{ coefficient: number; variable: string }> = [];

    const outputModel = craftModelByItem.get(itemKey);
    if (outputModel) {
      terms.push({ coefficient: 1, variable: outputModel.craftVar });
    }
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const yieldPerMission = actions[actionIndex].yields[itemKey] || 0;
      if (yieldPerMission > SCORE_EPS) {
        terms.push({ coefficient: yieldPerMission, variable: missionVars[actionIndex] });
      }
    }
    terms.push({ coefficient: 1, variable: unmetVarByItem.get(itemKey)! });

    for (const craftModel of craftModels) {
      const recipe = getRecipe(craftModel.itemKey);
      const ingredientQty = recipe?.ingredients[itemKey] || 0;
      if (ingredientQty > 0) {
        terms.push({ coefficient: -ingredientQty, variable: craftModel.craftVar });
      }
    }

    const rhs = demandQty - inventoryQty;
    lines.push(`  b_${itemIndex}: ${formatLinearExpression(terms)} >= ${formatLpNumber(rhs)}`);
  }

  const actionIndexesByOption = new Map<string, number[]>();
  for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
    const optionKey = actions[actionIndex].optionKey;
    const existing = actionIndexesByOption.get(optionKey) || [];
    existing.push(actionIndex);
    actionIndexesByOption.set(optionKey, existing);
  }
  let requiredConstraintIndex = 0;
  for (const [optionKey, requirement] of Object.entries(requiredMissionLaunches)) {
    const safeLaunches = Math.max(0, Math.round(requirement.launches));
    if (safeLaunches <= 0) {
      continue;
    }
    const actionIndexes = actionIndexesByOption.get(optionKey) || [];
    if (actionIndexes.length === 0) {
      throw new Error(`required prep mission option has no compatible actions: ${optionKey}`);
    }
    const lhs = actionIndexes.map((index) => missionVars[index]).join(" + ");
    const operator = requirement.exact ? "=" : ">=";
    lines.push(`  r_${requiredConstraintIndex}: ${lhs} ${operator} ${formatLpNumber(safeLaunches)}`);
    requiredConstraintIndex += 1;
  }

  let optionMaxConstraintIndex = 0;
  for (const [optionKey, launchCapRaw] of Object.entries(maxMissionLaunchesByOption)) {
    const launchCap = Math.max(0, Math.round(launchCapRaw));
    if (launchCap <= 0) {
      continue;
    }
    const actionIndexes = actionIndexesByOption.get(optionKey) || [];
    if (actionIndexes.length === 0) {
      continue;
    }
    const lhs = actionIndexes.map((index) => missionVars[index]).join(" + ");
    lines.push(`  mx_${optionMaxConstraintIndex}: ${lhs} <= ${formatLpNumber(launchCap)}`);
    optionMaxConstraintIndex += 1;
  }

  let precedenceConstraintIndex = 0;
  for (const chain of optionLaunchPrecedenceChains) {
    if (chain.length <= 1) {
      continue;
    }
    for (let phaseIndex = 1; phaseIndex < chain.length; phaseIndex += 1) {
      const currentOptionKey = chain[phaseIndex];
      const previousOptionKey = chain[phaseIndex - 1];
      const currentIndexes = actionIndexesByOption.get(currentOptionKey) || [];
      if (currentIndexes.length === 0) {
        continue;
      }
      const previousIndexes = actionIndexesByOption.get(previousOptionKey) || [];
      const terms: Array<{ coefficient: number; variable: string }> = [];
      for (const index of currentIndexes) {
        terms.push({ coefficient: 1, variable: missionVars[index] });
      }
      for (const index of previousIndexes) {
        terms.push({ coefficient: -1, variable: missionVars[index] });
      }
      lines.push(`  pc_${precedenceConstraintIndex}: ${formatLinearExpression(terms)} <= 0`);
      precedenceConstraintIndex += 1;
    }
  }

  for (let modelIndex = 0; modelIndex < craftModels.length; modelIndex += 1) {
    const model = craftModels[modelIndex];
    const relationTerms: Array<{ coefficient: number; variable: string }> = [
      { coefficient: 1, variable: model.craftVar },
      ...model.preDiscountUnitVars.map((variable) => ({ coefficient: -1, variable })),
    ];
    if (model.tailVar) {
      relationTerms.push({ coefficient: -1, variable: model.tailVar });
    }
    lines.push(`  cl_${modelIndex}: ${formatLinearExpression(relationTerms)} = 0`);

    for (let unitIndex = 0; unitIndex + 1 < model.preDiscountUnitVars.length; unitIndex += 1) {
      lines.push(
        `  cm_${modelIndex}_${unitIndex}: ${model.preDiscountUnitVars[unitIndex]} - ${model.preDiscountUnitVars[unitIndex + 1]} >= 0`
      );
    }
    if (model.tailVar && model.preDiscountUnitVars.length > 0) {
      const lastUnitVar = model.preDiscountUnitVars[model.preDiscountUnitVars.length - 1];
      lines.push(`  ctg_${modelIndex}: ${model.tailVar} - ${formatLpNumber(model.tailCap)} ${lastUnitVar} <= 0`);
    }
  }

  lines.push("Bounds");
  for (const model of craftModels) {
    lines.push(`  0 <= ${model.craftVar} <= ${formatLpNumber(model.craftBound)}`);
    for (const unitVar of model.preDiscountUnitVars) {
      lines.push(`  0 <= ${unitVar} <= 1`);
    }
    if (model.tailVar) {
      lines.push(`  0 <= ${model.tailVar} <= ${formatLpNumber(model.tailCap)}`);
    }
  }
  for (const variable of missionVars) {
    lines.push(`  ${variable} >= 0`);
  }
  for (const variable of unmetVarByItem.values()) {
    lines.push(`  ${variable} >= 0`);
  }

  const integerVars = [
    ...craftModels.map((model) => model.craftVar),
    ...craftModels.flatMap((model) => (model.tailVar ? [model.tailVar] : [])),
    ...missionVars,
  ];
  if (integerVars.length > 0) {
    lines.push("General");
    const chunkSize = 24;
    for (let index = 0; index < integerVars.length; index += chunkSize) {
      lines.push(`  ${integerVars.slice(index, index + chunkSize).join(" ")}`);
    }
  }
  const binaryVars = craftModels.flatMap((model) => model.preDiscountUnitVars);
  if (binaryVars.length > 0) {
    lines.push("Binary");
    const chunkSize = 24;
    for (let index = 0; index < binaryVars.length; index += chunkSize) {
      lines.push(`  ${binaryVars.slice(index, index + chunkSize).join(" ")}`);
    }
  }
  lines.push("End");

  const solution = await solveWithHighs(lines.join("\n"));
  const status = solution.Status || "Unknown";
  if (status !== "Optimal") {
    throw new Error(`unified HiGHS solve status '${status}'`);
  }

  const crafts: Record<string, number> = {};
  for (const model of craftModels) {
    const rawValue = solution.Columns?.[model.craftVar]?.Primal || 0;
    const rounded = Math.max(0, Math.round(rawValue));
    if (rounded > 0) {
      crafts[model.itemKey] = rounded;
    }
  }

  const missionCounts: Record<string, number> = {};
  for (let index = 0; index < actions.length; index += 1) {
    const rawValue = solution.Columns?.[missionVars[index]]?.Primal || 0;
    const rounded = Math.max(0, Math.round(rawValue));
    if (rounded > 0) {
      missionCounts[actions[index].key] = rounded;
    }
  }

  const remainingDemand: Record<string, number> = {};
  for (const itemKey of itemKeys) {
    const rawValue = solution.Columns?.[unmetVarByItem.get(itemKey)!]?.Primal || 0;
    remainingDemand[itemKey] = Math.max(0, rawValue);
  }

  const geCost = craftModels.reduce((sum, model) => {
    const craftedCount = crafts[model.itemKey] || 0;
    return sum + getBatchDiscountedCost(model.baseCost, model.initialCraftCount, craftedCount);
  }, 0);
  const totalSlotSeconds = actions.reduce((sum, action) => {
    const launches = missionCounts[action.key] || 0;
    return sum + launches * action.durationSeconds;
  }, 0);

  return {
    crafts,
    missionCounts,
    remainingDemand,
    geCost,
    totalSlotSeconds,
    notes: ["Craft + mission allocation solved with unified HiGHS model (exact craft discount scheduling)."],
  };
}

type ProgressionState = {
  launchCounts: ShipLaunchCounts;
  shipLevels: ShipLevelInfo[];
  missionOptions: MissionOption[];
  prepSteps: PrepProgressionStep[];
  prepSlotSeconds: number;
};

type ProgressionAction = {
  nextLaunchCounts: ShipLaunchCounts;
  nextShipLevels: ShipLevelInfo[];
  step: PrepProgressionStep;
};

type ProgressionCandidate = {
  shipLevels: ShipLevelInfo[];
  missionOptions: MissionOption[];
  prepSteps: PrepProgressionStep[];
  prepSlotSeconds: number;
};

function missionOptionsFingerprint(options: MissionOption[]): string {
  return options
    .slice()
    .sort((a, b) => {
      const missionCompare = a.missionId.localeCompare(b.missionId);
      if (missionCompare !== 0) {
        return missionCompare;
      }
      return a.durationType.localeCompare(b.durationType);
    })
    .map((option) => missionOptionKey(option))
    .join("||");
}

function cloneLaunchCounts(launchCounts: ShipLaunchCounts): ShipLaunchCounts {
  const clone: ShipLaunchCounts = {};
  for (const [ship, byDuration] of Object.entries(launchCounts)) {
    clone[ship] = {
      TUTORIAL: Math.max(0, Math.round(byDuration.TUTORIAL || 0)),
      SHORT: Math.max(0, Math.round(byDuration.SHORT || 0)),
      LONG: Math.max(0, Math.round(byDuration.LONG || 0)),
      EPIC: Math.max(0, Math.round(byDuration.EPIC || 0)),
    };
  }
  return clone;
}

function launchCountsFingerprint(launchCounts: ShipLaunchCounts, shipOrder: string[]): string {
  return shipOrder
    .map((ship) => {
      const byDuration = launchCounts[ship];
      if (!byDuration) {
        return `${ship}:0,0,0,0`;
      }
      return `${ship}:${byDuration.TUTORIAL},${byDuration.SHORT},${byDuration.LONG},${byDuration.EPIC}`;
    })
    .join("|");
}

function missionOptionsByShip(options: MissionOption[]): Map<string, MissionOption[]> {
  const grouped = new Map<string, MissionOption[]>();
  for (const option of options) {
    const group = grouped.get(option.ship) || [];
    group.push(option);
    grouped.set(option.ship, group);
  }
  return grouped;
}

function compactProgressionSteps(steps: PrepProgressionStep[]): ProgressionLaunchRow[] {
  const compacted = new Map<string, ProgressionLaunchRow>();
  for (const step of steps) {
    const key = `${step.ship}|${step.durationType}|${step.durationSeconds}|${step.reason}`;
    const existing = compacted.get(key);
    if (existing) {
      existing.launches += step.launches;
      continue;
    }
    compacted.set(key, {
      ship: step.ship,
      durationType: step.durationType,
      launches: step.launches,
      durationSeconds: step.durationSeconds,
      reason: step.reason,
    });
  }
  return Array.from(compacted.values()).sort((a, b) => {
    const timeDiff = a.durationSeconds * a.launches - b.durationSeconds * b.launches;
    if (Math.abs(timeDiff) > SCORE_EPS) {
      return timeDiff;
    }
    return a.ship.localeCompare(b.ship);
  });
}

function progressionShipRows(shipLevels: ShipLevelInfo[]): ProgressionShipRow[] {
  return shipLevels.map((ship) => ({
    ship: ship.ship,
    unlocked: ship.unlocked,
    level: ship.level,
    maxLevel: ship.maxLevel,
    launches: ship.launches,
    launchPoints: ship.launchPoints,
  }));
}

function buildMissionRows(actions: MissionAction[], missionCounts: Record<string, number>): PlanMissionRow[] {
  const actionByKey = new Map(actions.map((action) => [action.key, action]));
  return Object.entries(missionCounts)
    .map(([key, launches]) => {
      const action = actionByKey.get(key);
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
}

function buildCraftRows(crafts: Record<string, number>): PlanCraftRow[] {
  return Object.entries(crafts)
    .map(([itemKey, count]) => ({ itemId: itemKeyToId(itemKey), count }))
    .sort((a, b) => b.count - a.count);
}

function expectedTargetFromMissions(
  targetKey: string,
  actions: MissionAction[],
  missionCounts: Record<string, number>
): number {
  const byKey = new Map(actions.map((action) => [action.key, action]));
  let total = 0;
  for (const [actionKey, launches] of Object.entries(missionCounts)) {
    const action = byKey.get(actionKey);
    if (!action) {
      continue;
    }
    total += (action.yields[targetKey] || 0) * launches;
  }
  return Math.max(0, total);
}

function buildTargetBreakdown(options: {
  quantity: number;
  targetKey: string;
  crafts: Record<string, number>;
  actions: MissionAction[];
  missionCounts: Record<string, number>;
  remainingDemand: Record<string, number>;
}): TargetBreakdown {
  const { quantity, targetKey, crafts, actions, missionCounts, remainingDemand } = options;
  const requested = Math.max(0, quantity);
  const shortfall = Math.max(0, remainingDemand[targetKey] || 0);
  const fulfilled = Math.max(0, requested - shortfall);
  const rawCraft = Math.max(0, crafts[targetKey] || 0);
  const rawMissionExpected = expectedTargetFromMissions(targetKey, actions, missionCounts);

  const fromCraft = Math.min(fulfilled, rawCraft);
  const remainingAfterCraft = Math.max(0, fulfilled - fromCraft);
  const fromMissionsExpected = Math.min(remainingAfterCraft, rawMissionExpected);
  const fromInventory = Math.max(0, fulfilled - fromCraft - fromMissionsExpected);

  return {
    requested,
    fromInventory,
    fromCraft,
    fromMissionsExpected,
    shortfall,
  };
}

type PrepOptionRequirement = {
  option: MissionOption;
  launches: number;
};

function aggregatePrepOptionRequirements(steps: PrepProgressionStep[]): Map<string, PrepOptionRequirement> {
  const requirements = new Map<string, PrepOptionRequirement>();
  for (const step of steps) {
    const key = missionOptionKey(step.option);
    const existing = requirements.get(key);
    if (existing) {
      existing.launches += Math.max(0, Math.round(step.launches));
      continue;
    }
    requirements.set(key, {
      option: step.option,
      launches: Math.max(0, Math.round(step.launches)),
    });
  }
  return requirements;
}

function mergeMissionOptionsByKey(primary: MissionOption[], secondary: MissionOption[]): MissionOption[] {
  const byKey = new Map<string, MissionOption>();
  for (const option of primary) {
    byKey.set(missionOptionKey(option), option);
  }
  for (const option of secondary) {
    const key = missionOptionKey(option);
    if (!byKey.has(key)) {
      byKey.set(key, option);
    }
  }
  return Array.from(byKey.values());
}

function addRequiredLaunchConstraint(
  constraints: Record<string, RequiredMissionLaunchConstraint>,
  optionKey: string,
  launchesRaw: number,
  exact: boolean
): void {
  const launches = Math.max(0, Math.round(launchesRaw));
  if (launches <= 0) {
    return;
  }
  const existing = constraints[optionKey];
  if (!existing) {
    constraints[optionKey] = { launches, exact };
    return;
  }
  if (existing.exact || exact) {
    constraints[optionKey] = { launches: Math.max(existing.launches, launches), exact: true };
    return;
  }
  constraints[optionKey] = { launches: Math.max(existing.launches, launches), exact: false };
}

function aggregateMissionLaunchesByOption(
  actions: MissionAction[],
  missionCounts: Record<string, number>
): Map<string, number> {
  const launchesByOption = new Map<string, number>();
  const actionsByKey = new Map(actions.map((action) => [action.key, action]));
  for (const [actionKey, launchesRaw] of Object.entries(missionCounts)) {
    const launches = Math.max(0, Math.round(launchesRaw));
    if (launches <= 0) {
      continue;
    }
    const action = actionsByKey.get(actionKey);
    if (!action) {
      continue;
    }
    launchesByOption.set(action.optionKey, (launchesByOption.get(action.optionKey) || 0) + launches);
  }
  return launchesByOption;
}

function incrementLaunchCounts(
  launchCounts: ShipLaunchCounts,
  ship: string,
  durationType: DurationType,
  launchesRaw: number
): void {
  const launches = Math.max(0, Math.round(launchesRaw));
  if (launches <= 0) {
    return;
  }
  const byDuration = launchCounts[ship];
  if (!byDuration) {
    return;
  }
  byDuration[durationType] = Math.max(0, Math.round(byDuration[durationType] || 0)) + launches;
}

function projectShipLevelsAfterPlannedLaunches(options: {
  baseShipLevels: ShipLevelInfo[];
  prepSteps: PrepProgressionStep[];
  actions: MissionAction[];
  missionCounts: Record<string, number>;
}): ShipLevelInfo[] {
  const { baseShipLevels, prepSteps, actions, missionCounts } = options;
  const launchCounts = shipLevelsToLaunchCounts(baseShipLevels);

  for (const step of prepSteps) {
    incrementLaunchCounts(launchCounts, step.ship, step.durationType, step.launches);
  }

  const prepRequirements = aggregatePrepOptionRequirements(prepSteps);
  const launchesByOption = aggregateMissionLaunchesByOption(actions, missionCounts);
  const optionShapeByKey = new Map<string, { ship: string; durationType: DurationType }>();
  for (const action of actions) {
    if (!optionShapeByKey.has(action.optionKey)) {
      optionShapeByKey.set(action.optionKey, {
        ship: action.ship,
        durationType: action.durationType,
      });
    }
  }
  for (const [optionKey, requirement] of prepRequirements.entries()) {
    if (!optionShapeByKey.has(optionKey)) {
      optionShapeByKey.set(optionKey, {
        ship: requirement.option.ship,
        durationType: requirement.option.durationType,
      });
    }
  }

  for (const [optionKey, totalLaunches] of launchesByOption.entries()) {
    const prepLaunches = prepRequirements.get(optionKey)?.launches || 0;
    const postPrepLaunches = Math.max(0, totalLaunches - prepLaunches);
    if (postPrepLaunches <= 0) {
      continue;
    }
    const shape = optionShapeByKey.get(optionKey);
    if (!shape) {
      continue;
    }
    incrementLaunchCounts(launchCounts, shape.ship, shape.durationType, postPrepLaunches);
  }

  return computeShipLevelsFromLaunchCounts(launchCounts);
}

function findDominantFinalOptionKey(
  finalOptionKeys: Set<string>,
  launchesByOption: Map<string, number>
): string | null {
  let bestKey: string | null = null;
  let bestLaunches = 0;
  for (const [optionKey, launches] of launchesByOption.entries()) {
    if (!finalOptionKeys.has(optionKey) || launches <= 0) {
      continue;
    }
    if (!bestKey || launches > bestLaunches) {
      bestKey = optionKey;
      bestLaunches = launches;
    }
  }
  return bestKey;
}

function findHighestTierExtendedOption(options: MissionOption[]): MissionOption | null {
  const shipOrder = getShipOrder();
  let best: MissionOption | null = null;
  let bestTier = -1;
  for (const option of options) {
    if (option.durationType !== "EPIC") {
      continue;
    }
    const tierIndex = shipOrder.indexOf(option.ship);
    if (tierIndex < 0) {
      continue;
    }
    if (!best || tierIndex > bestTier) {
      best = option;
      bestTier = tierIndex;
    }
  }
  return best;
}

function launchesUntilShipLevelIncrease(
  launchCounts: ShipLaunchCounts,
  ship: string,
  durationType: DurationType,
  currentLevel: number,
  maxLevel: number
): number {
  if (currentLevel >= maxLevel) {
    return Number.POSITIVE_INFINITY;
  }
  const probeCounts = cloneLaunchCounts(launchCounts);
  for (let launches = 1; launches <= PROGRESSION_MAX_LAUNCHES_PER_ACTION; launches += 1) {
    probeCounts[ship][durationType] += 1;
    const projectedLevels = computeShipLevelsFromLaunchCounts(probeCounts);
    const projectedInfo = projectedLevels.find((entry) => entry.ship === ship);
    if (projectedInfo && projectedInfo.level > currentLevel) {
      return launches;
    }
  }
  return Number.POSITIVE_INFINITY;
}

function buildPhasedOptionPlan(options: {
  profile: PlayerProfile;
  baseLaunchCounts: ShipLaunchCounts;
  ship: string;
  durationType: DurationType;
  budgetLaunches: number;
}): Array<{ option: MissionOption; launches: number }> {
  const { profile, baseLaunchCounts, ship, durationType, budgetLaunches } = options;
  let remaining = Math.max(0, Math.round(budgetLaunches));
  if (remaining <= 0) {
    return [];
  }

  const phases: Array<{ option: MissionOption; launches: number }> = [];
  const workingCounts = cloneLaunchCounts(baseLaunchCounts);
  for (let phaseIndex = 0; phaseIndex < REFINEMENT_MAX_PHASES_PER_OPTION && remaining > 0; phaseIndex += 1) {
    const shipLevels = computeShipLevelsFromLaunchCounts(workingCounts);
    const missionOptions = buildMissionOptions(shipLevels, profile.epicResearchFTLLevel, profile.epicResearchZerogLevel);
    const option = missionOptions.find((entry) => entry.ship === ship && entry.durationType === durationType);
    if (!option) {
      break;
    }
    const shipInfo = shipLevels.find((entry) => entry.ship === ship);
    if (!shipInfo) {
      break;
    }

    const launchesToNextLevel = launchesUntilShipLevelIncrease(
      workingCounts,
      ship,
      durationType,
      shipInfo.level,
      shipInfo.maxLevel
    );
    const cappedLaunches = Number.isFinite(launchesToNextLevel) ? Math.max(1, Math.round(launchesToNextLevel)) : remaining;
    const launches = phaseIndex + 1 >= REFINEMENT_MAX_PHASES_PER_OPTION
      ? remaining
      : Math.min(remaining, cappedLaunches);

    phases.push({ option, launches });
    workingCounts[ship][durationType] += launches;
    remaining -= launches;
  }

  if (remaining > 0 && phases.length > 0) {
    phases[phases.length - 1].launches += remaining;
  }

  return phases;
}

type PhasedYieldRefinementPlan = {
  sourceOptionKey: string;
  mode: "exact" | "cap";
  phases: Array<{ option: MissionOption; launches: number }>;
};

async function runPhasedYieldRefinement(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  priorityTime: number;
  closure: Set<string>;
  candidate: ProgressionCandidate;
  baseActions: MissionAction[];
  baseMissionCounts: Record<string, number>;
  geRef: number;
  timeRef: number;
  lootData: LootJson;
}): Promise<
  | {
      actions: MissionAction[];
      unified: UnifiedPlan;
      totalSlotSeconds: number;
      weightedScore: number;
      prepNoYieldSlotSeconds: number;
      notes: string[];
    }
  | null
> {
  const {
    profile,
    targetKey,
    quantity,
    priorityTime,
    closure,
    candidate,
    baseActions,
    baseMissionCounts,
    geRef,
    timeRef,
    lootData,
  } = options;

  const finalOptionKeys = new Set(candidate.missionOptions.map((option) => missionOptionKey(option)));
  const optionByKey = new Map(candidate.missionOptions.map((option) => [missionOptionKey(option), option]));
  const launchesByOption = aggregateMissionLaunchesByOption(baseActions, baseMissionCounts);

  const dominantOptionKey = findDominantFinalOptionKey(finalOptionKeys, launchesByOption);
  if (!dominantOptionKey) {
    return null;
  }
  const dominantOption = optionByKey.get(dominantOptionKey);
  if (!dominantOption) {
    return null;
  }
  const dominantLaunchBudget = Math.max(0, Math.round(launchesByOption.get(dominantOptionKey) || 0));
  if (dominantLaunchBudget <= 0) {
    return null;
  }

  const highestTierExtended = findHighestTierExtendedOption(candidate.missionOptions);
  const highestTierExtendedKey = highestTierExtended ? missionOptionKey(highestTierExtended) : null;

  const baseLaunchCounts = shipLevelsToLaunchCounts(candidate.shipLevels);
  const plans: PhasedYieldRefinementPlan[] = [];

  const dominantPhases = buildPhasedOptionPlan({
    profile,
    baseLaunchCounts,
    ship: dominantOption.ship,
    durationType: dominantOption.durationType,
    budgetLaunches: dominantLaunchBudget,
  });
  if (dominantPhases.length === 0) {
    return null;
  }
  plans.push({
    sourceOptionKey: dominantOptionKey,
    mode: "exact",
    phases: dominantPhases,
  });

  if (highestTierExtended && highestTierExtendedKey && highestTierExtendedKey !== dominantOptionKey) {
    const baselineHighestBudget = Math.max(0, Math.round(launchesByOption.get(highestTierExtendedKey) || 0));
    let highestBudget = baselineHighestBudget;
    if (highestBudget <= 0) {
      highestBudget = dominantLaunchBudget;
    }
    if (highestBudget > 0) {
      const highestPhases = buildPhasedOptionPlan({
        profile,
        baseLaunchCounts,
        ship: highestTierExtended.ship,
        durationType: "EPIC",
        budgetLaunches: highestBudget,
      });
      if (highestPhases.length > 0) {
        plans.push({
          sourceOptionKey: highestTierExtendedKey,
          mode: "cap",
          phases: highestPhases,
        });
      }
    }
  }

  if (plans.length === 0) {
    return null;
  }

  const sourceKeys = new Set(plans.map((plan) => plan.sourceOptionKey));
  const remapToFirstPhase = new Map<string, string>();
  const phasedOptions: MissionOption[] = [];
  for (const plan of plans) {
    if (plan.phases.length === 0) {
      continue;
    }
    remapToFirstPhase.set(plan.sourceOptionKey, missionOptionKey(plan.phases[0].option));
    for (const phase of plan.phases) {
      phasedOptions.push(phase.option);
    }
  }

  const baseOptions = candidate.missionOptions.filter((option) => !sourceKeys.has(missionOptionKey(option)));
  const refinedMissionOptions = mergeMissionOptionsByKey(baseOptions, phasedOptions);
  const refinedActions = await buildMissionActionsForOptions(refinedMissionOptions, closure, lootData);
  const refinedActionOptionKeys = new Set(refinedActions.map((action) => action.optionKey));
  const refinedFinalOptionKeys = new Set(refinedMissionOptions.map((option) => missionOptionKey(option)));

  const prepRequirements = aggregatePrepOptionRequirements(candidate.prepSteps);
  const requiredMissionLaunches: Record<string, RequiredMissionLaunchConstraint> = {};
  let prepNoYieldSlotSeconds = 0;
  for (const [optionKey, requirement] of prepRequirements.entries()) {
    if (requirement.launches <= 0) {
      continue;
    }
    const mappedOptionKey = remapToFirstPhase.get(optionKey) || optionKey;
    if (!refinedActionOptionKeys.has(mappedOptionKey)) {
      prepNoYieldSlotSeconds += requirement.launches * requirement.option.durationSeconds;
      continue;
    }
    addRequiredLaunchConstraint(
      requiredMissionLaunches,
      mappedOptionKey,
      requirement.launches,
      !refinedFinalOptionKeys.has(mappedOptionKey)
    );
  }

  const maxMissionLaunchesByOption: Record<string, number> = {};
  const optionLaunchPrecedenceChains: string[][] = [];
  for (const plan of plans) {
    const phaseKeys = plan.phases.map((phase) => missionOptionKey(phase.option));
    if (plan.mode === "exact") {
      for (const phase of plan.phases) {
        addRequiredLaunchConstraint(
          requiredMissionLaunches,
          missionOptionKey(phase.option),
          phase.launches,
          true
        );
      }
      continue;
    }
    for (const phase of plan.phases) {
      const phaseKey = missionOptionKey(phase.option);
      const cap = Math.max(0, Math.round(phase.launches));
      if (cap <= 0) {
        continue;
      }
      maxMissionLaunchesByOption[phaseKey] = Math.max(maxMissionLaunchesByOption[phaseKey] || 0, cap);
    }
    if (phaseKeys.length > 1) {
      optionLaunchPrecedenceChains.push(phaseKeys);
    }
  }

  const unified = await solveUnifiedCraftMissionPlan({
    profile,
    targetKey,
    quantity,
    priorityTime,
    closure,
    actions: refinedActions,
    geRef,
    timeRef,
    requiredMissionLaunches,
    maxMissionLaunchesByOption,
    optionLaunchPrecedenceChains,
  });

  const totalSlotSeconds = prepNoYieldSlotSeconds + unified.totalSlotSeconds;
  const weightedScore = normalizedScore(
    unified.geCost,
    totalSlotSeconds / 3,
    priorityTime,
    geRef,
    timeRef
  );

  const notes: string[] = [];
  notes.push(
    "Ran one phased-yield refinement pass on the best candidate (dominant launched option exact-phased; highest-tier unlocked extended ship cap-phased heuristic)."
  );
  if (prepNoYieldSlotSeconds > 0) {
    notes.push(
      `Refinement treated ${missionDurationLabel(
        prepNoYieldSlotSeconds / 3
      )} of prep launches as pure progression time (no required-item expected drops).`
    );
  }

  return {
    actions: refinedActions,
    unified,
    totalSlotSeconds,
    weightedScore,
    prepNoYieldSlotSeconds,
    notes,
  };
}

function findBestLevelUpAction(
  state: ProgressionState,
  ship: string,
  optionMap: Map<string, MissionOption[]>
): ProgressionAction | null {
  const currentInfo = state.shipLevels.find((entry) => entry.ship === ship);
  if (!currentInfo || !currentInfo.unlocked || currentInfo.level >= currentInfo.maxLevel) {
    return null;
  }
  const options = optionMap.get(ship) || [];
  let best: ProgressionAction | null = null;
  let bestSlotSeconds = Number.POSITIVE_INFINITY;

  for (const option of options) {
    const testCounts = cloneLaunchCounts(state.launchCounts);
    for (let launches = 1; launches <= PROGRESSION_MAX_LAUNCHES_PER_ACTION; launches += 1) {
      testCounts[ship][option.durationType] += 1;
      const projectedLevels = computeShipLevelsFromLaunchCounts(testCounts);
      const projectedInfo = projectedLevels.find((entry) => entry.ship === ship);
      if (!projectedInfo || projectedInfo.level <= currentInfo.level) {
        continue;
      }
      const slotSeconds = launches * option.durationSeconds;
      if (slotSeconds < bestSlotSeconds) {
        bestSlotSeconds = slotSeconds;
        best = {
          nextLaunchCounts: cloneLaunchCounts(testCounts),
          nextShipLevels: projectedLevels,
          step: {
            ship,
            durationType: option.durationType,
            launches,
            durationSeconds: option.durationSeconds,
            reason: `Raise ${ship} to level ${projectedInfo.level}`,
            option,
          },
        };
      }
      break;
    }
  }

  return best;
}

function findBestUnlockAction(
  state: ProgressionState,
  shipToUnlock: string,
  shipOrder: string[],
  optionMap: Map<string, MissionOption[]>
): ProgressionAction | null {
  const targetInfo = state.shipLevels.find((entry) => entry.ship === shipToUnlock);
  if (!targetInfo || targetInfo.unlocked) {
    return null;
  }
  const shipIndex = shipOrder.indexOf(shipToUnlock);
  if (shipIndex <= 0) {
    return null;
  }

  const previousShip = shipOrder[shipIndex - 1];
  const previousInfo = state.shipLevels.find((entry) => entry.ship === previousShip);
  if (!previousInfo?.unlocked) {
    return null;
  }

  const options = optionMap.get(previousShip) || [];
  let best: ProgressionAction | null = null;
  let bestSlotSeconds = Number.POSITIVE_INFINITY;

  for (const option of options) {
    const testCounts = cloneLaunchCounts(state.launchCounts);
    for (let launches = 1; launches <= PROGRESSION_MAX_LAUNCHES_PER_ACTION; launches += 1) {
      testCounts[previousShip][option.durationType] += 1;
      const projectedLevels = computeShipLevelsFromLaunchCounts(testCounts);
      const projectedTarget = projectedLevels.find((entry) => entry.ship === shipToUnlock);
      if (!projectedTarget?.unlocked) {
        continue;
      }
      const slotSeconds = launches * option.durationSeconds;
      if (slotSeconds < bestSlotSeconds) {
        bestSlotSeconds = slotSeconds;
        best = {
          nextLaunchCounts: cloneLaunchCounts(testCounts),
          nextShipLevels: projectedLevels,
          step: {
            ship: previousShip,
            durationType: option.durationType,
            launches,
            durationSeconds: option.durationSeconds,
            reason: `Unlock ${shipToUnlock} via ${previousShip} launches`,
            option,
          },
        };
      }
      break;
    }
  }

  return best;
}

function enumerateProgressionActions(state: ProgressionState, shipOrder: string[]): ProgressionAction[] {
  const optionMap = missionOptionsByShip(state.missionOptions);
  const actions: ProgressionAction[] = [];

  for (const ship of shipOrder) {
    const levelUp = findBestLevelUpAction(state, ship, optionMap);
    if (levelUp) {
      actions.push(levelUp);
    }
  }

  for (let index = 1; index < shipOrder.length; index += 1) {
    const unlock = findBestUnlockAction(state, shipOrder[index], shipOrder, optionMap);
    if (unlock) {
      actions.push(unlock);
    }
  }

  return actions.sort((a, b) => {
    const slotSecondsDiff = a.step.durationSeconds * a.step.launches - b.step.durationSeconds * b.step.launches;
    if (Math.abs(slotSecondsDiff) > SCORE_EPS) {
      return slotSecondsDiff;
    }
    return a.step.reason.localeCompare(b.step.reason);
  });
}

function buildProgressionCandidates(profile: PlayerProfile): ProgressionCandidate[] {
  if (profile.shipLevels.length === 0) {
    return [
      {
        shipLevels: profile.shipLevels,
        missionOptions: profile.missionOptions,
        prepSteps: [],
        prepSlotSeconds: 0,
      },
    ];
  }

  const initialMissionOptions =
    profile.missionOptions.length > 0
      ? profile.missionOptions
      : buildMissionOptions(profile.shipLevels, profile.epicResearchFTLLevel, profile.epicResearchZerogLevel);
  const baseCandidate: ProgressionCandidate = {
    shipLevels: profile.shipLevels,
    missionOptions: initialMissionOptions,
    prepSteps: [],
    prepSlotSeconds: 0,
  };

  const shipOrder = getShipOrder();
  const initialLaunchCounts = shipLevelsToLaunchCounts(profile.shipLevels);
  const initialState: ProgressionState = {
    launchCounts: initialLaunchCounts,
    shipLevels: profile.shipLevels,
    missionOptions: initialMissionOptions,
    prepSteps: [],
    prepSlotSeconds: 0,
  };

  const candidates: ProgressionCandidate[] = [baseCandidate];
  const visited = new Set<string>([launchCountsFingerprint(initialLaunchCounts, shipOrder)]);
  let frontier: ProgressionState[] = [initialState];

  for (let depth = 0; depth < PROGRESSION_MAX_DEPTH; depth += 1) {
    const nextFrontier: ProgressionState[] = [];
    for (const state of frontier) {
      const nextActions = enumerateProgressionActions(state, shipOrder);
      for (const action of nextActions) {
        const fingerprint = launchCountsFingerprint(action.nextLaunchCounts, shipOrder);
        if (visited.has(fingerprint)) {
          continue;
        }
        visited.add(fingerprint);

        const prepSlotSeconds = state.prepSlotSeconds + action.step.launches * action.step.durationSeconds;
        const prepSteps = [...state.prepSteps, action.step];
        const nextMissionOptions = buildMissionOptions(
          action.nextShipLevels,
          profile.epicResearchFTLLevel,
          profile.epicResearchZerogLevel
        );

        nextFrontier.push({
          launchCounts: action.nextLaunchCounts,
          shipLevels: action.nextShipLevels,
          missionOptions: nextMissionOptions,
          prepSteps,
          prepSlotSeconds,
        });
      }
    }

    if (nextFrontier.length === 0) {
      break;
    }

    nextFrontier.sort((a, b) => a.prepSlotSeconds - b.prepSlotSeconds);
    frontier = nextFrontier.slice(0, PROGRESSION_BEAM_WIDTH);
    for (const state of frontier) {
      candidates.push({
        shipLevels: state.shipLevels,
        missionOptions: state.missionOptions,
        prepSteps: state.prepSteps,
        prepSlotSeconds: state.prepSlotSeconds,
      });
    }
  }

  return candidates;
}

function dedupeProgressionCandidatesByMissionOptions(candidates: ProgressionCandidate[]): {
  unique: ProgressionCandidate[];
  dedupedCount: number;
} {
  if (candidates.length <= 1) {
    return { unique: candidates, dedupedCount: 0 };
  }

  const bestByOptions = new Map<string, ProgressionCandidate>();
  for (const candidate of candidates) {
    const key = missionOptionsFingerprint(candidate.missionOptions);
    const existing = bestByOptions.get(key);
    if (!existing || candidate.prepSlotSeconds < existing.prepSlotSeconds) {
      bestByOptions.set(key, candidate);
    }
  }

  const unique = Array.from(bestByOptions.values()).sort((a, b) => a.prepSlotSeconds - b.prepSlotSeconds);
  return {
    unique,
    dedupedCount: Math.max(0, candidates.length - unique.length),
  };
}

async function planForTargetHeuristic(
  profile: PlayerProfile,
  targetItemId: string,
  quantity: number,
  priorityTimeRaw: number
): Promise<PlannerResult> {
  const targetKey = itemIdToKey(targetItemId);
  const priorityTime = Math.max(0, Math.min(1, priorityTimeRaw));
  const effectivePriorityTime = Math.max(priorityTime, MIN_MISSION_TIME_OBJECTIVE_WEIGHT);
  const quantityInt = Math.max(1, Math.round(quantity));

  const closure = new Set<string>();
  collectClosure(targetKey, closure);

  const actions = await buildMissionActions(profile, closure);

  const inventory: Record<string, number> = { ...profile.inventory };
  const craftCounts: Record<string, number> = { ...profile.craftCounts };
  const crafts: Record<string, number> = {};
  const demand: Record<string, number> = {};

  const { geRef, timeRef } = computeObjectiveReferences({
    profile,
    targetKey,
    quantity: quantityInt,
    actions,
  });

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
      const craftScore = normalizedScore(craftGe, 0, effectivePriorityTime, geRef, timeRef);

      const farmTpu = bestTimePerUnit(itemKey, actions);
      const farmScore = Number.isFinite(farmTpu)
        ? normalizedScore(0, farmTpu, effectivePriorityTime, geRef, timeRef)
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

  const missionAllocation = await allocateMissionsWithSolver(actions, remainingDemand);
  const missionCounts = missionAllocation.missionCounts;
  const totalSlotSeconds = missionAllocation.totalSlotSeconds;
  const remainingDemandAfterMissions = missionAllocation.remainingDemand;

  const expectedHours = totalSlotSeconds / 3 / 3600;
  const weightedScore = normalizedScore(
    geCost,
    totalSlotSeconds / 3,
    priorityTime,
    geRef,
    timeRef
  );

  const missionRows = buildMissionRows(actions, missionCounts);
  const craftRows = buildCraftRows(crafts);
  const targetBreakdown = buildTargetBreakdown({
    quantity: quantityInt,
    targetKey,
    crafts,
    actions,
    missionCounts,
    remainingDemand: remainingDemandAfterMissions,
  });

  const unmetItems = Object.entries(remainingDemandAfterMissions)
    .filter(([, qty]) => qty > 1e-6)
    .map(([itemKey, qty]) => ({ itemId: itemKeyToId(itemKey), quantity: qty }))
    .sort((a, b) => b.quantity - a.quantity);

  const uncoveredItemKeys = Object.entries(remainingDemandAfterMissions)
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
  const projectedShipLevels = projectShipLevelsAfterPlannedLaunches({
    baseShipLevels: profile.shipLevels,
    prepSteps: [],
    actions,
    missionCounts,
  });

  const notes: string[] = [...missionAllocation.notes];
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
    "Planner currently uses expected-drop values with solver-backed mission allocation and 3 mission slots. Re-run after returns."
  );
  notes.push(
    "Rarity is treated as fungible for planning (shiny inventory counted toward craftable supply by item tier)."
  );
  notes.push(
    "Ship progression snapshot reflects projected levels after applying all launches in this plan (prep + farming), and is not persisted."
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
    targetBreakdown,
    progression: {
      prepHours: 0,
      prepLaunches: [],
      projectedShipLevels: progressionShipRows(projectedShipLevels),
    },
    notes,
  };
}

export async function planForTarget(
  profile: PlayerProfile,
  targetItemId: string,
  quantity: number,
  priorityTimeRaw: number,
  plannerOptions: PlannerOptions = {}
): Promise<PlannerResult> {
  const targetKey = itemIdToKey(targetItemId);
  const priorityTime = Math.max(0, Math.min(1, priorityTimeRaw));
  const quantityInt = Math.max(1, Math.round(quantity));
  const fastMode = Boolean(plannerOptions.fastMode);
  const maxSolveMs = Math.max(0, Math.round(plannerOptions.maxSolveMs || 0));
  const startedAtMs = Date.now();
  const reportProgress = (
    event: Omit<PlannerProgressEvent, "elapsedMs"> & { elapsedMs?: number }
  ) => {
    if (!plannerOptions.onProgress) {
      return;
    }
    try {
      plannerOptions.onProgress({
        ...event,
        elapsedMs: event.elapsedMs ?? Date.now() - startedAtMs,
      });
    } catch {
      // Ignore progress callback errors.
    }
  };
  const yieldForProgressFlush = async () => {
    if (!plannerOptions.onProgress) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  };

  reportProgress({
    phase: "init",
    message: "Building ingredient closure and progression candidates...",
  });
  await yieldForProgressFlush();

  const closure = new Set<string>();
  collectClosure(targetKey, closure);

  const progressionCandidatesRaw = buildProgressionCandidates(profile);
  const progressionDeduped = dedupeProgressionCandidatesByMissionOptions(progressionCandidatesRaw);
  const progressionCandidates = fastMode
    ? progressionDeduped.unique.slice(0, FAST_MODE_MAX_CANDIDATES)
    : progressionDeduped.unique;
  reportProgress({
    phase: "candidates",
    message: `Prepared ${progressionCandidates.length.toLocaleString()} progression candidates. Loading mission loot dataset...`,
    completed: 0,
    total: progressionCandidates.length,
  });
  await yieldForProgressFlush();
  const referenceMissionOptions = progressionCandidates[0]?.missionOptions || profile.missionOptions;
  const lootData = await loadLootData();
  reportProgress({
    phase: "init",
    message: "Loaded mission loot data. Building mission action models...",
  });
  await yieldForProgressFlush();
  const baseActions = await buildMissionActionsForOptions(
    referenceMissionOptions,
    closure,
    lootData
  );
  const { geRef, timeRef } = computeObjectiveReferences({
    profile,
    targetKey,
    quantity: quantityInt,
    actions: baseActions,
  });

  try {
    const candidateTotal = progressionCandidates.length;
    const actionCache = new Map<string, MissionAction[]>();
    const solverErrors: string[] = [];
    const refinementNotes: string[] = [];
    let prunedCandidateCount = 0;
    let completedCandidateCount = 0;
    let timeBudgetExceeded = false;
    const candidateLoopStartedAtMs = Date.now();
    const estimateCandidateEtaMs = (): number | null => {
      if (completedCandidateCount <= 0 || completedCandidateCount >= candidateTotal) {
        return completedCandidateCount >= candidateTotal ? 0 : null;
      }
      const elapsed = Date.now() - candidateLoopStartedAtMs;
      if (elapsed <= 0) {
        return null;
      }
      const avgPerCandidateMs = elapsed / completedCandidateCount;
      return Math.max(0, Math.round((candidateTotal - completedCandidateCount) * avgPerCandidateMs));
    };
    reportProgress({
      phase: "candidates",
      message: `Starting horizon search across ${candidateTotal.toLocaleString()} progression candidates...`,
      completed: 0,
      total: candidateTotal,
      etaMs: null,
    });
    await yieldForProgressFlush();

    let best:
      | {
          candidate: ProgressionCandidate;
          actions: MissionAction[];
          unified: UnifiedPlan;
          totalSlotSeconds: number;
          weightedScore: number;
          prepNoYieldSlotSeconds: number;
        }
      | null = null;

    for (let candidateIndex = 0; candidateIndex < candidateTotal; candidateIndex += 1) {
      if (maxSolveMs > 0 && Date.now() - startedAtMs >= maxSolveMs) {
        timeBudgetExceeded = true;
        reportProgress({
          phase: "candidates",
          message: "Time budget reached; stopping horizon candidate search early.",
          completed: completedCandidateCount,
          total: candidateTotal,
          etaMs: null,
        });
        break;
      }

      const candidate = progressionCandidates[candidateIndex];
      reportProgress({
        phase: "candidate",
        message: `Evaluating candidate ${candidateIndex + 1} of ${candidateTotal}...`,
        completed: completedCandidateCount,
        total: candidateTotal,
        etaMs: estimateCandidateEtaMs(),
      });
      await yieldForProgressFlush();

      const prepOnlyLowerBound = normalizedScore(
        0,
        candidate.prepSlotSeconds / 3,
        priorityTime,
        geRef,
        timeRef
      );
      if (best && prepOnlyLowerBound + SCORE_EPS >= best.weightedScore) {
        prunedCandidateCount += 1;
        completedCandidateCount = candidateIndex + 1;
        reportProgress({
          phase: "candidates",
          message: `Processed ${completedCandidateCount.toLocaleString()}/${candidateTotal.toLocaleString()} candidates (${prunedCandidateCount.toLocaleString()} pruned).`,
          completed: completedCandidateCount,
          total: candidateTotal,
          etaMs: estimateCandidateEtaMs(),
        });
        await yieldForProgressFlush();
        continue;
      }

      const prepRequirements = aggregatePrepOptionRequirements(candidate.prepSteps);
      const prepOptions = Array.from(prepRequirements.values()).map((entry) => entry.option);
      const combinedOptions = mergeMissionOptionsByKey(candidate.missionOptions, prepOptions);
      const candidateKey = missionOptionsFingerprint(combinedOptions);
      let candidateActions = actionCache.get(candidateKey);
      if (!candidateActions) {
        candidateActions = await buildMissionActionsForOptions(
          combinedOptions,
          closure,
          lootData
        );
        actionCache.set(candidateKey, candidateActions);
      }
      try {
        const finalOptionKeys = new Set(candidate.missionOptions.map((option) => missionOptionKey(option)));
        const actionOptionKeys = new Set(candidateActions.map((action) => action.optionKey));
        const requiredMissionLaunches: Record<string, RequiredMissionLaunchConstraint> = {};
        let prepNoYieldSlotSeconds = 0;
        for (const [optionKey, requirement] of prepRequirements.entries()) {
          if (requirement.launches <= 0) {
            continue;
          }
          if (!actionOptionKeys.has(optionKey)) {
            prepNoYieldSlotSeconds += requirement.launches * requirement.option.durationSeconds;
            continue;
          }
          addRequiredLaunchConstraint(
            requiredMissionLaunches,
            optionKey,
            requirement.launches,
            !finalOptionKeys.has(optionKey)
          );
        }

        const unified = await solveUnifiedCraftMissionPlan({
          profile,
          targetKey,
          quantity: quantityInt,
          priorityTime,
          closure,
          actions: candidateActions,
          geRef,
          timeRef,
          requiredMissionLaunches,
        });
        const totalSlotSeconds = prepNoYieldSlotSeconds + unified.totalSlotSeconds;
        const weightedScore = normalizedScore(
          unified.geCost,
          totalSlotSeconds / 3,
          priorityTime,
          geRef,
          timeRef
        );
        if (
          !best ||
          weightedScore + SCORE_EPS < best.weightedScore ||
          (Math.abs(weightedScore - best.weightedScore) <= SCORE_EPS && totalSlotSeconds < best.totalSlotSeconds)
        ) {
          best = {
            candidate,
            actions: candidateActions,
            unified,
            totalSlotSeconds,
            weightedScore,
            prepNoYieldSlotSeconds,
          };
        }
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        solverErrors.push(details);
      }

      completedCandidateCount = candidateIndex + 1;
      reportProgress({
        phase: "candidates",
        message: `Processed ${completedCandidateCount.toLocaleString()}/${candidateTotal.toLocaleString()} candidates (${prunedCandidateCount.toLocaleString()} pruned, ${solverErrors.length.toLocaleString()} solve errors).`,
        completed: completedCandidateCount,
        total: candidateTotal,
        etaMs: estimateCandidateEtaMs(),
      });
      await yieldForProgressFlush();
    }

    if (!best) {
      const details = solverErrors.length > 0 ? solverErrors[0] : "no feasible horizon candidate";
      throw new Error(`unified HiGHS solve failed across all horizon candidates (${details})`);
    }

    if (!fastMode && !timeBudgetExceeded) {
      reportProgress({
        phase: "refinement",
        message: "Running phased-yield refinement pass...",
        completed: 0,
        total: 1,
        etaMs: null,
      });
      await yieldForProgressFlush();
      try {
        const refined = await runPhasedYieldRefinement({
          profile,
          targetKey,
          quantity: quantityInt,
          priorityTime,
          closure,
          candidate: best.candidate,
          baseActions: best.actions,
          baseMissionCounts: best.unified.missionCounts,
          geRef,
          timeRef,
          lootData,
        });
        if (refined) {
          refinementNotes.push(...refined.notes);
          if (
            refined.weightedScore + SCORE_EPS < best.weightedScore ||
            (Math.abs(refined.weightedScore - best.weightedScore) <= SCORE_EPS &&
              refined.totalSlotSeconds < best.totalSlotSeconds)
          ) {
            best = {
              ...best,
              actions: refined.actions,
              unified: refined.unified,
              totalSlotSeconds: refined.totalSlotSeconds,
              weightedScore: refined.weightedScore,
              prepNoYieldSlotSeconds: refined.prepNoYieldSlotSeconds,
            };
            refinementNotes.push("Accepted phased-yield refinement result (improved weighted objective).");
          } else {
            refinementNotes.push("Phased-yield refinement did not improve weighted objective; kept baseline solve.");
          }
        }
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        refinementNotes.push(`Phased-yield refinement skipped (${details}).`);
      }
      reportProgress({
        phase: "refinement",
        message: "Phased-yield refinement finished.",
        completed: 1,
        total: 1,
        etaMs: 0,
      });
      await yieldForProgressFlush();
    } else if (!fastMode && timeBudgetExceeded) {
      refinementNotes.push("Skipped phased-yield refinement due to solve-time budget cap.");
      reportProgress({
        phase: "refinement",
        message: "Skipped phased-yield refinement due to solve-time budget.",
        completed: 1,
        total: 1,
        etaMs: 0,
      });
      await yieldForProgressFlush();
    }

    reportProgress({
      phase: "finalize",
      message: "Assembling final plan output...",
      completed: completedCandidateCount,
      total: candidateTotal,
      etaMs: 0,
    });
    await yieldForProgressFlush();

    const missionRows = buildMissionRows(best.actions, best.unified.missionCounts);
    const craftRows = buildCraftRows(best.unified.crafts);
    const targetBreakdown = buildTargetBreakdown({
      quantity: quantityInt,
      targetKey,
      crafts: best.unified.crafts,
      actions: best.actions,
      missionCounts: best.unified.missionCounts,
      remainingDemand: best.unified.remainingDemand,
    });
    const unmetItems = Object.entries(best.unified.remainingDemand)
      .filter(([, qty]) => qty > 1e-6)
      .map(([itemKey, qty]) => ({ itemId: itemKeyToId(itemKey), quantity: qty }))
      .sort((a, b) => b.quantity - a.quantity);

    const uncoveredItemKeys = Object.entries(best.unified.remainingDemand)
      .filter(
        ([itemKey, qty]) =>
          qty > 1e-6 &&
          !best.actions.some((action) => {
            const yieldPerMission = action.yields[itemKey] || 0;
            return yieldPerMission > 0;
          })
      )
      .map(([itemKey]) => itemKey);

    if (uncoveredItemKeys.length > 0 && missionRows.length === 0 && craftRows.length === 0) {
      throw new MissionCoverageError(uncoveredItemKeys);
    }

    const compactedPrepLaunches = compactProgressionSteps(best.candidate.prepSteps);
    const prepHours = best.candidate.prepSlotSeconds / 3 / 3600;
    const notes: string[] = [...best.unified.notes, ...refinementNotes];
    if (fastMode) {
      notes.push(
        `Fast solve mode enabled: limited progression-state solves to ${progressionCandidates.length.toLocaleString()} candidates.`
      );
    }
    if (progressionDeduped.dedupedCount > 0) {
      notes.push(
        `Collapsed ${progressionDeduped.dedupedCount} redundant progression states with identical mission options before solving.`
      );
    }
    const evaluatedCount = completedCandidateCount;
    if (evaluatedCount > 1) {
      notes.push(`Horizon search evaluated ${evaluatedCount} projected ship progression states.`);
    }
    if (prunedCandidateCount > 0) {
      notes.push(`Pruned ${prunedCandidateCount} progression candidates using prep-time lower-bound screening.`);
    }
    if (timeBudgetExceeded && maxSolveMs > 0) {
      notes.push(
        `Horizon search stopped early at the ${Math.round(maxSolveMs / 1000).toLocaleString()}s solve-time budget.`
      );
    }
    if (compactedPrepLaunches.length > 0) {
      const prepLaunchCount = compactedPrepLaunches.reduce((sum, row) => sum + row.launches, 0);
      notes.push(
        `Included ${prepLaunchCount.toLocaleString()} prep launches (${missionDurationLabel(
          best.candidate.prepSlotSeconds / 3
        )} at 3-slot throughput) to unlock/level ships before target farming.`
      );
    }
    if (best.prepNoYieldSlotSeconds > 0) {
      notes.push(
        `Some prep launches (${missionDurationLabel(
          best.prepNoYieldSlotSeconds / 3
        )} at 3-slot throughput) had no expected drops for required items and were treated as pure progression time.`
      );
    }
    if (best.actions.length === 0) {
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
      "Planner currently uses expected-drop values with unified solver-backed craft+mission allocation, bounded ship-progression horizon search, and 3 mission slots. Re-run after returns."
    );
    notes.push(
      "Prep launches are credited with expected drops for required items when compatible mission-target coverage exists."
    );
    notes.push(
      "Rarity is treated as fungible for planning (shiny inventory counted toward craftable supply by item tier)."
    );
    notes.push(
      "Ship progression snapshot reflects projected levels after applying all launches in this plan (prep + farming), and is not persisted."
    );

    const projectedShipLevels = projectShipLevelsAfterPlannedLaunches({
      baseShipLevels: profile.shipLevels,
      prepSteps: best.candidate.prepSteps,
      actions: best.actions,
      missionCounts: best.unified.missionCounts,
    });

    reportProgress({
      phase: "finalize",
      message: "Plan ready.",
      completed: completedCandidateCount,
      total: candidateTotal,
      etaMs: 0,
    });
    await yieldForProgressFlush();

    return {
      targetItemId,
      quantity: quantityInt,
      priorityTime,
      geCost: best.unified.geCost,
      expectedHours: best.totalSlotSeconds / 3 / 3600,
      weightedScore: best.weightedScore,
      crafts: craftRows,
      missions: missionRows,
      unmetItems,
      targetBreakdown,
      progression: {
        prepHours,
        prepLaunches: compactedPrepLaunches,
        projectedShipLevels: progressionShipRows(projectedShipLevels),
      },
      notes,
    };
  } catch (error) {
    if (error instanceof MissionCoverageError) {
      throw error;
    }
    const details = error instanceof Error ? error.message : String(error);
    reportProgress({
      phase: "fallback",
      message: `Primary solve path unavailable (${details}); running heuristic fallback...`,
      etaMs: null,
    });
    await yieldForProgressFlush();
    const fallback = await planForTargetHeuristic(profile, targetItemId, quantityInt, priorityTime);
    fallback.notes.unshift(
      `Unified solver allocation unavailable (${details}); fell back to heuristic craft decomposition + mission solver allocation.`
    );
    reportProgress({
      phase: "fallback",
      message: "Fallback plan ready.",
      etaMs: 0,
    });
    await yieldForProgressFlush();
    return fallback;
  }
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
