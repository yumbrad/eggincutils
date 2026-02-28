import type { LootJson, MissionLevelLootStore, MissionTargetLootStore } from "./loot-data";
import type { HighsSolveResult } from "./highs";
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
import type { PlayerProfile } from "./profile";

async function getDefaultSolverFn(): Promise<SolverFunction> {
  const { solveWithHighs } = await import("./highs");
  return solveWithHighs;
}

async function getDefaultLootData(): Promise<LootJson> {
  const { loadLootData } = await import("./loot-data");
  return loadLootData();
}

type MissionAction = {
  key: string;
  optionKey: string;
  missionId: string;
  ship: string;
  durationType: DurationType;
  level: number;
  durationSeconds: number;
  targetAfxId: number;
  yields: Record<string, number>;
};

type PlanMissionRow = {
  missionId: string;
  ship: string;
  durationType: DurationType;
  level: number;
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

type ShinyRaritySelection = {
  rare: boolean;
  epic: boolean;
  legendary: boolean;
};

export type AvailableCombo = {
  ship: string;
  durationType: DurationType;
  targetAfxId: number;
};

export type PlannerResult = {
  targetItemId: string;
  quantity: number;
  priorityTime: number;
  geCost: number;
  totalSlotSeconds: number;
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
  availableCombos: AvailableCombo[];
};

export type SolverFunction = (
  model: string,
  options?: Record<string, string | number | boolean>
) => Promise<HighsSolveResult>;

export type PlannerOptions = {
  fastMode?: boolean;
  missionDropRarities?: Partial<ShinyRaritySelection>;
  maxSolveMs?: number;
  onProgress?: (event: PlannerProgressEvent) => void;
  onBenchmarkSample?: (sample: PlannerBenchmarkSample) => void;
  solverFn?: SolverFunction;
  lootData?: LootJson;
};

export type PlannerProgressEvent = {
  phase: "init" | "candidates" | "candidate" | "refinement" | "finalize" | "fallback";
  message: string;
  elapsedMs: number;
  completed?: number;
  total?: number;
  etaMs?: number | null;
};

export type PlannerBenchmarkSample = {
  targetItemId: string;
  quantity: number;
  priorityTime: number;
  fastMode: boolean;
  wallMs: number;
  expectedHours: number;
  geCost: number;
  path: "primary" | "fallback";
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
const MAX_CRAFT_DISCOUNT_PIECEWISE_STEPS = 10;
const MAX_DISCOUNT_FACTOR = 0.9;
const DISCOUNT_CURVE_EXPONENT = 0.2;
const MISSION_SOLVER_UNMET_PENALTY_FACTOR = 1000;
const SCORE_EPS = 1e-9;
const PROGRESSION_MAX_DEPTH = 4;
const PROGRESSION_BEAM_WIDTH = 8;
const PROGRESSION_MAX_LAUNCHES_PER_ACTION = 600;
const FAST_MODE_MAX_CANDIDATES = 4;
const NORMAL_MODE_MAX_CANDIDATES = 12;
const MIN_MISSION_TIME_OBJECTIVE_WEIGHT = 1e-5;
const MISSION_LAUNCH_TIEBREAKER_SECONDS = 300;
const PLAN_SCORE_TIE_TOLERANCE_FRACTION = 0.01;
const REFINEMENT_MAX_PHASES_PER_OPTION = 3;
const INTEGRATED_MAX_PHASES = 9;
const PHASED_BUDGET_LAUNCHES = 5000;
const BINARY_BIG_M = 5000;
const LP_SCREENING_MILP_RESOLVES = 2;
const DEFAULT_INCLUDE_SHINY_RARITIES: ShinyRaritySelection = {
  rare: true,
  epic: true,
  legendary: true,
};

function normalizeShinyRaritySelection(raw?: Partial<ShinyRaritySelection>): ShinyRaritySelection {
  if (!raw) {
    return { ...DEFAULT_INCLUDE_SHINY_RARITIES };
  }
  return {
    rare: raw.rare !== false,
    epic: raw.epic !== false,
    legendary: raw.legendary !== false,
  };
}

function missionDropRarityNote(selection: ShinyRaritySelection): string {
  const shinyTiers: string[] = [];
  if (selection.rare) {
    shinyTiers.push("Rare");
  }
  if (selection.epic) {
    shinyTiers.push("Epic");
  }
  if (selection.legendary) {
    shinyTiers.push("Legendary");
  }
  if (shinyTiers.length === 0) {
    return "Mission drops include common rarity only (R/E/L disabled by planner settings).";
  }
  return `Mission drops include common + ${shinyTiers.join(" + ")} rarities (per planner settings).`;
}

function getDiscountedCost(baseCost: number, craftCount: number): number {
  const progress = Math.min(1, craftCount / MAX_CRAFT_COUNT_FOR_DISCOUNT);
  const multiplier = 1 - MAX_DISCOUNT_FACTOR * Math.pow(progress, DISCOUNT_CURVE_EXPONENT);
  return Math.floor(baseCost * multiplier);
}

export function normalizedScore(ge: number, timeSec: number, priorityTime: number, geRef: number, timeRef: number): number {
  const safeGeRef = Math.max(1, geRef);
  const safeTimeRef = Math.max(1, timeRef);
  return (1 - priorityTime) * (ge / safeGeRef) + priorityTime * (timeSec / safeTimeRef);
}

function laneOrderByLoad(loads: number[]): number[] {
  return [0, 1, 2].sort((a, b) => {
    const diff = loads[a] - loads[b];
    if (Math.abs(diff) > SCORE_EPS) {
      return diff;
    }
    return a - b;
  });
}

function distributeLaunchesAcrossLanes(launchesRaw: number, durationSecondsRaw: number, laneLoads: number[]): number[] {
  const allocations = [0, 0, 0];
  const projected = [...laneLoads];
  let remaining = Math.max(0, Math.round(launchesRaw));
  const durationSeconds = Math.max(0, Math.round(durationSecondsRaw));
  if (remaining <= 0 || durationSeconds <= 0) {
    return allocations;
  }

  while (remaining > 0) {
    const order = laneOrderByLoad(projected);
    const first = order[0];
    const second = order[1];
    const gap = projected[second] - projected[first];
    let chunk = 1;
    if (gap > 0) {
      chunk = Math.ceil(gap / durationSeconds);
    } else {
      const minLoad = projected[first];
      const tiedCount = order.filter((lane) => Math.abs(projected[lane] - minLoad) < SCORE_EPS).length;
      chunk = Math.floor(remaining / Math.max(1, tiedCount));
    }
    const assign = Math.max(1, Math.min(remaining, chunk));
    allocations[first] += assign;
    projected[first] += assign * durationSeconds;
    remaining -= assign;
  }

  return allocations;
}

function distributeSecondsAcrossLanes(totalSlotSecondsRaw: number, laneLoads: number[]): number[] {
  const allocations = [0, 0, 0];
  const projected = [...laneLoads];
  let remaining = Math.max(0, Math.round(totalSlotSecondsRaw));
  if (remaining <= 0) {
    return allocations;
  }

  while (remaining > 0) {
    const order = laneOrderByLoad(projected);
    const first = order[0];
    const second = order[1];
    const gap = Math.max(0, Math.round(projected[second] - projected[first]));
    let chunk = 1;
    if (gap > 0) {
      chunk = gap;
    } else {
      const minLoad = projected[first];
      const tiedCount = order.filter((lane) => Math.abs(projected[lane] - minLoad) < SCORE_EPS).length;
      chunk = Math.floor(remaining / Math.max(1, tiedCount));
    }
    const assign = Math.max(1, Math.min(remaining, chunk));
    allocations[first] += assign;
    projected[first] += assign;
    remaining -= assign;
  }

  return allocations;
}

type LaunchDurationSegment = {
  launches: number;
  durationSeconds: number;
};

function estimateThreeSlotMakespanSeconds(segments: LaunchDurationSegment[], residualSlotSecondsRaw = 0): number {
  const laneLoads = [0, 0, 0];
  const normalizedSegments = segments
    .map((segment) => ({
      launches: Math.max(0, Math.round(segment.launches)),
      durationSeconds: Math.max(0, Math.round(segment.durationSeconds)),
    }))
    .filter((segment) => segment.launches > 0 && segment.durationSeconds > 0)
    .sort((a, b) => b.durationSeconds - a.durationSeconds || b.launches - a.launches);

  for (const segment of normalizedSegments) {
    const launchAllocations = distributeLaunchesAcrossLanes(segment.launches, segment.durationSeconds, laneLoads);
    for (let lane = 0; lane < 3; lane += 1) {
      const launches = launchAllocations[lane];
      if (launches <= 0) {
        continue;
      }
      laneLoads[lane] += launches * segment.durationSeconds;
    }
  }

  const residualSlotSeconds = Math.max(0, Math.round(residualSlotSecondsRaw));
  if (residualSlotSeconds > 0) {
    const residualAllocations = distributeSecondsAcrossLanes(residualSlotSeconds, laneLoads);
    for (let lane = 0; lane < 3; lane += 1) {
      const seconds = residualAllocations[lane];
      if (seconds <= 0) {
        continue;
      }
      laneLoads[lane] += seconds;
    }
  }

  return Math.max(0, ...laneLoads);
}

function estimateThreeSlotExpectedHours(options: {
  actions: MissionAction[];
  missionCounts: Record<string, number>;
  residualSlotSeconds?: number;
}): number {
  const actionByKey = new Map(options.actions.map((action) => [action.key, action]));
  const launchesByDuration = new Map<number, number>();
  for (const [actionKey, launchesRaw] of Object.entries(options.missionCounts)) {
    const launches = Math.max(0, Math.round(launchesRaw));
    if (launches <= 0) {
      continue;
    }
    const action = actionByKey.get(actionKey);
    if (!action) {
      continue;
    }
    const durationSeconds = Math.max(0, Math.round(action.durationSeconds));
    if (durationSeconds <= 0) {
      continue;
    }
    launchesByDuration.set(durationSeconds, (launchesByDuration.get(durationSeconds) || 0) + launches);
  }
  const segments = Array.from(launchesByDuration.entries()).map(([durationSeconds, launches]) => ({
    launches,
    durationSeconds,
  }));
  const makespanSeconds = estimateThreeSlotMakespanSeconds(segments, options.residualSlotSeconds || 0);
  return makespanSeconds / 3600;
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
  capacity: number,
  includeShinyRarities: ShinyRaritySelection
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
    const common = item.counts[0] || 0;
    const rare = includeShinyRarities.rare ? item.counts[1] || 0 : 0;
    const epic = includeShinyRarities.epic ? item.counts[2] || 0 : 0;
    const legendary = includeShinyRarities.legendary ? item.counts[3] || 0 : 0;
    const totalItemDrops = common + rare + epic + legendary;
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
  lootData?: LootJson,
  missionDropRarities?: Partial<ShinyRaritySelection>
): Promise<MissionAction[]> {
  const loot = lootData || (await getDefaultLootData());
  const includeShinyRarities = normalizeShinyRaritySelection(missionDropRarities);
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
      const yields = yieldsFromTarget(target, relevantItems, option.capacity, includeShinyRarities);
      if (Object.keys(yields).length === 0) {
        continue;
      }
      actions.push({
        key: `${optionKey}|${target.targetAfxId}`,
        optionKey,
        missionId: option.missionId,
        ship: option.ship,
        durationType: option.durationType,
        level: option.level,
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
  relevantItems: Set<string>,
  missionDropRarities?: Partial<ShinyRaritySelection>
): Promise<MissionAction[]> {
  return buildMissionActionsForOptions(profile.missionOptions, relevantItems, undefined, missionDropRarities);
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
  initialDemand: Record<string, number>,
  solverFnOption?: SolverFunction
): Promise<MissionAllocation> {
  const solverFn = solverFnOption ?? await getDefaultSolverFn();
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
    const solution = await solverFn(lines.join("\n"), {
      mip_rel_gap: 0.01,
    });
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

type UnifiedSolveMetrics = {
  lpRelaxation: boolean;
  status: string;
  elapsedMs: number;
  actionCount: number;
  missionVarCount: number;
  craftVarCount: number;
  craftPieceVarCount: number;
  unmetVarCount: number;
  binaryVarCount: number;
  integerVarCount: number;
  constraintCount: number;
};

function formatLinearExpression(terms: Array<{ coefficient: number; variable: string }>): string {
  const filtered = terms.filter((term) => Math.abs(term.coefficient) > SCORE_EPS);
  if (filtered.length === 0) {
    return "0";
  }

  const parts: string[] = [];
  for (let index = 0; index < filtered.length; index += 1) {
    const term = filtered[index];
    const absCoeff = Math.abs(term.coefficient);
    const coeffText = formatLpNumber(absCoeff);
    const op = term.coefficient < 0 ? "-" : "+";
    
    if (index === 0) {
      if (term.coefficient < 0) {
        parts.push(`- ${coeffText} ${term.variable}`);
      } else {
        parts.push(`${coeffText} ${term.variable}`);
      }
    } else {
      parts.push(`${op} ${coeffText} ${term.variable}`);
    }
  }
  return parts.join(" ");
}

type CraftCostModel = {
  itemKey: string;
  craftVar: string;
  craftBound: number;
  baseCost: number;
  initialCraftCount: number;
  preDiscountStepVars: string[];
  preDiscountStepCosts: number[];
  preDiscountStepSizes: number[];
  tailVar: string | null;
  tailCap: number;
};

type CraftModelSkeleton = {
  itemKeys: string[];
  craftModels: CraftCostModel[];
  craftModelByItem: Map<string, CraftCostModel>;
  unmetVarByItem: Map<string, string>;
  demandByItem: Map<string, number>;
};

function buildCraftModelSkeleton(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  closure: Set<string>;
}): CraftModelSkeleton {
  const { profile, targetKey, quantity, closure } = options;
  const itemKeys = Array.from(closure).sort();
  const unmetVarByItem = new Map<string, string>();
  for (let index = 0; index < itemKeys.length; index += 1) {
    unmetVarByItem.set(itemKeys[index], `u_${index}`);
  }

  const craftUpperBounds = estimateCraftUpperBounds(targetKey, quantity);
  const craftModels: CraftCostModel[] = [];
  const craftModelByItem = new Map<string, CraftCostModel>();

  let craftVarCounter = 0;
  let craftStepCounter = 0;
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
    const preDiscountCapacity = Math.max(
      0,
      MAX_CRAFT_COUNT_FOR_DISCOUNT - initialCraftCount
    );
    const preDiscountLimit = Math.min(craftBound, preDiscountCapacity);

    const preDiscountStepVars: string[] = [];
    const preDiscountStepCosts: number[] = [];
    const preDiscountStepSizes: number[] = [];

    if (preDiscountLimit > 0) {
      const piecewiseSteps = preDiscountLimit <= 10 ? 3 : preDiscountLimit <= 50 ? 5 : MAX_CRAFT_DISCOUNT_PIECEWISE_STEPS;
      const stepSize = Math.max(1, Math.ceil(preDiscountLimit / piecewiseSteps));
      let processed = 0;
      while (processed < preDiscountLimit) {
        const currentStepSize = Math.min(stepSize, preDiscountLimit - processed);
        preDiscountStepVars.push(`cs_${craftStepCounter}`);
        const avgCost = getBatchDiscountedCost(recipe.cost, initialCraftCount + processed, currentStepSize) / currentStepSize;
        preDiscountStepCosts.push(avgCost);
        preDiscountStepSizes.push(currentStepSize);

        craftStepCounter += 1;
        processed += currentStepSize;
      }
    }

    const tailCap = Math.max(0, craftBound - preDiscountLimit);
    const tailVar = tailCap > 0 ? `ct_${craftTailCounter++}` : null;

    const model: CraftCostModel = {
      itemKey,
      craftVar: `c_${craftVarCounter++}`,
      craftBound,
      baseCost: recipe.cost,
      initialCraftCount,
      preDiscountStepVars,
      preDiscountStepCosts,
      preDiscountStepSizes,
      tailVar,
      tailCap,
    };
    craftModels.push(model);
    craftModelByItem.set(itemKey, model);
  }

  const demandByItem = new Map<string, number>(itemKeys.map((itemKey) => [itemKey, itemKey === targetKey ? quantity : 0]));

  return { itemKeys, craftModels, craftModelByItem, unmetVarByItem, demandByItem };
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
  phasedChainConstraints?: PhasedChainConstraint[];
  lpRelaxation?: boolean;
  craftSkeleton?: CraftModelSkeleton;
  onSolveMetrics?: (metrics: UnifiedSolveMetrics) => void;
  solverFn?: SolverFunction;
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
    phasedChainConstraints = [],
    lpRelaxation = false,
    craftSkeleton,
    onSolveMetrics,
    solverFn: solverFnOption,
  } = options;
  const solve = solverFnOption ?? await getDefaultSolverFn();
  const {
    itemKeys,
    craftModels,
    craftModelByItem,
    unmetVarByItem,
    demandByItem,
  } = craftSkeleton || buildCraftModelSkeleton({ profile, targetKey, quantity, closure });
  const missionVars = actions.map((_, index) => `m_${index}`);
  const normalizedGeRef = Math.max(1, geRef);
  const normalizedTimeRef = Math.max(1, timeRef);

  const lines: string[] = [];
  lines.push("Minimize");
  const objectiveTerms: Array<{ coefficient: number; variable: string }> = [];
  let maxObjectiveCoeff = 1;

  for (const model of craftModels) {
    for (let index = 0; index < model.preDiscountStepVars.length; index += 1) {
      const geCoeff = model.preDiscountStepCosts[index];
      const coefficient = ((1 - priorityTime) * geCoeff) / normalizedGeRef;
      objectiveTerms.push({
        coefficient,
        variable: model.preDiscountStepVars[index],
      });
      maxObjectiveCoeff = Math.max(maxObjectiveCoeff, Math.abs(coefficient));
    }
    if (model.tailVar && model.tailCap > 0) {
      const tailCost = getDiscountedCost(
        model.baseCost,
        model.initialCraftCount + model.preDiscountStepSizes.reduce((a, b) => a + b, 0)
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
  const missionLaunchTiebreakCoeff = (missionObjectiveWeight * MISSION_LAUNCH_TIEBREAKER_SECONDS) / normalizedTimeRef;
  for (let index = 0; index < actions.length; index += 1) {
    const coefficient =
      (missionObjectiveWeight * (actions[index].durationSeconds / 3)) / normalizedTimeRef + missionLaunchTiebreakCoeff;
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
    // Target demand is interpreted as additional units beyond current inventory.
    const inventoryQty = itemKey === targetKey ? 0 : Math.max(0, profile.inventory[itemKey] || 0);
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

  // Binary indicator constraints for phased leveling chains:
  // For each phase i > 0: L_i <= M * z_i (z_i binary: 1 if phase active)
  // For each phase i > 0: sum(L_{i-1} actions) >= cap_{i-1} * z_i (prev phase must be full)
  const phasedBinaryVars: string[] = [];
  let phasedConstraintIndex = 0;
  for (let chainIndex = 0; chainIndex < phasedChainConstraints.length; chainIndex += 1) {
    const { chain, caps } = phasedChainConstraints[chainIndex];
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
      const zVar = `zp_${chainIndex}_${phaseIndex}`;
      phasedBinaryVars.push(zVar);

      // L_i <= M_i * z_i  =>  L_i - M_i * z_i <= 0
      // Use the tightest available per-phase cap instead of a global Big-M.
      const phaseCapRaw = caps[phaseIndex];
      const optionCapRaw = maxMissionLaunchesByOption[currentOptionKey];
      const activationCap = Math.max(
        1,
        Math.round(
          (Number.isFinite(phaseCapRaw) && phaseCapRaw > 0)
            ? phaseCapRaw
            : (Number.isFinite(optionCapRaw) && optionCapRaw > 0)
              ? optionCapRaw
              : BINARY_BIG_M
        )
      );
      const activationTerms: Array<{ coefficient: number; variable: string }> = [];
      for (const idx of currentIndexes) {
        activationTerms.push({ coefficient: 1, variable: missionVars[idx] });
      }
      activationTerms.push({ coefficient: -activationCap, variable: zVar });
      lines.push(`  pa_${phasedConstraintIndex}: ${formatLinearExpression(activationTerms)} <= 0`);
      phasedConstraintIndex += 1;

      // sum(L_{i-1} actions) >= cap_{i-1} * z_i  =>  sum(L_{i-1}) - cap_{i-1} * z_i >= 0
      const prevCap = caps[phaseIndex - 1];
      if (prevCap > 0 && previousIndexes.length > 0) {
        const completionTerms: Array<{ coefficient: number; variable: string }> = [];
        for (const idx of previousIndexes) {
          completionTerms.push({ coefficient: 1, variable: missionVars[idx] });
        }
        completionTerms.push({ coefficient: -prevCap, variable: zVar });
      lines.push(`  pb_${phasedConstraintIndex}: ${formatLinearExpression(completionTerms)} >= 0`);
      phasedConstraintIndex += 1;
      }
    }
  }

  for (let modelIndex = 0; modelIndex < craftModels.length; modelIndex += 1) {
    const model = craftModels[modelIndex];
    const relationTerms: Array<{ coefficient: number; variable: string }> = [
      { coefficient: 1, variable: model.craftVar },
    ];
    for (let stepIndex = 0; stepIndex < model.preDiscountStepVars.length; stepIndex += 1) {
      relationTerms.push({ coefficient: -1, variable: model.preDiscountStepVars[stepIndex] });
    }
    if (model.tailVar) {
      relationTerms.push({ coefficient: -1, variable: model.tailVar });
    }
    lines.push(`  cl_${modelIndex}: ${formatLinearExpression(relationTerms)} = 0`);

    for (let stepIndex = 0; stepIndex + 1 < model.preDiscountStepVars.length; stepIndex += 1) {
      const sizeN = model.preDiscountStepSizes[stepIndex];
      const sizeNext = model.preDiscountStepSizes[stepIndex + 1];
      lines.push(
        `  cm_${modelIndex}_${stepIndex}: ${formatLpNumber(sizeNext)} ${model.preDiscountStepVars[stepIndex]} - ${formatLpNumber(sizeN)} ${model.preDiscountStepVars[stepIndex + 1]} >= 0`
      );
    }
    if (model.tailVar && model.preDiscountStepVars.length > 0) {
      const lastStepVar = model.preDiscountStepVars[model.preDiscountStepVars.length - 1];
      const lastStepSize = model.preDiscountStepSizes[model.preDiscountStepSizes.length - 1];
      lines.push(`  ctg_${modelIndex}: ${formatLpNumber(lastStepSize)} ${model.tailVar} - ${formatLpNumber(model.tailCap)} ${lastStepVar} <= 0`);
    }
  }

  lines.push("Bounds");
  for (const model of craftModels) {
    lines.push(`  0 <= ${model.craftVar} <= ${formatLpNumber(model.craftBound)}`);
    for (let stepIndex = 0; stepIndex < model.preDiscountStepVars.length; stepIndex += 1) {
      lines.push(`  0 <= ${model.preDiscountStepVars[stepIndex]} <= ${formatLpNumber(model.preDiscountStepSizes[stepIndex])}`);
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
  for (const zVar of phasedBinaryVars) {
    lines.push(`  0 <= ${zVar} <= 1`);
  }

  const integerVars = lpRelaxation
    ? []
    : [
        ...craftModels.map((model) => model.craftVar),
        ...craftModels.flatMap((model) => model.preDiscountStepVars),
        ...craftModels.flatMap((model) => (model.tailVar ? [model.tailVar] : [])),
        ...missionVars,
      ];
  if (!lpRelaxation) {
    if (integerVars.length > 0) {
      lines.push("General");
      const chunkSize = 24;
      for (let index = 0; index < integerVars.length; index += chunkSize) {
        lines.push(`  ${integerVars.slice(index, index + chunkSize).join(" ")}`);
      }
    }
    if (phasedBinaryVars.length > 0) {
      lines.push("Binary");
      const chunkSize = 24;
      for (let index = 0; index < phasedBinaryVars.length; index += chunkSize) {
        lines.push(`  ${phasedBinaryVars.slice(index, index + chunkSize).join(" ")}`);
      }
    }
  }
  lines.push("End");

  const craftVarCount = craftModels.length;
  const craftPieceVarCount = craftModels.reduce(
    (sum, model) => sum + model.preDiscountStepVars.length + (model.tailVar ? 1 : 0),
    0
  );
  const unmetVarCount = itemKeys.length;
  const missionVarCount = missionVars.length;
  const binaryVarCount = phasedBinaryVars.length;
  const demandConstraintCount = itemKeys.length;
  const craftLinkConstraintCount = craftModels.reduce((sum, model) => {
    let modelCount = 1; // cl_
    modelCount += Math.max(0, model.preDiscountStepVars.length - 1); // cm_
    if (model.tailVar && model.preDiscountStepVars.length > 0) {
      modelCount += 1; // ctg_
    }
    return sum + modelCount;
  }, 0);
  const constraintCount =
    demandConstraintCount +
    requiredConstraintIndex +
    optionMaxConstraintIndex +
    precedenceConstraintIndex +
    phasedConstraintIndex +
    craftLinkConstraintCount;

  const solveStartedAtMs = Date.now();
  const solution = await solve(lines.join("\n"), {
    ...(lpRelaxation ? {} : { mip_rel_gap: 0.01 }),
  });
  const elapsedMs = Math.max(0, Date.now() - solveStartedAtMs);
  const status = solution.Status || "Unknown";
  onSolveMetrics?.({
    lpRelaxation,
    status,
    elapsedMs,
    actionCount: actions.length,
    missionVarCount,
    craftVarCount,
    craftPieceVarCount,
    unmetVarCount,
    binaryVarCount,
    integerVarCount: integerVars.length,
    constraintCount,
  });
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
        .sort((a, b) => b.quantity - a.quantity);

      return {
        missionId: action.missionId,
        ship: action.ship,
        durationType: action.durationType,
        level: action.level,
        targetAfxId: action.targetAfxId,
        launches,
        durationSeconds: action.durationSeconds,
        expectedYields,
      };
    })
    .filter((row): row is PlanMissionRow => row !== null)
    .sort((a, b) => b.launches - a.launches || a.level - b.level);
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
  maxPhases?: number;
}): Array<{ option: MissionOption; launches: number }> {
  const { profile, baseLaunchCounts, ship, durationType, budgetLaunches } = options;
  const maxPhases = options.maxPhases ?? REFINEMENT_MAX_PHASES_PER_OPTION;
  let remaining = Math.max(0, Math.round(budgetLaunches));
  if (remaining <= 0) {
    return [];
  }

  const phases: Array<{ option: MissionOption; launches: number }> = [];
  const workingCounts = cloneLaunchCounts(baseLaunchCounts);
  for (let phaseIndex = 0; phaseIndex < maxPhases && remaining > 0; phaseIndex += 1) {
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
    const launches = phaseIndex + 1 >= maxPhases
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

type PhasedChainConstraint = {
  /** optionKeys in order from lowest level phase to highest */
  chain: string[];
  /** max launches allowed at each phase (launches to complete that level) */
  caps: number[];
};

type PhasedActionsResult = {
  phasedOptions: MissionOption[];
  maxLaunchesByOption: Record<string, number>;
  phaseChains: PhasedChainConstraint[];
};

function buildPhasedActionsForCandidate(
  profile: PlayerProfile,
  candidate: ProgressionCandidate
): PhasedActionsResult {
  const baseLaunchCounts = shipLevelsToLaunchCounts(candidate.shipLevels);
  const phasedOptions: MissionOption[] = [];
  const maxLaunchesByOption: Record<string, number> = {};
  const phaseChains: PhasedChainConstraint[] = [];

  const seenShipDuration = new Set<string>();
  for (const option of candidate.missionOptions) {
    const shipDurKey = `${option.ship}|${option.durationType}`;
    if (seenShipDuration.has(shipDurKey)) {
      continue;
    }
    seenShipDuration.add(shipDurKey);

    const phases = buildPhasedOptionPlan({
      profile,
      baseLaunchCounts,
      ship: option.ship,
      durationType: option.durationType,
      budgetLaunches: PHASED_BUDGET_LAUNCHES,
      maxPhases: INTEGRATED_MAX_PHASES,
    });
    if (phases.length <= 1) {
      // Ship doesn't level during budget — keep original option, no chain needed
      continue;
    }

    const chain: string[] = [];
    const caps: number[] = [];
    for (const phase of phases) {
      const phaseKey = missionOptionKey(phase.option);
      phasedOptions.push(phase.option);
      chain.push(phaseKey);
      caps.push(phase.launches);
      maxLaunchesByOption[phaseKey] = Math.max(maxLaunchesByOption[phaseKey] || 0, phase.launches);
    }
    if (chain.length > 1) {
      phaseChains.push({ chain, caps });
    }
  }

  return { phasedOptions, maxLaunchesByOption, phaseChains };
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
  missionDropRarities?: Partial<ShinyRaritySelection>;
  craftSkeleton?: CraftModelSkeleton;
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
    missionDropRarities,
    craftSkeleton,
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
  const refinedActions = await buildMissionActionsForOptions(
    refinedMissionOptions,
    closure,
    lootData,
    missionDropRarities
  );
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
    craftSkeleton,
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

function findLevelToMaxAction(
  state: ProgressionState,
  ship: string,
  optionMap: Map<string, MissionOption[]>
): ProgressionAction | null {
  const currentInfo = state.shipLevels.find((entry) => entry.ship === ship);
  if (!currentInfo || !currentInfo.unlocked || currentInfo.level >= currentInfo.maxLevel) {
    return null;
  }
  // Need at least 2 level-ups remaining to be useful as a macro (single level-up is already covered)
  if (currentInfo.maxLevel - currentInfo.level < 2) {
    return null;
  }
  const options = optionMap.get(ship) || [];
  let best: ProgressionAction | null = null;
  let bestSlotSeconds = Number.POSITIVE_INFINITY;

  for (const option of options) {
    const testCounts = cloneLaunchCounts(state.launchCounts);
    const maxLaunches = PROGRESSION_MAX_LAUNCHES_PER_ACTION * (currentInfo.maxLevel - currentInfo.level);
    for (let launches = 1; launches <= Math.min(maxLaunches, 3000); launches += 1) {
      testCounts[ship][option.durationType] += 1;
      const projectedLevels = computeShipLevelsFromLaunchCounts(testCounts);
      const projectedInfo = projectedLevels.find((entry) => entry.ship === ship);
      if (!projectedInfo || projectedInfo.level < currentInfo.maxLevel) {
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
            reason: `Level ${ship} to max (${currentInfo.level} → ${currentInfo.maxLevel})`,
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
    const levelMax = findLevelToMaxAction(state, ship, optionMap);
    if (levelMax) {
      actions.push(levelMax);
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
  priorityTimeRaw: number,
  plannerOptions: Pick<PlannerOptions, "missionDropRarities" | "solverFn" | "lootData"> = {}
): Promise<PlannerResult> {
  const targetKey = itemIdToKey(targetItemId);
  const priorityTime = Math.max(0, Math.min(1, priorityTimeRaw));
  const effectivePriorityTime = Math.max(priorityTime, MIN_MISSION_TIME_OBJECTIVE_WEIGHT);
  const quantityInt = Math.max(1, Math.round(quantity));

  const closure = new Set<string>();
  collectClosure(targetKey, closure);

  const actions = await buildMissionActionsForOptions(
    profile.missionOptions, closure, plannerOptions.lootData, plannerOptions.missionDropRarities
  );

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

  const fulfill = (itemKey: string, needed: number, depth = 0, useInventory = true) => {
    const safeNeeded = Math.max(0, Math.round(needed));
    if (safeNeeded === 0) {
      return;
    }
    if (depth > 30) {
      demand[itemKey] = (demand[itemKey] || 0) + safeNeeded;
      return;
    }

    let remaining = safeNeeded;
    if (useInventory) {
      const available = Math.max(0, inventory[itemKey] || 0);
      const used = Math.min(available, remaining);
      inventory[itemKey] = available - used;
      remaining -= used;
    }

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
        fulfill(ingredientKey, ingredientQty, depth + 1, true);
      }

      geCost += craftGe;
      craftCounts[itemKey] = nextCraftCount + 1;
      crafts[itemKey] = (crafts[itemKey] || 0) + 1;
      remaining -= 1;
    }
  };

  // Target demand is interpreted as additional units beyond current inventory.
  fulfill(targetKey, quantityInt, 0, false);

  const remainingDemand: Record<string, number> = {};
  for (const [itemKey, qty] of Object.entries(demand)) {
    if (qty > 0) {
      remainingDemand[itemKey] = qty;
    }
  }

  const missionAllocation = await allocateMissionsWithSolver(actions, remainingDemand, plannerOptions.solverFn);
  const missionCounts = missionAllocation.missionCounts;
  const totalSlotSeconds = missionAllocation.totalSlotSeconds;
  const remainingDemandAfterMissions = missionAllocation.remainingDemand;

  const expectedHours = estimateThreeSlotExpectedHours({
    actions,
    missionCounts,
  });
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
  notes.push("Target quantity is interpreted as additional copies beyond current inventory.");
  notes.push(missionDropRarityNote(normalizeShinyRaritySelection(plannerOptions.missionDropRarities)));
  notes.push(
    "Ship progression snapshot reflects projected levels after applying all launches in this plan (prep + farming), and is not persisted."
  );

  return {
    targetItemId,
    quantity: quantityInt,
    priorityTime,
    geCost,
    totalSlotSeconds,
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
    availableCombos: [],
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
  const missionDropRarities = normalizeShinyRaritySelection(plannerOptions.missionDropRarities);
  const solverFn = plannerOptions.solverFn;
  const injectedLootData = plannerOptions.lootData;
  const benchmarkStartedAtMs = Date.now();
  let benchmarkExcludedMs = 0;
  const reportBenchmark = (result: PlannerResult, path: "primary" | "fallback") => {
    if (!plannerOptions.onBenchmarkSample) {
      return;
    }
    try {
      plannerOptions.onBenchmarkSample({
        targetItemId,
        quantity: quantityInt,
        priorityTime,
        fastMode,
        wallMs: Math.max(0, Date.now() - benchmarkStartedAtMs - benchmarkExcludedMs),
        expectedHours: result.expectedHours,
        geCost: result.geCost,
        path,
      });
    } catch {
      // Ignore benchmark callback errors.
    }
  };
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

  const fastCandidateLimit = priorityTime <= SCORE_EPS ? NORMAL_MODE_MAX_CANDIDATES : FAST_MODE_MAX_CANDIDATES;
  const candidateLimit = fastMode ? fastCandidateLimit : NORMAL_MODE_MAX_CANDIDATES;
  const progressionCandidates = progressionDeduped.unique.slice(0, candidateLimit);
  reportProgress({
    phase: "candidates",
    message: `Prepared ${progressionCandidates.length.toLocaleString()} progression candidates. Loading mission loot dataset...`,
    completed: 0,
    total: progressionCandidates.length,
  });
  await yieldForProgressFlush();
  const referenceMissionOptions = progressionCandidates[0]?.missionOptions || profile.missionOptions;
  const lootLoadStartedAtMs = Date.now();
  const lootData = injectedLootData ?? await getDefaultLootData();
  benchmarkExcludedMs += Math.max(0, Date.now() - lootLoadStartedAtMs);
  reportProgress({
    phase: "init",
    message: "Loaded mission loot data. Building mission action models...",
  });
  await yieldForProgressFlush();
  const baseActions = await buildMissionActionsForOptions(referenceMissionOptions, closure, lootData, missionDropRarities);

  const craftSkeleton = buildCraftModelSkeleton({
    profile,
    targetKey,
    quantity: quantityInt,
    closure,
  });

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
    type SolveStageStats = {
      attempts: number;
      totalMs: number;
      maxMs: number;
      maxConstraintCount: number;
      maxIntegerVarCount: number;
      maxBinaryVarCount: number;
      maxActionCount: number;
    };
    const createSolveStageStats = (): SolveStageStats => ({
      attempts: 0,
      totalMs: 0,
      maxMs: 0,
      maxConstraintCount: 0,
      maxIntegerVarCount: 0,
      maxBinaryVarCount: 0,
      maxActionCount: 0,
    });
    const lpSolveStats = createSolveStageStats();
    const milpSolveStats = createSolveStageStats();
    const recordSolveMetrics = (stats: SolveStageStats, metrics: UnifiedSolveMetrics) => {
      stats.attempts += 1;
      stats.totalMs += metrics.elapsedMs;
      stats.maxMs = Math.max(stats.maxMs, metrics.elapsedMs);
      stats.maxConstraintCount = Math.max(stats.maxConstraintCount, metrics.constraintCount);
      stats.maxIntegerVarCount = Math.max(stats.maxIntegerVarCount, metrics.integerVarCount);
      stats.maxBinaryVarCount = Math.max(stats.maxBinaryVarCount, metrics.binaryVarCount);
      stats.maxActionCount = Math.max(stats.maxActionCount, metrics.actionCount);
    };
    const formatMsLabel = (rawMs: number): string => {
      const safeMs = Math.max(0, rawMs);
      if (safeMs >= 10_000) {
        return `${(safeMs / 1000).toFixed(1)}s`;
      }
      if (safeMs >= 1_000) {
        return `${(safeMs / 1000).toFixed(2)}s`;
      }
      return `${Math.round(safeMs)}ms`;
    };
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
            solveMetrics: UnifiedSolveMetrics | null;
            totalSlotSeconds: number;
            weightedScore: number;
            geCost: number;
            unmetTotal: number;
            totalLaunches: number;
            prepNoYieldSlotSeconds: number;
        }
      | null = null;

    type CandidateEvalInput = {
      candidate: ProgressionCandidate;
      candidateActions: MissionAction[];
      requiredMissionLaunches: Record<string, RequiredMissionLaunchConstraint>;
      maxMissionLaunchesByOption: Record<string, number>;
      phasedChainConstraints: PhasedChainConstraint[];
      prepNoYieldSlotSeconds: number;
    };
    type MilpSolveProgressContext = {
      prefix: string;
      candidateIndex: number;
      candidateTotal: number;
      completed: number;
      etaMs: number | null;
    };
    const emitMilpStageProgress = async (
      context: MilpSolveProgressContext | undefined,
      stageLabel: string
    ) => {
      if (!context) {
        return;
      }
      reportProgress({
        phase: "candidate",
        message: `${context.prefix}${stageLabel}: candidate ${context.candidateIndex} of ${context.candidateTotal}...`,
        completed: context.completed,
        total: context.candidateTotal,
        etaMs: context.etaMs,
      });
      await yieldForProgressFlush();
    };

    const prepareCandidateInput = async (
      candidate: ProgressionCandidate
    ): Promise<CandidateEvalInput | null> => {
      const prepRequirements = aggregatePrepOptionRequirements(candidate.prepSteps);
      const prepOptions = Array.from(prepRequirements.values()).map((entry) => entry.option);

      // Build phased options for integrated leveling
      const phased = buildPhasedActionsForCandidate(profile, candidate);
      const phasedOptionKeys = new Set(phased.phasedOptions.map((o) => missionOptionKey(o)));

      // Merge: base candidate options (excluding those replaced by phased) + prep options + phased options
      const baseOptions = candidate.missionOptions.filter(
        (option) => !phasedOptionKeys.has(missionOptionKey(option))
      );
      const combinedOptions = mergeMissionOptionsByKey(
        mergeMissionOptionsByKey(baseOptions, phased.phasedOptions),
        prepOptions
      );
      const candidateKey = missionOptionsFingerprint(combinedOptions);
      let candidateActions = actionCache.get(candidateKey);
      if (!candidateActions) {
        candidateActions = await buildMissionActionsForOptions(combinedOptions, closure, lootData, missionDropRarities);
        actionCache.set(candidateKey, candidateActions);
      }
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
      return {
        candidate,
        candidateActions,
        requiredMissionLaunches,
        maxMissionLaunchesByOption: phased.maxLaunchesByOption,
        phasedChainConstraints: phased.phaseChains,
        prepNoYieldSlotSeconds,
      };
    };

    const solveCandidateInput = async (
      input: CandidateEvalInput,
      lpRelaxation: boolean,
      milpProgressContext?: MilpSolveProgressContext
    ) => {
      if (!lpRelaxation) {
        await emitMilpStageProgress(milpProgressContext, "Integer-constrained solve");
      }
      let baselineSolveMetrics: UnifiedSolveMetrics | null = null;
      const baselineUnified = await solveUnifiedCraftMissionPlan({
        profile,
        targetKey,
        quantity: quantityInt,
        priorityTime,
        closure,
        actions: input.candidateActions,
        geRef,
        timeRef,
        requiredMissionLaunches: input.requiredMissionLaunches,
        maxMissionLaunchesByOption: input.maxMissionLaunchesByOption,
        phasedChainConstraints: input.phasedChainConstraints,
        lpRelaxation,
        craftSkeleton,
        solverFn,
        onSolveMetrics: (metrics) => {
          baselineSolveMetrics = metrics;
          if (lpRelaxation) {
            recordSolveMetrics(lpSolveStats, metrics);
          } else {
            recordSolveMetrics(milpSolveStats, metrics);
          }
        },
      });
      const unified = baselineUnified;
      const totalSlotSeconds = input.prepNoYieldSlotSeconds + unified.totalSlotSeconds;
      const weightedScore = normalizedScore(
        unified.geCost,
        totalSlotSeconds / 3,
        priorityTime,
        geRef,
        timeRef
      );
      const unmetTotal = Object.values(unified.remainingDemand).reduce((sum, qty) => sum + Math.max(0, qty), 0);
      const totalLaunches = Object.values(unified.missionCounts).reduce(
        (sum, launches) => sum + Math.max(0, Math.round(launches)),
        0
      );
      return {
        unified,
        solveMetrics: baselineSolveMetrics,
        totalSlotSeconds,
        weightedScore,
        geCost: unified.geCost,
        unmetTotal,
        totalLaunches,
      };
    };
    const estimateBatchEtaMs = (startedAtMs: number, completed: number, total: number): number | null => {
      if (completed <= 0 || completed >= total) {
        return completed >= total ? 0 : null;
      }
      const elapsed = Date.now() - startedAtMs;
      if (elapsed <= 0) {
        return null;
      }
      const avgPerStepMs = elapsed / completed;
      return Math.max(0, Math.round((total - completed) * avgPerStepMs));
    };
    const comparePlanQuality = (
      a: { unmetTotal: number; weightedScore: number; geCost: number; totalSlotSeconds: number; totalLaunches: number },
      b: { unmetTotal: number; weightedScore: number; geCost: number; totalSlotSeconds: number; totalLaunches: number }
    ): number => {
      const unmetDiff = a.unmetTotal - b.unmetTotal;
      if (Math.abs(unmetDiff) > 1e-6) {
        return unmetDiff;
      }

      const geScale = Math.max(1, Math.min(Math.abs(a.geCost), Math.abs(b.geCost)));
      const geTieThreshold = Math.max(1, geScale * PLAN_SCORE_TIE_TOLERANCE_FRACTION);
      const geDiff = a.geCost - b.geCost;
      const geTied = Math.abs(geDiff) <= geTieThreshold;

      const slotScale = Math.max(1, Math.min(Math.abs(a.totalSlotSeconds), Math.abs(b.totalSlotSeconds)));
      const slotTieThreshold = Math.max(1, slotScale * PLAN_SCORE_TIE_TOLERANCE_FRACTION);
      const slotSecondsDiff = a.totalSlotSeconds - b.totalSlotSeconds;
      const timeTied = Math.abs(slotSecondsDiff) <= slotTieThreshold;

      if (geTied && timeTied) {
        const launchDiff = a.totalLaunches - b.totalLaunches;
        if (launchDiff !== 0) {
          return launchDiff;
        }
      }

      const scoreDiff = a.weightedScore - b.weightedScore;
      const scoreScale = Math.max(SCORE_EPS, Math.min(Math.abs(a.weightedScore), Math.abs(b.weightedScore)));
      const scoreTieThreshold = Math.max(SCORE_EPS, scoreScale * PLAN_SCORE_TIE_TOLERANCE_FRACTION);
      if (Math.abs(scoreDiff) > scoreTieThreshold) {
        return scoreDiff;
      }
      if (Math.abs(slotSecondsDiff) > SCORE_EPS) {
        return slotSecondsDiff;
      }
      if (Math.abs(geDiff) > SCORE_EPS) {
        return geDiff;
      }
      return a.totalLaunches - b.totalLaunches;
    };
    const shouldReplaceBest = (
      current: typeof best,
      next: { unmetTotal: number; weightedScore: number; geCost: number; totalSlotSeconds: number; totalLaunches: number }
    ): boolean => !current || comparePlanQuality(next, current) < 0;

    // Phase 1: LP-screen all candidates (fast)
    type LpScreenResult = {
      input: CandidateEvalInput;
      unified: UnifiedPlan;
      solveMetrics: UnifiedSolveMetrics | null;
      weightedScore: number;
      geCost: number;
      totalSlotSeconds: number;
      unmetTotal: number;
      totalLaunches: number;
    };
    const lpScreened: LpScreenResult[] = [];
    for (let candidateIndex = 0; candidateIndex < candidateTotal; candidateIndex += 1) {
      if (maxSolveMs > 0 && Date.now() - startedAtMs >= maxSolveMs) {
        timeBudgetExceeded = true;
        reportProgress({
          phase: "candidates",
          message: "Time budget reached; stopping relaxed screening early.",
          completed: completedCandidateCount,
          total: candidateTotal,
          etaMs: null,
        });
        break;
      }

      const candidate = progressionCandidates[candidateIndex];
      reportProgress({
        phase: "candidate",
        message: `Relaxed (fractional) solve: candidate ${candidateIndex + 1} of ${candidateTotal}...`,
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
      const currentBestLp = lpScreened.reduce<LpScreenResult | null>((bestLp, row) => {
        if (!bestLp) {
          return row;
        }
        return comparePlanQuality(row, bestLp) < 0 ? row : bestLp;
      }, null);
      if (
        lpScreened.length >= LP_SCREENING_MILP_RESOLVES &&
        currentBestLp &&
        currentBestLp.unmetTotal <= 1e-6 &&
        prepOnlyLowerBound + SCORE_EPS >= currentBestLp.weightedScore
      ) {
        prunedCandidateCount += 1;
        completedCandidateCount = candidateIndex + 1;
        continue;
      }

      try {
        const input = await prepareCandidateInput(candidate);
        if (!input) {
          completedCandidateCount = candidateIndex + 1;
          continue;
        }
        const result = await solveCandidateInput(input, true);
        lpScreened.push({
          input,
          unified: result.unified,
          solveMetrics: result.solveMetrics,
          weightedScore: result.weightedScore,
          geCost: result.geCost,
          totalSlotSeconds: result.totalSlotSeconds,
          unmetTotal: result.unmetTotal,
          totalLaunches: result.totalLaunches,
        });
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        solverErrors.push(details);
      }

      completedCandidateCount = candidateIndex + 1;
      reportProgress({
        phase: "candidates",
        message: `Relaxed-screened ${completedCandidateCount.toLocaleString()}/${candidateTotal.toLocaleString()} candidates (${prunedCandidateCount.toLocaleString()} pruned).`,
        completed: completedCandidateCount,
        total: candidateTotal,
        etaMs: estimateCandidateEtaMs(),
      });
      await yieldForProgressFlush();
    }

    // Phase 2: MILP re-solve top candidates
    lpScreened.sort((a, b) => {
      return comparePlanQuality(a, b);
    });
    if (fastMode) {
      const fastMilpResolves = priorityTime <= SCORE_EPS ? 2 : 1;
      if (fastMilpResolves > 0 && lpScreened.length > 0) {
        const fastMilpCandidates = lpScreened.slice(0, fastMilpResolves);
        const fastMilpStartedAtMs = Date.now();
        let fastMilpCompleted = 0;
        for (let resolveIndex = 0; resolveIndex < fastMilpCandidates.length; resolveIndex += 1) {
          reportProgress({
            phase: "candidate",
            message: `Fast mode: Preparing integer candidate ${resolveIndex + 1} of ${fastMilpCandidates.length}...`,
            completed: fastMilpCompleted,
            total: fastMilpCandidates.length,
            etaMs: estimateBatchEtaMs(fastMilpStartedAtMs, fastMilpCompleted, fastMilpCandidates.length),
          });
          await yieldForProgressFlush();

          const { input } = fastMilpCandidates[resolveIndex];
          try {
            const result = await solveCandidateInput(input, false, {
              prefix: "Fast mode: ",
              candidateIndex: resolveIndex + 1,
              candidateTotal: fastMilpCandidates.length,
              completed: fastMilpCompleted,
              etaMs: estimateBatchEtaMs(fastMilpStartedAtMs, fastMilpCompleted, fastMilpCandidates.length),
            });
            if (shouldReplaceBest(best, result)) {
              best = {
                candidate: input.candidate,
                actions: input.candidateActions,
                unified: result.unified,
                solveMetrics: result.solveMetrics,
                totalSlotSeconds: result.totalSlotSeconds,
                weightedScore: result.weightedScore,
                geCost: result.geCost,
                unmetTotal: result.unmetTotal,
                totalLaunches: result.totalLaunches,
                prepNoYieldSlotSeconds: input.prepNoYieldSlotSeconds,
              };
            }
          } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            solverErrors.push(details);
          }

          fastMilpCompleted = resolveIndex + 1;
          reportProgress({
            phase: "candidates",
            message: `Fast mode: Integer re-solved ${fastMilpCompleted}/${fastMilpCandidates.length} relaxed-screened candidates.`,
            completed: fastMilpCompleted,
            total: fastMilpCandidates.length,
            etaMs: estimateBatchEtaMs(fastMilpStartedAtMs, fastMilpCompleted, fastMilpCandidates.length),
          });
          await yieldForProgressFlush();
        }
      }
      if (!best) {
        const bestLp = lpScreened[0];
        if (bestLp) {
          best = {
            candidate: bestLp.input.candidate,
            actions: bestLp.input.candidateActions,
            unified: bestLp.unified,
            solveMetrics: bestLp.solveMetrics,
            totalSlotSeconds: bestLp.totalSlotSeconds,
            weightedScore: bestLp.weightedScore,
            geCost: bestLp.geCost,
            unmetTotal: bestLp.unmetTotal,
            totalLaunches: bestLp.totalLaunches,
            prepNoYieldSlotSeconds: bestLp.input.prepNoYieldSlotSeconds,
          };
        }
      }
    } else {
      const milpCandidates = lpScreened.slice(0, LP_SCREENING_MILP_RESOLVES);
      let milpStartedAtMs = 0;
      let milpCompleted = 0;

      if (milpCandidates.length > 0) {
        milpStartedAtMs = Date.now();
        reportProgress({
          phase: "candidates",
          message: `Integer re-solving top ${milpCandidates.length} of ${lpScreened.length} relaxed-screened candidates...`,
          completed: milpCompleted,
          total: milpCandidates.length,
          etaMs: null,
        });
        await yieldForProgressFlush();
      }

      for (let resolveIndex = 0; resolveIndex < milpCandidates.length; resolveIndex += 1) {
        reportProgress({
          phase: "candidate",
          message: `Preparing integer candidate ${resolveIndex + 1} of ${milpCandidates.length}...`,
          completed: milpCompleted,
          total: milpCandidates.length,
          etaMs: estimateBatchEtaMs(milpStartedAtMs, milpCompleted, milpCandidates.length),
        });
        await yieldForProgressFlush();

        const { input } = milpCandidates[resolveIndex];
        try {
          const result = await solveCandidateInput(input, false, {
            prefix: "",
            candidateIndex: resolveIndex + 1,
            candidateTotal: milpCandidates.length,
            completed: milpCompleted,
            etaMs: estimateBatchEtaMs(milpStartedAtMs, milpCompleted, milpCandidates.length),
          });
          if (shouldReplaceBest(best, result)) {
            best = {
              candidate: input.candidate,
              actions: input.candidateActions,
              unified: result.unified,
              solveMetrics: result.solveMetrics,
              totalSlotSeconds: result.totalSlotSeconds,
              weightedScore: result.weightedScore,
              geCost: result.geCost,
              unmetTotal: result.unmetTotal,
              totalLaunches: result.totalLaunches,
              prepNoYieldSlotSeconds: input.prepNoYieldSlotSeconds,
            };
          }
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          solverErrors.push(details);
        }

        milpCompleted = resolveIndex + 1;
        reportProgress({
          phase: "candidates",
          message: `Integer re-solved ${milpCompleted}/${milpCandidates.length} relaxed-screened candidates.`,
          completed: milpCompleted,
          total: milpCandidates.length,
          etaMs: estimateBatchEtaMs(milpStartedAtMs, milpCompleted, milpCandidates.length),
        });
        await yieldForProgressFlush();
      }
    }

    if (!best) {
      const details = solverErrors.length > 0 ? solverErrors[0] : "no feasible horizon candidate";
      throw new Error(`unified HiGHS solve failed across all horizon candidates (${details})`);
    }

    // Phased leveling is now integrated into every candidate evaluation via
    // buildPhasedActionsForCandidate + binary indicator constraints. The separate
    // runPhasedYieldRefinement pass is skipped.
    refinementNotes.push("Integrated phased leveling: ship level-up yields are modeled in every candidate solve (binary indicator constraints).");
    reportProgress({
      phase: "refinement",
      message: "Skipped legacy refinement (integrated phased leveling active).",
      completed: 1,
      total: 1,
      etaMs: 0,
    });
    await yieldForProgressFlush();

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
      if (priorityTime <= SCORE_EPS) {
        notes.push("Fast mode GE-priority path integer re-solves the top two LP-screened progression candidates.");
      } else {
        notes.push("Fast mode integer re-solves the top LP-screened progression candidate.");
      }
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
    const summarizeSolveStage = (label: string, stats: SolveStageStats): string | null => {
      if (stats.attempts <= 0) {
        return null;
      }
      const averageMs = stats.totalMs / stats.attempts;
      return `${label}: ${stats.attempts.toLocaleString()} solves (${formatMsLabel(stats.totalMs)} total, avg ${formatMsLabel(
        averageMs
      )}, max ${formatMsLabel(stats.maxMs)}), peak model ${stats.maxConstraintCount.toLocaleString()} rows / ${stats.maxIntegerVarCount.toLocaleString()} integer vars (${stats.maxBinaryVarCount.toLocaleString()} binary), ${stats.maxActionCount.toLocaleString()} actions.`;
    };
    const solveStageSummaries = [
      summarizeSolveStage("LP screening", lpSolveStats),
      summarizeSolveStage("MILP re-solve", milpSolveStats),
    ].filter((entry): entry is string => entry !== null);
    if (solveStageSummaries.length > 0) {
      notes.push(`Solver diagnostics: ${solveStageSummaries.join(" ")}`);
    }
    if (best.solveMetrics) {
      const solveType = best.solveMetrics.lpRelaxation ? "LP" : "MILP";
      notes.push(
        `Selected ${solveType} model size: ${best.solveMetrics.constraintCount.toLocaleString()} rows, ${best.solveMetrics.integerVarCount.toLocaleString()} integer vars (${best.solveMetrics.binaryVarCount.toLocaleString()} binary), ${best.solveMetrics.actionCount.toLocaleString()} mission actions.`
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
      "Planner uses expected-drop values with unified solver-backed craft+mission allocation, integrated phased ship leveling, bounded ship-progression horizon search, and 3 mission slots. Re-run after returns."
    );
    notes.push("Target quantity is interpreted as additional copies beyond current inventory.");
    notes.push(
      "Prep launches are credited with expected drops for required items when compatible mission-target coverage exists."
    );
    notes.push(missionDropRarityNote(missionDropRarities));
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

    const expectedHours = estimateThreeSlotExpectedHours({
      actions: best.actions,
      missionCounts: best.unified.missionCounts,
      residualSlotSeconds: best.prepNoYieldSlotSeconds,
    });

    // Build available combos from the best candidate's actions
    const comboSet = new Set<string>();
    const availableCombos: AvailableCombo[] = [];
    for (const action of best.actions) {
      const comboKey = `${action.ship}|${action.durationType}|${action.targetAfxId}`;
      if (!comboSet.has(comboKey)) {
        comboSet.add(comboKey);
        availableCombos.push({
          ship: action.ship,
          durationType: action.durationType as DurationType,
          targetAfxId: action.targetAfxId,
        });
      }
    }

    const result: PlannerResult = {
      targetItemId,
      quantity: quantityInt,
      priorityTime,
      geCost: best.unified.geCost,
      totalSlotSeconds: best.totalSlotSeconds,
      expectedHours,
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
      availableCombos,
    };
    reportBenchmark(result, "primary");
    return result;
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
    const fallback = await planForTargetHeuristic(profile, targetItemId, quantityInt, priorityTime, {
      missionDropRarities,
      solverFn,
      lootData: injectedLootData,
    });
    fallback.notes.unshift(
      `Unified solver allocation unavailable (${details}); fell back to heuristic craft decomposition + mission solver allocation.`
    );
    reportProgress({
      phase: "fallback",
      message: "Fallback plan ready.",
      etaMs: 0,
    });
    await yieldForProgressFlush();
    reportBenchmark(fallback, "fallback");
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

export type MonolithicPathIngredient = {
  itemId: string;
  requested: number;
  fromInventory: number;
  fromCraft: number;
  fromMissionsExpected: number;
  shortfall: number;
};

export type MonolithicPathResult = {
  ship: string;
  durationType: DurationType;
  targetAfxId: number;
  totalLaunches: number;
  finalShipLevel: number | null;
  finalShipMaxLevel: number | null;
  expectedHours: number;
  geCost: number;
  feasible: boolean;
  ingredientBreakdown: MonolithicPathIngredient[];
  phases: Array<{ level: number; capacity: number; launches: number }>;
};

export async function computeMonolithicPaths(options: {
  profile: PlayerProfile;
  targetItemId: string;
  quantity: number;
  priorityTime: number;
  selectedCombos: Array<{ ship: string; durationType: DurationType; targetAfxId: number }>;
  missionDropRarities?: Partial<ShinyRaritySelection>;
  solverFn?: SolverFunction;
  lootData?: LootJson;
}): Promise<MonolithicPathResult[]> {
  const { profile, targetItemId, quantity, priorityTime, selectedCombos, missionDropRarities, solverFn: solverFnOption, lootData: injectedLootData } = options;
  const targetKey = itemIdToKey(targetItemId);
  const quantityInt = Math.max(1, Math.round(quantity));

  const closure = new Set<string>();
  collectClosure(targetKey, closure);

  const lootData = injectedLootData ?? await getDefaultLootData();
  const allOptions = profile.missionOptions.length > 0
    ? profile.missionOptions
    : buildMissionOptions(profile.shipLevels, profile.epicResearchFTLLevel, profile.epicResearchZerogLevel);
  const baseLaunchCounts = shipLevelsToLaunchCounts(profile.shipLevels);

  const craftSkeleton = buildCraftModelSkeleton({
    profile,
    targetKey,
    quantity: quantityInt,
    closure,
  });

  const results: MonolithicPathResult[] = [];

  for (const combo of selectedCombos) {
    try {
      // Build phased options for this specific ship+duration
      const phases = buildPhasedOptionPlan({
        profile,
        baseLaunchCounts,
        ship: combo.ship,
        durationType: combo.durationType,
        budgetLaunches: PHASED_BUDGET_LAUNCHES,
        maxPhases: INTEGRATED_MAX_PHASES,
      });

      const phasedOptions = phases.length > 0
        ? phases.map((p) => p.option)
        : allOptions.filter((o) => o.ship === combo.ship && o.durationType === combo.durationType);

      // Build actions filtered to only this combo's target
      const comboActions = await buildMissionActionsForOptions(phasedOptions, closure, lootData, missionDropRarities);
      const filteredActions = comboActions.filter((a) => a.targetAfxId === combo.targetAfxId);

      if (filteredActions.length === 0) {
        results.push({
          ship: combo.ship,
          durationType: combo.durationType,
          targetAfxId: combo.targetAfxId,
          totalLaunches: 0,
          finalShipLevel: null,
          finalShipMaxLevel: null,
          expectedHours: 0,
          geCost: 0,
          feasible: false,
          ingredientBreakdown: [],
          phases: [],
        });
        continue;
      }

      const { geRef, timeRef } = computeObjectiveReferences({
        profile,
        targetKey,
        quantity: quantityInt,
        actions: filteredActions,
      });

      // Build phase chain constraints
      const maxMissionLaunchesByOption: Record<string, number> = {};
      const phasedChainConstraints: PhasedChainConstraint[] = [];
      if (phases.length > 1) {
        const chain: string[] = [];
        const caps: number[] = [];
        for (const phase of phases) {
          const phaseKey = missionOptionKey(phase.option);
          chain.push(phaseKey);
          caps.push(phase.launches);
          maxMissionLaunchesByOption[phaseKey] = Math.max(maxMissionLaunchesByOption[phaseKey] || 0, phase.launches);
        }
        phasedChainConstraints.push({ chain, caps });
      }

      const unified = await solveUnifiedCraftMissionPlan({
        profile,
        targetKey,
        quantity: quantityInt,
        priorityTime,
        closure,
        actions: filteredActions,
        geRef,
        timeRef,
        maxMissionLaunchesByOption,
        phasedChainConstraints,
        craftSkeleton,
        solverFn: solverFnOption,
      });

      const totalLaunches = Object.values(unified.missionCounts).reduce((sum, v) => sum + Math.max(0, Math.round(v)), 0);
      const expectedHours = estimateThreeSlotExpectedHours({
        actions: filteredActions,
        missionCounts: unified.missionCounts,
      });
      const projectedShipLevels = projectShipLevelsAfterPlannedLaunches({
        baseShipLevels: profile.shipLevels,
        prepSteps: [],
        actions: filteredActions,
        missionCounts: unified.missionCounts,
      });
      const finalShip = projectedShipLevels.find((ship) => ship.ship === combo.ship) || null;

      // Build ingredient breakdown
      const ingredientBreakdown: MonolithicPathIngredient[] = [];
      for (const itemKey of closure) {
        const demandQty = craftSkeleton
          ? craftSkeleton.demandByItem.get(itemKey) || 0
          : 0;
        if (demandQty <= 0 && itemKey !== targetKey) {
          continue;
        }
        const inventoryQty = itemKey === targetKey ? 0 : Math.max(0, profile.inventory[itemKey] || 0);
        const fromCraft = Math.max(0, unified.crafts[itemKey] || 0);
        let fromMissionsExpected = 0;
        for (const [actionKey, launches] of Object.entries(unified.missionCounts)) {
          const action = filteredActions.find((a) => a.key === actionKey);
          if (action) {
            fromMissionsExpected += (action.yields[itemKey] || 0) * launches;
          }
        }
        const shortfall = Math.max(0, unified.remainingDemand[itemKey] || 0);
        const requested = itemKey === targetKey ? quantityInt : demandQty;
        ingredientBreakdown.push({
          itemId: itemKeyToId(itemKey),
          requested,
          fromInventory: inventoryQty,
          fromCraft,
          fromMissionsExpected,
          shortfall,
        });
      }

      const feasible = !ingredientBreakdown.some((i) => i.shortfall > 1e-6);

      const phaseSummary = phases.map((p) => ({
        level: p.option.level,
        capacity: p.option.capacity,
        launches: p.launches,
      }));

      results.push({
        ship: combo.ship,
        durationType: combo.durationType,
        targetAfxId: combo.targetAfxId,
        totalLaunches,
        finalShipLevel: finalShip ? finalShip.level : null,
        finalShipMaxLevel: finalShip ? finalShip.maxLevel : null,
        expectedHours,
        geCost: unified.geCost,
        feasible,
        ingredientBreakdown,
        phases: phaseSummary,
      });
    } catch {
      results.push({
        ship: combo.ship,
        durationType: combo.durationType,
        targetAfxId: combo.targetAfxId,
        totalLaunches: 0,
        finalShipLevel: null,
        finalShipMaxLevel: null,
        expectedHours: 0,
        geCost: 0,
        feasible: false,
        ingredientBreakdown: [],
        phases: [],
      });
    }
  }

  return results;
}
