import type { LootJson, MissionLevelLootStore, MissionTargetLootStore } from "./loot-data";
import type { HighsSolveResult } from "./highs";
import artifactConsumptionData from "../data/artifact-consumption.json";
import missionYieldIndexData from "../data/mission-yield-index.json";
import { isStoneFragmentKey, isUntargetedTargetAfxId, itemIdToCanonicalKey, itemIdToKey, itemKeyToDisplayName, itemKeyToId } from "./item-utils";
import { getRecipe, recipes } from "./recipes";
import {
  buildMissionOptions,
  computeShipLevelsFromLaunchCounts,
  DurationType,
  getNominalMissionCapacity,
  getShipOrder,
  MissionOption,
  ShipLaunchCounts,
  ShipLevelInfo,
  shipLevelsToLaunchCounts,
} from "./ship-data";
import {
  projectInFlightMissions,
  type InFlightMissionRow,
  type InFlightProjection,
} from "./in-flight";
import type { Inventory, PlayerProfile } from "./profile";
import { getVirtueFuelPerLaunch } from "./virtue-fuel";

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
  lootLevel: number;
  durationSeconds: number;
  targetAfxId: number;
  yields: Record<string, number>;
};

type ArtifactConsumptionMap = Record<string, Record<string, number>>;

type ConsumptionOption = {
  sourceItemKey: string;
  yields: Record<string, number>;
};

const ARTIFACT_CONSUMPTION = artifactConsumptionData as ArtifactConsumptionMap;
const UNTARGETED_ONLY_SHIPS = new Set(["CHICKEN_ONE", "CHICKEN_NINE", "CHICKEN_HEAVY", "BCR"]);

type PlanMissionRow = {
  missionId: string;
  ship: string;
  durationType: DurationType;
  level: number;
  targetAfxId: number;
  launches: number;
  durationSeconds: number;
  expectedYields: Array<{ itemId: string; quantity: number }>;
  /** Already launched — nothing for the player to send, drops are just owed. */
  inAir?: boolean;
  /** Only set on in-air rows: wall-clock seconds until the last one lands. */
  secondsRemaining?: number;
  /** Only set on in-air rows: the wait for each launch, longest first. */
  launchSecondsRemaining?: number[];
};

type PlanCraftRow = {
  itemId: string;
  count: number;
};

type PlanConsumptionRow = {
  itemId: string;
  count: number;
  yields: Array<{ itemId: string; quantity: number }>;
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

export type PlannerTarget = {
  targetItemId: string;
  quantity: number;
};

type TargetBreakdownRow = TargetBreakdown & {
  itemId: string;
};

type ShinyRaritySelection = {
  rare: boolean;
  epic: boolean;
  legendary: boolean;
  fragments: boolean;
};

export type AvailableCombo = {
  ship: string;
  durationType: DurationType;
  targetAfxId: number;
};

export type PlannerResult = {
  targetItemId: string;
  quantity: number;
  targets: PlannerTarget[];
  priorityTime: number;
  objectiveMode: MissionObjectiveMode;
  geCost: number;
  fuelCost: number;
  totalSlotSeconds: number;
  expectedHours: number;
  weightedScore: number;
  crafts: PlanCraftRow[];
  consumptions: PlanConsumptionRow[];
  missions: PlanMissionRow[];
  unmetItems: Array<{ itemId: string; quantity: number }>;
  targetBreakdown: TargetBreakdown;
  targetBreakdowns: TargetBreakdownRow[];
  progression: {
    prepHours: number;
    prepLaunches: ProgressionLaunchRow[];
    projectedShipLevels: ProgressionShipRow[];
  };
  inFlight: {
    missionCount: number;
    /** Until the last outstanding mission lands. */
    secondsRemaining: number;
  };
  schedule: {
    /** Makespan of the launches still to be made, ignoring what is in the air. */
    missionSeconds: number;
    /** Slot time already committed to missions in the air. */
    inAirSeconds: number;
    /** Makespan from now, with in-air ships holding their slots first. */
    totalSeconds: number;
  };
  notes: string[];
  availableCombos: AvailableCombo[];
};

/** What the solver produces: the launches still to be made, before the
 *  player's outstanding in-air missions are folded back in. */
type PlannedLaunches = Omit<PlannerResult, "inFlight" | "schedule">;

export type MissionObjectiveMode = "ge" | "virtueFuel";

export type SolverFunction = (
  model: string,
  options?: Record<string, string | number | boolean>
) => Promise<HighsSolveResult>;

export type PlannerOptions = {
  targets?: PlannerTarget[];
  objectiveMode?: MissionObjectiveMode;
  minimumTimePriority?: number;
  fastMode?: boolean;
  targetCraftedOnly?: boolean;
  missionDropRarities?: Partial<ShinyRaritySelection>;
  allowedShipDurations?: Array<{ ship: string; durationType: string }>;
  selectedConsumptionItemIds?: string[];
  maxSolveMs?: number;
  disableMissionYieldIndex?: boolean;
  missionYieldIndexTopPerItem?: number;
  onProgress?: (event: PlannerProgressEvent) => void;
  onBenchmarkSample?: (sample: PlannerBenchmarkSample) => void;
  solverFn?: SolverFunction;
  lootData?: LootJson;
  disableNormalFastIncumbent?: boolean;
  disableFastQuantityAcceleration?: boolean;
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
const MIN_MISSION_TARGET_SAMPLE_LAUNCHES = 10;
const MIN_MISSION_TARGET_SAMPLE_DROPS = 500;
const MISSION_SOLVER_UNMET_PENALTY_FACTOR = 1000;
const SCORE_EPS = 1e-9;
const PROGRESSION_MAX_DEPTH = 4;
const PROGRESSION_BEAM_WIDTH = 8;
const PROGRESSION_MAX_LAUNCHES_PER_ACTION = 600;
const FAST_MODE_MAX_CANDIDATES = 4;
const NORMAL_MODE_MAX_CANDIDATES = 12;
const MIN_MISSION_TIME_OBJECTIVE_WEIGHT = 1e-5;
const MISSION_LAUNCH_TIEBREAKER_SECONDS = 300;
const TARGETED_MISSION_TIEBREAKER_SECONDS = 1;
const PLAN_SCORE_TIE_TOLERANCE_FRACTION = 0.01;
const REFINEMENT_MAX_PHASES_PER_OPTION = 3;
const INTEGRATED_MAX_PHASES = 9;
const PHASED_BUDGET_LAUNCHES = 5000;
const BINARY_BIG_M = 5000;
const LP_SCREENING_MILP_RESOLVES = 2;
const NORMAL_GE_POLISH_TIME_LIMIT_SECONDS = 20;
const VIRTUE_FUEL_MIN_TIME_PRIORITY = 0.15;
const VIRTUE_GE_TIEBREAKER_WEIGHT = 1e-9;
const FAST_QUANTITY_ACCELERATION_MIN_QUANTITY = 5;
const FAST_QUANTITY_ACCELERATION_MAX_BLOCK_QUANTITY = 5;
const NORMAL_SCALED_INCUMBENT_MAX_MILP_RESOLVES = 2;
const MONOLITHIC_INCUMBENT_MAX_COMBOS = 6;
const ENABLE_NORMAL_FAST_INCUMBENT_COMPARISON = false;
const CLOSURE_CACHE_MAX_ENTRIES = 96;
const PROGRESSION_CACHE_MAX_ENTRIES = 48;
const MISSION_ACTION_CACHE_MAX_ENTRIES = 192;
const CRAFT_SKELETON_CACHE_MAX_ENTRIES = 128;
const BEST_CANDIDATE_CACHE_MAX_ENTRIES = 96;
const MISSION_YIELD_INDEX_TOP_PER_ITEM_FAST = 24;
const MISSION_YIELD_INDEX_TOP_PER_ITEM_NORMAL = 48;
const MISSION_YIELD_INDEX_COVERAGE_REPAIR_PER_ITEM = 3;
const DEFAULT_INCLUDE_SHINY_RARITIES: ShinyRaritySelection = {
  rare: true,
  epic: true,
  legendary: true,
  fragments: true,
};

class LruCache<K, V> {
  private readonly maxEntries: number;
  private readonly map = new Map<K, V>();

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(1, Math.round(maxEntries));
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value as K | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.map.delete(oldestKey);
    }
  }
}

type ProgressionCacheEntry = {
  unique: ProgressionCandidate[];
  dedupedCount: number;
};

type MissionActionCacheEntry = {
  actions: MissionAction[];
  rawCount: number;
  prunedCount: number;
  indexFilteredCount: number;
  coverageRepairCount: number;
};

type MissionYieldIndexPosting = {
  actionId: string;
  ratePerCapacity: number;
  expectedPerHour: number;
};

type MissionYieldIndexBucket = "common" | "rare" | "epic" | "legendary" | "allRarities";

type MissionYieldIndex = {
  schemaVersion: number;
  source?: {
    topPerItem?: number;
  };
  byItem: Record<string, Partial<Record<MissionYieldIndexBucket, MissionYieldIndexPosting[]>>>;
};

type MissionActionFilter = {
  key: string;
  topPerItem: number;
  allowedActionIds: Set<string>;
  allowedMissionTargetKeys: Set<string>;
};

const MISSION_YIELD_INDEX = missionYieldIndexData as MissionYieldIndex;

const closureCache = new LruCache<string, Set<string>>(CLOSURE_CACHE_MAX_ENTRIES);
const progressionCache = new LruCache<string, ProgressionCacheEntry>(PROGRESSION_CACHE_MAX_ENTRIES);
const missionActionsCache = new LruCache<string, MissionActionCacheEntry>(MISSION_ACTION_CACHE_MAX_ENTRIES);
const craftSkeletonCache = new LruCache<string, CraftModelSkeleton>(CRAFT_SKELETON_CACHE_MAX_ENTRIES);
const bestCandidateFingerprintCache = new LruCache<string, string>(BEST_CANDIDATE_CACHE_MAX_ENTRIES);
const lootObjectIds = new WeakMap<LootJson, number>();
let nextLootObjectId = 1;

function normalizeShinyRaritySelection(raw?: Partial<ShinyRaritySelection>): ShinyRaritySelection {
  if (!raw) {
    return { ...DEFAULT_INCLUDE_SHINY_RARITIES };
  }
  return {
    rare: raw.rare !== false,
    epic: raw.epic !== false,
    legendary: raw.legendary !== false,
    fragments: raw.fragments !== false,
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
    return selection.fragments
      ? "Mission drops include common rarity only (R/E/L disabled by planner settings)."
      : "Mission drops include common rarity only; stone fragments are excluded.";
  }
  const fragmentText = selection.fragments ? "" : "; stone fragments excluded";
  return `Mission drops include common + ${shinyTiers.join(" + ")} rarities${fragmentText} (per planner settings).`;
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

type ObjectiveContext = {
  mode: MissionObjectiveMode;
  priorityTime: number;
  resourceWeight: number;
  timeWeight: number;
  minimumTimePriority: number;
};

function normalizeObjectiveContext(
  modeRaw: MissionObjectiveMode | undefined,
  priorityTimeRaw: number,
  minimumTimePriorityRaw?: number
): ObjectiveContext {
  const mode: MissionObjectiveMode = modeRaw === "virtueFuel" ? "virtueFuel" : "ge";
  const priorityTime = Math.max(0, Math.min(1, priorityTimeRaw));
  if (mode === "virtueFuel") {
    const minimumTimePriority = Math.max(
      0,
      Math.min(
        0.95,
        Number.isFinite(minimumTimePriorityRaw as number)
          ? minimumTimePriorityRaw as number
          : VIRTUE_FUEL_MIN_TIME_PRIORITY
      )
    );
    const timeWeight = minimumTimePriority + priorityTime * (1 - minimumTimePriority);
    return {
      mode,
      priorityTime,
      resourceWeight: 1 - timeWeight,
      timeWeight,
      minimumTimePriority,
    };
  }
  return {
    mode,
    priorityTime,
    resourceWeight: 1 - priorityTime,
    timeWeight: priorityTime,
    minimumTimePriority: 0,
  };
}

function normalizedObjectiveScore(resourceCost: number, timeSec: number, context: ObjectiveContext, resourceRef: number, timeRef: number): number {
  const safeResourceRef = Math.max(1, resourceRef);
  const safeTimeRef = Math.max(1, timeRef);
  return context.resourceWeight * (resourceCost / safeResourceRef) + context.timeWeight * (timeSec / safeTimeRef);
}

function missionFuelCost(actions: MissionAction[], missionCounts: Record<string, number>): number {
  const actionByKey = new Map(actions.map((action) => [action.key, action]));
  return Object.entries(missionCounts).reduce((sum, [actionKey, launchesRaw]) => {
    const action = actionByKey.get(actionKey);
    const launches = Math.max(0, Math.round(launchesRaw));
    if (!action || launches <= 0) {
      return sum;
    }
    return sum + launches * getVirtueFuelPerLaunch(action.ship, action.durationType);
  }, 0);
}

function objectiveResourceCost(context: ObjectiveContext, geCost: number, fuelCost: number): number {
  return context.mode === "virtueFuel" ? fuelCost : geCost;
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

function estimateThreeSlotMakespanSeconds(
  segments: LaunchDurationSegment[],
  residualSlotSecondsRaw = 0,
  initialLaneLoads?: number[]
): number {
  // Lanes can start busy when missions are already in the air: those slots are
  // not free until the outstanding ship lands.
  const laneLoads = [0, 1, 2].map((lane) => Math.max(0, Math.round(initialLaneLoads?.[lane] || 0)));
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

function isCraftedOnlyEligibleGoalKey(itemKey: string): boolean {
  if (/_stone_\d+$/.test(itemKey)) {
    return false;
  }
  return !(
    /^gold_meteorite_\d+$/.test(itemKey) ||
    /^tau_ceti_geode_\d+$/.test(itemKey) ||
    /^solar_titanium_\d+$/.test(itemKey)
  );
}

function normalizeConsumptionItemKeys(itemIds?: string[]): Set<string> {
  const selected = new Set<string>();
  for (const itemId of itemIds || []) {
    if (typeof itemId !== "string" || itemId.trim().length === 0) {
      continue;
    }
    const itemKey = itemIdToCanonicalKey(itemId.trim());
    if (ARTIFACT_CONSUMPTION[itemKey]) {
      selected.add(itemKey);
    }
  }
  return selected;
}

function buildConsumptionOptionsForClosure(
  selectedItemKeys: Set<string>,
  closure: Set<string>
): ConsumptionOption[] {
  const options: ConsumptionOption[] = [];
  for (const sourceItemKey of Array.from(selectedItemKeys).sort()) {
    const rawYields = ARTIFACT_CONSUMPTION[sourceItemKey];
    if (!rawYields) {
      continue;
    }
    const usefulYields: Record<string, number> = {};
    for (const [outputItemKey, quantity] of Object.entries(rawYields)) {
      const safeQuantity = Math.max(0, quantity);
      if (safeQuantity > SCORE_EPS && closure.has(outputItemKey)) {
        usefulYields[outputItemKey] = safeQuantity;
      }
    }
    if (Object.keys(usefulYields).length === 0) {
      continue;
    }
    collectClosure(sourceItemKey, closure);
    options.push({ sourceItemKey, yields: usefulYields });
  }
  return options;
}

function consumptionProducedByItem(
  itemKey: string,
  consumptions: Record<string, number>,
  consumptionOptions: ConsumptionOption[]
): number {
  let total = 0;
  for (const option of consumptionOptions) {
    const count = Math.max(0, Math.round(consumptions[option.sourceItemKey] || 0));
    if (count <= 0) {
      continue;
    }
    const yieldQty = option.yields[itemKey] || 0;
    if (yieldQty > 0) {
      total += count * yieldQty;
    }
  }
  return total;
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

function estimateCraftUpperBoundsForTargets(
  targetDemandByItem: Map<string, number>,
  consumptionOptions: ConsumptionOption[] = []
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [targetKey, quantity] of targetDemandByItem.entries()) {
    collectCraftUpperBounds(targetKey, Math.max(0, Math.round(quantity)), totals);
  }
  const directDemand = new Map<string, number>();
  for (const [targetKey, quantity] of targetDemandByItem.entries()) {
    directDemand.set(targetKey, Math.max(0, Math.round(quantity)));
  }
  for (const option of consumptionOptions) {
    let sourceCountBound = 0;
    for (const [outputItemKey, yieldQty] of Object.entries(option.yields)) {
      if (yieldQty <= SCORE_EPS) {
        continue;
      }
      const outputNeed = Math.max(0, (totals[outputItemKey] || 0) + (directDemand.get(outputItemKey) || 0));
      if (outputNeed > 0) {
        sourceCountBound = Math.max(sourceCountBound, Math.ceil(outputNeed / yieldQty));
      }
    }
    if (sourceCountBound > 0) {
      collectCraftUpperBounds(option.sourceItemKey, sourceCountBound, totals);
    }
  }
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
    if (!includeShinyRarities.fragments && isStoneFragmentKey(itemKey)) {
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

function hasEnoughMissionTargetSample(
  target: MissionTargetLootStore,
  option: MissionOption,
  lootLevel: number
): boolean {
  if (target.totalDrops < MIN_MISSION_TARGET_SAMPLE_DROPS) {
    return false;
  }
  const nominalCapacity = getNominalMissionCapacity(option.ship, option.durationType, lootLevel) || option.capacity;
  if (nominalCapacity <= 0) {
    return false;
  }
  return target.totalDrops / nominalCapacity >= MIN_MISSION_TARGET_SAMPLE_LAUNCHES;
}

function canMissionOptionUseLootTarget(option: MissionOption, targetAfxId: number): boolean {
  return !UNTARGETED_ONLY_SHIPS.has(option.ship) || isUntargetedTargetAfxId(targetAfxId);
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
      if (!canMissionOptionUseLootTarget(option, target.targetAfxId)) {
        continue;
      }
      if (!hasEnoughMissionTargetSample(target, option, levelLoot.level)) {
        continue;
      }
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
        lootLevel: levelLoot.level,
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

/**
 * Prune actions whose yields are entirely sub-dominated: every yielded item
 * belongs to an artifact family where a higher-tier version is already available
 * from other actions. Such actions are practically useless since the solver
 * would never prefer farming lower-tier sub-components and crafting up when the
 * higher-tier item can be obtained directly.
 */
function pruneSubDominatedActions(actions: MissionAction[]): MissionAction[] {
  const maxDroppedTier: Record<string, number> = {};
  for (const action of actions) {
    for (const itemKey of Object.keys(action.yields)) {
      const match = itemKey.match(/^(.+)_(\d+)$/);
      if (match) {
        const family = match[1];
        const tier = parseInt(match[2], 10);
        if (tier > (maxDroppedTier[family] || 0)) {
          maxDroppedTier[family] = tier;
        }
      }
    }
  }

  return actions.filter((action) => {
    const yieldKeys = Object.keys(action.yields);
    if (yieldKeys.length === 0) {
      return false;
    }
    for (const itemKey of yieldKeys) {
      const match = itemKey.match(/^(.+)_(\d+)$/);
      if (!match) {
        return true; // Unknown format → keep
      }
      if (parseInt(match[2], 10) >= (maxDroppedTier[match[1]] || 0)) {
        return true; // At least one yield is not sub-dominated → keep
      }
    }
    return false; // All yields sub-dominated → prune
  });
}

function missionYieldIndexActionId(action: MissionAction): string {
  return `${action.missionId}|L${action.lootLevel}|T${action.targetAfxId}`;
}

function missionYieldIndexMissionTargetKey(missionId: string, targetAfxId: number): string {
  return `${missionId}|T${targetAfxId}`;
}

function missionYieldIndexMissionTargetKeyFromActionId(actionId: string): string | null {
  const match = actionId.match(/^(.*)\|L\d+\|T(-?\d+)$/);
  if (!match) {
    return null;
  }
  return missionYieldIndexMissionTargetKey(match[1], Number(match[2]));
}

function missionYieldIndexBuckets(selection: ShinyRaritySelection): MissionYieldIndexBucket[] {
  const buckets: MissionYieldIndexBucket[] = ["common"];
  if (selection.rare) {
    buckets.push("rare");
  }
  if (selection.epic) {
    buckets.push("epic");
  }
  if (selection.legendary) {
    buckets.push("legendary");
  }
  if (selection.rare && selection.epic && selection.legendary) {
    buckets.push("allRarities");
  }
  return buckets;
}

function buildMissionActionFilterFromYieldIndex(options: {
  relevantItems: Set<string>;
  missionDropRarities: ShinyRaritySelection;
  topPerItem: number;
}): MissionActionFilter | null {
  const topPerItem = Math.max(1, Math.round(options.topPerItem));
  const buckets = missionYieldIndexBuckets(options.missionDropRarities);
  const allowedActionIds = new Set<string>();
  const allowedMissionTargetKeys = new Set<string>();
  const itemKeys = Array.from(options.relevantItems).sort();

  for (const itemKey of itemKeys) {
    const itemPostings = MISSION_YIELD_INDEX.byItem[itemKey];
    if (!itemPostings) {
      continue;
    }
    for (const bucket of buckets) {
      const postings = itemPostings[bucket] || [];
      for (const posting of postings.slice(0, topPerItem)) {
        allowedActionIds.add(posting.actionId);
        const missionTargetKey = missionYieldIndexMissionTargetKeyFromActionId(posting.actionId);
        if (missionTargetKey) {
          allowedMissionTargetKeys.add(missionTargetKey);
        }
      }
    }
  }

  if (allowedActionIds.size === 0 && allowedMissionTargetKeys.size === 0) {
    return null;
  }

  return {
    key: [
      "yield-index",
      `top:${topPerItem}`,
      `rar:${missionDropRarityCacheKey(options.missionDropRarities)}`,
      `items:${itemKeys.join(",")}`,
    ].join("::"),
    topPerItem,
    allowedActionIds,
    allowedMissionTargetKeys,
  };
}

function actionAllowedByMissionYieldIndex(action: MissionAction, filter: MissionActionFilter): boolean {
  if (filter.allowedActionIds.has(missionYieldIndexActionId(action))) {
    return true;
  }
  return filter.allowedMissionTargetKeys.has(
    missionYieldIndexMissionTargetKey(action.missionId, action.targetAfxId)
  );
}

function filterMissionActionsWithYieldIndex(
  actions: MissionAction[],
  relevantItems: Set<string>,
  filter?: MissionActionFilter | null
): { actions: MissionAction[]; indexFilteredCount: number; coverageRepairCount: number } {
  if (!filter || actions.length === 0) {
    return {
      actions,
      indexFilteredCount: 0,
      coverageRepairCount: 0,
    };
  }

  const selectedByKey = new Map<string, MissionAction>();
  for (const action of actions) {
    if (actionAllowedByMissionYieldIndex(action, filter)) {
      selectedByKey.set(action.key, action);
    }
  }

  let coverageRepairCount = 0;
  const repairedItemKeys = Array.from(relevantItems).sort();
  for (const itemKey of repairedItemKeys) {
    const alreadyCovered = Array.from(selectedByKey.values()).some((action) => (action.yields[itemKey] || 0) > SCORE_EPS);
    if (alreadyCovered) {
      continue;
    }
    const repairActions = actions
      .filter((action) => (action.yields[itemKey] || 0) > SCORE_EPS)
      .sort((a, b) => {
        const aRate = (a.yields[itemKey] || 0) / Math.max(1, a.durationSeconds);
        const bRate = (b.yields[itemKey] || 0) / Math.max(1, b.durationSeconds);
        const rateDiff = bRate - aRate;
        if (Math.abs(rateDiff) > SCORE_EPS) {
          return rateDiff;
        }
        return missionYieldIndexActionId(a).localeCompare(missionYieldIndexActionId(b));
      })
      .slice(0, MISSION_YIELD_INDEX_COVERAGE_REPAIR_PER_ITEM);
    for (const action of repairActions) {
      if (!selectedByKey.has(action.key)) {
        selectedByKey.set(action.key, action);
        coverageRepairCount += 1;
      }
    }
  }

  const filtered = Array.from(selectedByKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  return {
    actions: filtered,
    indexFilteredCount: Math.max(0, actions.length - filtered.length),
    coverageRepairCount,
  };
}

function missionYieldIndexEnabled(disabledByOption?: boolean, injectedLootData?: LootJson): boolean {
  if (disabledByOption) {
    return false;
  }
  if (injectedLootData) {
    return false;
  }
  if (process.env.NODE_ENV === "test" || process.env.MISSION_YIELD_INDEX_DISABLED === "1") {
    return false;
  }
  return MISSION_YIELD_INDEX.schemaVersion === 1;
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

function bestFuelPerUnit(itemKey: string, actions: MissionAction[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const action of actions) {
    const yieldPerMission = action.yields[itemKey] || 0;
    if (yieldPerMission <= 0) {
      continue;
    }
    const fuelPerItem = getVirtueFuelPerLaunch(action.ship, action.durationType) / yieldPerMission;
    if (fuelPerItem < best) {
      best = fuelPerItem;
    }
  }
  return best;
}

function computeObjectiveReferences(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  actions: MissionAction[];
  targetDemandByItem?: Map<string, number>;
}): { geRef: number; fuelRef: number; timeRef: number } {
  const { profile, targetKey, quantity, actions } = options;
  const quantityInt = Math.max(1, Math.round(quantity));
  const targetDemandByItem = options.targetDemandByItem && options.targetDemandByItem.size > 0
    ? options.targetDemandByItem
    : new Map([[targetKey, quantityInt]]);
  const craftUpperBounds = estimateCraftUpperBoundsForTargets(targetDemandByItem);

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
  let maxTargetRecipeCost = getRecipe(targetKey)?.cost || 1;
  for (const itemKey of targetDemandByItem.keys()) {
    maxTargetRecipeCost = Math.max(maxTargetRecipeCost, getRecipe(itemKey)?.cost || 1);
  }
  const geRef = Math.max(1, geUpperBound, maxTargetRecipeCost);

  let timeRef = 0;
  let hasFiniteTargetTime = false;
  for (const [itemKey, demandQty] of targetDemandByItem.entries()) {
    const targetTimePerUnit = bestTimePerUnit(itemKey, actions);
    if (Number.isFinite(targetTimePerUnit)) {
      timeRef += targetTimePerUnit * Math.max(1, Math.round(demandQty));
      hasFiniteTargetTime = true;
    }
  }
  if (!hasFiniteTargetTime) {
    timeRef = Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(timeRef)) {
    const fastestActionDuration = actions.length > 0 ? Math.min(...actions.map((action) => action.durationSeconds)) : 3600;
    timeRef = fastestActionDuration / 3;
  }
  let fuelRef = 0;
  let hasFiniteTargetFuel = false;
  for (const [itemKey, demandQty] of targetDemandByItem.entries()) {
    const targetFuelPerUnit = bestFuelPerUnit(itemKey, actions);
    if (Number.isFinite(targetFuelPerUnit)) {
      fuelRef += targetFuelPerUnit * Math.max(1, Math.round(demandQty));
      hasFiniteTargetFuel = true;
    }
  }
  if (!hasFiniteTargetFuel) {
    fuelRef = Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(fuelRef)) {
    fuelRef = actions.length > 0
      ? Math.max(...actions.map((action) => getVirtueFuelPerLaunch(action.ship, action.durationType)))
      : 1;
  }
  return {
    geRef,
    fuelRef: Math.max(1, fuelRef),
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
  consumptions: Record<string, number>;
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
  targetDemandByItem?: Map<string, number>;
  consumptionOptions?: ConsumptionOption[];
}): CraftModelSkeleton {
  const { profile, targetKey, quantity, closure } = options;
  const itemKeys = Array.from(closure).sort();
  const unmetVarByItem = new Map<string, string>();
  for (let index = 0; index < itemKeys.length; index += 1) {
    unmetVarByItem.set(itemKeys[index], `u_${index}`);
  }

  const targetDemandByItem = options.targetDemandByItem && options.targetDemandByItem.size > 0
    ? options.targetDemandByItem
    : new Map([[targetKey, quantity]]);
  const craftUpperBounds = estimateCraftUpperBoundsForTargets(targetDemandByItem, options.consumptionOptions || []);
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

  const demandByItem = new Map<string, number>(
    itemKeys.map((itemKey) => [itemKey, Math.max(0, Math.round(targetDemandByItem.get(itemKey) || 0))])
  );

  return { itemKeys, craftModels, craftModelByItem, unmetVarByItem, demandByItem };
}

async function solveUnifiedCraftMissionPlan(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  priorityTime: number;
  objectiveMode?: MissionObjectiveMode;
  minimumTimePriority?: number;
  closure: Set<string>;
  actions: MissionAction[];
  geRef: number;
  fuelRef?: number;
  timeRef: number;
  requiredMissionLaunches?: Record<string, RequiredMissionLaunchConstraint>;
  maxMissionLaunchesByOption?: Record<string, number>;
  optionLaunchPrecedenceChains?: string[][];
  phasedChainConstraints?: PhasedChainConstraint[];
  geCostUpperBound?: number;
  strictGeObjective?: boolean;
  totalSlotSecondsUpperBound?: number;
  timeLimitSeconds?: number;
  lpRelaxation?: boolean;
  targetCraftedOnly?: boolean;
  targetCraftedOnlyKeys?: Set<string>;
  consumptionOptions?: ConsumptionOption[];
  craftSkeleton?: CraftModelSkeleton;
  onSolveMetrics?: (metrics: UnifiedSolveMetrics) => void;
  solverFn?: SolverFunction;
}): Promise<UnifiedPlan> {
  const {
    profile,
    targetKey,
    quantity,
    priorityTime,
    objectiveMode,
    minimumTimePriority,
    closure,
    actions,
    geRef,
    fuelRef = 1,
    timeRef,
    requiredMissionLaunches = {},
    maxMissionLaunchesByOption = {},
    optionLaunchPrecedenceChains = [],
    phasedChainConstraints = [],
    geCostUpperBound,
    strictGeObjective = false,
    totalSlotSecondsUpperBound,
    timeLimitSeconds,
    lpRelaxation = false,
    targetCraftedOnly = false,
    targetCraftedOnlyKeys,
    consumptionOptions = [],
    craftSkeleton,
    onSolveMetrics,
    solverFn: solverFnOption,
  } = options;
  const effectiveTargetCraftedOnlyKeys = targetCraftedOnlyKeys || (targetCraftedOnly && isCraftedOnlyEligibleGoalKey(targetKey) ? new Set([targetKey]) : new Set<string>());
  const solve = solverFnOption ?? await getDefaultSolverFn();
  const {
    itemKeys,
    craftModels,
    craftModelByItem,
    unmetVarByItem,
    demandByItem,
  } = craftSkeleton || buildCraftModelSkeleton({ profile, targetKey, quantity, closure, consumptionOptions });
  const missionVars = actions.map((_, index) => `m_${index}`);
  const consumptionVars = consumptionOptions.map((_, index) => `x_${index}`);
  const normalizedGeRef = Math.max(1, geRef);
  const normalizedFuelRef = Math.max(1, fuelRef);
  const normalizedTimeRef = Math.max(1, timeRef);
  const objectiveContext = normalizeObjectiveContext(objectiveMode, priorityTime, minimumTimePriority);

  const lines: string[] = [];
  lines.push("Minimize");
  const objectiveTerms: Array<{ coefficient: number; variable: string }> = [];
  const geConstraintTerms: Array<{ coefficient: number; variable: string }> = [];
  let maxObjectiveCoeff = 1;

  for (const model of craftModels) {
    for (let index = 0; index < model.preDiscountStepVars.length; index += 1) {
      const geCoeff = model.preDiscountStepCosts[index];
      geConstraintTerms.push({
        coefficient: geCoeff,
        variable: model.preDiscountStepVars[index],
      });
      const coefficient = objectiveContext.mode === "ge"
        ? (objectiveContext.resourceWeight * geCoeff) / normalizedGeRef
        : (VIRTUE_GE_TIEBREAKER_WEIGHT * geCoeff) / normalizedGeRef;
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
      geConstraintTerms.push({
        coefficient: tailCost,
        variable: model.tailVar,
      });
      const coefficient = objectiveContext.mode === "ge"
        ? (objectiveContext.resourceWeight * tailCost) / normalizedGeRef
        : (VIRTUE_GE_TIEBREAKER_WEIGHT * tailCost) / normalizedGeRef;
      objectiveTerms.push({
        coefficient,
        variable: model.tailVar,
      });
      maxObjectiveCoeff = Math.max(maxObjectiveCoeff, Math.abs(coefficient));
    }
  }

  const missionObjectiveWeight = strictGeObjective ? 0 : Math.max(objectiveContext.timeWeight, MIN_MISSION_TIME_OBJECTIVE_WEIGHT);
  if (missionObjectiveWeight > 0) {
    const missionLaunchTiebreakCoeff = (missionObjectiveWeight * MISSION_LAUNCH_TIEBREAKER_SECONDS) / normalizedTimeRef;
    const targetedTiebreakCoeff = (missionObjectiveWeight * TARGETED_MISSION_TIEBREAKER_SECONDS) / normalizedTimeRef;
    for (let index = 0; index < actions.length; index += 1) {
      const fuelCoeff = objectiveContext.mode === "virtueFuel"
        ? (objectiveContext.resourceWeight * getVirtueFuelPerLaunch(actions[index].ship, actions[index].durationType)) / normalizedFuelRef
        : 0;
      const coefficient =
        fuelCoeff +
        (missionObjectiveWeight * (actions[index].durationSeconds / 3)) / normalizedTimeRef +
        missionLaunchTiebreakCoeff +
        (isUntargetedTargetAfxId(actions[index].targetAfxId) ? 0 : targetedTiebreakCoeff);
      objectiveTerms.push({
        coefficient,
        variable: missionVars[index],
      });
      maxObjectiveCoeff = Math.max(maxObjectiveCoeff, Math.abs(coefficient));
    }
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
    const demandQty = demandByItem.get(itemKey) || 0;
    const inventoryQty = demandQty > 0 ? 0 : Math.max(0, profile.inventory[itemKey] || 0);
    const terms: Array<{ coefficient: number; variable: string }> = [];

    const outputModel = craftModelByItem.get(itemKey);
    if (outputModel) {
      terms.push({ coefficient: 1, variable: outputModel.craftVar });
    }
    for (let consumptionIndex = 0; consumptionIndex < consumptionOptions.length; consumptionIndex += 1) {
      const option = consumptionOptions[consumptionIndex];
      if (option.sourceItemKey === itemKey) {
        terms.push({ coefficient: -1, variable: consumptionVars[consumptionIndex] });
      }
      const yieldQty = option.yields[itemKey] || 0;
      if (yieldQty > SCORE_EPS) {
        terms.push({ coefficient: yieldQty, variable: consumptionVars[consumptionIndex] });
      }
    }
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const yieldPerMission = actions[actionIndex].yields[itemKey] || 0;
      if (yieldPerMission > SCORE_EPS && !effectiveTargetCraftedOnlyKeys.has(itemKey)) {
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
  // For each phase i > 0: every lower phase in the same ship/duration chain must be full.
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

      for (let previousPhaseIndex = 0; previousPhaseIndex < phaseIndex; previousPhaseIndex += 1) {
        const previousPhaseKey = chain[previousPhaseIndex];
        const previousIndexes = actionIndexesByOption.get(previousPhaseKey) || [];
        const prevCap = Math.max(0, Math.round(caps[previousPhaseIndex] || 0));
        if (prevCap <= 0) {
          continue;
        }
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
  const hasGeCostUpperBound = geCostUpperBound !== undefined && Number.isFinite(geCostUpperBound);
  let geConstraintCount = 0;
  if (hasGeCostUpperBound) {
    const safeGeUpperBound = Math.max(0, Math.floor((geCostUpperBound as number) + SCORE_EPS));
    if (geConstraintTerms.length > 0) {
      lines.push(`  gc_0: ${formatLinearExpression(geConstraintTerms)} <= ${formatLpNumber(safeGeUpperBound)}`);
      geConstraintCount = 1;
    } else if (safeGeUpperBound < 0) {
      throw new Error(`invalid GE upper bound: ${geCostUpperBound}`);
    }
  }
  const hasSlotSecondsUpperBound = totalSlotSecondsUpperBound !== undefined && Number.isFinite(totalSlotSecondsUpperBound);
  let slotSecondsConstraintCount = 0;
  if (hasSlotSecondsUpperBound) {
    const safeSlotUpperBound = Math.max(0, Math.floor((totalSlotSecondsUpperBound as number) + SCORE_EPS));
    if (missionVars.length > 0) {
      const slotTerms: Array<{ coefficient: number; variable: string }> = [];
      for (let index = 0; index < actions.length; index += 1) {
        slotTerms.push({ coefficient: actions[index].durationSeconds, variable: missionVars[index] });
      }
      lines.push(`  ts_0: ${formatLinearExpression(slotTerms)} <= ${formatLpNumber(safeSlotUpperBound)}`);
      slotSecondsConstraintCount = 1;
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
  for (const variable of consumptionVars) {
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
        ...consumptionVars,
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
  const consumptionVarCount = consumptionVars.length;
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
    craftLinkConstraintCount +
    geConstraintCount +
    slotSecondsConstraintCount;

  const solveStartedAtMs = Date.now();
  const useExactMipGap = !lpRelaxation && (strictGeObjective || hasGeCostUpperBound);
  const solution = await solve(lines.join("\n"), {
    ...(lpRelaxation ? {} : { mip_rel_gap: useExactMipGap ? 0 : 0.01 }),
    ...(timeLimitSeconds !== undefined && Number.isFinite(timeLimitSeconds) && timeLimitSeconds > 0
      ? { time_limit: timeLimitSeconds }
      : {}),
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

  const consumptions: Record<string, number> = {};
  for (let index = 0; index < consumptionOptions.length; index += 1) {
    const rawValue = solution.Columns?.[consumptionVars[index]]?.Primal || 0;
    const rounded = Math.max(0, Math.round(rawValue));
    if (rounded > 0) {
      consumptions[consumptionOptions[index].sourceItemKey] = rounded;
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
    consumptions,
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

function missionDropRarityCacheKey(selection: ShinyRaritySelection): string {
  return `${selection.rare ? 1 : 0}${selection.epic ? 1 : 0}${selection.legendary ? 1 : 0}${selection.fragments ? 1 : 0}`;
}

function allowedShipDurationsCacheKey(
  allowedShipDurations?: Array<{ ship: string; durationType: string }>
): string {
  if (!allowedShipDurations || allowedShipDurations.length === 0) {
    return "*";
  }
  const unique = new Set<string>();
  for (const row of allowedShipDurations) {
    unique.add(`${row.ship}|${row.durationType}`);
  }
  return Array.from(unique).sort().join(",");
}

function closureFingerprint(closure: Set<string>): string {
  return Array.from(closure).sort().join(",");
}

function getTargetClosureCached(targetKey: string): Set<string> {
  const cached = closureCache.get(targetKey);
  if (cached) {
    return new Set(cached);
  }
  const closure = new Set<string>();
  collectClosure(targetKey, closure);
  closureCache.set(targetKey, new Set(closure));
  return closure;
}

function shipLevelsFingerprint(shipLevels: ShipLevelInfo[]): string {
  return shipLevels
    .slice()
    .sort((a, b) => a.ship.localeCompare(b.ship))
    .map(
      (row) =>
        `${row.ship}:${row.unlocked ? 1 : 0}:${row.level}:${row.maxLevel}:${row.launches}:${row.launchPoints}`
    )
    .join("|");
}

function profileProgressionCacheKey(
  profile: PlayerProfile,
  allowedDurationsKey: string
): string {
  const profileMissionOptionsKey =
    profile.missionOptions.length > 0 ? missionOptionsFingerprint(profile.missionOptions) : "none";
  return [
    shipLevelsFingerprint(profile.shipLevels),
    `ftl:${profile.epicResearchFTLLevel}`,
    `zerog:${profile.epicResearchZerogLevel}`,
    `opts:${profileMissionOptionsKey}`,
    `allow:${allowedDurationsKey}`,
  ].join("::");
}

function getLootObjectId(lootData: LootJson): number {
  const existing = lootObjectIds.get(lootData);
  if (existing !== undefined) {
    return existing;
  }
  const created = nextLootObjectId;
  nextLootObjectId += 1;
  lootObjectIds.set(lootData, created);
  return created;
}

function missionActionsCacheKey(options: {
  missionOptions: MissionOption[];
  closureKey: string;
  missionDropRarities: ShinyRaritySelection;
  lootData: LootJson;
  actionFilter?: MissionActionFilter | null;
}): string {
  return [
    `opts:${missionOptionsFingerprint(options.missionOptions)}`,
    `closure:${options.closureKey}`,
    `rar:${missionDropRarityCacheKey(options.missionDropRarities)}`,
    `loot:${getLootObjectId(options.lootData)}`,
    `filter:${options.actionFilter?.key || "none"}`,
  ].join("::");
}

async function getMissionActionsForOptionsCached(options: {
  missionOptions: MissionOption[];
  relevantItems: Set<string>;
  closureKey: string;
  lootData: LootJson;
  missionDropRarities: ShinyRaritySelection;
  actionFilter?: MissionActionFilter | null;
}): Promise<MissionActionCacheEntry> {
  const cacheKey = missionActionsCacheKey({
    missionOptions: options.missionOptions,
    closureKey: options.closureKey,
    missionDropRarities: options.missionDropRarities,
    lootData: options.lootData,
    actionFilter: options.actionFilter,
  });
  const cached = missionActionsCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const builtRaw = await buildMissionActionsForOptions(
    options.missionOptions,
    options.relevantItems,
    options.lootData,
    options.missionDropRarities
  );
  const builtPruned = pruneSubDominatedActions(
    builtRaw
  );
  const filtered = filterMissionActionsWithYieldIndex(
    builtPruned,
    options.relevantItems,
    options.actionFilter
  );
  const created: MissionActionCacheEntry = {
    actions: filtered.actions,
    rawCount: builtRaw.length,
    prunedCount: Math.max(0, builtRaw.length - builtPruned.length),
    indexFilteredCount: filtered.indexFilteredCount,
    coverageRepairCount: filtered.coverageRepairCount,
  };
  missionActionsCache.set(cacheKey, created);
  return created;
}

function craftCountsFingerprintForClosure(craftCounts: Record<string, number>, closure: Set<string>): string {
  return Array.from(closure)
    .sort()
    .map((itemKey) => `${itemKey}:${Math.max(0, Math.round(craftCounts[itemKey] || 0))}`)
    .join("|");
}

function craftSkeletonCacheKey(options: {
  targetKey: string;
  quantity: number;
  closure: Set<string>;
  profile: PlayerProfile;
  targetDemandByItem?: Map<string, number>;
  consumptionOptions?: ConsumptionOption[];
}): string {
  const demandKey = options.targetDemandByItem && options.targetDemandByItem.size > 0
    ? Array.from(options.targetDemandByItem.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([itemKey, qty]) => `${itemKey}:${Math.max(0, Math.round(qty))}`)
        .join("|")
    : `${options.targetKey}:${Math.max(1, Math.round(options.quantity))}`;
  const consumptionKey = options.consumptionOptions && options.consumptionOptions.length > 0
    ? options.consumptionOptions
        .map((option) => `${option.sourceItemKey}:${Object.entries(option.yields).sort(([a], [b]) => a.localeCompare(b)).map(([itemKey, qty]) => `${itemKey}=${qty}`).join(",")}`)
        .join("|")
    : "none";
  return [
    `target:${options.targetKey}`,
    `qty:${Math.max(1, Math.round(options.quantity))}`,
    `demand:${demandKey}`,
    `closure:${closureFingerprint(options.closure)}`,
    `consume:${consumptionKey}`,
    `counts:${craftCountsFingerprintForClosure(options.profile.craftCounts, options.closure)}`,
  ].join("::");
}

function getCraftSkeletonCached(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  closure: Set<string>;
  targetDemandByItem?: Map<string, number>;
  consumptionOptions?: ConsumptionOption[];
}): CraftModelSkeleton {
  const key = craftSkeletonCacheKey(options);
  const cached = craftSkeletonCache.get(key);
  if (cached) {
    return cached;
  }
  const created = buildCraftModelSkeleton(options);
  craftSkeletonCache.set(key, created);
  return created;
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

function durationTypeSortRank(durationType: DurationType): number {
  switch (durationType) {
    case "TUTORIAL":
      return 0;
    case "SHORT":
      return 1;
    case "LONG":
      return 2;
    case "EPIC":
      return 3;
    default:
      return 99;
  }
}

function buildAvailableCombosFromActions(
  primaryActions: MissionAction[],
  additionalActions: MissionAction[] = []
): AvailableCombo[] {
  const comboSet = new Set<string>();
  const availableCombos: AvailableCombo[] = [];
  const addActionCombo = (action: MissionAction) => {
    const comboKey = `${action.ship}|${action.durationType}|${action.targetAfxId}`;
    if (comboSet.has(comboKey)) {
      return;
    }
    comboSet.add(comboKey);
    availableCombos.push({
      ship: action.ship,
      durationType: action.durationType,
      targetAfxId: action.targetAfxId,
    });
  };

  for (const action of primaryActions) {
    addActionCombo(action);
  }
  for (const action of additionalActions) {
    addActionCombo(action);
  }
  return availableCombos;
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
    .sort((a, b) => {
      const shipDiff = a.ship.localeCompare(b.ship);
      if (shipDiff !== 0) {
        return shipDiff;
      }
      const durationDiff = durationTypeSortRank(a.durationType) - durationTypeSortRank(b.durationType);
      if (durationDiff !== 0) {
        return durationDiff;
      }
      const levelDiff = a.level - b.level;
      if (levelDiff !== 0) {
        return levelDiff;
      }
      const targetDiff = a.targetAfxId - b.targetAfxId;
      if (targetDiff !== 0) {
        return targetDiff;
      }
      return b.launches - a.launches;
    });
}

function buildCraftRows(crafts: Record<string, number>): PlanCraftRow[] {
  return Object.entries(crafts)
    .map(([itemKey, count]) => ({ itemId: itemKeyToId(itemKey), count }))
    .sort((a, b) => b.count - a.count);
}

function buildConsumptionRows(
  consumptions: Record<string, number>,
  consumptionOptions: ConsumptionOption[]
): PlanConsumptionRow[] {
  const optionBySource = new Map(consumptionOptions.map((option) => [option.sourceItemKey, option]));
  return Object.entries(consumptions)
    .filter(([, count]) => count > 0)
    .map(([sourceItemKey, countRaw]) => {
      const count = Math.max(0, Math.round(countRaw));
      const option = optionBySource.get(sourceItemKey);
      const yields = option
        ? Object.entries(option.yields)
            .map(([itemKey, perConsume]) => ({
              itemId: itemKeyToId(itemKey),
              quantity: count * Math.max(0, perConsume),
            }))
            .filter((row) => row.quantity > SCORE_EPS)
            .sort((a, b) => b.quantity - a.quantity || a.itemId.localeCompare(b.itemId))
        : [];
      return { itemId: itemKeyToId(sourceItemKey), count, yields };
    })
    .sort((a, b) => b.count - a.count || a.itemId.localeCompare(b.itemId));
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

function chooseFastQuantityAccelerationBlock(quantity: number): number {
  const safeQuantity = Math.max(1, Math.round(quantity));
  if (safeQuantity < FAST_QUANTITY_ACCELERATION_MIN_QUANTITY) {
    return safeQuantity;
  }
  if (safeQuantity <= 10) {
    return 1;
  }
  return Math.max(1, Math.min(FAST_QUANTITY_ACCELERATION_MAX_BLOCK_QUANTITY, Math.ceil(safeQuantity / 25)));
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function targetDemandGcd(targetDemandByItem: Map<string, number>): number {
  let gcd = 0;
  for (const quantity of targetDemandByItem.values()) {
    const safeQuantity = Math.max(0, Math.round(quantity));
    if (safeQuantity <= 0) {
      continue;
    }
    gcd = gcd === 0 ? safeQuantity : greatestCommonDivisor(gcd, safeQuantity);
  }
  return Math.max(1, gcd);
}

function divideTargetDemand(targetDemandByItem: Map<string, number>, divisor: number): Map<string, number> {
  const safeDivisor = Math.max(1, Math.round(divisor));
  if (safeDivisor <= 1) {
    return new Map(targetDemandByItem);
  }
  return new Map(
    Array.from(targetDemandByItem.entries()).map(([itemKey, quantity]) => [
      itemKey,
      Math.max(1, Math.round(quantity / safeDivisor)),
    ])
  );
}

function sumRecordValues(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, value) => sum + Math.max(0, value), 0);
}

function computeGeCostForCrafts(profile: PlayerProfile, crafts: Record<string, number>): number {
  let total = 0;
  for (const [itemKey, countRaw] of Object.entries(crafts)) {
    const recipe = getRecipe(itemKey);
    if (!recipe) {
      continue;
    }
    total += getBatchDiscountedCost(
      recipe.cost,
      Math.max(0, profile.craftCounts[itemKey] || 0),
      Math.max(0, Math.round(countRaw))
    );
  }
  return total;
}

function profileWithoutClosureInventory(profile: PlayerProfile, closure: Set<string>): PlayerProfile {
  const inventory = { ...profile.inventory };
  for (const itemKey of closure) {
    if (inventory[itemKey] !== undefined) {
      inventory[itemKey] = 0;
    }
  }
  return {
    ...profile,
    inventory,
  };
}

function computeRemainingDemandForPlan(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  closure: Set<string>;
  crafts: Record<string, number>;
  consumptions?: Record<string, number>;
  consumptionOptions?: ConsumptionOption[];
  actions: MissionAction[];
  missionCounts: Record<string, number>;
  targetCraftedOnly?: boolean;
  targetDemandByItem?: Map<string, number>;
  targetCraftedOnlyKeys?: Set<string>;
}): Record<string, number> {
  const {
    profile,
    targetKey,
    quantity,
    closure,
    crafts,
    consumptions = {},
    consumptionOptions = [],
    actions,
    missionCounts,
    targetCraftedOnly = false,
  } = options;
  const targetDemandByItem = options.targetDemandByItem && options.targetDemandByItem.size > 0
    ? options.targetDemandByItem
    : new Map([[targetKey, Math.max(0, Math.round(quantity))]]);
  const targetCraftedOnlyKeys = options.targetCraftedOnlyKeys || (targetCraftedOnly && isCraftedOnlyEligibleGoalKey(targetKey) ? new Set([targetKey]) : new Set<string>());
  const actionByKey = new Map(actions.map((action) => [action.key, action]));
  const remaining: Record<string, number> = {};

  for (const itemKey of Array.from(closure).sort()) {
    const demandQty = Math.max(0, Math.round(targetDemandByItem.get(itemKey) || 0));
    const inventoryQty = demandQty > 0 ? 0 : Math.max(0, profile.inventory[itemKey] || 0);
    const craftOutput = Math.max(0, Math.round(crafts[itemKey] || 0));
    const consumptionOutput = consumptionProducedByItem(itemKey, consumptions, consumptionOptions);
    let missionOutput = 0;
    if (!targetCraftedOnlyKeys.has(itemKey)) {
      for (const [actionKey, launchesRaw] of Object.entries(missionCounts)) {
        const action = actionByKey.get(actionKey);
        if (!action) {
          continue;
        }
        const launches = Math.max(0, Math.round(launchesRaw));
        missionOutput += (action.yields[itemKey] || 0) * launches;
      }
    }

    let ingredientConsumption = 0;
    for (const [craftedItemKey, craftCountRaw] of Object.entries(crafts)) {
      const craftCount = Math.max(0, Math.round(craftCountRaw));
      if (craftCount <= 0) {
        continue;
      }
      const recipe = getRecipe(craftedItemKey);
      const ingredientQty = recipe?.ingredients[itemKey] || 0;
      if (ingredientQty > 0) {
        ingredientConsumption += ingredientQty * craftCount;
      }
    }

    remaining[itemKey] = Math.max(
      0,
      demandQty - inventoryQty - craftOutput - consumptionOutput - missionOutput + ingredientConsumption + Math.max(0, Math.round(consumptions[itemKey] || 0))
    );
  }

  return remaining;
}

function computePreMissionDemandForPlan(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  closure: Set<string>;
  crafts: Record<string, number>;
  consumptions?: Record<string, number>;
  consumptionOptions?: ConsumptionOption[];
  targetDemandByItem?: Map<string, number>;
}): Record<string, number> {
  const { profile, targetKey, quantity, closure, crafts, consumptions = {}, consumptionOptions = [] } = options;
  const targetDemandByItem = options.targetDemandByItem && options.targetDemandByItem.size > 0
    ? options.targetDemandByItem
    : new Map([[targetKey, Math.max(0, Math.round(quantity))]]);
  const remaining: Record<string, number> = {};
  for (const itemKey of Array.from(closure).sort()) {
    const demandQty = Math.max(0, Math.round(targetDemandByItem.get(itemKey) || 0));
    const inventoryQty = demandQty > 0 ? 0 : Math.max(0, profile.inventory[itemKey] || 0);
    const craftOutput = Math.max(0, Math.round(crafts[itemKey] || 0));
    const consumptionOutput = consumptionProducedByItem(itemKey, consumptions, consumptionOptions);
    let ingredientConsumption = 0;
    for (const [craftedItemKey, craftCountRaw] of Object.entries(crafts)) {
      const craftCount = Math.max(0, Math.round(craftCountRaw));
      if (craftCount <= 0) {
        continue;
      }
      const recipe = getRecipe(craftedItemKey);
      const ingredientQty = recipe?.ingredients[itemKey] || 0;
      if (ingredientQty > 0) {
        ingredientConsumption += ingredientQty * craftCount;
      }
    }
    remaining[itemKey] = Math.max(
      0,
      demandQty - inventoryQty - craftOutput - consumptionOutput + ingredientConsumption + Math.max(0, Math.round(consumptions[itemKey] || 0))
    );
  }
  return remaining;
}

function demandSatisfied(demand: Record<string, number>): boolean {
  return Object.values(demand).every((qty) => qty <= 1e-6);
}

function applyMissionYieldToDemand(
  demand: Record<string, number>,
  action: MissionAction,
  launchesRaw: number,
  targetKey: string,
  targetCraftedOnly: boolean,
  targetCraftedOnlyKeys?: Set<string>
): Record<string, number> {
  const launches = Math.max(0, Math.round(launchesRaw));
  if (launches <= 0) {
    return { ...demand };
  }
  const next: Record<string, number> = { ...demand };
  const effectiveTargetCraftedOnlyKeys = targetCraftedOnlyKeys || (targetCraftedOnly && isCraftedOnlyEligibleGoalKey(targetKey) ? new Set([targetKey]) : new Set<string>());
  for (const [itemKey, yieldPerMission] of Object.entries(action.yields)) {
    if (effectiveTargetCraftedOnlyKeys.has(itemKey)) {
      continue;
    }
    if (yieldPerMission <= 0 || !next[itemKey]) {
      continue;
    }
    next[itemKey] = Math.max(0, next[itemKey] - yieldPerMission * launches);
  }
  return next;
}

function launchesNeededWithinChunk(options: {
  demand: Record<string, number>;
  action: MissionAction;
  maxLaunches: number;
  targetKey: string;
  targetCraftedOnly: boolean;
  targetCraftedOnlyKeys?: Set<string>;
}): number {
  const { demand, action, maxLaunches, targetKey, targetCraftedOnly, targetCraftedOnlyKeys } = options;
  const cap = Math.max(0, Math.round(maxLaunches));
  if (cap <= 0) {
    return 0;
  }
  if (!demandSatisfied(applyMissionYieldToDemand(demand, action, cap, targetKey, targetCraftedOnly, targetCraftedOnlyKeys))) {
    return cap;
  }

  let low = 0;
  let high = cap;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (demandSatisfied(applyMissionYieldToDemand(demand, action, mid, targetKey, targetCraftedOnly, targetCraftedOnlyKeys))) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}

function scaleMissionCountsForRepeatedBlock(options: {
  actions: MissionAction[];
  missionCounts: Record<string, number>;
  prepSteps: PrepProgressionStep[];
  factor: number;
}): Record<string, number> {
  const { actions, missionCounts, prepSteps, factor } = options;
  const safeFactor = Math.max(1, Math.round(factor));
  if (safeFactor <= 1) {
    return { ...missionCounts };
  }

  const actionByKey = new Map(actions.map((action) => [action.key, action]));
  const prepRequirements = aggregatePrepOptionRequirements(prepSteps);
  const byOption = new Map<string, Array<{ key: string; launches: number }>>();
  for (const [actionKey, launchesRaw] of Object.entries(missionCounts)) {
    const action = actionByKey.get(actionKey);
    const launches = Math.max(0, Math.round(launchesRaw));
    if (!action || launches <= 0) {
      continue;
    }
    const group = byOption.get(action.optionKey) || [];
    group.push({ key: actionKey, launches });
    byOption.set(action.optionKey, group);
  }

  const scaled: Record<string, number> = {};
  for (const [optionKey, entries] of byOption.entries()) {
    const prepLaunches = Math.min(
      entries.reduce((sum, entry) => sum + entry.launches, 0),
      Math.max(0, Math.round(prepRequirements.get(optionKey)?.launches || 0))
    );
    let prepOverScale = Math.max(0, (safeFactor - 1) * prepLaunches);
    const sorted = entries
      .map((entry) => ({ ...entry, scaled: entry.launches * safeFactor }))
      .sort((a, b) => b.launches - a.launches || a.key.localeCompare(b.key));

    for (const entry of sorted) {
      if (prepOverScale <= 0) {
        break;
      }
      const reduction = Math.min(entry.scaled, prepOverScale);
      entry.scaled -= reduction;
      prepOverScale -= reduction;
    }
    for (const entry of sorted) {
      const launches = Math.max(0, Math.round(entry.scaled));
      if (launches > 0) {
        scaled[entry.key] = launches;
      }
    }
  }

  return scaled;
}

function scaleUnifiedPlanForRequestedQuantity(options: {
  profile: PlayerProfile;
  targetKey: string;
  requestedQuantity: number;
  solvedQuantity: number;
  closure: Set<string>;
  actions: MissionAction[];
  unified: UnifiedPlan;
  prepSteps: PrepProgressionStep[];
  prepNoYieldSlotSeconds: number;
  targetCraftedOnly?: boolean;
  targetDemandByItem?: Map<string, number>;
  targetCraftedOnlyKeys?: Set<string>;
  consumptionOptions?: ConsumptionOption[];
}): { unified: UnifiedPlan; totalSlotSeconds: number; repeatFactor: number; unmetTotal: number } {
  const {
    profile,
    targetKey,
    requestedQuantity,
    solvedQuantity,
    closure,
    actions,
    unified,
    prepSteps,
    prepNoYieldSlotSeconds,
    targetCraftedOnly = false,
  } = options;
  const repeatFactor = Math.max(1, Math.ceil(Math.max(1, requestedQuantity) / Math.max(1, solvedQuantity)));
  const crafts: Record<string, number> = {};
  for (const [itemKey, countRaw] of Object.entries(unified.crafts)) {
    const count = Math.max(0, Math.round(countRaw));
    if (count > 0) {
      crafts[itemKey] = count * repeatFactor;
    }
  }
  const consumptions: Record<string, number> = {};
  for (const [itemKey, countRaw] of Object.entries(unified.consumptions)) {
    const count = Math.max(0, Math.round(countRaw));
    if (count > 0) {
      consumptions[itemKey] = count * repeatFactor;
    }
  }
  const missionCounts = scaleMissionCountsForRepeatedBlock({
    actions,
    missionCounts: unified.missionCounts,
    prepSteps,
    factor: repeatFactor,
  });
  const remainingDemand = computeRemainingDemandForPlan({
    profile,
    targetKey,
    quantity: requestedQuantity,
    closure,
    crafts,
    consumptions,
    consumptionOptions: options.consumptionOptions,
    actions,
    missionCounts,
    targetCraftedOnly,
    targetDemandByItem: options.targetDemandByItem,
    targetCraftedOnlyKeys: options.targetCraftedOnlyKeys,
  });
  const geCost = computeGeCostForCrafts(profile, crafts);
  const missionSlotSeconds = actions.reduce((sum, action) => {
    const launches = Math.max(0, Math.round(missionCounts[action.key] || 0));
    return sum + launches * action.durationSeconds;
  }, 0);

  return {
    unified: {
      crafts,
      consumptions,
      missionCounts,
      remainingDemand,
      geCost,
      totalSlotSeconds: missionSlotSeconds,
      notes: [...unified.notes],
    },
    totalSlotSeconds: prepNoYieldSlotSeconds + missionSlotSeconds,
    repeatFactor,
    unmetTotal: sumRecordValues(remainingDemand),
  };
}

async function refineScaledPlanWithProgression(options: {
  profile: PlayerProfile;
  targetKey: string;
  requestedQuantity: number;
  closure: Set<string>;
  actions: MissionAction[];
  unified: UnifiedPlan;
  prepSteps: PrepProgressionStep[];
  targetCraftedOnly?: boolean;
  targetDemandByItem?: Map<string, number>;
  targetCraftedOnlyKeys?: Set<string>;
  consumptionOptions?: ConsumptionOption[];
  lootData: LootJson;
  missionDropRarities: ShinyRaritySelection;
}): Promise<{ actions: MissionAction[]; unified: UnifiedPlan; prunedLaunches: number }> {
  const {
    profile,
    targetKey,
    requestedQuantity,
    closure,
    actions,
    unified,
    prepSteps,
    targetCraftedOnly = false,
    lootData,
    missionDropRarities,
  } = options;
  const actionByKey = new Map(actions.map((action) => [action.key, action]));
  const refinedActionByKey = new Map(actionByKey);
  const prepRequirements = aggregatePrepOptionRequirements(prepSteps);
  const launchEntries = Object.entries(unified.missionCounts)
    .map(([actionKey, launchesRaw]) => {
      const action = actionByKey.get(actionKey);
      const launches = Math.max(0, Math.round(launchesRaw));
      return action && launches > 0 ? { action, launches } : null;
    })
    .filter((entry): entry is { action: MissionAction; launches: number } => entry !== null)
    .sort((a, b) => {
      const aPrep = prepRequirements.has(a.action.optionKey) ? 0 : 1;
      const bPrep = prepRequirements.has(b.action.optionKey) ? 0 : 1;
      if (aPrep !== bPrep) {
        return aPrep - bPrep;
      }
      return a.action.durationSeconds - b.action.durationSeconds || b.launches - a.launches;
    });

  let demand = computePreMissionDemandForPlan({
    profile,
    targetKey,
    quantity: requestedQuantity,
    closure,
    crafts: unified.crafts,
    consumptions: unified.consumptions,
    consumptionOptions: options.consumptionOptions,
    targetDemandByItem: options.targetDemandByItem,
  });
  const launchCounts = shipLevelsToLaunchCounts(profile.shipLevels);
  for (const step of prepSteps) {
    incrementLaunchCounts(launchCounts, step.ship, step.durationType, step.launches);
  }
  const refinedMissionCounts: Record<string, number> = {};
  let prunedLaunches = 0;
  const dynamicActionCache = new Map<string, MissionAction | null>();

  const resolveCurrentAction = async (original: MissionAction): Promise<MissionAction> => {
    if (profile.shipLevels.length === 0) {
      return original;
    }
    const shipLevels = computeShipLevelsFromLaunchCounts(launchCounts);
    const option = buildMissionOptions(
      shipLevels,
      profile.epicResearchFTLLevel,
      profile.epicResearchZerogLevel
    ).find((candidate) => candidate.ship === original.ship && candidate.durationType === original.durationType);
    if (!option) {
      return original;
    }
    const cacheKey = `${missionOptionKey(option)}|${original.targetAfxId}`;
    if (dynamicActionCache.has(cacheKey)) {
      return dynamicActionCache.get(cacheKey) || original;
    }
    const currentActions = await buildMissionActionsForOptions(
      [option],
      closure,
      lootData,
      missionDropRarities
    );
    const current = currentActions.find((candidate) => candidate.targetAfxId === original.targetAfxId) || null;
    dynamicActionCache.set(cacheKey, current);
    if (current) {
      refinedActionByKey.set(current.key, current);
      return current;
    }
    const progressionOnlyAction: MissionAction = {
      key: `${cacheKey}|progression`,
      optionKey: missionOptionKey(option),
      missionId: option.missionId,
      ship: option.ship,
      durationType: option.durationType,
      level: option.level,
      lootLevel: option.level,
      durationSeconds: option.durationSeconds,
      targetAfxId: original.targetAfxId,
      yields: {},
    };
    refinedActionByKey.set(progressionOnlyAction.key, progressionOnlyAction);
    return progressionOnlyAction;
  };

  for (const entry of launchEntries) {
    let remainingLaunches = entry.launches;
    while (remainingLaunches > 0) {
      const currentAction = await resolveCurrentAction(entry.action);
      const currentInfo = computeShipLevelsFromLaunchCounts(launchCounts).find(
        (ship) => ship.ship === entry.action.ship
      );
      const launchesToNext = currentInfo
        ? launchesUntilShipLevelIncrease(
            launchCounts,
            entry.action.ship,
            entry.action.durationType,
            currentInfo.level,
            currentInfo.maxLevel
          )
        : Number.POSITIVE_INFINITY;
      const chunkLaunches = Math.max(
        1,
        Math.min(
          remainingLaunches,
          Number.isFinite(launchesToNext) ? Math.max(1, Math.round(launchesToNext)) : remainingLaunches
        )
      );
      const launchesToUse = launchesNeededWithinChunk({
        demand,
        action: currentAction,
        maxLaunches: chunkLaunches,
        targetKey,
        targetCraftedOnly,
        targetCraftedOnlyKeys: options.targetCraftedOnlyKeys,
      });
      if (launchesToUse > 0) {
        refinedMissionCounts[currentAction.key] = (refinedMissionCounts[currentAction.key] || 0) + launchesToUse;
        demand = applyMissionYieldToDemand(demand, currentAction, launchesToUse, targetKey, targetCraftedOnly, options.targetCraftedOnlyKeys);
        incrementLaunchCounts(launchCounts, entry.action.ship, entry.action.durationType, launchesToUse);
      }
      prunedLaunches += Math.max(0, chunkLaunches - launchesToUse);
      remainingLaunches -= chunkLaunches;
      if (demandSatisfied(demand)) {
        prunedLaunches += remainingLaunches;
        remainingLaunches = 0;
      }
    }
  }

  const remainingDemand = computeRemainingDemandForPlan({
    profile,
    targetKey,
    quantity: requestedQuantity,
    closure,
    crafts: unified.crafts,
    consumptions: unified.consumptions,
    consumptionOptions: options.consumptionOptions,
    actions: Array.from(refinedActionByKey.values()),
    missionCounts: refinedMissionCounts,
    targetCraftedOnly,
    targetDemandByItem: options.targetDemandByItem,
    targetCraftedOnlyKeys: options.targetCraftedOnlyKeys,
  });
  const totalSlotSeconds = Array.from(refinedActionByKey.values()).reduce((sum, action) => {
    const launches = Math.max(0, Math.round(refinedMissionCounts[action.key] || 0));
    return sum + launches * action.durationSeconds;
  }, 0);

  return {
    actions: Array.from(refinedActionByKey.values()),
    unified: {
      ...unified,
      missionCounts: refinedMissionCounts,
      remainingDemand,
      totalSlotSeconds,
    },
    prunedLaunches,
  };
}

async function repairScaledPlanRemainingDemand(options: {
  profile: PlayerProfile;
  targetKey: string;
  requestedQuantity: number;
  closure: Set<string>;
  actions: MissionAction[];
  unified: UnifiedPlan;
  prepSteps: PrepProgressionStep[];
  targetCraftedOnly?: boolean;
  targetDemandByItem?: Map<string, number>;
  targetCraftedOnlyKeys?: Set<string>;
  consumptionOptions?: ConsumptionOption[];
  solverFn?: SolverFunction;
}): Promise<{ unified: UnifiedPlan; repairedLaunches: number; notes: string[] }> {
  const {
    profile,
    targetKey,
    requestedQuantity,
    closure,
    actions,
    unified,
    prepSteps,
    targetCraftedOnly = false,
    solverFn,
  } = options;
  const repairDemand: Record<string, number> = {};
  for (const [itemKey, qty] of Object.entries(unified.remainingDemand)) {
    if (qty <= 1e-6) {
      continue;
    }
    if (targetCraftedOnly && isCraftedOnlyEligibleGoalKey(targetKey) && itemKey === targetKey) {
      continue;
    }
    repairDemand[itemKey] = qty;
  }
  if (Object.keys(repairDemand).length === 0) {
    return {
      unified,
      repairedLaunches: 0,
      notes: [],
    };
  }

  const projectedShipLevels = projectShipLevelsAfterPlannedLaunches({
    baseShipLevels: profile.shipLevels,
    prepSteps,
    actions,
    missionCounts: unified.missionCounts,
  });
  const maxLevelByShip = new Map(projectedShipLevels.map((ship) => [ship.ship, ship.level]));
  const repairActions = actions.filter((action) => {
    const projectedLevel = maxLevelByShip.get(action.ship);
    return projectedLevel !== undefined && action.level <= projectedLevel;
  });
  const allocation = await allocateMissionsWithSolver(repairActions, repairDemand, solverFn);
  const repairedMissionCounts: Record<string, number> = { ...unified.missionCounts };
  let repairedLaunches = 0;
  for (const [actionKey, launchesRaw] of Object.entries(allocation.missionCounts)) {
    const launches = Math.max(0, Math.round(launchesRaw));
    if (launches <= 0) {
      continue;
    }
    repairedMissionCounts[actionKey] = Math.max(0, Math.round(repairedMissionCounts[actionKey] || 0)) + launches;
    repairedLaunches += launches;
  }

  if (repairedLaunches <= 0) {
    return {
      unified,
      repairedLaunches: 0,
      notes: allocation.notes,
    };
  }

  const remainingDemand = computeRemainingDemandForPlan({
    profile,
    targetKey,
    quantity: requestedQuantity,
    closure,
    crafts: unified.crafts,
    consumptions: unified.consumptions,
    consumptionOptions: options.consumptionOptions,
    actions,
    missionCounts: repairedMissionCounts,
    targetCraftedOnly,
    targetDemandByItem: options.targetDemandByItem,
    targetCraftedOnlyKeys: options.targetCraftedOnlyKeys,
  });
  const totalSlotSeconds = actions.reduce((sum, action) => {
    const launches = Math.max(0, Math.round(repairedMissionCounts[action.key] || 0));
    return sum + launches * action.durationSeconds;
  }, 0);

  return {
    unified: {
      ...unified,
      missionCounts: repairedMissionCounts,
      remainingDemand,
      totalSlotSeconds,
      notes: [...unified.notes, ...allocation.notes],
    },
    repairedLaunches,
    notes: [
      `Added ${repairedLaunches.toLocaleString()} repair launch${repairedLaunches === 1 ? "" : "es"} at currently projected ship levels to cover residual ingredient demand from one-time inventory used by the representative block.`,
    ],
  };
}

function buildTargetBreakdown(options: {
  quantity: number;
  targetKey: string;
  crafts: Record<string, number>;
  actions: MissionAction[];
  missionCounts: Record<string, number>;
  remainingDemand: Record<string, number>;
  targetCraftedOnly?: boolean;
}): TargetBreakdown {
  const { quantity, targetKey, crafts, actions, missionCounts, remainingDemand, targetCraftedOnly = false } = options;
  const requested = Math.max(0, quantity);
  const shortfall = Math.max(0, remainingDemand[targetKey] || 0);
  const fulfilled = Math.max(0, requested - shortfall);
  const rawCraft = Math.max(0, crafts[targetKey] || 0);
  const effectiveTargetCraftedOnly = targetCraftedOnly && isCraftedOnlyEligibleGoalKey(targetKey);
  const rawMissionExpected = effectiveTargetCraftedOnly ? 0 : expectedTargetFromMissions(targetKey, actions, missionCounts);

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

function buildTargetBreakdowns(options: {
  targetDemandByItem: Map<string, number>;
  crafts: Record<string, number>;
  actions: MissionAction[];
  missionCounts: Record<string, number>;
  remainingDemand: Record<string, number>;
  targetCraftedOnlyKeys: Set<string>;
}): TargetBreakdownRow[] {
  return Array.from(options.targetDemandByItem.entries()).map(([targetKey, quantity]) => ({
    itemId: itemKeyToId(targetKey),
    ...buildTargetBreakdown({
      quantity,
      targetKey,
      crafts: options.crafts,
      actions: options.actions,
      missionCounts: options.missionCounts,
      remainingDemand: options.remainingDemand,
      targetCraftedOnly: options.targetCraftedOnlyKeys.has(targetKey),
    }),
  }));
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

function buildProgressionCandidates(
  profile: PlayerProfile,
  missionOptionFilter?: (options: MissionOption[]) => MissionOption[]
): ProgressionCandidate[] {
  const applyFilter = missionOptionFilter || ((opts: MissionOption[]) => opts);
  if (profile.shipLevels.length === 0) {
    return [
      {
        shipLevels: profile.shipLevels,
        missionOptions: applyFilter(profile.missionOptions),
        prepSteps: [],
        prepSlotSeconds: 0,
      },
    ];
  }

  const initialMissionOptions = applyFilter(
    profile.missionOptions.length > 0
      ? profile.missionOptions
      : buildMissionOptions(profile.shipLevels, profile.epicResearchFTLLevel, profile.epicResearchZerogLevel)
  );
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
        const nextMissionOptions = applyFilter(buildMissionOptions(
          action.nextShipLevels,
          profile.epicResearchFTLLevel,
          profile.epicResearchZerogLevel
        ));

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

function normalizePlannerTargets(targetItemId: string, quantity: number, targets?: PlannerTarget[]): {
  primaryTargetKey: string;
  primaryQuantity: number;
  targets: PlannerTarget[];
  targetDemandByItem: Map<string, number>;
  targetCraftedOnlyKeys: Set<string>;
} {
  const rawTargets = targets && targets.length > 0 ? targets : [{ targetItemId, quantity }];
  const targetDemandByItem = new Map<string, number>();
  for (const target of rawTargets) {
    const itemKey = itemIdToCanonicalKey(target.targetItemId);
    const safeQuantity = Math.max(1, Math.round(target.quantity));
    targetDemandByItem.set(itemKey, (targetDemandByItem.get(itemKey) || 0) + safeQuantity);
  }
  const normalizedTargets = Array.from(targetDemandByItem.entries()).map(([itemKey, qty]) => ({
    targetItemId: itemKeyToId(itemKey),
    quantity: Math.max(1, Math.round(qty)),
  }));
  const primary = normalizedTargets[0] || { targetItemId, quantity };
  const primaryTargetKey = itemIdToCanonicalKey(primary.targetItemId);
  const primaryQuantity = Math.max(1, Math.round(primary.quantity));
  return {
    primaryTargetKey,
    primaryQuantity,
    targets: normalizedTargets,
    targetDemandByItem,
    targetCraftedOnlyKeys: new Set(Array.from(targetDemandByItem.keys()).filter(isCraftedOnlyEligibleGoalKey)),
  };
}

async function planForTargetHeuristic(
  profile: PlayerProfile,
  targetItemId: string,
  quantity: number,
  priorityTimeRaw: number,
  plannerOptions: Pick<PlannerOptions, "missionDropRarities" | "targetCraftedOnly" | "solverFn" | "lootData" | "objectiveMode" | "minimumTimePriority"> = {}
): Promise<PlannedLaunches> {
  const targetKey = itemIdToCanonicalKey(targetItemId);
  const priorityTime = Math.max(0, Math.min(1, priorityTimeRaw));
  const objectiveContext = normalizeObjectiveContext(plannerOptions.objectiveMode, priorityTime, plannerOptions.minimumTimePriority);
  const effectivePriorityTime = Math.max(objectiveContext.timeWeight, MIN_MISSION_TIME_OBJECTIVE_WEIGHT);
  const quantityInt = Math.max(1, Math.round(quantity));
  const missionDropRarities = normalizeShinyRaritySelection(plannerOptions.missionDropRarities);
  const targetCraftedOnly = Boolean(plannerOptions.targetCraftedOnly);

  const closure = getTargetClosureCached(targetKey);
  const closureKey = closureFingerprint(closure);
  const lootData = plannerOptions.lootData ?? await getDefaultLootData();
  const actionFilter = missionYieldIndexEnabled(false, plannerOptions.lootData)
    ? buildMissionActionFilterFromYieldIndex({
        relevantItems: closure,
        missionDropRarities,
        topPerItem: MISSION_YIELD_INDEX_TOP_PER_ITEM_FAST,
      })
    : null;
  const actionsEntry = await getMissionActionsForOptionsCached({
    missionOptions: profile.missionOptions,
    relevantItems: closure,
    closureKey,
    lootData,
    missionDropRarities,
    actionFilter,
  });
  const actions = actionsEntry.actions;

  const inventory: Record<string, number> = { ...profile.inventory };
  const craftCounts: Record<string, number> = { ...profile.craftCounts };
  const crafts: Record<string, number> = {};
  const demand: Record<string, number> = {};

  const { geRef, fuelRef, timeRef } = computeObjectiveReferences({
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
      const craftScore = objectiveContext.mode === "ge"
        ? normalizedScore(craftGe, 0, effectivePriorityTime, geRef, timeRef)
        : Number.POSITIVE_INFINITY;

      const farmTpu = bestTimePerUnit(itemKey, actions);
      const farmScore = Number.isFinite(farmTpu)
        ? normalizedScore(0, farmTpu, effectivePriorityTime, geRef, timeRef)
        : Number.POSITIVE_INFINITY;

      const chooseFarm = !(targetCraftedOnly && isCraftedOnlyEligibleGoalKey(targetKey) && itemKey === targetKey && depth === 0) && farmScore + SCORE_EPS < craftScore;
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
  const fuelCost = missionFuelCost(actions, missionCounts);
  const remainingDemandAfterMissions = missionAllocation.remainingDemand;

  const expectedHours = estimateThreeSlotExpectedHours({
    actions,
    missionCounts,
  });
  const weightedScore = normalizedObjectiveScore(
    objectiveResourceCost(objectiveContext, geCost, fuelCost),
    totalSlotSeconds / 3,
    objectiveContext,
    objectiveContext.mode === "virtueFuel" ? fuelRef : geRef,
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
    targetCraftedOnly,
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
  if (targetCraftedOnly) {
    notes.push("Artifacts-only crafted goal mode enabled: mission drops do not count toward shiny-capable artifact goals, but still count toward stones and ingredient goals.");
  }
  notes.push(missionDropRarityNote(missionDropRarities));
  notes.push(
    "Ship progression snapshot reflects projected levels after applying all launches in this plan (prep + farming), and is not persisted."
  );

  return {
    targetItemId: itemKeyToId(targetKey),
    quantity: quantityInt,
    targets: [{ targetItemId: itemKeyToId(targetKey), quantity: quantityInt }],
    priorityTime,
    objectiveMode: objectiveContext.mode,
    geCost,
    fuelCost,
    totalSlotSeconds,
    expectedHours,
    weightedScore,
    crafts: craftRows,
    consumptions: [],
    missions: missionRows,
    unmetItems,
    targetBreakdown,
    targetBreakdowns: [{ itemId: itemKeyToId(targetKey), ...targetBreakdown }],
    progression: {
      prepHours: 0,
      prepLaunches: [],
      projectedShipLevels: progressionShipRows(projectedShipLevels),
    },
    notes,
    availableCombos: [],
  };
}

/**
 * Fold the player's outstanding missions into the plan.
 *
 * Their drops are added to the supply the solver plans against, so it stops
 * asking for launches the player has already committed to, and their remaining
 * flight time is charged to the mission slots they are still holding. The rows
 * come back tagged `inAir` so the UI can report the drops as expected mission
 * yield rather than inventory the player cannot spend yet.
 */
export async function planForTarget(
  profile: PlayerProfile,
  targetItemId: string,
  quantity: number,
  priorityTimeRaw: number,
  plannerOptions: PlannerOptions = {}
): Promise<PlannerResult> {
  const missionDropRarities = normalizeShinyRaritySelection(plannerOptions.missionDropRarities);
  const inFlight = await projectInFlightMissions(profile.inFlightMissions || [], {
    lootData: plannerOptions.lootData,
    includeRarities: missionDropRarities,
    includeStoneFragments: missionDropRarities.fragments,
  });

  const planningProfile: PlayerProfile =
    Object.keys(inFlight.yields).length > 0
      ? { ...profile, inventory: mergeInventory(profile.inventory, inFlight.yields) }
      : profile;

  const result = await planForNewLaunches(
    planningProfile,
    targetItemId,
    quantity,
    priorityTimeRaw,
    plannerOptions
  );

  return withInFlightSchedule(result, inFlight);
}

function mergeInventory(inventory: Inventory, extra: Record<string, number>): Inventory {
  const merged: Inventory = { ...inventory };
  for (const [itemKey, quantity] of Object.entries(extra)) {
    merged[itemKey] = (merged[itemKey] || 0) + quantity;
  }
  return merged;
}

/**
 * In-air ships each hold one of the three mission slots until they land, so the
 * lanes start busy. Everything the plan still has to launch is packed after.
 */
function inAirLaneLoads(rows: InFlightMissionRow[]): number[] {
  return rows
    .flatMap((row) => row.launchSecondsRemaining)
    .sort((a, b) => b - a)
    .slice(0, 3);
}

function withInFlightSchedule(result: PlannedLaunches, inFlight: InFlightProjection): PlannerResult {
  const missionSeconds = Math.max(0, Math.round(result.expectedHours * 3600));
  if (inFlight.missionCount === 0) {
    return {
      ...result,
      inFlight: { missionCount: 0, secondsRemaining: 0 },
      schedule: { missionSeconds, inAirSeconds: 0, totalSeconds: missionSeconds },
    };
  }

  const segments = result.missions.map((mission) => ({
    launches: mission.launches,
    durationSeconds: mission.durationSeconds,
  }));
  const prepSlotSeconds = result.progression.prepLaunches.reduce(
    (sum, prep) => sum + Math.max(0, prep.launches) * Math.max(0, prep.durationSeconds),
    0
  );
  const totalSeconds = Math.round(
    estimateThreeSlotMakespanSeconds(segments, prepSlotSeconds, inAirLaneLoads(inFlight.rows))
  );

  return {
    ...result,
    missions: [
      ...result.missions,
      ...inFlight.rows.map((row) => ({
        missionId: row.missionId,
        ship: row.ship,
        durationType: row.durationType,
        level: row.level,
        targetAfxId: row.targetAfxId,
        launches: row.launches,
        durationSeconds: row.durationSeconds,
        expectedYields: row.expectedYields,
        inAir: true,
        secondsRemaining: row.secondsRemaining,
        launchSecondsRemaining: row.launchSecondsRemaining,
      })),
    ],
    inFlight: {
      missionCount: inFlight.missionCount,
      secondsRemaining: inFlight.secondsRemaining,
    },
    schedule: {
      missionSeconds,
      inAirSeconds: inFlight.secondsRemaining,
      totalSeconds: Math.max(totalSeconds, inFlight.secondsRemaining),
    },
  };
}

async function planForNewLaunches(
  profile: PlayerProfile,
  targetItemId: string,
  quantity: number,
  priorityTimeRaw: number,
  plannerOptions: PlannerOptions = {}
): Promise<PlannedLaunches> {
  const normalizedTargets = normalizePlannerTargets(targetItemId, quantity, plannerOptions.targets);
  const targetKey = normalizedTargets.primaryTargetKey;
  const priorityTime = Math.max(0, Math.min(1, priorityTimeRaw));
  const objectiveContext = normalizeObjectiveContext(
    plannerOptions.objectiveMode,
    priorityTime,
    plannerOptions.minimumTimePriority
  );
  const objectiveMode = objectiveContext.mode;
  const quantityInt = normalizedTargets.primaryQuantity;
  const multiTarget = normalizedTargets.targets.length > 1;
  const fastMode = Boolean(plannerOptions.fastMode);
  const missionDropRarities = normalizeShinyRaritySelection(plannerOptions.missionDropRarities);
  const targetCraftedOnly = Boolean(plannerOptions.targetCraftedOnly);
  const selectedConsumptionItemKeys = normalizeConsumptionItemKeys(plannerOptions.selectedConsumptionItemIds);
  const multiTargetScaleFactor = multiTarget ? targetDemandGcd(normalizedTargets.targetDemandByItem) : 1;
  const singleTargetFastQuantityAcceleration =
    fastMode &&
    !multiTarget &&
    !plannerOptions.disableFastQuantityAcceleration &&
    quantityInt >= FAST_QUANTITY_ACCELERATION_MIN_QUANTITY;
  const multiTargetFastQuantityAcceleration =
    fastMode &&
    multiTarget &&
    !plannerOptions.disableFastQuantityAcceleration &&
    multiTargetScaleFactor > 1;
  const fastQuantityAcceleration = singleTargetFastQuantityAcceleration || multiTargetFastQuantityAcceleration;
  const solveQuantity = singleTargetFastQuantityAcceleration
    ? chooseFastQuantityAccelerationBlock(quantityInt)
    : multiTargetFastQuantityAcceleration
      ? Math.max(1, Math.round(quantityInt / multiTargetScaleFactor))
    : quantityInt;
  const solveTargetDemandByItem = multiTargetFastQuantityAcceleration
    ? divideTargetDemand(normalizedTargets.targetDemandByItem, multiTargetScaleFactor)
    : multiTarget
      ? normalizedTargets.targetDemandByItem
    : new Map([[targetKey, solveQuantity]]);
  const missionDropRarityKey = missionDropRarityCacheKey(missionDropRarities);
  const solverFn = plannerOptions.solverFn;
  const injectedLootData = plannerOptions.lootData;
  const allowedDurationsKey = allowedShipDurationsCacheKey(plannerOptions.allowedShipDurations);
  const missionOptionFilter = plannerOptions.allowedShipDurations
    ? (() => {
        const allowed = new Set(
          plannerOptions.allowedShipDurations!.map((sd) => `${sd.ship}|${sd.durationType}`)
        );
        return (options: MissionOption[]) => options.filter((o) => allowed.has(`${o.ship}|${o.durationType}`));
      })()
    : undefined;
  const benchmarkStartedAtMs = Date.now();
  let benchmarkExcludedMs = 0;
  const reportBenchmark = (result: PlannedLaunches, path: "primary" | "fallback") => {
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

  let fastIncumbentResult: PlannedLaunches | null = null;
  if (
    !fastMode &&
    ENABLE_NORMAL_FAST_INCUMBENT_COMPARISON &&
    !plannerOptions.disableNormalFastIncumbent &&
    quantityInt >= FAST_QUANTITY_ACCELERATION_MIN_QUANTITY
  ) {
    reportProgress({
      phase: "init",
      message: "Testing fast scaled incumbent for normal-mode comparison...",
    });
    await yieldForProgressFlush();
    try {
      fastIncumbentResult = await planForTarget(profile, targetItemId, quantityInt, priorityTime, {
        fastMode: true,
        objectiveMode,
        minimumTimePriority: objectiveContext.minimumTimePriority,
        targetCraftedOnly,
        missionDropRarities,
        selectedConsumptionItemIds: Array.from(selectedConsumptionItemKeys).map((itemKey) => itemKeyToId(itemKey)),
        allowedShipDurations: plannerOptions.allowedShipDurations,
        solverFn,
        lootData: injectedLootData,
        disableNormalFastIncumbent: true,
      });
    } catch {
      fastIncumbentResult = null;
    }
  }

  const shouldAdoptFastIncumbentResult = (normalResult: PlannedLaunches): boolean => {
    if (!fastIncumbentResult) {
      return false;
    }
    const fastUnmet = fastIncumbentResult.unmetItems.reduce((sum, item) => sum + Math.max(0, item.quantity), 0);
    const normalUnmet = normalResult.unmetItems.reduce((sum, item) => sum + Math.max(0, item.quantity), 0);
    if (fastUnmet > normalUnmet + 1e-6) {
      return false;
    }
    if (fastUnmet + 1e-6 < normalUnmet) {
      return true;
    }
    const fastHours = Math.max(0, fastIncumbentResult.expectedHours);
    const normalHours = Math.max(0, normalResult.expectedHours);
    const fastResource = Math.max(0, objectiveResourceCost(objectiveContext, fastIncumbentResult.geCost, fastIncumbentResult.fuelCost));
    const normalResource = Math.max(0, objectiveResourceCost(objectiveContext, normalResult.geCost, normalResult.fuelCost));
    if (fastHours + 1 / 3600 < normalHours && fastResource <= normalResource + SCORE_EPS) {
      return true;
    }
    if (fastHours <= normalHours * 0.99 && fastResource <= normalResource * 1.05 + SCORE_EPS) {
      return true;
    }
    const resourceRef = Math.max(1, fastResource, normalResource);
    const timeRef = Math.max(1, normalResult.totalSlotSeconds / 3);
    const fastScore = normalizedObjectiveScore(fastResource, fastIncumbentResult.totalSlotSeconds / 3, objectiveContext, resourceRef, timeRef);
    const normalScore = normalizedObjectiveScore(normalResource, normalResult.totalSlotSeconds / 3, objectiveContext, resourceRef, timeRef);
    return fastScore + SCORE_EPS < normalScore && fastHours <= normalHours * 1.01;
  };
  const maybeAdoptFastIncumbentResult = (normalResult: PlannedLaunches): PlannedLaunches => {
    if (!shouldAdoptFastIncumbentResult(normalResult) || !fastIncumbentResult) {
      return normalResult;
    }
    return {
      ...fastIncumbentResult,
      notes: [
        `Normal solve adopted the fast scaled incumbent because it compared better than the full normal result (${missionDurationLabel(
          fastIncumbentResult.expectedHours * 3600
        )} vs ${missionDurationLabel(normalResult.expectedHours * 3600)}, ${Math.round(
          fastIncumbentResult.geCost
        ).toLocaleString()} GE vs ${Math.round(normalResult.geCost).toLocaleString()} GE).`,
        ...fastIncumbentResult.notes,
      ],
    };
  };

  reportProgress({
    phase: "init",
    message: "Building ingredient closure and progression candidates...",
  });
  await yieldForProgressFlush();

  const closure = getTargetClosureCached(targetKey);
  for (const target of normalizedTargets.targets) {
    for (const itemKey of getTargetClosureCached(itemIdToCanonicalKey(target.targetItemId))) {
      closure.add(itemKey);
    }
  }
  const consumptionOptions = buildConsumptionOptionsForClosure(selectedConsumptionItemKeys, closure);
  const closureKey = closureFingerprint(closure);
  const representativeBlockProfile = profile;
  const missionYieldIndexTopPerItem = Math.max(
    1,
    Math.round(
      plannerOptions.missionYieldIndexTopPerItem ||
        (fastMode ? MISSION_YIELD_INDEX_TOP_PER_ITEM_FAST : MISSION_YIELD_INDEX_TOP_PER_ITEM_NORMAL)
    )
  );
  const missionActionFilter = missionYieldIndexEnabled(plannerOptions.disableMissionYieldIndex, injectedLootData)
    ? buildMissionActionFilterFromYieldIndex({
        relevantItems: closure,
        missionDropRarities,
        topPerItem: missionYieldIndexTopPerItem,
      })
    : null;

  const progressionKey = profileProgressionCacheKey(profile, allowedDurationsKey);
  const cachedProgression = progressionCache.get(progressionKey);
  const progressionDeduped = cachedProgression
    ? cachedProgression
    : (() => {
        const progressionCandidatesRaw = buildProgressionCandidates(profile, missionOptionFilter);
        const deduped = dedupeProgressionCandidatesByMissionOptions(progressionCandidatesRaw);
        progressionCache.set(progressionKey, deduped);
        return deduped;
      })();

  const fastCandidateLimit = objectiveMode === "ge" && priorityTime <= SCORE_EPS
    ? NORMAL_MODE_MAX_CANDIDATES
    : FAST_MODE_MAX_CANDIDATES;
  const candidateLimit = fastMode ? fastCandidateLimit : NORMAL_MODE_MAX_CANDIDATES;
  const progressionCandidates = progressionDeduped.unique.slice(0, candidateLimit);
  const candidateReuseKey = [
    progressionKey,
    `target:${targetKey}`,
    `targets:${normalizedTargets.targets.map((target) => `${target.targetItemId}:${target.quantity}`).join(",")}`,
    `qty:${solveQuantity}`,
    `rar:${missionDropRarityKey}`,
    `craftedOnly:${targetCraftedOnly ? 1 : 0}`,
    `consume:${consumptionOptions.map((option) => option.sourceItemKey).join(",") || "none"}`,
    `mode:${objectiveMode}:${priorityTime <= SCORE_EPS ? "ge" : "mix"}:${objectiveContext.minimumTimePriority}`,
    `fast:${fastMode ? 1 : 0}`,
    `filter:${missionActionFilter?.key || "none"}`,
  ].join("::");
  const preferredCandidateFingerprint = bestCandidateFingerprintCache.get(candidateReuseKey);
  if (preferredCandidateFingerprint) {
    const preferredIndex = progressionCandidates.findIndex(
      (candidate) => missionOptionsFingerprint(candidate.missionOptions) === preferredCandidateFingerprint
    );
    if (preferredIndex > 0) {
      const [preferred] = progressionCandidates.splice(preferredIndex, 1);
      progressionCandidates.unshift(preferred);
    }
  }
  reportProgress({
    phase: "candidates",
    message: `Prepared ${progressionCandidates.length.toLocaleString()} progression candidates. Loading mission loot dataset...`,
    completed: 0,
    total: progressionCandidates.length,
  });
  await yieldForProgressFlush();
  const referenceMissionOptions = progressionDeduped.unique[0]?.missionOptions || profile.missionOptions;
  const lootLoadStartedAtMs = Date.now();
  const lootData = injectedLootData ?? await getDefaultLootData();
  benchmarkExcludedMs += Math.max(0, Date.now() - lootLoadStartedAtMs);
  reportProgress({
    phase: "init",
    message: "Loaded mission loot data. Building mission action models...",
  });
  await yieldForProgressFlush();
  const baseActionsEntry = await getMissionActionsForOptionsCached({
    missionOptions: referenceMissionOptions,
    relevantItems: closure,
    closureKey,
    lootData,
    missionDropRarities,
    actionFilter: missionActionFilter,
  });
  const baseActions = baseActionsEntry.actions;
  const subDominatedPrunedCount = baseActionsEntry.prunedCount;
  if (subDominatedPrunedCount > 0) {
    reportProgress({
      phase: "init",
      message: `Pruned ${subDominatedPrunedCount} sub-dominated actions (${baseActions.length} remaining).`,
    });
    await yieldForProgressFlush();
  }
  if (baseActionsEntry.indexFilteredCount > 0) {
    reportProgress({
      phase: "init",
      message: `Mission yield index filtered ${baseActionsEntry.indexFilteredCount.toLocaleString()} low-ranked actions from the reference model (${baseActions.length.toLocaleString()} retained).`,
    });
    await yieldForProgressFlush();
  }

  const craftSkeleton = getCraftSkeletonCached({
    profile: representativeBlockProfile,
    targetKey,
    quantity: solveQuantity,
    closure,
    targetDemandByItem: solveTargetDemandByItem,
    consumptionOptions,
  });

  const { geRef, fuelRef, timeRef } = computeObjectiveReferences({
    profile: representativeBlockProfile,
    targetKey,
    quantity: solveQuantity,
    actions: baseActions,
    targetDemandByItem: solveTargetDemandByItem,
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
    const gePolishSolveStats = createSolveStageStats();
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
    let indexFilteredActionCount = baseActionsEntry.indexFilteredCount;
    let indexCoverageRepairActionCount = baseActionsEntry.coverageRepairCount;
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
            fuelCost: number;
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
        const candidateEntry = await getMissionActionsForOptionsCached({
          missionOptions: combinedOptions,
          relevantItems: closure,
          closureKey,
          lootData,
          missionDropRarities,
          actionFilter: missionActionFilter,
        });
        indexFilteredActionCount += candidateEntry.indexFilteredCount;
        indexCoverageRepairActionCount += candidateEntry.coverageRepairCount;
        candidateActions = candidateEntry.actions;
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
      const geOnlyCandidateMilp = objectiveMode === "ge" && !lpRelaxation && priorityTime <= SCORE_EPS;
      if (!lpRelaxation) {
        await emitMilpStageProgress(
          milpProgressContext,
          geOnlyCandidateMilp ? "Lowest-GE solve" : "Integer-constrained solve"
        );
      }
      let baselineSolveMetrics: UnifiedSolveMetrics | null = null;
      const baselineUnified = await solveUnifiedCraftMissionPlan({
        profile: representativeBlockProfile,
        targetKey,
        quantity: solveQuantity,
        priorityTime,
        objectiveMode,
        minimumTimePriority: objectiveContext.minimumTimePriority,
        closure,
        actions: input.candidateActions,
        geRef,
        fuelRef,
        timeRef,
        requiredMissionLaunches: input.requiredMissionLaunches,
        maxMissionLaunchesByOption: input.maxMissionLaunchesByOption,
        phasedChainConstraints: input.phasedChainConstraints,
        lpRelaxation,
        strictGeObjective: geOnlyCandidateMilp,
        targetCraftedOnly,
        targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : undefined,
        consumptionOptions,
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
      let unified = baselineUnified;
      let solveMetrics = baselineSolveMetrics;
      if (geOnlyCandidateMilp) {
        await emitMilpStageProgress(milpProgressContext, "Time tie-break solve (within lowest GE)");
        let tieBreakSolveMetrics: UnifiedSolveMetrics | null = null;
        try {
          const tieBreakUnified = await solveUnifiedCraftMissionPlan({
            profile: representativeBlockProfile,
            targetKey,
            quantity: solveQuantity,
            priorityTime: 1,
            objectiveMode,
            minimumTimePriority: objectiveContext.minimumTimePriority,
            closure,
            actions: input.candidateActions,
            geRef,
            fuelRef,
            timeRef,
            requiredMissionLaunches: input.requiredMissionLaunches,
            maxMissionLaunchesByOption: input.maxMissionLaunchesByOption,
            phasedChainConstraints: input.phasedChainConstraints,
            geCostUpperBound: baselineUnified.geCost,
            lpRelaxation: false,
            targetCraftedOnly,
            targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : undefined,
            consumptionOptions,
            craftSkeleton,
            solverFn,
            onSolveMetrics: (metrics) => {
              tieBreakSolveMetrics = metrics;
              recordSolveMetrics(milpSolveStats, metrics);
            },
          });
          unified = tieBreakUnified;
          solveMetrics = tieBreakSolveMetrics;
        } catch {
          // Keep the GE-optimal baseline if time tie-break refinement fails.
        }
      }
      const totalSlotSeconds = input.prepNoYieldSlotSeconds + unified.totalSlotSeconds;
      const fuelCost = missionFuelCost(input.candidateActions, unified.missionCounts);
      const weightedScore = normalizedObjectiveScore(
        objectiveResourceCost(objectiveContext, unified.geCost, fuelCost),
        totalSlotSeconds / 3,
        objectiveContext,
        objectiveMode === "virtueFuel" ? fuelRef : geRef,
        timeRef
      );
      const unmetTotal = Object.values(unified.remainingDemand).reduce((sum, qty) => sum + Math.max(0, qty), 0);
      const totalLaunches = Object.values(unified.missionCounts).reduce(
        (sum, launches) => sum + Math.max(0, Math.round(launches)),
        0
      );
      return {
        unified,
        solveMetrics,
        totalSlotSeconds,
        weightedScore,
        geCost: unified.geCost,
        fuelCost,
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
      a: { unmetTotal: number; weightedScore: number; geCost: number; fuelCost: number; totalSlotSeconds: number; totalLaunches: number },
      b: { unmetTotal: number; weightedScore: number; geCost: number; fuelCost: number; totalSlotSeconds: number; totalLaunches: number }
    ): number => {
      const unmetDiff = a.unmetTotal - b.unmetTotal;
      if (Math.abs(unmetDiff) > 1e-6) {
        return unmetDiff;
      }

      const resourceA = objectiveResourceCost(objectiveContext, a.geCost, a.fuelCost);
      const resourceB = objectiveResourceCost(objectiveContext, b.geCost, b.fuelCost);
      const resourceScale = Math.max(1, Math.min(Math.abs(resourceA), Math.abs(resourceB)));
      const resourceTieThreshold = Math.max(1, resourceScale * PLAN_SCORE_TIE_TOLERANCE_FRACTION);
      const resourceDiff = resourceA - resourceB;
      const resourceTied = Math.abs(resourceDiff) <= resourceTieThreshold;

      const slotScale = Math.max(1, Math.min(Math.abs(a.totalSlotSeconds), Math.abs(b.totalSlotSeconds)));
      const slotTieThreshold = Math.max(1, slotScale * PLAN_SCORE_TIE_TOLERANCE_FRACTION);
      const slotSecondsDiff = a.totalSlotSeconds - b.totalSlotSeconds;
      const timeTied = Math.abs(slotSecondsDiff) <= slotTieThreshold;

      if (resourceTied && timeTied) {
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
      if (Math.abs(resourceDiff) > SCORE_EPS) {
        return resourceDiff;
      }
      const geDiff = a.geCost - b.geCost;
      if (Math.abs(geDiff) > SCORE_EPS) {
        return geDiff;
      }
      return a.totalLaunches - b.totalLaunches;
    };
    const shouldReplaceBest = (
      current: typeof best,
      next: { unmetTotal: number; weightedScore: number; geCost: number; fuelCost: number; totalSlotSeconds: number; totalLaunches: number }
    ): boolean => !current || comparePlanQuality(next, current) < 0;
    const expectedHoursForPlan = (
      actions: MissionAction[],
      missionCounts: Record<string, number>,
      prepNoYieldSlotSeconds: number
    ): number =>
      estimateThreeSlotExpectedHours({
        actions,
        missionCounts,
        residualSlotSeconds: prepNoYieldSlotSeconds,
      });
    const shouldReplaceWithScaledIncumbent = (
      current: typeof best,
      next: {
        actions: MissionAction[];
        missionCounts: Record<string, number>;
        prepNoYieldSlotSeconds: number;
        unmetTotal: number;
        weightedScore: number;
        geCost: number;
        fuelCost: number;
        totalSlotSeconds: number;
        totalLaunches: number;
      }
    ): boolean => {
      if (!current) {
        return true;
      }
      if (next.unmetTotal + 1e-6 < current.unmetTotal) {
        return true;
      }
      if (next.unmetTotal > current.unmetTotal + 1e-6) {
        return false;
      }
      if (next.unmetTotal <= 1e-6 && current.unmetTotal <= 1e-6) {
        const nextHours = expectedHoursForPlan(next.actions, next.missionCounts, next.prepNoYieldSlotSeconds);
        const currentHours = expectedHoursForPlan(
          current.actions,
          current.unified.missionCounts,
          current.prepNoYieldSlotSeconds
        );
        const nextResource = Math.max(0, objectiveResourceCost(objectiveContext, next.geCost, next.fuelCost));
        const currentResource = Math.max(0, objectiveResourceCost(objectiveContext, current.geCost, current.fuelCost));
        if (nextHours + 1 / 3600 < currentHours && nextResource <= currentResource + SCORE_EPS) {
          return true;
        }
        if (nextHours <= currentHours * 0.99 && nextResource <= currentResource * 1.05 + SCORE_EPS) {
          return true;
        }
      }
      return false;
    };
    const chosenCombosForPlan = (
      actions: MissionAction[],
      missionCounts: Record<string, number>
    ): AvailableCombo[] => {
      const actionByKey = new Map(actions.map((action) => [action.key, action]));
      const combos: AvailableCombo[] = [];
      const seen = new Set<string>();
      const launchedEntries = Object.entries(missionCounts)
        .map(([actionKey, launchesRaw]) => {
          const action = actionByKey.get(actionKey);
          const launches = Math.max(0, Math.round(launchesRaw));
          return action && launches > 0 ? { action, launches } : null;
        })
        .filter((entry): entry is { action: MissionAction; launches: number } => entry !== null)
        .sort((a, b) => b.launches - a.launches || a.action.durationSeconds - b.action.durationSeconds);
      for (const { action } of launchedEntries) {
        const comboKey = `${action.ship}|${action.durationType}|${action.targetAfxId}`;
        if (seen.has(comboKey)) {
          continue;
        }
        seen.add(comboKey);
        combos.push({
          ship: action.ship,
          durationType: action.durationType,
          targetAfxId: action.targetAfxId,
        });
        if (combos.length >= MONOLITHIC_INCUMBENT_MAX_COMBOS) {
          break;
        }
      }
      return combos;
    };
    const shouldReplaceWithMonolithicIncumbent = (
      current: {
        actions: MissionAction[];
        unified: UnifiedPlan;
        prepNoYieldSlotSeconds: number;
        totalSlotSeconds: number;
        unmetTotal: number;
        geCost: number;
        fuelCost: number;
        totalLaunches: number;
      },
      next: {
        actions: MissionAction[];
        unified: UnifiedPlan;
        prepNoYieldSlotSeconds: number;
        totalSlotSeconds: number;
        unmetTotal: number;
        geCost: number;
        fuelCost: number;
        totalLaunches: number;
      }
    ): boolean => {
      if (next.unmetTotal + 1e-6 < current.unmetTotal) {
        return true;
      }
      if (next.unmetTotal > current.unmetTotal + 1e-6) {
        return false;
      }
      const currentHours = expectedHoursForPlan(current.actions, current.unified.missionCounts, current.prepNoYieldSlotSeconds);
      const nextHours = expectedHoursForPlan(next.actions, next.unified.missionCounts, next.prepNoYieldSlotSeconds);
      if (
        nextHours <= currentHours + 1 / 3600 &&
        objectiveResourceCost(objectiveContext, next.geCost, next.fuelCost) <=
          objectiveResourceCost(objectiveContext, current.geCost, current.fuelCost) + SCORE_EPS &&
        (
          nextHours + 1 / 3600 < currentHours ||
          objectiveResourceCost(objectiveContext, next.geCost, next.fuelCost) + SCORE_EPS <
            objectiveResourceCost(objectiveContext, current.geCost, current.fuelCost)
        )
      ) {
        return true;
      }
      const resourceRefCommon = Math.max(
        1,
        objectiveResourceCost(objectiveContext, current.geCost, current.fuelCost),
        objectiveResourceCost(objectiveContext, next.geCost, next.fuelCost)
      );
      const timeRefCommon = Math.max(1, current.totalSlotSeconds / 3, next.totalSlotSeconds / 3);
      const currentScore = normalizedObjectiveScore(
        objectiveResourceCost(objectiveContext, current.geCost, current.fuelCost),
        current.totalSlotSeconds / 3,
        objectiveContext,
        resourceRefCommon,
        timeRefCommon
      );
      const nextScore = normalizedObjectiveScore(
        objectiveResourceCost(objectiveContext, next.geCost, next.fuelCost),
        next.totalSlotSeconds / 3,
        objectiveContext,
        resourceRefCommon,
        timeRefCommon
      );
      if (nextScore + SCORE_EPS < currentScore * 0.99 && nextHours <= currentHours * 1.05) {
        return true;
      }
      return false;
    };
    const solveMonolithicIncumbentForCombo = async (
      combo: AvailableCombo,
      baseCandidate: ProgressionCandidate,
      prepNoYieldSlotSeconds: number,
      fullQuantityCraftSkeleton: CraftModelSkeleton
    ): Promise<{
      actions: MissionAction[];
      unified: UnifiedPlan;
      totalSlotSeconds: number;
      weightedScore: number;
      geCost: number;
      fuelCost: number;
      unmetTotal: number;
      totalLaunches: number;
    } | null> => {
      const baseLaunchCounts = shipLevelsToLaunchCounts(baseCandidate.shipLevels);
      const phases = buildPhasedOptionPlan({
        profile,
        baseLaunchCounts,
        ship: combo.ship,
        durationType: combo.durationType,
        budgetLaunches: PHASED_BUDGET_LAUNCHES,
        maxPhases: INTEGRATED_MAX_PHASES,
      });
      const phasedOptions = phases.length > 0
        ? phases.map((phase) => phase.option)
        : baseCandidate.missionOptions.filter(
            (option) => option.ship === combo.ship && option.durationType === combo.durationType
          );
      if (phasedOptions.length === 0) {
        return null;
      }
      const comboActionsEntry = await getMissionActionsForOptionsCached({
        missionOptions: phasedOptions,
        relevantItems: closure,
        closureKey,
        lootData,
        missionDropRarities,
      });
      const comboActions = comboActionsEntry.actions.filter((action) => action.targetAfxId === combo.targetAfxId);
      if (comboActions.length === 0) {
        return null;
      }

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

      const comboRefs = computeObjectiveReferences({
        profile,
        targetKey,
        quantity: quantityInt,
        actions: comboActions,
        targetDemandByItem: normalizedTargets.targetDemandByItem,
      });
      const unified = await solveUnifiedCraftMissionPlan({
        profile,
        targetKey,
        quantity: quantityInt,
        priorityTime,
        objectiveMode,
        minimumTimePriority: objectiveContext.minimumTimePriority,
        closure,
        actions: comboActions,
        geRef: comboRefs.geRef,
        fuelRef: comboRefs.fuelRef,
        timeRef: comboRefs.timeRef,
        maxMissionLaunchesByOption,
        phasedChainConstraints,
        targetCraftedOnly,
        targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : undefined,
        consumptionOptions,
        craftSkeleton: fullQuantityCraftSkeleton,
        solverFn,
        onSolveMetrics: (metrics) => {
          recordSolveMetrics(milpSolveStats, metrics);
        },
      });
      const remainingDemand = computeRemainingDemandForPlan({
        profile,
        targetKey,
        quantity: quantityInt,
        closure,
        crafts: unified.crafts,
        consumptions: unified.consumptions,
        consumptionOptions,
        actions: comboActions,
        missionCounts: unified.missionCounts,
        targetCraftedOnly,
        targetDemandByItem: normalizedTargets.targetDemandByItem,
        targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : undefined,
      });
      const checkedUnified: UnifiedPlan = {
        ...unified,
        remainingDemand,
      };
      const totalSlotSeconds = prepNoYieldSlotSeconds + unified.totalSlotSeconds;
      const unmetTotal = sumRecordValues(checkedUnified.remainingDemand);
      const totalLaunches = sumRecordValues(checkedUnified.missionCounts);
      const fuelCost = missionFuelCost(comboActions, checkedUnified.missionCounts);
      return {
        actions: comboActions,
        unified: checkedUnified,
        totalSlotSeconds,
        weightedScore: normalizedObjectiveScore(
          objectiveResourceCost(objectiveContext, checkedUnified.geCost, fuelCost),
          totalSlotSeconds / 3,
          objectiveContext,
          objectiveMode === "virtueFuel" ? fuelRef : geRef,
          timeRef
        ),
        geCost: checkedUnified.geCost,
        fuelCost,
        unmetTotal,
        totalLaunches,
      };
    };

    const geOnlyMode = objectiveMode === "ge" && priorityTime <= SCORE_EPS;
    const screeningLabel = geOnlyMode ? "Integer-constrained" : "Relaxed (fractional)";
    const screenedPastTense = geOnlyMode ? "Integer-screened" : "Relaxed-screened";

    const tryScaledQuantityIncumbent = async (): Promise<void> => {
      if (fastMode || geOnlyMode || quantityInt < FAST_QUANTITY_ACCELERATION_MIN_QUANTITY) {
        return;
      }
      if (multiTarget) {
        return;
      }
      const blockQuantity = chooseFastQuantityAccelerationBlock(quantityInt);
      if (blockQuantity >= quantityInt) {
        return;
      }

      const blockProfile = profileWithoutClosureInventory(profile, closure);
      const blockCraftSkeleton = getCraftSkeletonCached({
        profile: blockProfile,
        targetKey,
        quantity: blockQuantity,
        closure,
        targetDemandByItem: new Map([[targetKey, blockQuantity]]),
        consumptionOptions,
      });
      const blockRefs = computeObjectiveReferences({
        profile: blockProfile,
        targetKey,
        quantity: blockQuantity,
        actions: baseActions,
        targetDemandByItem: new Map([[targetKey, blockQuantity]]),
      });
      type BlockScreenResult = {
        input: CandidateEvalInput;
        unified: UnifiedPlan;
        solveMetrics: UnifiedSolveMetrics | null;
        weightedScore: number;
        geCost: number;
        fuelCost: number;
        totalSlotSeconds: number;
        unmetTotal: number;
        totalLaunches: number;
      };
      const blockScreened: BlockScreenResult[] = [];

      reportProgress({
        phase: "candidates",
        message: `Testing small-block scaled incumbent candidates (${blockQuantity.toLocaleString()} representative target)...`,
        completed: 0,
        total: candidateTotal,
        etaMs: null,
      });
      await yieldForProgressFlush();

      for (let candidateIndex = 0; candidateIndex < candidateTotal; candidateIndex += 1) {
        try {
          const input = await prepareCandidateInput(progressionCandidates[candidateIndex]);
          if (!input) {
            continue;
          }
          let solveMetrics: UnifiedSolveMetrics | null = null;
          const unified = await solveUnifiedCraftMissionPlan({
            profile: blockProfile,
            targetKey,
            quantity: blockQuantity,
            priorityTime,
            objectiveMode,
            minimumTimePriority: objectiveContext.minimumTimePriority,
            closure,
            actions: input.candidateActions,
            geRef: blockRefs.geRef,
            fuelRef: blockRefs.fuelRef,
            timeRef: blockRefs.timeRef,
            requiredMissionLaunches: input.requiredMissionLaunches,
            maxMissionLaunchesByOption: input.maxMissionLaunchesByOption,
            phasedChainConstraints: input.phasedChainConstraints,
            lpRelaxation: true,
            targetCraftedOnly,
            targetCraftedOnlyKeys: targetCraftedOnly && isCraftedOnlyEligibleGoalKey(targetKey) ? new Set([targetKey]) : undefined,
            consumptionOptions,
            craftSkeleton: blockCraftSkeleton,
            solverFn,
            onSolveMetrics: (metrics) => {
              solveMetrics = metrics;
              recordSolveMetrics(lpSolveStats, metrics);
            },
          });
          const totalSlotSeconds = input.prepNoYieldSlotSeconds + unified.totalSlotSeconds;
          const fuelCost = missionFuelCost(input.candidateActions, unified.missionCounts);
          blockScreened.push({
            input,
            unified,
            solveMetrics,
            weightedScore: normalizedObjectiveScore(
              objectiveResourceCost(objectiveContext, unified.geCost, fuelCost),
              totalSlotSeconds / 3,
              objectiveContext,
              objectiveMode === "virtueFuel" ? blockRefs.fuelRef : blockRefs.geRef,
              blockRefs.timeRef
            ),
            geCost: unified.geCost,
            fuelCost,
            totalSlotSeconds,
            unmetTotal: sumRecordValues(unified.remainingDemand),
            totalLaunches: sumRecordValues(unified.missionCounts),
          });
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          solverErrors.push(`small-block scaled incumbent screening failed: ${details}`);
        }
      }

      blockScreened.sort((a, b) => comparePlanQuality(a, b));
      const blockMilpResolveCount = Math.min(
        blockScreened.length,
        Math.max(LP_SCREENING_MILP_RESOLVES, NORMAL_SCALED_INCUMBENT_MAX_MILP_RESOLVES)
      );
      const blockMilpCandidates = blockScreened.slice(0, blockMilpResolveCount);
      let adopted = false;
      for (const screened of blockMilpCandidates) {
        try {
          let solveMetrics: UnifiedSolveMetrics | null = null;
          const unified = await solveUnifiedCraftMissionPlan({
            profile: blockProfile,
            targetKey,
            quantity: blockQuantity,
            priorityTime,
            objectiveMode,
            minimumTimePriority: objectiveContext.minimumTimePriority,
            closure,
            actions: screened.input.candidateActions,
            geRef: blockRefs.geRef,
            fuelRef: blockRefs.fuelRef,
            timeRef: blockRefs.timeRef,
            requiredMissionLaunches: screened.input.requiredMissionLaunches,
            maxMissionLaunchesByOption: screened.input.maxMissionLaunchesByOption,
            phasedChainConstraints: screened.input.phasedChainConstraints,
            lpRelaxation: false,
            targetCraftedOnly,
            targetCraftedOnlyKeys: targetCraftedOnly && isCraftedOnlyEligibleGoalKey(targetKey) ? new Set([targetKey]) : undefined,
            consumptionOptions,
            craftSkeleton: blockCraftSkeleton,
            solverFn,
            onSolveMetrics: (metrics) => {
              solveMetrics = metrics;
              recordSolveMetrics(milpSolveStats, metrics);
            },
          });
          const scaled = scaleUnifiedPlanForRequestedQuantity({
            profile,
            targetKey,
            requestedQuantity: quantityInt,
            solvedQuantity: blockQuantity,
            closure,
            actions: screened.input.candidateActions,
            unified,
            prepSteps: screened.input.candidate.prepSteps,
            prepNoYieldSlotSeconds: screened.input.prepNoYieldSlotSeconds,
            targetCraftedOnly,
            consumptionOptions,
          });
          const refined = await refineScaledPlanWithProgression({
            profile,
            targetKey,
            requestedQuantity: quantityInt,
            closure,
            actions: screened.input.candidateActions,
            unified: scaled.unified,
            prepSteps: screened.input.candidate.prepSteps,
            targetCraftedOnly,
            consumptionOptions,
            lootData,
            missionDropRarities,
          });
          const totalSlotSeconds = screened.input.prepNoYieldSlotSeconds + refined.unified.totalSlotSeconds;
          const unmetTotal = sumRecordValues(refined.unified.remainingDemand);
          const totalLaunches = sumRecordValues(refined.unified.missionCounts);
          const fuelCost = missionFuelCost(refined.actions, refined.unified.missionCounts);
          const scaledCandidate = {
            actions: refined.actions,
            missionCounts: refined.unified.missionCounts,
            prepNoYieldSlotSeconds: screened.input.prepNoYieldSlotSeconds,
            unmetTotal,
            weightedScore: normalizedObjectiveScore(
              objectiveResourceCost(objectiveContext, refined.unified.geCost, fuelCost),
              totalSlotSeconds / 3,
              objectiveContext,
              objectiveMode === "virtueFuel" ? fuelRef : geRef,
              timeRef
            ),
            geCost: refined.unified.geCost,
            fuelCost,
            totalSlotSeconds,
            totalLaunches,
          };
          if (shouldReplaceWithScaledIncumbent(best, scaledCandidate)) {
            best = {
              candidate: screened.input.candidate,
              actions: refined.actions,
              unified: refined.unified,
              solveMetrics,
              totalSlotSeconds,
              weightedScore: scaledCandidate.weightedScore,
              geCost: refined.unified.geCost,
              fuelCost,
              unmetTotal,
              totalLaunches,
              prepNoYieldSlotSeconds: screened.input.prepNoYieldSlotSeconds,
            };
            adopted = true;
            refinementNotes.push(
              `Normal solve adopted a scaled small-block incumbent: solved ${blockQuantity.toLocaleString()} target, scaled to ${quantityInt.toLocaleString()}, then replayed launches through projected ship-level gains.`
            );
            refinementNotes.push(
              "Scaled incumbent solved its representative block with required-item inventory ignored, then applied current inventory once during final replay."
            );
            if (refined.prunedLaunches > 0) {
              refinementNotes.push(
                `Scaled incumbent pruned ${refined.prunedLaunches.toLocaleString()} launches after projected ship level gains improved expected drops.`
              );
            }
          }
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          solverErrors.push(`small-block scaled incumbent integer solve failed: ${details}`);
        }
      }
      if (!adopted && blockMilpCandidates.length > 0) {
        refinementNotes.push(
          `Normal solve checked ${blockMilpCandidates.length.toLocaleString()} small-block scaled incumbent candidate${blockMilpCandidates.length === 1 ? "" : "s"}; none beat the full-quantity integer plan.`
        );
      }
    };

    // Phase 1: screen all candidates (LP for mixed priorities, MILP for GE-only)
    type LpScreenResult = {
      input: CandidateEvalInput;
      unified: UnifiedPlan;
      solveMetrics: UnifiedSolveMetrics | null;
      weightedScore: number;
      geCost: number;
      fuelCost: number;
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
          message: `Time budget reached; stopping ${screeningLabel.toLowerCase()} screening early.`,
          completed: completedCandidateCount,
          total: candidateTotal,
          etaMs: null,
        });
        break;
      }

      const candidate = progressionCandidates[candidateIndex];
      reportProgress({
        phase: "candidate",
        message: `${screeningLabel} solve: candidate ${candidateIndex + 1} of ${candidateTotal}...`,
        completed: completedCandidateCount,
        total: candidateTotal,
        etaMs: estimateCandidateEtaMs(),
      });
      await yieldForProgressFlush();

      const prepOnlyLowerBound = normalizedObjectiveScore(
        0,
        candidate.prepSlotSeconds / 3,
        objectiveContext,
        objectiveMode === "virtueFuel" ? fuelRef : geRef,
        timeRef
      );
      const currentBestLp = lpScreened.reduce<LpScreenResult | null>((bestLp, row) => {
        if (!bestLp) {
          return row;
        }
        return comparePlanQuality(row, bestLp) < 0 ? row : bestLp;
      }, null);
      if (
        !geOnlyMode &&
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
        const result = await solveCandidateInput(input, !geOnlyMode);
        lpScreened.push({
          input,
          unified: result.unified,
          solveMetrics: result.solveMetrics,
          weightedScore: result.weightedScore,
          geCost: result.geCost,
          fuelCost: result.fuelCost,
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
        message: `${screenedPastTense} ${completedCandidateCount.toLocaleString()}/${candidateTotal.toLocaleString()} candidates (${prunedCandidateCount.toLocaleString()} pruned).`,
        completed: completedCandidateCount,
        total: candidateTotal,
        etaMs: estimateCandidateEtaMs(),
      });
      await yieldForProgressFlush();
    }

    // Phase 2: MILP re-solve top LP candidates (skipped in GE-only mode)
    lpScreened.sort((a, b) => {
      return comparePlanQuality(a, b);
    });
    if (geOnlyMode) {
      reportProgress({
        phase: "candidates",
        message: "GE-priority mode: using integer-screened horizon candidates directly.",
        completed: lpScreened.length,
        total: lpScreened.length,
        etaMs: 0,
      });
      await yieldForProgressFlush();
      for (const screened of lpScreened) {
        if (shouldReplaceBest(best, screened)) {
          best = {
            candidate: screened.input.candidate,
            actions: screened.input.candidateActions,
            unified: screened.unified,
            solveMetrics: screened.solveMetrics,
            totalSlotSeconds: screened.totalSlotSeconds,
            weightedScore: screened.weightedScore,
            geCost: screened.geCost,
            fuelCost: screened.fuelCost,
            unmetTotal: screened.unmetTotal,
            totalLaunches: screened.totalLaunches,
            prepNoYieldSlotSeconds: screened.input.prepNoYieldSlotSeconds,
          };
        }
      }
    } else if (fastMode) {
      const fastMilpResolves = 1;
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
                fuelCost: result.fuelCost,
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
            fuelCost: bestLp.fuelCost,
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
              fuelCost: result.fuelCost,
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

    if (best.unmetTotal <= 1e-6) {
      await tryScaledQuantityIncumbent();
    }

    if (objectiveMode === "ge" && !geOnlyMode && !fastMode && best.unmetTotal <= 1e-6 && best.geCost > SCORE_EPS) {
      const polishInput = await prepareCandidateInput(best.candidate);
      if (polishInput) {
        const baselineExpectedHours = estimateThreeSlotExpectedHours({
          actions: best.actions,
          missionCounts: best.unified.missionCounts,
          residualSlotSeconds: best.prepNoYieldSlotSeconds,
        });
        const baselineMakespanSeconds = Math.max(0, Math.round(baselineExpectedHours * 3600));
        const missionSlotSecondsBudget = Math.max(0, baselineMakespanSeconds * 3 - polishInput.prepNoYieldSlotSeconds);
        if (missionSlotSecondsBudget + SCORE_EPS >= best.unified.totalSlotSeconds) {
          reportProgress({
            phase: "candidate",
            message: "GE polish: testing lower craft cost within current timeline budget...",
            completed: completedCandidateCount,
            total: candidateTotal,
            etaMs: null,
          });
          await yieldForProgressFlush();
          let polishedSolveMetrics: UnifiedSolveMetrics | null = null;
          try {
            const polishedUnified = await solveUnifiedCraftMissionPlan({
              profile,
              targetKey,
              quantity: solveQuantity,
              priorityTime: 0,
              objectiveMode,
              minimumTimePriority: objectiveContext.minimumTimePriority,
              closure,
              actions: polishInput.candidateActions,
              geRef,
              fuelRef,
              timeRef,
              requiredMissionLaunches: polishInput.requiredMissionLaunches,
              maxMissionLaunchesByOption: polishInput.maxMissionLaunchesByOption,
              phasedChainConstraints: polishInput.phasedChainConstraints,
              strictGeObjective: true,
              totalSlotSecondsUpperBound: missionSlotSecondsBudget,
              timeLimitSeconds: NORMAL_GE_POLISH_TIME_LIMIT_SECONDS,
              lpRelaxation: false,
              targetCraftedOnly,
              targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : undefined,
              consumptionOptions,
              craftSkeleton,
              solverFn,
              onSolveMetrics: (metrics) => {
                polishedSolveMetrics = metrics;
                recordSolveMetrics(gePolishSolveStats, metrics);
              },
            });
            const polishedTotalSlotSeconds = polishInput.prepNoYieldSlotSeconds + polishedUnified.totalSlotSeconds;
            const polishedUnmetTotal = Object.values(polishedUnified.remainingDemand).reduce(
              (sum, qty) => sum + Math.max(0, qty),
              0
            );
            const polishedExpectedHours = estimateThreeSlotExpectedHours({
              actions: polishInput.candidateActions,
              missionCounts: polishedUnified.missionCounts,
              residualSlotSeconds: polishInput.prepNoYieldSlotSeconds,
            });
            const expectedHoursTolerance = 1 / 3600;
            if (
              polishedUnmetTotal <= 1e-6 &&
              polishedUnified.geCost + SCORE_EPS < best.geCost &&
              polishedExpectedHours <= baselineExpectedHours + expectedHoursTolerance
            ) {
              const polishedTotalLaunches = Object.values(polishedUnified.missionCounts).reduce(
                (sum, launches) => sum + Math.max(0, Math.round(launches)),
                0
              );
              const previousGeCost = best.geCost;
              const polishedFuelCost = missionFuelCost(polishInput.candidateActions, polishedUnified.missionCounts);
              best = {
                candidate: polishInput.candidate,
                actions: polishInput.candidateActions,
                unified: polishedUnified,
                solveMetrics: polishedSolveMetrics,
                totalSlotSeconds: polishedTotalSlotSeconds,
                weightedScore: normalizedObjectiveScore(
                  objectiveResourceCost(objectiveContext, polishedUnified.geCost, polishedFuelCost),
                  polishedTotalSlotSeconds / 3,
                  objectiveContext,
                  geRef,
                  timeRef
                ),
                geCost: polishedUnified.geCost,
                fuelCost: polishedFuelCost,
                unmetTotal: polishedUnmetTotal,
                totalLaunches: polishedTotalLaunches,
                prepNoYieldSlotSeconds: polishInput.prepNoYieldSlotSeconds,
              };
              refinementNotes.push(
                `GE polish reduced craft cost from ${Math.round(previousGeCost).toLocaleString()} to ${Math.round(
                  polishedUnified.geCost
                ).toLocaleString()} without increasing expected mission time.`
              );
            }
          } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            refinementNotes.push(
              `GE polish did not complete within the conservative ${NORMAL_GE_POLISH_TIME_LIMIT_SECONDS}s limit or returned no usable improvement (${details}); kept the baseline integer plan.`
            );
          }
        }
      }
    } else if (!geOnlyMode && fastMode) {
      refinementNotes.push("Fast mode skipped GE polish to avoid spending solve time on optional craft-cost refinement.");
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

    bestCandidateFingerprintCache.set(
      candidateReuseKey,
      missionOptionsFingerprint(best.candidate.missionOptions)
    );

    let outputActions = best.actions;
    let outputUnified = best.unified;
    let outputTotalSlotSeconds = best.totalSlotSeconds;
    let outputWeightedScore = best.weightedScore;
    let outputUnmetTotal = best.unmetTotal;
    if (fastQuantityAcceleration && solveQuantity < quantityInt) {
      const scaled = scaleUnifiedPlanForRequestedQuantity({
        profile,
        targetKey,
        requestedQuantity: quantityInt,
        solvedQuantity: solveQuantity,
        closure,
        actions: best.actions,
        unified: best.unified,
        prepSteps: best.candidate.prepSteps,
        prepNoYieldSlotSeconds: best.prepNoYieldSlotSeconds,
        targetCraftedOnly,
        targetDemandByItem: normalizedTargets.targetDemandByItem,
        targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : undefined,
      });
      const refined = await refineScaledPlanWithProgression({
        profile,
        targetKey,
        requestedQuantity: quantityInt,
        closure,
        actions: best.actions,
        unified: scaled.unified,
        prepSteps: best.candidate.prepSteps,
        targetCraftedOnly,
        targetDemandByItem: normalizedTargets.targetDemandByItem,
        targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : undefined,
        consumptionOptions,
        lootData,
        missionDropRarities,
      });
      outputActions = refined.actions;
      outputUnified = refined.unified;
      outputTotalSlotSeconds = best.prepNoYieldSlotSeconds + refined.unified.totalSlotSeconds;
      outputUnmetTotal = sumRecordValues(refined.unified.remainingDemand);
      if (outputUnmetTotal > 1e-6) {
        const repaired = await repairScaledPlanRemainingDemand({
          profile,
          targetKey,
          requestedQuantity: quantityInt,
          closure,
          actions: refined.actions,
          unified: refined.unified,
          prepSteps: best.candidate.prepSteps,
          targetCraftedOnly,
          targetDemandByItem: normalizedTargets.targetDemandByItem,
          targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : undefined,
          consumptionOptions,
          solverFn,
        });
        outputUnified = repaired.unified;
        outputTotalSlotSeconds = best.prepNoYieldSlotSeconds + repaired.unified.totalSlotSeconds;
        outputUnmetTotal = sumRecordValues(repaired.unified.remainingDemand);
        refinementNotes.push(...repaired.notes);
      }
      if (refined.prunedLaunches > 0) {
        refinementNotes.push(
          `Fast mode progression-aware scaling pruned ${refined.prunedLaunches.toLocaleString()} repeated launches after projected ship level gains improved expected drops.`
        );
      }
      const outputFuelCost = missionFuelCost(outputActions, outputUnified.missionCounts);
      outputWeightedScore = normalizedObjectiveScore(
        objectiveResourceCost(objectiveContext, outputUnified.geCost, outputFuelCost),
        outputTotalSlotSeconds / 3,
        objectiveContext,
        objectiveMode === "virtueFuel"
          ? Math.max(1, outputFuelCost, fuelRef * scaled.repeatFactor)
          : Math.max(1, computeGeCostForCrafts(profile, outputUnified.crafts), geRef),
        Math.max(1, timeRef * scaled.repeatFactor)
      );
      if (multiTargetFastQuantityAcceleration) {
        refinementNotes.push(
          `Fast mode multi-target acceleration divided requested target quantities by their GCD (${multiTargetScaleFactor.toLocaleString()}), solved the representative bundle, and scaled its mission/craft pattern ${scaled.repeatFactor.toLocaleString()}x.`
        );
      } else {
        refinementNotes.push(
          `Fast mode large-quantity acceleration solved a representative block of ${solveQuantity.toLocaleString()} and scaled its mission/craft pattern ${scaled.repeatFactor.toLocaleString()}x for the requested ${quantityInt.toLocaleString()}.`
        );
      }
      refinementNotes.push(
        "Fast mode validates scaled shortcuts with exact one-time inventory accounting; when the representative block uses current inventory, residual ingredient demand is repaired with additional launches."
      );
      if (outputUnmetTotal > 1e-6) {
        const unscaledFastResult = await planForTarget(profile, targetItemId, quantityInt, priorityTime, {
          ...plannerOptions,
          fastMode: true,
          objectiveMode,
          minimumTimePriority: objectiveContext.minimumTimePriority,
          disableFastQuantityAcceleration: true,
          disableNormalFastIncumbent: true,
        });
        unscaledFastResult.notes.unshift(
          "Rejected fast scaled shortcut because the replay still left unmet expected ingredient demand; reran fast mode without quantity scaling."
        );
        return unscaledFastResult;
      }
    }

    const comparisonAvailableActions = outputActions;
    if (outputUnmetTotal <= 1e-6) {
      const monolithicCombos = chosenCombosForPlan(outputActions, outputUnified.missionCounts);
      if (monolithicCombos.length > 0) {
        const fullQuantityCraftSkeleton = getCraftSkeletonCached({
          profile,
          targetKey,
          quantity: quantityInt,
          closure,
          targetDemandByItem: normalizedTargets.targetDemandByItem,
          consumptionOptions,
        });
        let testedMonolithicCount = 0;
        let adoptedMonolithicCombo: AvailableCombo | null = null;
        for (const combo of monolithicCombos) {
          try {
            const monolithic = await solveMonolithicIncumbentForCombo(
              combo,
              best.candidate,
              best.prepNoYieldSlotSeconds,
              fullQuantityCraftSkeleton
            );
            if (!monolithic) {
              continue;
            }
            testedMonolithicCount += 1;
            const currentCandidate = {
              actions: outputActions,
              unified: outputUnified,
              prepNoYieldSlotSeconds: best.prepNoYieldSlotSeconds,
              totalSlotSeconds: outputTotalSlotSeconds,
              unmetTotal: outputUnmetTotal,
              geCost: outputUnified.geCost,
              fuelCost: missionFuelCost(outputActions, outputUnified.missionCounts),
              totalLaunches: sumRecordValues(outputUnified.missionCounts),
            };
            const monolithicCandidate = {
              actions: monolithic.actions,
              unified: monolithic.unified,
              prepNoYieldSlotSeconds: best.prepNoYieldSlotSeconds,
              totalSlotSeconds: monolithic.totalSlotSeconds,
              unmetTotal: monolithic.unmetTotal,
              geCost: monolithic.geCost,
              fuelCost: monolithic.fuelCost,
              totalLaunches: monolithic.totalLaunches,
            };
            if (shouldReplaceWithMonolithicIncumbent(currentCandidate, monolithicCandidate)) {
              outputActions = monolithic.actions;
              outputUnified = monolithic.unified;
              outputTotalSlotSeconds = monolithic.totalSlotSeconds;
              outputWeightedScore = monolithic.weightedScore;
              outputUnmetTotal = monolithic.unmetTotal;
              adoptedMonolithicCombo = combo;
            }
          } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            solverErrors.push(`monolithic incumbent solve failed: ${details}`);
          }
        }
        if (adoptedMonolithicCombo) {
          refinementNotes.push(
            `Monolithic incumbent replaced the mixed plan using ${adoptedMonolithicCombo.ship} ${adoptedMonolithicCombo.durationType} target ${adoptedMonolithicCombo.targetAfxId} because it compared better on the selected ${objectiveMode === "virtueFuel" ? "fuel/time" : "GE/time"} priority.`
          );
        } else if (testedMonolithicCount > 0) {
          refinementNotes.push(
            `Checked ${testedMonolithicCount.toLocaleString()} monolithic incumbent candidate${testedMonolithicCount === 1 ? "" : "s"} from the mixed plan's chosen ship/target combos; none beat the mixed plan.`
          );
        }
      }
    }

    const missionRows = buildMissionRows(outputActions, outputUnified.missionCounts);
    const craftRows = buildCraftRows(outputUnified.crafts);
    const consumptionRows = buildConsumptionRows(outputUnified.consumptions, consumptionOptions);
    const targetBreakdown = buildTargetBreakdown({
      quantity: quantityInt,
      targetKey,
      crafts: outputUnified.crafts,
      actions: outputActions,
      missionCounts: outputUnified.missionCounts,
      remainingDemand: outputUnified.remainingDemand,
      targetCraftedOnly,
    });
    const targetBreakdowns = buildTargetBreakdowns({
      targetDemandByItem: normalizedTargets.targetDemandByItem,
      crafts: outputUnified.crafts,
      actions: outputActions,
      missionCounts: outputUnified.missionCounts,
      remainingDemand: outputUnified.remainingDemand,
      targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : new Set<string>(),
    });
    const unmetItems = Object.entries(outputUnified.remainingDemand)
      .filter(([, qty]) => qty > 1e-6)
      .map(([itemKey, qty]) => ({ itemId: itemKeyToId(itemKey), quantity: qty }))
      .sort((a, b) => b.quantity - a.quantity);

    const uncoveredItemKeys = Object.entries(outputUnified.remainingDemand)
      .filter(
        ([itemKey, qty]) =>
          qty > 1e-6 &&
          !outputActions.some((action) => {
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
    const notes: string[] = [...outputUnified.notes, ...refinementNotes];
    if (fastMode) {
      notes.push(
        `Fast solve mode enabled: limited progression-state solves to ${progressionCandidates.length.toLocaleString()} candidates.`
      );
      if (geOnlyMode) {
        notes.push("Fast mode GE-priority path used integer-constrained horizon screening across all retained candidates.");
      } else {
        notes.push("Fast mode integer re-solves the top LP-screened progression candidate.");
      }
    }
    if (geOnlyMode) {
      notes.push("GE-priority uses lexicographic integer solves per candidate: lowest GE first, then lowest mission time within that GE cost.");
    }
    if (objectiveMode === "virtueFuel") {
      notes.push(
        `Path of Virtue objective optimizes non-Humility fuel versus mission time; the fuel end keeps at least ${Math.round(
          objectiveContext.minimumTimePriority * 100
        )}% time weight to avoid extreme slowdowns.`
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
    if (subDominatedPrunedCount > 0) {
      notes.push(`Pruned ${subDominatedPrunedCount} sub-dominated mission actions (only yield lower-tier items already available at higher tiers).`);
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
      summarizeSolveStage(geOnlyMode ? "MILP screening" : "MILP re-solve", milpSolveStats),
      summarizeSolveStage("MILP GE-polish", gePolishSolveStats),
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
    if (missionActionFilter && indexFilteredActionCount > 0) {
      notes.push(
        `Mission yield index candidate reduction enabled: considered top ${missionActionFilter.topPerItem.toLocaleString()} ranked mission/target pairs per required item and filtered ${indexFilteredActionCount.toLocaleString()} low-ranked action entries before solving.`
      );
      if (indexCoverageRepairActionCount > 0) {
        notes.push(
          `Mission yield index coverage repair restored ${indexCoverageRepairActionCount.toLocaleString()} action entries so every item with full-model mission coverage retained at least one candidate.`
        );
      }
    }
    notes.push(
      "Planner uses expected-drop values with unified solver-backed craft+mission allocation, integrated phased ship leveling, bounded ship-progression horizon search, and 3 mission slots. Re-run after returns."
    );
    notes.push("Target quantity is interpreted as additional copies beyond current inventory.");
    if (targetCraftedOnly) {
      notes.push("Artifacts-only crafted goal mode enabled: mission drops do not count toward shiny-capable artifact goals, but still count toward stones and ingredient goals.");
    }
    if (consumptionRows.length > 0) {
      notes.push("Selected artifact consumption sources are modeled as optional expected stone yields; shiny consumption uses common-yield data.");
    }
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
      actions: outputActions,
      missionCounts: outputUnified.missionCounts,
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
      actions: outputActions,
      missionCounts: outputUnified.missionCounts,
      residualSlotSeconds: best.prepNoYieldSlotSeconds,
    });
    const outputFuelCost = missionFuelCost(outputActions, outputUnified.missionCounts);

    const availableCombos = buildAvailableCombosFromActions(comparisonAvailableActions, outputActions);

    const result: PlannedLaunches = {
      targetItemId: itemKeyToId(targetKey),
      quantity: quantityInt,
      targets: normalizedTargets.targets,
      priorityTime,
      objectiveMode,
      geCost: outputUnified.geCost,
      fuelCost: outputFuelCost,
      totalSlotSeconds: outputTotalSlotSeconds,
      expectedHours,
      weightedScore: outputWeightedScore,
      crafts: craftRows,
      consumptions: consumptionRows,
      missions: missionRows,
      unmetItems,
      targetBreakdown,
      targetBreakdowns,
      progression: {
        prepHours,
        prepLaunches: compactedPrepLaunches,
        projectedShipLevels: progressionShipRows(projectedShipLevels),
      },
      notes,
      availableCombos,
    };
    const finalResult = maybeAdoptFastIncumbentResult(result);
    reportBenchmark(finalResult, "primary");
    return finalResult;
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
    const fallbackProfile = missionOptionFilter
      ? { ...profile, missionOptions: missionOptionFilter(profile.missionOptions) }
      : profile;
    const fallback = await planForTargetHeuristic(fallbackProfile, targetItemId, quantityInt, priorityTime, {
      missionDropRarities,
      targetCraftedOnly,
      objectiveMode,
      minimumTimePriority: objectiveContext.minimumTimePriority,
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
    const finalFallback = maybeAdoptFastIncumbentResult(fallback);
    reportBenchmark(finalFallback, "fallback");
    return finalFallback;
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
  targets?: PlannerTarget[];
  quantity: number;
  priorityTime: number;
  selectedCombos: Array<{ ship: string; durationType: DurationType; targetAfxId: number }>;
  missionDropRarities?: Partial<ShinyRaritySelection>;
  targetCraftedOnly?: boolean;
  selectedConsumptionItemIds?: string[];
  solverFn?: SolverFunction;
  lootData?: LootJson;
}): Promise<MonolithicPathResult[]> {
  const {
    profile,
    targetItemId,
    targets,
    quantity,
    priorityTime,
    selectedCombos,
    missionDropRarities,
    targetCraftedOnly = false,
    selectedConsumptionItemIds,
    solverFn: solverFnOption,
    lootData: injectedLootData,
  } = options;
  const normalizedTargets = normalizePlannerTargets(targetItemId, quantity, targets);
  const targetKey = normalizedTargets.primaryTargetKey;
  const quantityInt = normalizedTargets.primaryQuantity;
  const missionDropRaritySelection = normalizeShinyRaritySelection(missionDropRarities);
  const selectedConsumptionItemKeys = normalizeConsumptionItemKeys(selectedConsumptionItemIds);

  const closure = new Set(getTargetClosureCached(targetKey));
  for (const itemKey of normalizedTargets.targetDemandByItem.keys()) {
    collectClosure(itemKey, closure);
  }
  const consumptionOptions = buildConsumptionOptionsForClosure(selectedConsumptionItemKeys, closure);
  const closureKey = closureFingerprint(closure);

  const lootData = injectedLootData ?? await getDefaultLootData();
  const allOptions = profile.missionOptions.length > 0
    ? profile.missionOptions
    : buildMissionOptions(profile.shipLevels, profile.epicResearchFTLLevel, profile.epicResearchZerogLevel);
  const baseLaunchCounts = shipLevelsToLaunchCounts(profile.shipLevels);

  const craftSkeleton = getCraftSkeletonCached({
    profile,
    targetKey,
    quantity: quantityInt,
    closure,
    targetDemandByItem: normalizedTargets.targetDemandByItem,
    consumptionOptions,
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
      const comboActionsEntry = await getMissionActionsForOptionsCached({
        missionOptions: phasedOptions,
        relevantItems: closure,
        closureKey,
        lootData,
        missionDropRarities: missionDropRaritySelection,
      });
      const comboActions = comboActionsEntry.actions;
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
        targetCraftedOnly,
        targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : undefined,
        consumptionOptions,
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
            if (!(targetCraftedOnly && isCraftedOnlyEligibleGoalKey(targetKey) && itemKey === targetKey)) {
              fromMissionsExpected += (action.yields[itemKey] || 0) * launches;
            }
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
