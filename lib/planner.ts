import type { LootJson, MissionLevelLootStore, MissionTargetLootStore } from "./loot-data";
import type { HighsSolveResult } from "./highs";
import artifactConsumptionData from "../data/artifact-consumption.json";
import missionYieldIndexData from "../data/mission-yield-index.json";
import {
  artifactDisplayMap,
  isStoneFragmentKey,
  isUntargetedTargetAfxId,
  itemIdToCanonicalKey,
  itemIdToKey,
  itemKeyToDisplayName,
  itemKeyToId,
} from "./item-utils";
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
import { getVirtueFuelConfig, getVirtueFuelPerLaunch, TRILLION, type VirtueFuelKey } from "./virtue-fuel";
import {
  packVirtueTanks,
  scheduleVirtueLaunches,
  VIRTUE_REFILL_ROUTE_ORDER,
  VIRTUE_SHIFT_CAP_DETENTS,
  VIRTUE_SHIFT_PENALTY_SECONDS,
  type VirtueFuelVector,
  type VirtueTankStartMode,
} from "./virtue-tanks";
import {
  VIRTUE_FASTER_OPTION_EXTRA_SHIFTS,
  VIRTUE_LAUNCH_EFFORT_SECONDS,
  virtueFasterOptionQualifies,
  virtueTankPlanScoreSeconds,
  type VirtueTankPlannerOptions,
  type VirtueTankPlannerResult,
  type VirtueTankPlanUnit,
} from "./virtue-tank-plan";
import {
  planVirtueLastTankTopUp,
  virtueLastTankRoom,
  VIRTUE_TOP_UP_TARGET_AFX_IDS,
  virtueTopUpItemKeys,
  virtueTopUpYieldOf,
  type VirtueLastTankTopUp,
  type VirtueTopUpCandidate,
} from "./virtue-top-up";

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
  /** Stable row id; virtue tank units point back at rows through it. */
  rowKey?: string;
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
  /** Craft-count goals only: the goal total, the count already crafted, and
   *  how many crafts were still owed when the plan was built. */
  craftGoal?: boolean;
  craftGoalTotal?: number;
  craftedBefore?: number;
};

export type PlannerTarget = {
  targetItemId: string;
  quantity: number;
  /** Read `quantity` as an all-time craft-count goal for this item rather than
   *  as copies to add to the plan: the plan crafts the difference from the
   *  count the profile already carries, and copies eaten by a higher tier
   *  still count toward it. Ignored for items with no recipe. */
  craftGoal?: boolean;
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
  /** Path of Virtue tank mode only: the plan split into fuel tanks and refuel loops. */
  virtueTanks?: VirtueTankPlannerResult;
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
  /** Path of Virtue tank mode: plan within a shift cap and pack launches into fuel tanks. */
  virtueTank?: VirtueTankPlannerOptions;
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
/** GE weight kept on crafts even at 100% time priority. With a weight of
 *  exactly 0 the solver has no reason to leave a pointless craft out of an
 *  incumbent (HiGHS stops at a 1% gap or a time limit, not at optimality).
 *  Craft coefficients are cost / geRef where geRef is the whole plan's GE, so
 *  the weight has to be large enough that a cheap craft survives the 1e-9
 *  coefficient filter; at 1e-3 the GE side is still far inside the MIP gap. */
const MIN_CRAFT_GE_OBJECTIVE_WEIGHT = 1e-3;
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
/** Tank mode fuel tie-break: seconds of mission time per trillion eggs burned. */
const VIRTUE_TANK_FUEL_TIEBREAK_SECONDS_PER_TRILLION = 0.1;
/** Per-loop whole-launch cuts only pay off when a few launches fill a tank. */
const VIRTUE_TANK_ATOMIC_CUT_MAX_LAUNCHES = 20;
/** Binding shift caps make the integer solves much harder; see the tank-mode status check. */
const VIRTUE_TANK_SOLVE_TIME_LIMIT_SECONDS = 30;
/** Normalized objective weight per shift in the fewest-shifts search (demand is hard there). */
const VIRTUE_TANK_MIN_SHIFT_WEIGHT = 1000;
const VIRTUE_TANK_PACK_TIME_LIMIT_SECONDS = 1.5;
/** Re-solves with a lower loop budget when packing needs more shifts than the solve counted. */
const VIRTUE_TANK_MAX_PACK_RETRIES = 2;
/**
 * Refuel loops a tank solve models one by one, so fuel can carry from one to
 * the next; loops past them are loop types that refill every egg they burn.
 * Two cover the usual carry (a loop tops up an egg so the next can skip it).
 * Each one costs the solve a handful of binaries, and a third already doubled
 * solve times on large goals.
 */
const VIRTUE_TANK_INDIVIDUAL_LOOPS = 2;
/** Caps above the slider's that are tried in turn before the fewest-shifts search. */
const VIRTUE_TANK_CAP_SCAN_STEPS = 3;
/**
 * Tank mode times a plan by a makespan bound, which counts the rounds three
 * slots fly for each mission duration this long or longer. Shorter rounds
 * move it by at most a couple of shifts' worth, and each duration costs the
 * solve an integer.
 */
const VIRTUE_TANK_MAKESPAN_ROUND_MIN_SECONDS = 8 * 3600;
/**
 * Tank mode's mission time is (1 - w) x the makespan bound + w x slot time
 * over three slots: equal to slot time over three whenever the rounds do not
 * bind, while slot time still breaks ties between plans of equal makespan.
 */
const VIRTUE_TANK_SLOT_TIME_WEIGHT = 0.1;
/**
 * The mission-rounds re-solve only refines a plan the candidate already has,
 * and on large goals it can run to the full tank time limit for a few percent.
 */
const VIRTUE_TANK_ROUNDS_TIME_LIMIT_SECONDS = 10;
/**
 * An over-cap search that has already run this long skips the extra pass
 * that looks for a faster option (VirtueTankPlannerResult.fasterOption).
 */
const VIRTUE_TANK_FASTER_OPTION_SKIP_AFTER_SECONDS = 90;
/**
 * A plan within the cap is checked for a faster option (see
 * withinCapLooksSlow in planVirtueTankLaunches) only while the search is
 * younger than this: the pass costs about as much as the search so far.
 */
const VIRTUE_TANK_WITHIN_CAP_FASTER_SKIP_AFTER_SECONDS = 60;
/**
 * A plan within the cap with more launches than this looks slow: a low cap
 * leaves only ships that burn little fuel, and those fly many short, poor
 * launches where a few more shifts would refuel for far better ones.
 */
const VIRTUE_TANK_WITHIN_CAP_SLOW_LAUNCHES = 100;
/**
 * A plan within the cap found this quickly is checked against the best plan
 * with one shift fewer. The solve times a plan as if every launch could fly
 * as soon as a slot frees up, but a later tank's launches wait for its
 * refuel, so a plan with more refuel loops can pack slower than one with
 * fewer, which the cap allows too.
 */
const VIRTUE_TANK_FEWER_SHIFTS_CHECK_MAX_ELAPSED_SECONDS = 5;
/**
 * Mission/target pairs tank mode keeps per item and ranking
 * (pruneVirtueTankActions).
 */
const VIRTUE_TANK_ACTION_TOP_PER_ITEM = 4;
/**
 * A pruned tank solve (pruneVirtueTankActions) that finishes within this
 * many seconds is checked by one more solve over every candidate action,
 * which has to beat it by the plan tie tolerance within
 * VIRTUE_TANK_FULL_CHECK_TIME_LIMIT_SECONDS. A slower pruned solve means
 * the full one would only run into its time limit.
 */
const VIRTUE_TANK_FULL_CHECK_MAX_PRUNED_SECONDS = 5;
const VIRTUE_TANK_FULL_CHECK_TIME_LIMIT_SECONDS = 10;
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

/**
 * HiGHS hands back the best incumbent it found within its gap or time limit,
 * and at 100% time priority a craft costs it (almost) nothing, so that
 * incumbent can carry crafts that feed no target, no other craft and no
 * consumption — a lone T2 beak on a geode+deflector plan, say. Drop any craft
 * whose output the balance rows would still cover without it, and any
 * consumption whose every yield is surplus, until nothing more can go. Only
 * supply nothing draws on is removed, so every row the solver satisfied still
 * holds; freed ingredients can make their own crafts surplus, hence the loop.
 * Crafts a craft-count goal asked for are surplus by the balance rows but are
 * the point of the plan, so they are held back by their floor. Mission
 * launches are left exactly as solved.
 */
function trimSurplusCraftsAndConsumptions(options: {
  profile: PlayerProfile;
  itemKeys: string[];
  demandByItem: Map<string, number>;
  crafts: Record<string, number>;
  consumptions: Record<string, number>;
  consumptionOptions: ConsumptionOption[];
  actions: MissionAction[];
  missionCounts: Record<string, number>;
  targetCraftedOnlyKeys: Set<string>;
  craftFloorByItem?: Map<string, number>;
}): { droppedCrafts: number; droppedConsumptions: number } {
  const { profile, itemKeys, demandByItem, crafts, consumptions, consumptionOptions, actions, missionCounts, targetCraftedOnlyKeys } =
    options;
  const craftFloorByItem = options.craftFloorByItem || new Map<string, number>();
  const slackByItem = new Map<string, number>();
  for (const itemKey of itemKeys) {
    const demandQty = Math.max(0, demandByItem.get(itemKey) || 0);
    let slack = (demandQty > 0 ? 0 : Math.max(0, profile.inventory[itemKey] || 0)) - demandQty;
    slack += Math.max(0, crafts[itemKey] || 0);
    slack -= Math.max(0, consumptions[itemKey] || 0);
    for (const option of consumptionOptions) {
      slack += (option.yields[itemKey] || 0) * Math.max(0, consumptions[option.sourceItemKey] || 0);
    }
    if (!targetCraftedOnlyKeys.has(itemKey)) {
      for (const action of actions) {
        slack += (action.yields[itemKey] || 0) * Math.max(0, missionCounts[action.key] || 0);
      }
    }
    for (const [craftedItemKey, craftCount] of Object.entries(crafts)) {
      slack -= (getRecipe(craftedItemKey)?.ingredients[itemKey] || 0) * Math.max(0, craftCount);
    }
    slackByItem.set(itemKey, slack);
  }

  let droppedCrafts = 0;
  let droppedConsumptions = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const itemKey of itemKeys) {
      const count = Math.max(0, crafts[itemKey] || 0);
      const floor = Math.max(0, craftFloorByItem.get(itemKey) || 0);
      const removable = Math.min(count - floor, Math.floor((slackByItem.get(itemKey) || 0) + 1e-9));
      if (removable <= 0) {
        continue;
      }
      if (removable >= count) {
        delete crafts[itemKey];
      } else {
        crafts[itemKey] = count - removable;
      }
      slackByItem.set(itemKey, (slackByItem.get(itemKey) || 0) - removable);
      for (const [ingredientKey, ingredientQty] of Object.entries(getRecipe(itemKey)?.ingredients || {})) {
        if (slackByItem.has(ingredientKey)) {
          slackByItem.set(ingredientKey, (slackByItem.get(ingredientKey) || 0) + ingredientQty * removable);
        }
      }
      droppedCrafts += removable;
      changed = true;
    }
    for (const option of consumptionOptions) {
      const count = Math.max(0, consumptions[option.sourceItemKey] || 0);
      let removable = count;
      for (const [yieldKey, yieldQty] of Object.entries(option.yields)) {
        if (yieldQty > SCORE_EPS) {
          removable = Math.min(removable, Math.floor(((slackByItem.get(yieldKey) || 0) + 1e-9) / yieldQty));
        }
      }
      if (removable <= 0) {
        continue;
      }
      if (removable >= count) {
        delete consumptions[option.sourceItemKey];
      } else {
        consumptions[option.sourceItemKey] = count - removable;
      }
      for (const [yieldKey, yieldQty] of Object.entries(option.yields)) {
        slackByItem.set(yieldKey, (slackByItem.get(yieldKey) || 0) - yieldQty * removable);
      }
      if (slackByItem.has(option.sourceItemKey)) {
        slackByItem.set(option.sourceItemKey, (slackByItem.get(option.sourceItemKey) || 0) + removable);
      }
      droppedConsumptions += removable;
      changed = true;
    }
  }
  return { droppedCrafts, droppedConsumptions };
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
  consumptionOptions: ConsumptionOption[] = [],
  craftFloorByItem?: Map<string, number>
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [targetKey, quantity] of targetDemandByItem.entries()) {
    collectCraftUpperBounds(targetKey, Math.max(0, Math.round(quantity)), totals);
  }
  // A craft-count goal has no demand row, so its own crafts and everything it
  // eats have to be given room here or the craft variable is bounded to zero.
  for (const [itemKey, floorQty] of craftFloorByItem?.entries() || []) {
    collectCraftUpperBounds(itemKey, Math.max(0, Math.round(floorQty)), totals);
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

/**
 * An item's name with its tier number, as the planner page labels it
 * ("Distegguished gusset (T3)"); the display name's tier word repeats what
 * the name already says.
 */
function itemKeyToTierLabel(itemKey: string): string {
  const entry = artifactDisplayMap[itemKey];
  return entry && Number.isFinite(entry.tierNumber) ? `${entry.name} (T${entry.tierNumber})` : itemKeyToDisplayName(itemKey);
}

/**
 * Tank mode (which never uses the mission yield index): candidate mission
 * actions are cut down to the mission/target pairs worth considering, measured
 * on the loot data the plan runs on.
 * Hundreds of actions leave the tank solves to their time limits, and the
 * incumbents they stop on can be thousands of launches of whatever flies free.
 *
 * Per item the plan needs (anything the actions drop is in the goals'
 * closure), a pair is kept when it ranks in the top `topPerItem` by
 *  - time per unit: a launch's slot time over three slots plus its launch
 *    effort (VIRTUE_LAUNCH_EFFORT_SECONDS), per unit dropped;
 *  - C/I/K/R fuel per unit, where ships that burn none rank best;
 *  - each egg's fuel per unit, ties (above all the ships that burn none of
 *    that egg) going to the faster pair: the fastest way to get the item
 *    without Resilience, say, when the tank has none.
 * A pair counts every level it is offered at (phased leveling fills lower
 * levels first), rated by its best level. Every item that drops keeps at
 * least its best pairs, so an only source is never dropped, and the actions
 * of options that prep launches must fly are kept whole. A phased-leveling
 * chain (`phaseChains`) whose later level keeps an action also keeps every
 * action of each earlier level it has to fill first that would otherwise keep
 * none: those levels can offer only other targets, and with no action left
 * the chain could never reach the level kept. A launch that drops
 * a useful mix of items can lose every ranking and still be the one that
 * fills out a plan best; when the pruned solve is quick, the candidate solve
 * checks it against every action (VIRTUE_TANK_FULL_CHECK_MAX_PRUNED_SECONDS).
 */
function pruneVirtueTankActions(
  actions: MissionAction[],
  options: { topPerItem: number; keepOptionKeys: Set<string>; phaseChains?: PhasedChainConstraint[] }
): MissionAction[] {
  const topPerItem = Math.max(1, Math.round(options.topPerItem));
  const pairKey = (action: MissionAction) => `${action.missionId}|${action.targetAfxId}`;
  type PairRate = { time: number; fuel: number; eggs: Record<VirtueFuelKey, number> };
  const ratesByItem = new Map<string, Map<string, PairRate>>();
  for (const action of actions) {
    const config = getVirtueFuelConfig(action.ship, action.durationType);
    const eggFuel = (egg: VirtueFuelKey) => Math.max(0, config[egg] || 0);
    const launchSeconds = action.durationSeconds / 3 + VIRTUE_LAUNCH_EFFORT_SECONDS;
    const totalFuel = getVirtueFuelPerLaunch(action.ship, action.durationType);
    const key = pairKey(action);
    for (const [itemKey, perLaunch] of Object.entries(action.yields)) {
      if (!(perLaunch > SCORE_EPS)) {
        continue;
      }
      let rates = ratesByItem.get(itemKey);
      if (!rates) {
        rates = new Map();
        ratesByItem.set(itemKey, rates);
      }
      const rate: PairRate = {
        time: launchSeconds / perLaunch,
        fuel: totalFuel / perLaunch,
        eggs: {
          curiosity: eggFuel("curiosity") / perLaunch,
          integrity: eggFuel("integrity") / perLaunch,
          kindness: eggFuel("kindness") / perLaunch,
          resilience: eggFuel("resilience") / perLaunch,
        },
      };
      const existing = rates.get(key);
      if (!existing) {
        rates.set(key, rate);
        continue;
      }
      existing.time = Math.min(existing.time, rate.time);
      existing.fuel = Math.min(existing.fuel, rate.fuel);
      for (const egg of VIRTUE_REFILL_ROUTE_ORDER) {
        existing.eggs[egg] = Math.min(existing.eggs[egg], rate.eggs[egg]);
      }
    }
  }

  const keptPairs = new Set<string>();
  const byCost = (cost: (rate: PairRate) => number) => (a: [string, PairRate], b: [string, PairRate]) =>
    cost(a[1]) - cost(b[1]) || a[1].time - b[1].time || a[0].localeCompare(b[0]);
  const rankings: Array<(rate: PairRate) => number> = [
    (rate) => rate.time,
    (rate) => rate.fuel,
    ...VIRTUE_REFILL_ROUTE_ORDER.map((egg) => (rate: PairRate) => rate.eggs[egg]),
  ];
  for (const rates of ratesByItem.values()) {
    const entries = Array.from(rates.entries());
    for (const cost of rankings) {
      for (const [key] of entries.sort(byCost(cost)).slice(0, topPerItem)) {
        keptPairs.add(key);
      }
    }
  }
  const keptOptionKeys = new Set(options.keepOptionKeys);
  const optionsWithKeptActions = new Set(
    actions.filter((action) => keptPairs.has(pairKey(action))).map((action) => action.optionKey)
  );
  for (const optionKey of keptOptionKeys) {
    optionsWithKeptActions.add(optionKey);
  }
  // The planner's phased-chain rows make each later level wait until every
  // earlier level with launches left (a cap above 0) is full, counting that
  // level's launches over its kept actions.
  for (const { chain, caps } of options.phaseChains || []) {
    let lastKept = -1;
    for (let phase = chain.length - 1; phase > 0; phase -= 1) {
      if (optionsWithKeptActions.has(chain[phase])) {
        lastKept = phase;
        break;
      }
    }
    for (let phase = 0; phase < lastKept; phase += 1) {
      if (Math.round(caps[phase] || 0) > 0 && !optionsWithKeptActions.has(chain[phase])) {
        keptOptionKeys.add(chain[phase]);
      }
    }
  }
  return actions.filter((action) => keptPairs.has(pairKey(action)) || keptOptionKeys.has(action.optionKey));
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

/** Demand plus craft-count goals, so objective references scale with the whole
 *  ask and not just the part that has a demand row. */
function referenceQuantities(
  targetDemandByItem: Map<string, number>,
  craftFloorByItem?: Map<string, number>
): Array<[string, number]> {
  const totals = new Map(targetDemandByItem);
  for (const [itemKey, floorQty] of craftFloorByItem?.entries() || []) {
    totals.set(itemKey, (totals.get(itemKey) || 0) + Math.max(0, Math.round(floorQty)));
  }
  return Array.from(totals.entries());
}

function computeObjectiveReferences(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  actions: MissionAction[];
  targetDemandByItem?: Map<string, number>;
  craftFloorByItem?: Map<string, number>;
}): { geRef: number; fuelRef: number; timeRef: number } {
  const { profile, targetKey, quantity, actions } = options;
  const quantityInt = Math.max(1, Math.round(quantity));
  const targetDemandByItem = options.targetDemandByItem && options.targetDemandByItem.size > 0
    ? options.targetDemandByItem
    : new Map([[targetKey, quantityInt]]);
  const craftUpperBounds = estimateCraftUpperBoundsForTargets(targetDemandByItem, [], options.craftFloorByItem);

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
  for (const [itemKey, demandQty] of referenceQuantities(targetDemandByItem, options.craftFloorByItem)) {
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
  for (const [itemKey, demandQty] of referenceQuantities(targetDemandByItem, options.craftFloorByItem)) {
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
  /** Tank mode only: shifts the solve's refuel loops take, Σ (eggs + 1) per loop. */
  virtueShifts?: number;
  /** Tank mode only: the solve's objective value, for a cutoff another solve must beat. */
  objectiveValue?: number;
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
  /** Crafts this plan must make regardless of demand, from a craft-count goal. */
  craftFloor: number;
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
  craftFloorByItem: Map<string, number>;
};

function buildCraftModelSkeleton(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  closure: Set<string>;
  targetDemandByItem?: Map<string, number>;
  craftFloorByItem?: Map<string, number>;
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
  const craftFloorByItem = options.craftFloorByItem || new Map<string, number>();
  const craftUpperBounds = estimateCraftUpperBoundsForTargets(
    targetDemandByItem,
    options.consumptionOptions || [],
    craftFloorByItem
  );
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
    const craftFloor = Math.max(0, Math.round(craftFloorByItem.get(itemKey) || 0));
    const craftBound = Math.max(craftFloor, Math.ceil(Math.max(0, craftUpperBounds[itemKey] || 0)));
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
      craftFloor,
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

  const effectiveCraftFloorByItem = new Map<string, number>();
  for (const model of craftModels) {
    if (model.craftFloor > 0) {
      effectiveCraftFloorByItem.set(model.itemKey, model.craftFloor);
    }
  }

  return { itemKeys, craftModels, craftModelByItem, unmetVarByItem, demandByItem, craftFloorByItem: effectiveCraftFloorByItem };
}

/** What the unified solve needs to model Path of Virtue fuel tanks. */
type VirtueTankSolveOptions = {
  capacity: number;
  startMode: VirtueTankStartMode;
  /** C/I/K/R in the tank now: the first tank in "current" mode. */
  currentContents: VirtueFuelVector;
  /** Most shifts the refuel loops may take; null leaves it open (the fewest-shifts search). */
  shiftCap: number | null;
  /**
   * "budget": mission time plus VIRTUE_SHIFT_PENALTY_SECONDS per shift and
   * VIRTUE_LAUNCH_EFFORT_SECONDS per launch.
   * "minShift": fewest shifts, then mission time and launch effort.
   * Either way every goal must be met (unmet demand is fixed at 0): a plan
   * that cannot meet them within the cap is infeasible, not partial.
   */
  objective: "budget" | "minShift";
  /** Launches with no mission variable that still burn tank fuel and hold slots: prep steps with no useful drops. */
  fixedLaunches?: Array<{ ship: string; durationType: string; durationSeconds: number; launches: number }>;
  /** Let goals go unmet (at the usual penalty) instead of failing: only to name the ones no plan can meet. */
  softDemand?: boolean;
  /**
   * Proven least shifts for this candidate (from its screening solve). The
   * fewest-shifts search passes it so the bound starts there and the solve
   * stops once it finds a plan with that many.
   */
  shiftFloor?: number;
  /** Objective another candidate already reached: the solve fails fast unless it can beat it. */
  objectiveCutoff?: number;
  /**
   * Time the "budget" objective by the makespan bound (virtueTankMakespanBound)
   * instead of slot time over three slots. It costs the solve an integer per
   * long duration, so candidates get it only when slot time misjudged their plan.
   */
  makespanRounds?: boolean;
};

type VirtueTankFuelGroup = {
  /** Fuel per launch by egg, in percent of the tank capacity. */
  fuelPct: Partial<Record<VirtueFuelKey, number>>;
  totalPct: number;
  eggs: VirtueFuelKey[];
  actionIndexes: number[];
  fixedLaunches: number;
};

type VirtueTankLoopType = {
  key: string;
  eggs: VirtueFuelKey[];
  /** One shift per egg refilled plus the shift back to Humility. */
  shifts: number;
  groupIndexes: number[];
};

type VirtueTankModel = {
  groups: VirtueTankFuelGroup[];
  /** Refuel loops that refill every egg their launches burn. */
  loops: VirtueTankLoopType[];
  /** Eggs some launch burns, in route order: the first refuel loop picks which of them to refill. */
  eggs: VirtueFuelKey[];
};

/**
 * Groups launches by ship and duration (fuel is per launch, not per level or
 * target) and lists the refuel loop types worth modeling: a loop must only
 * refill eggs some group burns, hold at least one group, and not be beaten by
 * a loop with fewer eggs that holds the same groups. Humility is live-fueled
 * on its farm and never takes tank room, so it is not modeled.
 */
function buildVirtueTankModel(actions: MissionAction[], tank: VirtueTankSolveOptions): VirtueTankModel {
  const capacity = Math.max(1, tank.capacity);
  const groupByKey = new Map<string, VirtueTankFuelGroup>();
  const groups: VirtueTankFuelGroup[] = [];
  const groupFor = (ship: string, durationType: string): VirtueTankFuelGroup | null => {
    const key = `${ship}|${durationType}`;
    const existing = groupByKey.get(key);
    if (existing) {
      return existing;
    }
    const config = getVirtueFuelConfig(ship, durationType);
    const fuelPct: Partial<Record<VirtueFuelKey, number>> = {};
    const eggs: VirtueFuelKey[] = [];
    let totalPct = 0;
    for (const egg of VIRTUE_REFILL_ROUTE_ORDER) {
      const amount = Math.max(0, config[egg] || 0);
      if (amount > 0) {
        fuelPct[egg] = (amount / capacity) * 100;
        eggs.push(egg);
        totalPct += fuelPct[egg]!;
      }
    }
    if (totalPct <= 0) {
      return null;
    }
    const group: VirtueTankFuelGroup = { fuelPct, totalPct, eggs, actionIndexes: [], fixedLaunches: 0 };
    groupByKey.set(key, group);
    groups.push(group);
    return group;
  };
  for (let index = 0; index < actions.length; index += 1) {
    groupFor(actions[index].ship, actions[index].durationType)?.actionIndexes.push(index);
  }
  for (const fixed of tank.fixedLaunches || []) {
    const launches = Math.max(0, Math.round(fixed.launches));
    const group = launches > 0 ? groupFor(fixed.ship, fixed.durationType) : null;
    if (group) {
      group.fixedLaunches += launches;
    }
  }

  const burned = new Set(groups.flatMap((group) => group.eggs));
  const candidates: VirtueTankLoopType[] = [];
  for (let mask = 1; mask < 1 << VIRTUE_REFILL_ROUTE_ORDER.length; mask += 1) {
    const eggs = VIRTUE_REFILL_ROUTE_ORDER.filter((_, eggIndex) => (mask & (1 << eggIndex)) !== 0);
    if (!eggs.every((egg) => burned.has(egg))) {
      continue;
    }
    const groupIndexes = groups
      .map((group, groupIndex) => (group.eggs.every((egg) => eggs.includes(egg)) ? groupIndex : -1))
      .filter((groupIndex) => groupIndex >= 0);
    if (groupIndexes.length > 0) {
      candidates.push({ key: eggs.map((egg) => egg[0].toUpperCase()).join(""), eggs, shifts: eggs.length + 1, groupIndexes });
    }
  }
  const loops = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other.eggs.length < candidate.eggs.length &&
          candidate.groupIndexes.every((groupIndex) => other.groupIndexes.includes(groupIndex))
      )
  );
  return { groups, loops, eggs: VIRTUE_REFILL_ROUTE_ORDER.filter((egg) => burned.has(egg)) };
}

/**
 * How a tank solve models its refuel loops: up to VIRTUE_TANK_INDIVIDUAL_LOOPS
 * one by one, and loop types past them while the cap leaves room for more
 * (every loop takes at least two shifts). `exact` says the loops modeled one
 * by one cover every loop the cap allows.
 */
function virtueTankLoopLayout(shiftCap: number | null): { individual: number; tail: boolean; exact: boolean } {
  const maxLoops = shiftCap === null ? Number.POSITIVE_INFINITY : Math.floor(Math.max(0, shiftCap) / 2);
  const individual = Math.min(maxLoops, VIRTUE_TANK_INDIVIDUAL_LOOPS);
  return { individual, tail: maxLoops > individual, exact: maxLoops <= individual };
}

/**
 * Tank mode's lower bound on how long launches take on three mission slots:
 * the slot time spread evenly, or the rounds each long duration needs (n
 * missions of one duration fly in ceil(n / 3) rounds), whichever is longer.
 * Slot time over three alone reads one 38h mission as 13h.
 */
function virtueTankMakespanBound(launches: Array<{ durationSeconds: number; launches: number }>): number {
  let slotSeconds = 0;
  const launchesByDuration = new Map<number, number>();
  for (const entry of launches) {
    const count = Math.max(0, entry.launches);
    if (count <= 0) {
      continue;
    }
    slotSeconds += count * entry.durationSeconds;
    if (entry.durationSeconds >= VIRTUE_TANK_MAKESPAN_ROUND_MIN_SECONDS) {
      launchesByDuration.set(entry.durationSeconds, (launchesByDuration.get(entry.durationSeconds) || 0) + count);
    }
  }
  let bound = slotSeconds / 3;
  for (const [durationSeconds, count] of launchesByDuration.entries()) {
    bound = Math.max(bound, durationSeconds * Math.ceil(count / 3 - SCORE_EPS));
  }
  return bound;
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
  /** Path of Virtue tank mode (virtue objective only): fuel tank, refuel loop and shift cap rows. */
  virtueTank?: VirtueTankSolveOptions;
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
    virtueTank,
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
    craftFloorByItem,
  } = craftSkeleton || buildCraftModelSkeleton({ profile, targetKey, quantity, closure, consumptionOptions });
  const missionVars = actions.map((_, index) => `m_${index}`);
  const consumptionVars = consumptionOptions.map((_, index) => `x_${index}`);
  const normalizedGeRef = Math.max(1, geRef);
  const normalizedFuelRef = Math.max(1, fuelRef);
  const normalizedTimeRef = Math.max(1, timeRef);
  const objectiveContext = normalizeObjectiveContext(objectiveMode, priorityTime, minimumTimePriority);
  const tankModel = virtueTank && objectiveContext.mode === "virtueFuel" ? buildVirtueTankModel(actions, virtueTank) : null;

  const lines: string[] = [];
  lines.push("Minimize");
  const objectiveTerms: Array<{ coefficient: number; variable: string }> = [];
  const geConstraintTerms: Array<{ coefficient: number; variable: string }> = [];
  let maxObjectiveCoeff = 1;
  const craftGeObjectiveWeight = objectiveContext.mode === "ge"
    ? Math.max(objectiveContext.resourceWeight, MIN_CRAFT_GE_OBJECTIVE_WEIGHT)
    : VIRTUE_GE_TIEBREAKER_WEIGHT;

  for (const model of craftModels) {
    for (let index = 0; index < model.preDiscountStepVars.length; index += 1) {
      const geCoeff = model.preDiscountStepCosts[index];
      geConstraintTerms.push({
        coefficient: geCoeff,
        variable: model.preDiscountStepVars[index],
      });
      const coefficient = (craftGeObjectiveWeight * geCoeff) / normalizedGeRef;
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
      const coefficient = (craftGeObjectiveWeight * tailCost) / normalizedGeRef;
      objectiveTerms.push({
        coefficient,
        variable: model.tailVar,
      });
      maxObjectiveCoeff = Math.max(maxObjectiveCoeff, Math.abs(coefficient));
    }
  }

  const missionObjectiveWeight = strictGeObjective ? 0 : Math.max(objectiveContext.timeWeight, MIN_MISSION_TIME_OBJECTIVE_WEIGHT);
  // Tank mode with makespanRounds: mission time is the makespan bound vmk
  // blended with a little slot time (VIRTUE_TANK_SLOT_TIME_WEIGHT).
  const tankMakespan = tankModel !== null && virtueTank!.objective === "budget" && Boolean(virtueTank!.makespanRounds) && !lpRelaxation;
  const slotTimeWeight = tankMakespan ? VIRTUE_TANK_SLOT_TIME_WEIGHT : 1;
  if (missionObjectiveWeight > 0) {
    // Tank mode charges each launch the player's effort
    // (VIRTUE_LAUNCH_EFFORT_SECONDS), which plan comparisons count too, in
    // place of the usual launch tie-break.
    const missionLaunchTiebreakCoeff =
      (missionObjectiveWeight * (tankModel ? VIRTUE_LAUNCH_EFFORT_SECONDS : MISSION_LAUNCH_TIEBREAKER_SECONDS)) / normalizedTimeRef;
    const targetedTiebreakCoeff = (missionObjectiveWeight * TARGETED_MISSION_TIEBREAKER_SECONDS) / normalizedTimeRef;
    for (let index = 0; index < actions.length; index += 1) {
      // Tank mode prices fuel through the shifts it forces, so fuel itself is
      // only a tie-break there.
      const fuelCoeff = tankModel
        ? (missionObjectiveWeight *
            VIRTUE_TANK_FUEL_TIEBREAK_SECONDS_PER_TRILLION *
            (getVirtueFuelPerLaunch(actions[index].ship, actions[index].durationType) / TRILLION)) /
          normalizedTimeRef
        : objectiveContext.mode === "virtueFuel"
          ? (objectiveContext.resourceWeight * getVirtueFuelPerLaunch(actions[index].ship, actions[index].durationType)) / normalizedFuelRef
          : 0;
      const coefficient =
        fuelCoeff +
        (slotTimeWeight * missionObjectiveWeight * (actions[index].durationSeconds / 3)) / normalizedTimeRef +
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
  // Tank mode: the first refuel loops are modeled one by one (see
  // virtueTankLoopLayout), so a loop can top up an egg for the next one. Each
  // costs a shift back to Humility (vw_j) plus one per egg it refills
  // (vz_j_e). Loops past them, while the cap leaves room, are loop types that
  // refill every egg their launches burn (vk_tau of each). Shift terms stay
  // out of maxObjectiveCoeff so the unmet penalty keeps its usual scale.
  const tankEggs = tankModel?.eggs || [];
  const loopLayout = virtueTankLoopLayout(virtueTank?.shiftCap ?? null);
  const individualLoops =
    tankModel && tankEggs.length > 0 ? Array.from({ length: loopLayout.individual }, (_, index) => index + 1) : [];
  const tailLoops = tankModel && tankEggs.length > 0 && loopLayout.tail ? tankModel.loops : [];
  const loopUsedVar = (loop: number) => `vw_${loop}`;
  const refillVar = (loop: number, egg: VirtueFuelKey) => `vz_${loop}_${egg[0]}`;
  const loopContentVar = (loop: number, egg: VirtueFuelKey) => `vb_${loop}_${egg[0]}`;
  const tailCountVars = tailLoops.map((loop) => `vk_${loop.key}`);
  const shiftTerms: Array<{ coefficient: number; variable: string }> = [
    ...individualLoops.flatMap((loop) => [
      { coefficient: 1, variable: loopUsedVar(loop) },
      ...tankEggs.map((egg) => ({ coefficient: 1, variable: refillVar(loop, egg) })),
    ]),
    ...tailLoops.map((loop, tailIndex) => ({ coefficient: loop.shifts, variable: tailCountVars[tailIndex] })),
  ];
  if (tankModel) {
    const shiftCoeff = virtueTank!.objective === "minShift"
      ? VIRTUE_TANK_MIN_SHIFT_WEIGHT
      : (Math.max(missionObjectiveWeight, MIN_MISSION_TIME_OBJECTIVE_WEIGHT) * VIRTUE_SHIFT_PENALTY_SECONDS) / normalizedTimeRef;
    for (const term of shiftTerms) {
      objectiveTerms.push({ coefficient: shiftCoeff * term.coefficient, variable: term.variable });
    }
    if (tankMakespan) {
      objectiveTerms.push({
        coefficient:
          ((1 - VIRTUE_TANK_SLOT_TIME_WEIGHT) * Math.max(missionObjectiveWeight, MIN_MISSION_TIME_OBJECTIVE_WEIGHT)) / normalizedTimeRef,
        variable: "vmk",
      });
    }
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

  // Tank model, fuel in percent of the tank. Each fuel group's launches are
  // split between the first tank (vn_g_0), the refuel loops (vq_g_j) and,
  // past them, tail loop types (vn_g_tau). Per egg, loop j starts with
  // vb_j_e: what the tank before it left, or anything up to a full tank when
  // the loop refills the egg. Drains are free, so only the eggs a loop starts
  // with take room, and they fit one tank. Loop capacity is the whole tank:
  // packing afterwards models the limit sliders exactly and is the source of
  // truth for the shifts.
  const tankShareBounds: Array<{ variable: string; upper?: number }> = [];
  const tankScreeningIntegerVars: string[] = [...tailCountVars];
  const tankLaunchIntegerVars: string[] = [];
  const tankBinaryVars: string[] = [
    ...individualLoops.flatMap((loop) => [loopUsedVar(loop), ...tankEggs.map((egg) => refillVar(loop, egg))]),
  ];
  const tankContentVars: string[] = [];
  let tankConstraintCount = 0;
  if (tankModel) {
    const tank = virtueTank!;
    const { groups } = tankModel;
    const initialVars = groups.map((_, groupIndex) => `vn_${groupIndex}_0`);
    const loopShareVar = (groupIndex: number, loop: number) => `vq_${groupIndex}_${loop}`;
    const tailShareVar = (groupIndex: number, loop: VirtueTankLoopType) => `vn_${groupIndex}_${loop.key}`;
    // A launch draws its fuel atomically, so a tank fits only whole launches.
    const launchesPerTank = (group: VirtueTankFuelGroup) => Math.floor(100 / group.totalPct + SCORE_EPS);
    const atomicUpper = (group: VirtueTankFuelGroup) => {
      const perTank = launchesPerTank(group);
      return perTank <= VIRTUE_TANK_ATOMIC_CUT_MAX_LAUNCHES ? perTank : undefined;
    };
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      const terms: Array<{ coefficient: number; variable: string }> = group.actionIndexes.map((actionIndex) => ({
        coefficient: 1,
        variable: missionVars[actionIndex],
      }));
      terms.push({ coefficient: -1, variable: initialVars[groupIndex] });
      tankShareBounds.push({ variable: initialVars[groupIndex], upper: atomicUpper(group) });
      for (const loop of individualLoops) {
        terms.push({ coefficient: -1, variable: loopShareVar(groupIndex, loop) });
        tankShareBounds.push({ variable: loopShareVar(groupIndex, loop), upper: atomicUpper(group) });
        tankLaunchIntegerVars.push(loopShareVar(groupIndex, loop));
      }
      for (const loop of tailLoops) {
        if (loop.groupIndexes.includes(groupIndex)) {
          terms.push({ coefficient: -1, variable: tailShareVar(groupIndex, loop) });
          tankShareBounds.push({ variable: tailShareVar(groupIndex, loop) });
        }
      }
      lines.push(`  vy_${groupIndex}: ${formatLinearExpression(terms)} = ${formatLpNumber(-group.fixedLaunches)}`);
      tankConstraintCount += 1;
    }
    // Integer first-tank shares: continuous ones let a fraction of a launch
    // use up exactly what is left in the tank, which undercounts the loops.
    // Loop shares are integer for the same reason, except in screening.
    tankScreeningIntegerVars.push(...initialVars);

    const burnTerms = (egg: VirtueFuelKey, shareVar: (groupIndex: number) => string) =>
      groups.flatMap((group, groupIndex) => {
        const fuelPct = group.fuelPct[egg] || 0;
        return fuelPct > 0 ? [{ coefficient: fuelPct, variable: shareVar(groupIndex) }] : [];
      });
    // The first tank is the current contents as-is, or an ideal fill (vi_e)
    // of at most one tank.
    const idealFillVars: string[] = [];
    for (const egg of tankEggs) {
      const initialBurn = burnTerms(egg, (groupIndex) => initialVars[groupIndex]);
      const idealFillVar = `vi_${egg[0]}`;
      // Tank readings carry float noise, so allow one egg of slack.
      const availablePct = ((Math.max(0, tank.currentContents[egg] || 0) + 1) / Math.max(1, tank.capacity)) * 100;
      if (tank.startMode === "ideal") {
        idealFillVars.push(idealFillVar);
        tankShareBounds.push({ variable: idealFillVar });
        lines.push(`  vt_${egg[0]}: ${formatLinearExpression([...initialBurn, { coefficient: -1, variable: idealFillVar }])} <= 0`);
      } else {
        lines.push(`  vt_${egg[0]}: ${formatLinearExpression(initialBurn)} <= ${formatLpNumber(availablePct)}`);
      }
      tankConstraintCount += 1;
      for (const loop of individualLoops) {
        const contentVar = loopContentVar(loop, egg);
        tankContentVars.push(contentVar);
        // The loop's launches burn only what it starts with...
        const loopBurn = burnTerms(egg, (groupIndex) => loopShareVar(groupIndex, loop));
        lines.push(`  vu_${loop}_${egg[0]}: ${formatLinearExpression([...loopBurn, { coefficient: -1, variable: contentVar }])} <= 0`);
        // ...which, unless it refills the egg, is what the tank before it left.
        const carryTerms: Array<{ coefficient: number; variable: string }> = [
          { coefficient: 1, variable: contentVar },
          { coefficient: -100, variable: refillVar(loop, egg) },
        ];
        let carryRhs = 0;
        if (loop === 1) {
          carryTerms.push(...initialBurn);
          if (tank.startMode === "ideal") {
            carryTerms.push({ coefficient: -1, variable: idealFillVar });
          } else {
            carryRhs = availablePct;
          }
        } else {
          carryTerms.push(...burnTerms(egg, (groupIndex) => loopShareVar(groupIndex, loop - 1)));
          carryTerms.push({ coefficient: -1, variable: loopContentVar(loop - 1, egg) });
        }
        lines.push(`  vr_${loop}_${egg[0]}: ${formatLinearExpression(carryTerms)} <= ${formatLpNumber(carryRhs)}`);
        // A refill is part of the loop.
        lines.push(`  ve_${loop}_${egg[0]}: ${refillVar(loop, egg)} - ${loopUsedVar(loop)} <= 0`);
        tankConstraintCount += 3;
      }
    }
    if (idealFillVars.length > 0) {
      lines.push(`  vt_0: ${formatLinearExpression(idealFillVars.map((variable) => ({ coefficient: 1, variable })))} <= 100`);
      tankConstraintCount += 1;
    }
    for (const loop of individualLoops) {
      const usedVar = loopUsedVar(loop);
      // What the loop starts with fits one tank; an unused loop holds nothing.
      lines.push(
        `  vc_${loop}: ${formatLinearExpression([
          ...tankEggs.map((egg) => ({ coefficient: 1, variable: loopContentVar(loop, egg) })),
          { coefficient: -100, variable: usedVar },
        ])} <= 0`
      );
      // A loop refills at least one egg (one that refills nothing would only
      // split a tank for a shift), and loops are used in order.
      lines.push(
        `  vh_${loop}: ${formatLinearExpression([
          { coefficient: 1, variable: usedVar },
          ...tankEggs.map((egg) => ({ coefficient: -1, variable: refillVar(loop, egg) })),
        ])} <= 0`
      );
      tankConstraintCount += 2;
      if (loop > 1) {
        lines.push(`  vo_${loop}: ${usedVar} - ${loopUsedVar(loop - 1)} <= 0`);
        tankConstraintCount += 1;
      }
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        const perLoop = atomicUpper(groups[groupIndex]);
        if (perLoop !== undefined) {
          lines.push(`  vd_${groupIndex}_${loop}: ${loopShareVar(groupIndex, loop)} - ${formatLpNumber(perLoop)} ${usedVar} <= 0`);
          tankConstraintCount += 1;
        }
      }
    }
    for (let tailIndex = 0; tailIndex < tailLoops.length; tailIndex += 1) {
      const loop = tailLoops[tailIndex];
      const countVar = tailCountVars[tailIndex];
      const terms: Array<{ coefficient: number; variable: string }> = loop.groupIndexes.map((groupIndex) => ({
        coefficient: groups[groupIndex].totalPct,
        variable: tailShareVar(groupIndex, loop),
      }));
      terms.push({ coefficient: -100, variable: countVar });
      lines.push(`  vl_${loop.key}: ${formatLinearExpression(terms)} <= 0`);
      tankConstraintCount += 1;
      for (const groupIndex of loop.groupIndexes) {
        const perLoop = atomicUpper(groups[groupIndex]);
        if (perLoop !== undefined) {
          lines.push(
            `  va_${groupIndex}_${loop.key}: ${formatLinearExpression([
              { coefficient: 1, variable: tailShareVar(groupIndex, loop) },
              { coefficient: -perLoop, variable: countVar },
            ])} <= 0`
          );
          tankConstraintCount += 1;
        }
      }
    }
    if (tank.shiftFloor !== undefined && tank.shiftFloor > 0 && shiftTerms.length > 0) {
      lines.push(`  vm_0: ${formatLinearExpression(shiftTerms)} >= ${formatLpNumber(Math.round(tank.shiftFloor))}`);
      tankConstraintCount += 1;
    }
    if (tank.shiftCap !== null && shiftTerms.length > 0) {
      const safeShiftCap = Math.max(0, Math.floor(tank.shiftCap + SCORE_EPS));
      lines.push(`  vs_0: ${formatLinearExpression(shiftTerms)} <= ${formatLpNumber(safeShiftCap)}`);
      tankConstraintCount += 1;
      // Tail loops only follow the last loop modeled one by one; this cuts
      // the copies of every plan that differ only in which kind a loop is.
      if (tailLoops.length > 0 && individualLoops.length > 0) {
        const tailRoom = Math.floor(safeShiftCap / 2) - individualLoops.length;
        lines.push(
          `  vg_0: ${formatLinearExpression([
            ...tailCountVars.map((variable) => ({ coefficient: 1, variable })),
            { coefficient: -tailRoom, variable: loopUsedVar(individualLoops[individualLoops.length - 1]) },
          ])} <= 0`
        );
        tankConstraintCount += 1;
      }
    }
  }
  // The makespan bound: slot time over three slots, and each long duration's
  // rounds (vrd_k), counting the fixed prep launches too.
  const makespanRoundVars: string[] = [];
  if (tankMakespan) {
    const fixedLaunches = (virtueTank!.fixedLaunches || []).filter(
      (fixed) => fixed.launches > 0 && Number.isFinite(fixed.durationSeconds) && fixed.durationSeconds > 0
    );
    const fixedSlotSeconds = fixedLaunches.reduce((sum, fixed) => sum + Math.round(fixed.launches) * fixed.durationSeconds, 0);
    const slotTerms = actions.map((action, index) => ({ coefficient: -action.durationSeconds, variable: missionVars[index] }));
    lines.push(`  vmk_s: ${formatLinearExpression([{ coefficient: 3, variable: "vmk" }, ...slotTerms])} >= ${formatLpNumber(fixedSlotSeconds)}`);
    tankConstraintCount += 1;
    const rounds = new Map<number, { missionIndexes: number[]; fixedLaunches: number }>();
    const roundsFor = (durationSeconds: number) => {
      const existing = rounds.get(durationSeconds);
      if (existing) {
        return existing;
      }
      const entry = { missionIndexes: [] as number[], fixedLaunches: 0 };
      rounds.set(durationSeconds, entry);
      return entry;
    };
    actions.forEach((action, index) => {
      if (action.durationSeconds >= VIRTUE_TANK_MAKESPAN_ROUND_MIN_SECONDS) {
        roundsFor(action.durationSeconds).missionIndexes.push(index);
      }
    });
    for (const fixed of fixedLaunches) {
      if (fixed.durationSeconds >= VIRTUE_TANK_MAKESPAN_ROUND_MIN_SECONDS) {
        roundsFor(fixed.durationSeconds).fixedLaunches += Math.round(fixed.launches);
      }
    }
    for (const [durationSeconds, entry] of rounds.entries()) {
      const roundVar = `vrd_${makespanRoundVars.length}`;
      const launchTerms = entry.missionIndexes.map((index) => ({ coefficient: -1, variable: missionVars[index] }));
      lines.push(`  ${roundVar}: ${formatLinearExpression([{ coefficient: 3, variable: roundVar }, ...launchTerms])} >= ${formatLpNumber(entry.fixedLaunches)}`);
      lines.push(`  vmk_${makespanRoundVars.length}: vmk - ${formatLpNumber(durationSeconds)} ${roundVar} >= 0`);
      makespanRoundVars.push(roundVar);
      tankConstraintCount += 2;
    }
  }
  // Tank solves never trade goals away: a cap too low for them should fail
  // (and trigger the fewest-shifts search), and without the do-nothing
  // incumbent a binding cap finds real plans far sooner.
  const hardDemand = tankModel !== null && !virtueTank!.softDemand;

  lines.push("Bounds");
  for (const model of craftModels) {
    lines.push(`  ${formatLpNumber(model.craftFloor)} <= ${model.craftVar} <= ${formatLpNumber(model.craftBound)}`);
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
    lines.push(hardDemand ? `  0 <= ${variable} <= 0` : `  ${variable} >= 0`);
  }
  for (const zVar of phasedBinaryVars) {
    lines.push(`  0 <= ${zVar} <= 1`);
  }
  for (const { variable, upper } of tankShareBounds) {
    lines.push(upper !== undefined ? `  0 <= ${variable} <= ${formatLpNumber(upper)}` : `  ${variable} >= 0`);
  }
  for (const variable of tailCountVars) {
    lines.push(`  ${variable} >= 0`);
  }
  for (const variable of tankBinaryVars) {
    lines.push(`  0 <= ${variable} <= 1`);
  }
  for (const variable of tankContentVars) {
    lines.push(`  ${variable} >= 0`);
  }
  if (tankMakespan) {
    lines.push("  vmk >= 0");
  }
  for (const variable of makespanRoundVars) {
    lines.push(`  ${variable} >= 0`);
  }

  // The loop switches and counts and the first-tank shares stay integer even
  // in the relaxed screening solve (a small MILP): a relaxed loop count of
  // fuel / capacity cannot tell candidates apart once whole loops are what
  // cost shifts.
  const integerVars = lpRelaxation
    ? [...tankScreeningIntegerVars, ...tankBinaryVars]
    : [
        ...craftModels.map((model) => model.craftVar),
        ...craftModels.flatMap((model) => model.preDiscountStepVars),
        ...craftModels.flatMap((model) => (model.tailVar ? [model.tailVar] : [])),
        ...consumptionVars,
        ...missionVars,
        ...tankScreeningIntegerVars,
        ...tankBinaryVars,
        ...tankLaunchIntegerVars,
        ...makespanRoundVars,
      ];
  if (integerVars.length > 0) {
    lines.push("General");
    const chunkSize = 24;
    for (let index = 0; index < integerVars.length; index += chunkSize) {
      lines.push(`  ${integerVars.slice(index, index + chunkSize).join(" ")}`);
    }
  }
  if (!lpRelaxation) {
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
    slotSecondsConstraintCount +
    tankConstraintCount;

  const solveStartedAtMs = Date.now();
  const useExactMipGap = !lpRelaxation && (strictGeObjective || hasGeCostUpperBound);
  const effectiveTimeLimitSeconds = timeLimitSeconds ?? (tankModel ? VIRTUE_TANK_SOLVE_TIME_LIMIT_SECONDS : undefined);
  // The fewest-shifts search only needs the shift count proven: stop once the
  // bound rules out one shift fewer, rather than closing 1% of a shift-sized
  // objective, which can take minutes. Mission time is re-optimized at N.
  const minShiftGap: Record<string, number> =
    tankModel && virtueTank!.objective === "minShift" ? { mip_abs_gap: VIRTUE_TANK_MIN_SHIFT_WEIGHT * 0.9 } : {};
  // Pruning against another candidate's objective turns a long losing solve
  // into a quick "Infeasible".
  const objectiveCutoff: Record<string, number> =
    tankModel && virtueTank!.objectiveCutoff !== undefined && Number.isFinite(virtueTank!.objectiveCutoff)
      ? { objective_bound: virtueTank!.objectiveCutoff }
      : {};
  const solution = await solve(lines.join("\n"), {
    ...(lpRelaxation && integerVars.length === 0 ? {} : { mip_rel_gap: useExactMipGap ? 0 : 0.01, ...minShiftGap, ...objectiveCutoff }),
    ...(effectiveTimeLimitSeconds !== undefined && Number.isFinite(effectiveTimeLimitSeconds) && effectiveTimeLimitSeconds > 0
      ? { time_limit: effectiveTimeLimitSeconds }
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
  // Binding shift caps can make a tank solve run for minutes, and its early
  // incumbents are often the do-nothing plan. A timed-out tank solve is kept
  // only if it has an incumbent that meets every goal (checked below).
  const acceptTankTimeLimit =
    tankModel !== null &&
    status === "Time limit reached" &&
    Number.isFinite(solution.ObjectiveValue as number) &&
    Math.abs(solution.ObjectiveValue as number) < 1e20 &&
    Object.keys(solution.Columns || {}).length > 0;
  if (status !== "Optimal" && !acceptTankTimeLimit) {
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

  const trimmed = trimSurplusCraftsAndConsumptions({
    profile,
    itemKeys,
    demandByItem,
    crafts,
    consumptions,
    consumptionOptions,
    actions,
    missionCounts,
    targetCraftedOnlyKeys: effectiveTargetCraftedOnlyKeys,
    craftFloorByItem,
  });
  const notes = ["Craft + mission allocation solved with unified HiGHS model (exact craft discount scheduling)."];
  if (trimmed.droppedCrafts > 0 || trimmed.droppedConsumptions > 0) {
    const dropped: string[] = [];
    if (trimmed.droppedCrafts > 0) {
      dropped.push(`${trimmed.droppedCrafts.toLocaleString()} craft${trimmed.droppedCrafts === 1 ? "" : "s"}`);
    }
    if (trimmed.droppedConsumptions > 0) {
      dropped.push(
        `${trimmed.droppedConsumptions.toLocaleString()} consumption${trimmed.droppedConsumptions === 1 ? "" : "s"}`
      );
    }
    notes.push(`Dropped ${dropped.join(" and ")} the solver left in its solution that nothing in the plan draws on.`);
  }

  const remainingDemand: Record<string, number> = {};
  for (const itemKey of itemKeys) {
    const rawValue = solution.Columns?.[unmetVarByItem.get(itemKey)!]?.Primal || 0;
    remainingDemand[itemKey] = Math.max(0, rawValue);
  }
  if (acceptTankTimeLimit && Object.values(remainingDemand).some((qty) => qty > 1e-6)) {
    throw new Error(`unified HiGHS solve status '${status}' before meeting every goal`);
  }
  let virtueShifts: number | undefined;
  if (tankModel) {
    const loopCount = (variable: string) => Math.max(0, Math.round(solution.Columns?.[variable]?.Primal || 0));
    virtueShifts = shiftTerms.reduce((sum, term) => sum + term.coefficient * loopCount(term.variable), 0);
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
    notes,
    ...(virtueShifts !== undefined ? { virtueShifts } : {}),
    ...(tankModel && Number.isFinite(solution.ObjectiveValue as number) ? { objectiveValue: solution.ObjectiveValue as number } : {}),
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

function craftFloorFingerprint(craftFloorByItem?: Map<string, number>): string {
  if (!craftFloorByItem || craftFloorByItem.size === 0) {
    return "none";
  }
  return Array.from(craftFloorByItem.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([itemKey, qty]) => `${itemKey}:${Math.max(0, Math.round(qty))}`)
    .join("|");
}

function craftSkeletonCacheKey(options: {
  targetKey: string;
  quantity: number;
  closure: Set<string>;
  profile: PlayerProfile;
  targetDemandByItem?: Map<string, number>;
  craftFloorByItem?: Map<string, number>;
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
    `floors:${craftFloorFingerprint(options.craftFloorByItem)}`,
  ].join("::");
}

function getCraftSkeletonCached(options: {
  profile: PlayerProfile;
  targetKey: string;
  quantity: number;
  closure: Set<string>;
  targetDemandByItem?: Map<string, number>;
  craftFloorByItem?: Map<string, number>;
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

/** Claims `base` as a row key, suffixing it if another row already has it. */
function claimUniqueRowKey(base: string, used: Set<string>): string {
  let key = base;
  for (let suffix = 2; used.has(key); suffix += 1) {
    key = `${base}#${suffix}`;
  }
  used.add(key);
  return key;
}

function missionRowKeyBase(row: { missionId: string; level: number; targetAfxId: number }): string {
  return `${row.missionId}|${row.level}|${row.targetAfxId}`;
}

/**
 * One row per launched action, each with a stable `rowKey`. Pass
 * `actionKeyByRowKey` to learn which action each row came from.
 */
function buildMissionRows(
  actions: MissionAction[],
  missionCounts: Record<string, number>,
  actionKeyByRowKey?: Map<string, string>
): PlanMissionRow[] {
  const actionByKey = new Map(actions.map((action) => [action.key, action]));
  const rows = Object.entries(missionCounts)
    .map(([key, launches]) => {
      const action = actionByKey.get(key);
      if (!action) {
        return null;
      }
      const expectedYields = Object.entries(action.yields)
        .map(([itemKey, perMission]) => ({ itemId: itemKeyToId(itemKey), quantity: perMission * launches }))
        .filter((entry) => entry.quantity > 0)
        .sort((a, b) => b.quantity - a.quantity);

      const row: PlanMissionRow = {
        missionId: action.missionId,
        ship: action.ship,
        durationType: action.durationType,
        level: action.level,
        targetAfxId: action.targetAfxId,
        launches,
        durationSeconds: action.durationSeconds,
        expectedYields,
      };
      return { row, actionKey: key };
    })
    .filter((entry): entry is { row: PlanMissionRow; actionKey: string } => entry !== null)
    .sort(({ row: a }, { row: b }) => {
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
  const usedRowKeys = new Set<string>();
  return rows.map(({ row, actionKey }) => {
    row.rowKey = claimUniqueRowKey(missionRowKeyBase(row), usedRowKeys);
    actionKeyByRowKey?.set(row.rowKey, actionKey);
    return row;
  });
}

/**
 * The plan's launches as tank-packing units: one per mission row, with the
 * prep launches a row carries (forced by a prep step) split out ahead of it,
 * plus one per prep step with no useful drops, which has no row but still
 * burns fuel. Prep units carry their step's dependency order.
 */
function buildVirtueTankUnits(options: {
  actions: MissionAction[];
  missionRows: PlanMissionRow[];
  actionKeyByRowKey: Map<string, string>;
  prepSteps: PrepProgressionStep[];
}): VirtueTankPlanUnit[] {
  const { actions, missionRows, actionKeyByRowKey, prepSteps } = options;
  const actionByKey = new Map(actions.map((action) => [action.key, action]));
  const actionOptionKeys = new Set(actions.map((action) => action.optionKey));
  const prepOrderByOption = new Map<string, number>();
  prepSteps.forEach((step, index) => {
    const optionKey = missionOptionKey(step.option);
    if (!prepOrderByOption.has(optionKey)) {
      prepOrderByOption.set(optionKey, index);
    }
  });
  const prepRequirements = aggregatePrepOptionRequirements(prepSteps);
  const prepLaunchesLeft = new Map(
    Array.from(prepRequirements.entries()).map(([optionKey, requirement]) => [optionKey, requirement.launches])
  );

  const prepUnits: VirtueTankPlanUnit[] = [];
  const missionUnits: VirtueTankPlanUnit[] = [];
  for (const row of missionRows) {
    if (row.inAir || !row.rowKey || row.launches <= 0) {
      continue;
    }
    const unitBase = {
      ship: row.ship,
      durationType: row.durationType,
      level: row.level,
      durationSeconds: row.durationSeconds,
      missionRowKey: row.rowKey,
      targetAfxId: row.targetAfxId,
    };
    const optionKey = actionByKey.get(actionKeyByRowKey.get(row.rowKey) || "")?.optionKey;
    const prepLaunches = optionKey ? Math.min(row.launches, prepLaunchesLeft.get(optionKey) || 0) : 0;
    if (optionKey && prepLaunches > 0) {
      prepLaunchesLeft.set(optionKey, (prepLaunchesLeft.get(optionKey) || 0) - prepLaunches);
      prepUnits.push({
        ...unitBase,
        id: `${row.rowKey}|prep`,
        launches: prepLaunches,
        isPrep: true,
        prepOrder: prepOrderByOption.get(optionKey) ?? 0,
      });
    }
    if (row.launches > prepLaunches) {
      missionUnits.push({ ...unitBase, id: row.rowKey, launches: row.launches - prepLaunches });
    }
  }

  const usedIds = new Set([...prepUnits, ...missionUnits].map((unit) => unit.id));
  for (const [optionKey, requirement] of prepRequirements.entries()) {
    if (actionOptionKeys.has(optionKey) || requirement.launches <= 0) {
      continue;
    }
    const { option } = requirement;
    prepUnits.push({
      id: claimUniqueRowKey(`prep|${option.missionId}|${option.level}`, usedIds),
      ship: option.ship,
      durationType: option.durationType,
      level: option.level,
      durationSeconds: option.durationSeconds,
      launches: requirement.launches,
      isPrep: true,
      prepOrder: prepOrderByOption.get(optionKey) ?? 0,
    });
  }
  prepUnits.sort((a, b) => (a.prepOrder ?? 0) - (b.prepOrder ?? 0));
  return [...prepUnits, ...missionUnits];
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
  craftGoalTotals?: Map<string, number>;
  craftCounts?: Record<string, number>;
}): TargetBreakdownRow[] {
  const rows: TargetBreakdownRow[] = [];
  for (const [targetKey, quantity] of options.targetDemandByItem.entries()) {
    if (quantity <= 0) {
      // The zero placeholder a craft-goal-only plan carries, not a real goal.
      continue;
    }
    rows.push({
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
    });
  }
  for (const [targetKey, goalTotal] of options.craftGoalTotals?.entries() || []) {
    const craftedBefore = Math.max(0, Math.round(options.craftCounts?.[targetKey] || 0));
    const plannedCrafts = Math.max(0, Math.round(options.crafts[targetKey] || 0));
    rows.push({
      itemId: itemKeyToId(targetKey),
      requested: Math.max(0, goalTotal - craftedBefore),
      fromInventory: 0,
      fromCraft: plannedCrafts,
      fromMissionsExpected: 0,
      shortfall: Math.max(0, goalTotal - craftedBefore - plannedCrafts),
      craftGoal: true,
      craftGoalTotal: goalTotal,
      craftedBefore,
    });
  }
  return rows;
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

/**
 * Whether a plan actually cashes in a candidate's prep progression: it launches
 * some ship that the prep unlocked, or launches a prep-leveled ship above its
 * pre-prep level. Launches the prep itself forces (at the pre-prep level) and
 * levels reached purely by the plan's own launches on untouched ships don't count.
 */
function planUsesPrepProgression(options: {
  candidate: ProgressionCandidate;
  baseShipLevels: ShipLevelInfo[];
  actions: MissionAction[];
  missionCounts: Record<string, number>;
}): boolean {
  const { candidate, baseShipLevels, actions, missionCounts } = options;
  if (candidate.prepSteps.length === 0) {
    return false;
  }
  const baseInfoByShip = new Map(baseShipLevels.map((entry) => [entry.ship, entry]));
  const prePrepLevelByBenefitShip = new Map<string, number>();
  for (const projected of candidate.shipLevels) {
    if (!projected.unlocked) {
      continue;
    }
    const base = baseInfoByShip.get(projected.ship);
    if (!base || !base.unlocked) {
      prePrepLevelByBenefitShip.set(projected.ship, -1);
      continue;
    }
    if (projected.level > base.level) {
      prePrepLevelByBenefitShip.set(projected.ship, base.level);
    }
  }
  if (prePrepLevelByBenefitShip.size === 0) {
    return false;
  }
  const actionByKey = new Map(actions.map((action) => [action.key, action]));
  for (const [actionKey, launchesRaw] of Object.entries(missionCounts)) {
    if (Math.max(0, Math.round(launchesRaw)) <= 0) {
      continue;
    }
    const action = actionByKey.get(actionKey);
    if (!action) {
      continue;
    }
    const prePrepLevel = prePrepLevelByBenefitShip.get(action.ship);
    if (prePrepLevel !== undefined && action.level > prePrepLevel) {
      return true;
    }
  }
  return false;
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

function normalizePlannerTargets(
  targetItemId: string,
  quantity: number,
  targets?: PlannerTarget[],
  craftCounts: Record<string, number> = {}
): {
  primaryTargetKey: string;
  primaryQuantity: number;
  targets: PlannerTarget[];
  demandTargets: PlannerTarget[];
  targetDemandByItem: Map<string, number>;
  craftFloorByItem: Map<string, number>;
  craftGoalTotals: Map<string, number>;
  targetCraftedOnlyKeys: Set<string>;
} {
  const rawTargets = targets && targets.length > 0 ? targets : [{ targetItemId, quantity }];
  const targetDemandByItem = new Map<string, number>();
  const craftGoalTotals = new Map<string, number>();
  for (const target of rawTargets) {
    const itemKey = itemIdToCanonicalKey(target.targetItemId);
    const safeQuantity = Math.max(1, Math.round(target.quantity));
    if (target.craftGoal && getRecipe(itemKey)) {
      // Two goals on the same item mean the higher total, not their sum.
      craftGoalTotals.set(itemKey, Math.max(craftGoalTotals.get(itemKey) || 0, safeQuantity));
      continue;
    }
    targetDemandByItem.set(itemKey, (targetDemandByItem.get(itemKey) || 0) + safeQuantity);
  }
  const craftFloorByItem = new Map<string, number>();
  for (const [itemKey, goalTotal] of craftGoalTotals.entries()) {
    const stillOwed = goalTotal - Math.max(0, Math.round(craftCounts[itemKey] || 0));
    if (stillOwed > 0) {
      craftFloorByItem.set(itemKey, stillOwed);
    }
  }
  const demandTargets = Array.from(targetDemandByItem.entries()).map(([itemKey, qty]) => ({
    targetItemId: itemKeyToId(itemKey),
    quantity: Math.max(1, Math.round(qty)),
  }));
  const craftGoalTargets = Array.from(craftGoalTotals.entries()).map(([itemKey, goalTotal]) => ({
    targetItemId: itemKeyToId(itemKey),
    quantity: goalTotal,
    craftGoal: true,
  }));
  const normalizedTargets = [...demandTargets, ...craftGoalTargets];
  const primary = normalizedTargets[0] || { targetItemId, quantity };
  const primaryTargetKey = itemIdToCanonicalKey(primary.targetItemId);
  const primaryQuantity = Math.max(1, Math.round(primary.quantity));
  if (targetDemandByItem.size === 0) {
    // Craft-count goals only. Every solve path treats an empty demand map as
    // "fall back to quantity of the primary target", which would invent demand
    // the player never asked for, so carry the primary key at zero instead.
    targetDemandByItem.set(primaryTargetKey, 0);
  }
  return {
    primaryTargetKey,
    primaryQuantity,
    targets: normalizedTargets,
    demandTargets,
    targetDemandByItem,
    craftFloorByItem,
    craftGoalTotals,
    targetCraftedOnlyKeys: new Set(demandTargets.map((target) => itemIdToCanonicalKey(target.targetItemId)).filter(isCraftedOnlyEligibleGoalKey)),
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

  const virtueTank = plannerOptions.objectiveMode === "virtueFuel" ? plannerOptions.virtueTank : undefined;
  const result = virtueTank
    ? await planVirtueTankLaunches(
        planningProfile,
        targetItemId,
        quantity,
        priorityTimeRaw,
        plannerOptions,
        virtueTank,
        inAirLaneLoads(inFlight.rows)
      )
    : await planForNewLaunches(
        planningProfile,
        targetItemId,
        quantity,
        priorityTimeRaw,
        plannerOptions
      );

  return withInFlightSchedule(result, inFlight);
}

/**
 * Top-up candidates (VirtueTankPlannerResult.lastTankTopUp): the missions the
 * plan could fly, each targeted at gold meteorite, Tau Ceti geode or solar
 * titanium, or untargeted, with their expected ingredients. The missions are
 * the profile's at the ship levels the plan ends on (`projectedShipLevels`,
 * with FTL and Zero-G research), or the profile's mission options as they are
 * when it has no ship levels; filtered to the allowed ships and durations and
 * to ships that burn tank fuel. Drops follow the plan's rarity selection and
 * loot data.
 */
export async function buildVirtueTopUpCandidates(options: {
  profile: PlayerProfile;
  projectedShipLevels?: Array<{ ship: string; unlocked: boolean; level: number }>;
  allowedShipDurations?: Array<{ ship: string; durationType: string }>;
  lootData?: LootJson;
  missionDropRarities?: Partial<ShinyRaritySelection>;
}): Promise<VirtueTopUpCandidate[]> {
  const { profile } = options;
  let missionOptions: MissionOption[] = profile.missionOptions;
  if (profile.shipLevels.length > 0) {
    const projected = new Map((options.projectedShipLevels || []).map((row) => [row.ship, row]));
    const shipLevels: ShipLevelInfo[] = profile.shipLevels.map((info) => {
      const row = projected.get(info.ship);
      return row ? { ...info, unlocked: info.unlocked || row.unlocked, level: Math.max(info.level, row.level) } : info;
    });
    missionOptions = buildMissionOptions(shipLevels, profile.epicResearchFTLLevel, profile.epicResearchZerogLevel);
  }
  if (options.allowedShipDurations) {
    const allowed = new Set(options.allowedShipDurations.map((sd) => `${sd.ship}|${sd.durationType}`));
    missionOptions = missionOptions.filter((option) => allowed.has(`${option.ship}|${option.durationType}`));
  }
  missionOptions = missionOptions.filter((option) => getVirtueFuelPerLaunch(option.ship, option.durationType) > 0);
  if (missionOptions.length === 0) {
    return [];
  }
  const targets = new Set(VIRTUE_TOP_UP_TARGET_AFX_IDS);
  const actions = await buildMissionActionsForOptions(
    missionOptions,
    new Set(virtueTopUpItemKeys()),
    options.lootData,
    options.missionDropRarities
  );
  return actions
    .filter((action) => targets.has(action.targetAfxId))
    .map((action) => ({
      ship: action.ship,
      durationType: action.durationType,
      level: action.level,
      durationSeconds: action.durationSeconds,
      targetAfxId: isUntargetedTargetAfxId(action.targetAfxId) ? null : action.targetAfxId,
      fuelPerLaunch: getVirtueFuelConfig(action.ship, action.durationType),
      expected: virtueTopUpYieldOf(action.yields),
    }));
}

/**
 * VirtueTankPlannerResult.lastTankTopUp for a finished tank-mode plan
 * (planVirtueLastTankTopUp over buildVirtueTopUpCandidates). Advisory: it
 * never changes the plan, and any failure just leaves it out.
 */
async function planLastTankTopUp(
  plan: PlannedLaunches,
  profile: PlayerProfile,
  plannerOptions: PlannerOptions
): Promise<VirtueLastTankTopUp | undefined> {
  const pack = plan.virtueTanks?.pack;
  if (!pack || !pack.feasible || !virtueLastTankRoom(pack)) {
    return undefined;
  }
  try {
    const candidates = await buildVirtueTopUpCandidates({
      profile,
      projectedShipLevels: plan.progression.projectedShipLevels,
      allowedShipDurations: plannerOptions.allowedShipDurations,
      lootData: plannerOptions.lootData,
      missionDropRarities: plannerOptions.missionDropRarities,
    });
    if (candidates.length === 0) {
      return undefined;
    }
    const topUp = await planVirtueLastTankTopUp({
      pack,
      candidates,
      solverFn: plannerOptions.solverFn ?? (await getDefaultSolverFn()),
    });
    return topUp ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * One tank-mode pass of planForNewLaunches. planVirtueTankLaunches runs a few:
 * at the shift cap, with fewer refuel loops when packing overshoots the cap,
 * at the next few caps and a fewest-shifts search when the cap cannot meet the
 * goals, and a re-plan at the shifts that search found.
 */
type VirtueTankRun = {
  capacity: number;
  startMode: VirtueTankStartMode;
  currentContents: VirtueFuelVector;
  currentHumility: number;
  /** Cap the player asked for. */
  shiftCap: number;
  /** Cap this pass's plan is reported against. */
  plannedShiftCap: number;
  /** Cap on the solve's refuel loops: below plannedShiftCap on a packing retry, null for the fewest-shifts search. */
  solveShiftCap: number | null;
  objective: "budget" | "minShift";
  /** Let goals go unmet instead of failing (see VirtueTankSolveOptions.softDemand). */
  softDemand?: boolean;
  /** Seconds until each mission slot held by an in-air virtue mission frees up. */
  inAirLaneFreeSeconds: number[];
  /** Start of the whole tank-mode search, for progress timing. */
  startedAtMs: number;
  /** Filled in by the pass. */
  report: VirtueTankPassReport;
};

/** What a tank-mode pass tells planVirtueTankLaunches besides its plan. */
type VirtueTankPassReport = {
  /**
   * A tank solve stopped short of a proof (a time limit), or candidates that
   * passed screening were never solved in full. A failed pass then does not
   * rule its cap out, and a fewest-shifts count is not proven the fewest.
   */
  inconclusive: boolean;
  /** Shifts the solve counted for the pass's plan; packing can take more or fewer. */
  solveShifts?: number;
};

/**
 * Path of Virtue tank mode: the fastest plan, charging
 * VIRTUE_SHIFT_PENALTY_SECONDS of mission time per shift and
 * VIRTUE_LAUNCH_EFFORT_SECONDS per launch, whose launches pack
 * into fuel tanks within the shift cap. Packing is the source of truth for
 * shifts: when it needs more than the solve counted, the plan is re-solved with
 * fewer refuel loops. When the cap cannot meet the goals, the plan is built at
 * the fewest shifts that can, and flagged as over the cap. Either way, a few
 * more shifts can be offered beside the plan when they are clearly faster
 * (VirtueTankPlannerResult.fasterOption).
 */
async function planVirtueTankLaunches(
  profile: PlayerProfile,
  targetItemId: string,
  quantity: number,
  priorityTimeRaw: number,
  plannerOptions: PlannerOptions,
  tank: VirtueTankPlannerOptions,
  inAirLaneFreeSeconds: number[]
): Promise<PlannedLaunches> {
  const startedAtMs = Date.now();
  const capacity = Number(tank.capacity);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error("Path of Virtue tank planning needs the fuel tank's capacity.");
  }
  const shiftCap = Number.isFinite(tank.shiftCap) ? Math.max(0, Math.floor(tank.shiftCap)) : 0;
  const startMode: VirtueTankStartMode = tank.startMode === "ideal" ? "ideal" : "current";
  const currentContents: VirtueFuelVector = {};
  for (const egg of VIRTUE_REFILL_ROUTE_ORDER) {
    const amount = Number(tank.currentContents?.[egg] || 0);
    if (Number.isFinite(amount) && amount > 0) {
      currentContents[egg] = amount;
    }
  }
  const currentHumility = Math.max(0, Number.isFinite(tank.currentHumility) ? (tank.currentHumility as number) : 0);
  const reportProgress = (phase: PlannerProgressEvent["phase"], message: string) => {
    try {
      plannerOptions.onProgress?.({ phase, message, elapsedMs: Date.now() - startedAtMs });
    } catch {
      // Ignore progress callback errors.
    }
  };
  // One benchmark sample for the whole search rather than one per pass.
  const passOptions: PlannerOptions = { ...plannerOptions, onBenchmarkSample: undefined };
  const solveShiftsByPlan = new Map<PlannedLaunches, number>();
  const runPass = async (
    objective: VirtueTankRun["objective"],
    plannedShiftCap: number,
    solveShiftCap: number | null,
    softDemand = false
  ): Promise<{ plan: PlannedLaunches | null; report: VirtueTankPassReport; error?: unknown }> => {
    const report: VirtueTankPassReport = { inconclusive: false };
    try {
      const plan = await planForNewLaunches(profile, targetItemId, quantity, priorityTimeRaw, passOptions, {
        capacity,
        startMode,
        currentContents,
        currentHumility,
        shiftCap,
        plannedShiftCap,
        solveShiftCap,
        objective,
        softDemand,
        inAirLaneFreeSeconds,
        startedAtMs,
        report,
      });
      // Tank solves hold every goal as hard demand, so a cap too low for the
      // goals fails the solve; a plan with anything unmet counts the same way.
      if (!softDemand && plan.unmetItems.length > 0) {
        return { plan: null, report: { ...report, inconclusive: true } };
      }
      if (report.solveShifts !== undefined) {
        solveShiftsByPlan.set(plan, report.solveShifts);
      }
      return { plan, report };
    } catch (error) {
      // Nothing drops some goal: no shift count changes that.
      if (error instanceof MissionCoverageError) {
        throw error;
      }
      return { plan: null, report, error };
    }
  };
  const packedShifts = (plan: PlannedLaunches) => plan.virtueTanks?.pack.totalShifts ?? 0;
  const planLaunches = (plan: PlannedLaunches) =>
    (plan.virtueTanks?.units || []).reduce((sum, unit) => sum + Math.max(0, unit.launches), 0);
  // The trade the slider makes: mission hours plus a penalty per shift and
  // the effort of every launch.
  const tankScore = (plan: PlannedLaunches) =>
    virtueTankPlanScoreSeconds({ expectedHours: plan.expectedHours, shifts: packedShifts(plan), launches: planLaunches(plan) });

  type CapAttempt = {
    /** Within the cap when `fits`; otherwise the plan packing closest to it, if any. */
    plan: PlannedLaunches | null;
    fits: boolean;
    /** No plan fits, and that is not proven. */
    inconclusive: boolean;
    error?: unknown;
  };
  // The fastest plan whose launches pack within `cap`. The first solve's
  // loops are capped at `solveShiftCap` (the cap itself unless the caller
  // knows the solve counts higher); when packing overshoots, the plan is
  // re-solved with fewer refuel loops.
  const planWithinCap = async (cap: number, solveShiftCap = cap): Promise<CapAttempt> => {
    const first = await runPass("budget", cap, solveShiftCap);
    if (!first.plan) {
      return { plan: null, fits: false, inconclusive: first.report.inconclusive, error: first.error };
    }
    if (packedShifts(first.plan) <= cap) {
      return { plan: first.plan, fits: true, inconclusive: false };
    }
    const tried = [first.plan];
    let last = { plan: first.plan, report: first.report, solveShiftCap };
    for (let retry = 0; retry < VIRTUE_TANK_MAX_PACK_RETRIES; retry += 1) {
      const nextSolveShiftCap =
        Math.min(last.solveShiftCap, last.report.solveShifts ?? last.solveShiftCap) - (packedShifts(last.plan) - cap);
      if (nextSolveShiftCap < 0) {
        break;
      }
      reportProgress("refinement", "Packing needs more shifts than the solve counted; re-solving with fewer refuel loops…");
      const next = await runPass("budget", cap, nextSolveShiftCap);
      if (!next.plan) {
        break;
      }
      if (packedShifts(next.plan) <= cap) {
        return { plan: next.plan, fits: true, inconclusive: false };
      }
      tried.push(next.plan);
      last = { plan: next.plan, report: next.report, solveShiftCap: nextSolveShiftCap };
    }
    const closest = tried.reduce((best, plan) =>
      packedShifts(plan) < packedShifts(best) || (packedShifts(plan) === packedShifts(best) && tankScore(plan) < tankScore(best))
        ? plan
        : best
    );
    return { plan: closest, fits: false, inconclusive: true };
  };

  type TankOutcome = {
    neededShifts?: number;
    proven?: boolean;
    note?: string;
    /** A plan with a few more shifts that scores clearly better (VirtueTankPlannerResult.fasterOption). */
    faster?: PlannedLaunches;
  };
  const finish = async (plan: PlannedLaunches, outcome: TankOutcome = {}): Promise<PlannedLaunches> => {
    const tanks = plan.virtueTanks!;
    const neededShifts = outcome.neededShifts;
    const notes = [...plan.notes];
    const tankNotes = [...tanks.notes];
    if (startMode === "current" && !tank.currentContents) {
      tankNotes.push("No fuel tank reading came with the profile, so the plan starts from an empty tank.");
    }
    if (outcome.note) {
      notes.unshift(outcome.note);
      tankNotes.push(outcome.note);
    }
    if (neededShifts !== undefined) {
      // Only a finished search proves the count; otherwise it is only the
      // fewest the search found.
      const overCapNote = outcome.proven
        ? `These goals need at least ${neededShifts} shifts; the slider allows ${shiftCap}. Planned with ${neededShifts} shifts.`
        : `No plan ${shiftCap > 0 ? `within ${shiftCap} shifts` : "without shifts"} was found; this plan takes ${neededShifts} shifts, and fewer may be possible.`;
      notes.unshift(overCapNote);
      if (!outcome.proven) {
        tankNotes.push(overCapNote);
      }
    }
    const faster = outcome.faster
      ? { shifts: packedShifts(outcome.faster), expectedHours: outcome.faster.expectedHours }
      : undefined;
    const lastTankTopUp = await planLastTankTopUp(plan, profile, plannerOptions);
    if (faster) {
      // Right after the over-cap line, or first within the cap.
      notes.splice(
        neededShifts !== undefined ? 1 : 0,
        0,
        `With ${faster.shifts} shifts the goals take about ${missionDurationLabel(
          faster.expectedHours * 3600
        )} instead of ${missionDurationLabel(plan.expectedHours * 3600)}.`
      );
    }
    const result: PlannedLaunches = {
      ...plan,
      notes,
      virtueTanks: {
        ...tanks,
        shiftCap,
        plannedShiftCap: neededShifts ?? shiftCap,
        overCap: neededShifts !== undefined,
        ...(neededShifts !== undefined ? { neededShifts, neededShiftsProven: Boolean(outcome.proven) } : {}),
        ...(faster ? { fasterOption: faster } : {}),
        notes: tankNotes,
        ...(lastTankTopUp ? { lastTankTopUp } : {}),
      },
    };
    try {
      plannerOptions.onBenchmarkSample?.({
        targetItemId,
        quantity: result.quantity,
        priorityTime: result.priorityTime,
        fastMode: Boolean(plannerOptions.fastMode),
        wallMs: Math.max(0, Date.now() - startedAtMs),
        expectedHours: result.expectedHours,
        geCost: result.geCost,
        path: "primary",
      });
    } catch {
      // Ignore benchmark callback errors.
    }
    return result;
  };
  const fastestOf = (plans: PlannedLaunches[]) =>
    plans.reduce<PlannedLaunches | undefined>(
      (best, plan) => (!best || tankScore(plan) < tankScore(best) ? plan : best),
      undefined
    );
  const fewestOf = (plans: PlannedLaunches[]) =>
    plans.reduce((best, plan) =>
      packedShifts(plan) < packedShifts(best) || (packedShifts(plan) === packedShifts(best) && tankScore(plan) < tankScore(best))
        ? plan
        : best
    );
  // A few more shifts than the plan's (the fewest over the cap, the cap
  // within it) can be far faster: one more pass with the cap
  // VIRTUE_FASTER_OPTION_EXTRA_SHIFTS above them (at most the slider's top
  // detent) finds the best plan there.
  // - Over the cap, the solve may count one past the pass's cap: its shift
  //   count can run one above what packing takes (a plan the solve counts at
  //   15 shifts can pack into 14), and packing still holds the plan to the
  //   cap. The pass is skipped once the search has run
  //   VIRTUE_TANK_FASTER_OPTION_SKIP_AFTER_SECONDS.
  // - Within the cap, the pass makes the same solve as planning with the
  //   slider at the pass's cap, so moving the slider there gives the offer
  //   back (the offer nearly always packs into the pass's cap). The pass is
  //   skipped once the search has run
  //   VIRTUE_TANK_WITHIN_CAP_FASTER_SKIP_AFTER_SECONDS.
  const fasterCapFor = (shifts: number) =>
    Math.min(shifts + VIRTUE_FASTER_OPTION_EXTRA_SHIFTS, VIRTUE_SHIFT_CAP_DETENTS[VIRTUE_SHIFT_CAP_DETENTS.length - 1]);
  const fasterPass = async (shifts: number, withinCap: boolean): Promise<PlannedLaunches | undefined> => {
    const fasterCap = fasterCapFor(shifts);
    if (fasterCap <= shifts) {
      return undefined;
    }
    const elapsedMs = Date.now() - startedAtMs;
    const maxSolveMs = Math.max(0, plannerOptions.maxSolveMs || 0);
    const skipAfterSeconds = withinCap
      ? VIRTUE_TANK_WITHIN_CAP_FASTER_SKIP_AFTER_SECONDS
      : VIRTUE_TANK_FASTER_OPTION_SKIP_AFTER_SECONDS;
    if (elapsedMs >= skipAfterSeconds * 1000 || (maxSolveMs > 0 && elapsedMs >= maxSolveMs)) {
      return undefined;
    }
    reportProgress("refinement", `Checking whether up to ${fasterCap} shifts is much faster…`);
    const attempt = await planWithinCap(fasterCap, withinCap ? fasterCap : fasterCap + 1);
    return attempt.fits && attempt.plan ? attempt.plan : undefined;
  };
  // Within the cap, the faster pass is worth its time only on a plan that
  // looks slow for its cap. A faster option packs into more shifts than the
  // cap (and never exactly one), which puts a floor under its score; a plan
  // that could not beat that floor by virtueFasterOptionQualifies is never
  // checked. Past the floor, a plan looks slow when it flies more than
  // VIRTUE_TANK_WITHIN_CAP_SLOW_LAUNCHES launches.
  const withinCapLooksSlow = (plan: PlannedLaunches) => {
    const floorSeconds = Math.max(2, shiftCap + 1) * VIRTUE_SHIFT_PENALTY_SECONDS;
    if (!virtueFasterOptionQualifies(tankScore(plan), floorSeconds, true)) {
      return false;
    }
    return planLaunches(plan) > VIRTUE_TANK_WITHIN_CAP_SLOW_LAUNCHES;
  };
  // A plan within the cap: when it looks slow and the search is young, the
  // faster pass runs above the cap. What it finds within the cap replaces
  // the plan when it scores better (a pass with more room can land on a
  // better plan the cap allows too); past the cap it is offered as the
  // faster option when virtueFasterOptionQualifies, as are plans the search
  // already found there (`known`).
  const finishWithinCap = async (
    plan: PlannedLaunches,
    known: PlannedLaunches[] = [],
    noteFor?: (plan: PlannedLaunches) => string | undefined
  ): Promise<PlannedLaunches> => {
    const fasterCap = fasterCapFor(shiftCap);
    const past = known.filter((entry) => packedShifts(entry) > shiftCap && packedShifts(entry) <= fasterCap);
    let best = plan;
    if (fasterCap > shiftCap && withinCapLooksSlow(plan)) {
      let extra: PlannedLaunches | undefined;
      try {
        extra = await fasterPass(shiftCap, true);
      } catch {
        // The plan stands.
      }
      if (extra && packedShifts(extra) <= shiftCap) {
        best = tankScore(extra) < tankScore(best) ? extra : best;
      } else if (extra) {
        past.push(extra);
      }
    }
    const fastest = fastestOf(past);
    const faster = fastest && virtueFasterOptionQualifies(tankScore(best), tankScore(fastest), true) ? fastest : undefined;
    return finish(best, { note: noteFor?.(best), faster });
  };
  // The best of the plans found: the fastest within the cap (finishWithinCap),
  // else the one with the fewest shifts, flagged over the cap. The faster
  // pass runs then, and what it finds counts like the rest: a plan at (or
  // under) the fewest shifts that scores better replaces it (solves at the
  // minimum can stop on plans the model rates alike), one within the cap
  // (after a search that did not finish) is the plan, and one with a few more
  // shifts is offered as the faster option when virtueFasterOptionQualifies,
  // counting its extra shifts and launches. `isProvenFewest` says the search
  // ruled out every smaller shift count.
  const settle = async (
    plans: PlannedLaunches[],
    isProvenFewest: (shifts: number) => boolean,
    noteFor?: (plan: PlannedLaunches) => string | undefined
  ): Promise<PlannedLaunches> => {
    const withinCap = (all: PlannedLaunches[]) => fastestOf(all.filter((plan) => packedShifts(plan) <= shiftCap));
    const fastestWithin = withinCap(plans);
    if (fastestWithin) {
      return finishWithinCap(fastestWithin, plans, noteFor);
    }
    const extra = await fasterPass(packedShifts(fewestOf(plans)), false);
    const all = extra ? [...plans, extra] : plans;
    const passWithin = withinCap(all);
    if (passWithin) {
      return finish(passWithin, { note: noteFor?.(passWithin) });
    }
    const fewest = fewestOf(all);
    const neededShifts = packedShifts(fewest);
    const fasterCap = fasterCapFor(neededShifts);
    const best = fastestOf(all.filter((plan) => packedShifts(plan) > neededShifts && packedShifts(plan) <= fasterCap));
    const faster = best && virtueFasterOptionQualifies(tankScore(fewest), tankScore(best), false) ? best : undefined;
    return finish(fewest, { neededShifts, proven: isProvenFewest(neededShifts), note: noteFor?.(fewest), faster });
  };

  const atCap = await planWithinCap(shiftCap);
  if (atCap.fits && atCap.plan) {
    const atCapShifts = packedShifts(atCap.plan);
    if (atCapShifts >= 2 && Date.now() - startedAtMs < VIRTUE_TANK_FEWER_SHIFTS_CHECK_MAX_ELAPSED_SECONDS * 1000) {
      reportProgress("refinement", `Checking whether fewer than ${atCapShifts} shifts is faster…`);
      try {
        const fewer = await planWithinCap(atCapShifts - 1);
        if (fewer.fits && fewer.plan && tankScore(fewer.plan) < tankScore(atCap.plan)) {
          return finishWithinCap(fewer.plan);
        }
      } catch {
        // The at-cap plan stands.
      }
    }
    return finishWithinCap(atCap.plan);
  }
  // Plans that meet the goals but pack above the cap. The at-cap one only
  // lands here when packing overshot every re-solve.
  const found: PlannedLaunches[] = [];
  if (atCap.plan) {
    found.push(atCap.plan);
  }
  const noteFor = (plan: PlannedLaunches): string | undefined => {
    if (plan === atCap.plan) {
      return `Packing these launches into tanks takes ${packedShifts(plan)} shifts, more than the cap of ${shiftCap}; no re-solve with fewer refuel loops fit it.`;
    }
    if (atCap.inconclusive && packedShifts(plan) <= shiftCap) {
      return `Planning with up to ${shiftCap} shifts did not finish, so this plan is built around the fewest shifts that reach the goals (${packedShifts(plan)}).`;
    }
    return undefined;
  };

  // Shift counts ruled out so far: every count up to this one failed a solve
  // that models all its loops one by one, so a plan one shift above it takes
  // the fewest shifts. Proof needs a failed cap, not a timed-out one. No plan
  // takes exactly one shift (a loop takes two), so ruling out 0 rules out 1.
  let ruledOutThrough =
    !atCap.inconclusive && !atCap.plan && virtueTankLoopLayout(shiftCap).exact ? Math.max(1, shiftCap) : -1;
  // Once the cap fails, goals just past it are cheapest to find by trying the
  // next caps in turn: a cap too low fails in screening, and a cap that fits
  // yields the fastest plan there. A loop takes at least two shifts, so a cap
  // of 1 is the same as 0. Caps the solve can still rule out with proof are
  // always tried; past them, only a few.
  if (!atCap.inconclusive && !atCap.plan) {
    let cap = Math.max(2, shiftCap + 1);
    for (
      let step = 0;
      step < VIRTUE_TANK_CAP_SCAN_STEPS || (ruledOutThrough === cap - 1 && virtueTankLoopLayout(cap).exact);
      step += 1, cap += 1
    ) {
      reportProgress("refinement", `Trying ${cap} shifts…`);
      const attempt = await planWithinCap(cap);
      if (attempt.fits && attempt.plan) {
        return settle([...found, attempt.plan], (shifts) => shifts === ruledOutThrough + 1, noteFor);
      }
      if (attempt.plan) {
        found.push(attempt.plan);
      }
      if (attempt.inconclusive || attempt.plan) {
        break;
      }
      if (ruledOutThrough === cap - 1 && virtueTankLoopLayout(cap).exact) {
        ruledOutThrough = cap;
      }
    }
  }

  // Fewest shifts that meet every goal: demand is hard and each shift
  // outweighs any mission time, so the count comes out lexicographically
  // minimal. It is proven when every solve finished, packing agrees with it,
  // and it is small enough that loops past the ones modeled one by one could
  // not do better.
  reportProgress("refinement", "Finding the fewest shifts that reach the goals…");
  const search = await runPass("minShift", shiftCap, null);
  let fewest = search.plan;
  let fewestProven =
    fewest !== null &&
    !search.report.inconclusive &&
    search.report.solveShifts === packedShifts(fewest) &&
    packedShifts(fewest) < 2 * (VIRTUE_TANK_INDIVIDUAL_LOOPS + 1);
  if (!fewest) {
    // Either no shift count meets the goals (something has no drop source) or
    // the search ran out of time. An open-cap pass that may leave goals unmet
    // tells the two apart, and names what cannot be met.
    const open = await runPass("budget", shiftCap, null, true);
    if (!open.plan) {
      throw atCap.error ?? search.error ?? open.error ?? new Error("Path of Virtue tank planning found no plan that meets the goals.");
    }
    if (open.plan.unmetItems.length > 0) {
      throw new MissionCoverageError(open.plan.unmetItems.map((item) => itemIdToCanonicalKey(item.itemId)));
    }
    fewest = open.plan;
    fewestProven = false;
  }
  found.push(fewest);

  // The fewest-shifts search stops as soon as its count is proven, so its
  // mission time is whatever its first plan had: re-plan with the time
  // objective at the shifts that plan takes (or the solve counted for it),
  // keeping the result if it packs within the cap, or within that count when
  // the cap is too low.
  const fewestShifts = Math.max(packedShifts(fewest), solveShiftsByPlan.get(fewest) ?? 0);
  const target = Math.max(shiftCap, packedShifts(fewest));
  reportProgress("refinement", `Planning the fastest route within ${Math.min(target, fewestShifts)} shifts…`);
  const replan = await planWithinCap(target, fewestShifts);
  if (replan.fits && replan.plan) {
    found.push(replan.plan);
  }
  const fewestPacked = packedShifts(fewest);
  return settle(
    found,
    (shifts) => shifts === ruledOutThrough + 1 || (fewestProven && shifts === fewestPacked),
    noteFor
  );
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
  if (result.virtueTanks) {
    return withVirtueTankSchedule(result, inFlight);
  }
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
    missions: [...result.missions, ...inAirMissionRows(result.missions, inFlight)],
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

function inAirMissionRows(plannedRows: PlanMissionRow[], inFlight: InFlightProjection): PlanMissionRow[] {
  const usedRowKeys = new Set(plannedRows.flatMap((row) => (row.rowKey ? [row.rowKey] : [])));
  return inFlight.rows.map((row) => ({
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
    rowKey: claimUniqueRowKey(`${missionRowKeyBase(row)}|air`, usedRowKeys),
  }));
}

/**
 * Tank mode: the packed schedule already seeds the lanes with the in-air
 * ships, so `expectedHours` runs from now; `missionSeconds` replays the same
 * launch order on empty lanes.
 */
function withVirtueTankSchedule(result: PlannedLaunches, inFlight: InFlightProjection): PlannerResult {
  const { units, pack } = result.virtueTanks!;
  const durations: Record<string, number> = {};
  for (const unit of units) {
    durations[unit.id] = unit.durationSeconds;
  }
  const missionSeconds = Math.round(scheduleVirtueLaunches(pack.launchOrder, { durations }).makespanSeconds);
  return {
    ...result,
    missions: [...result.missions, ...inAirMissionRows(result.missions, inFlight)],
    inFlight: {
      missionCount: inFlight.missionCount,
      secondsRemaining: inFlight.secondsRemaining,
    },
    schedule: {
      missionSeconds,
      inAirSeconds: inFlight.secondsRemaining,
      totalSeconds: Math.round(Math.max(pack.schedule.makespanSeconds, inFlight.secondsRemaining)),
    },
  };
}

async function planForNewLaunches(
  profile: PlayerProfile,
  targetItemId: string,
  quantity: number,
  priorityTimeRaw: number,
  plannerOptions: PlannerOptions = {},
  tankRun?: VirtueTankRun
): Promise<PlannedLaunches> {
  const normalizedTargets = normalizePlannerTargets(targetItemId, quantity, plannerOptions.targets, profile.craftCounts);
  const craftFloorByItem = normalizedTargets.craftFloorByItem;
  const hasCraftGoals = normalizedTargets.craftGoalTotals.size > 0;
  const targetKey = normalizedTargets.primaryTargetKey;
  // Tank mode swaps the fuel/time slider for the shift cap: mission time is the
  // whole objective, and fuel only counts through the shifts it forces.
  const priorityTime = tankRun ? 1 : Math.max(0, Math.min(1, priorityTimeRaw));
  const objectiveContext = normalizeObjectiveContext(
    plannerOptions.objectiveMode,
    priorityTime,
    plannerOptions.minimumTimePriority
  );
  const objectiveMode = objectiveContext.mode;
  const quantityInt = normalizedTargets.primaryQuantity;
  const multiTarget = normalizedTargets.demandTargets.length > 1;
  const fastMode = Boolean(plannerOptions.fastMode);
  const missionDropRarities = normalizeShinyRaritySelection(plannerOptions.missionDropRarities);
  const targetCraftedOnly = Boolean(plannerOptions.targetCraftedOnly);
  const selectedConsumptionItemKeys = normalizeConsumptionItemKeys(plannerOptions.selectedConsumptionItemIds);
  const multiTargetScaleFactor = multiTarget ? targetDemandGcd(normalizedTargets.targetDemandByItem) : 1;
  // Both accelerations solve a scaled-down block and multiply the result back
  // up; a craft-count floor does not scale with the block, and neither do
  // tank loops, so skip them for both.
  const singleTargetFastQuantityAcceleration =
    fastMode &&
    !tankRun &&
    !multiTarget &&
    !hasCraftGoals &&
    normalizedTargets.demandTargets.length === 1 &&
    !plannerOptions.disableFastQuantityAcceleration &&
    quantityInt >= FAST_QUANTITY_ACCELERATION_MIN_QUANTITY;
  const multiTargetFastQuantityAcceleration =
    fastMode &&
    !tankRun &&
    multiTarget &&
    !hasCraftGoals &&
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
    : singleTargetFastQuantityAcceleration
      ? new Map([[targetKey, solveQuantity]])
    : normalizedTargets.targetDemandByItem;
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
  const progressStartedAtMs = tankRun?.startedAtMs ?? startedAtMs;
  const reportProgress = (
    event: Omit<PlannerProgressEvent, "elapsedMs"> & { elapsedMs?: number }
  ) => {
    if (!plannerOptions.onProgress) {
      return;
    }
    try {
      plannerOptions.onProgress({
        ...event,
        elapsedMs: event.elapsedMs ?? Date.now() - progressStartedAtMs,
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
  // The fast incumbent plans without the tank, so tank mode never adopts it.
  if (
    !fastMode &&
    !tankRun &&
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
        targets: plannerOptions.targets,
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
  // Tank mode never uses the yield index: tank solves count an infeasible cap
  // as proof that the goals need more shifts, and the index's top pairs per
  // item (ranked on time alone) can drop the fuel-light launches a low cap
  // needs, so /api/plan claimed minimums the page beat. It prunes its actions
  // for fuel as well as time instead (pruneVirtueTankActions), the same on
  // every path.
  const missionActionFilter =
    !tankRun && missionYieldIndexEnabled(plannerOptions.disableMissionYieldIndex, injectedLootData)
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
    `targets:${normalizedTargets.targets.map((target) => `${target.targetItemId}:${target.quantity}${target.craftGoal ? ":cg" : ""}`).join(",")}`,
    `floors:${craftFloorFingerprint(craftFloorByItem)}`,
    `qty:${solveQuantity}`,
    `rar:${missionDropRarityKey}`,
    `craftedOnly:${targetCraftedOnly ? 1 : 0}`,
    `consume:${consumptionOptions.map((option) => option.sourceItemKey).join(",") || "none"}`,
    `mode:${objectiveMode}:${priorityTime <= SCORE_EPS ? "ge" : "mix"}:${objectiveContext.minimumTimePriority}`,
    `fast:${fastMode ? 1 : 0}`,
    `filter:${missionActionFilter?.key || "none"}`,
    `tank:${
      tankRun
        ? [
            tankRun.objective,
            tankRun.softDemand ? "soft" : "hard",
            tankRun.solveShiftCap ?? "open",
            tankRun.startMode,
            tankRun.capacity,
            ...VIRTUE_REFILL_ROUTE_ORDER.map((egg) => Math.round(tankRun.currentContents[egg] || 0)),
          ].join(":")
        : "none"
    }`,
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
    craftFloorByItem,
    consumptionOptions,
  });

  const { geRef, fuelRef, timeRef } = computeObjectiveReferences({
    profile: representativeBlockProfile,
    targetKey,
    quantity: solveQuantity,
    actions: baseActions,
    targetDemandByItem: solveTargetDemandByItem,
    craftFloorByItem,
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
    // Tank mode, which never uses the yield index to narrow the actions.
    const virtueTankActionPruning = Boolean(tankRun) && !missionActionFilter;
    const virtueTankActionCounts = { before: 0, after: 0, fullChecksWon: 0 };
    const prunedActionCache = new Map<string, MissionAction[]>();
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
      /** Prep launches excluded from the solve's missionCounts; counted back into
       *  totalLaunches so uncredited prep can't win a launch-count tiebreak. */
      prepNoYieldLaunches: number;
      /** The same launches by option: tank mode still has to fuel them. */
      prepNoYieldOptions: Array<{ option: MissionOption; launches: number }>;
      /**
       * Tank mode without the yield index: the pruned subset of
       * `candidateActions` the solves start from (pruneVirtueTankActions).
       * Plans still read their launches against `candidateActions`.
       */
      solveActions?: MissionAction[];
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
      let prepNoYieldLaunches = 0;
      const prepNoYieldOptions: CandidateEvalInput["prepNoYieldOptions"] = [];
      for (const [optionKey, requirement] of prepRequirements.entries()) {
        if (requirement.launches <= 0) {
          continue;
        }
        if (!actionOptionKeys.has(optionKey)) {
          prepNoYieldSlotSeconds += requirement.launches * requirement.option.durationSeconds;
          prepNoYieldLaunches += requirement.launches;
          prepNoYieldOptions.push({ option: requirement.option, launches: requirement.launches });
          continue;
        }
        addRequiredLaunchConstraint(
          requiredMissionLaunches,
          optionKey,
          requirement.launches,
          !finalOptionKeys.has(optionKey)
        );
      }
      const input: CandidateEvalInput = {
        candidate,
        candidateActions,
        requiredMissionLaunches,
        maxMissionLaunchesByOption: phased.maxLaunchesByOption,
        phasedChainConstraints: phased.phaseChains,
        prepNoYieldSlotSeconds,
        prepNoYieldLaunches,
        prepNoYieldOptions,
      };
      if (!virtueTankActionPruning) {
        return input;
      }
      // Pruning keeps every action of the prep options, so which prep
      // launches have drops (worked out above) is unchanged.
      let pruned = prunedActionCache.get(candidateKey);
      if (!pruned) {
        pruned = pruneVirtueTankActions(candidateActions, {
          topPerItem: VIRTUE_TANK_ACTION_TOP_PER_ITEM,
          keepOptionKeys: new Set(prepRequirements.keys()),
          phaseChains: phased.phaseChains,
        });
        virtueTankActionCounts.before += candidateActions.length;
        virtueTankActionCounts.after += pruned.length;
        prunedActionCache.set(candidateKey, pruned);
      }
      return pruned.length < candidateActions.length ? { ...input, solveActions: pruned } : input;
    };

    // What a candidate's no-yield prep adds to its tank score, which its
    // solve objective leaves out: that share of the prep's slot time over
    // three slots, plus its launch effort.
    const tankPrepObjective = (input: CandidateEvalInput, slotTimeWeight: number): number =>
      ((slotTimeWeight * input.prepNoYieldSlotSeconds) / 3 + VIRTUE_LAUNCH_EFFORT_SECONDS * input.prepNoYieldLaunches) /
      Math.max(1, timeRef);
    type TankSolveHints = Pick<VirtueTankSolveOptions, "shiftFloor" | "objectiveCutoff">;
    const tankSolveOptions = (input: CandidateEvalInput, hints: TankSolveHints = {}): VirtueTankSolveOptions | undefined =>
      tankRun
        ? {
            capacity: tankRun.capacity,
            startMode: tankRun.startMode,
            currentContents: tankRun.currentContents,
            shiftCap: tankRun.solveShiftCap,
            objective: tankRun.objective,
            softDemand: tankRun.softDemand,
            fixedLaunches: input.prepNoYieldOptions.map(({ option, launches }) => ({
              ship: option.ship,
              durationType: option.durationType,
              durationSeconds: option.durationSeconds,
              launches,
            })),
            ...hints,
          }
        : undefined;
    // In the fewest-shifts search a screening solve that reached optimality
    // proves its shift count is the least the candidate can do: its loop
    // counts are integer and only the launches are relaxed.
    // Once a candidate has an integer plan, later ones only need to beat its
    // objective (within the tie tolerance the comparison uses anyway). Plans
    // are compared with their no-yield prep time, which the solve objective
    // leaves out, so the cutoff moves by the difference in it.
    const tankSolveHintsFor = (screened: {
      input: CandidateEvalInput;
      unified: UnifiedPlan;
      solveMetrics: UnifiedSolveMetrics | null;
    }): TankSolveHints => {
      if (!tankRun) {
        return {};
      }
      const hints: TankSolveHints = {};
      if (tankRun.objective === "minShift" && screened.solveMetrics?.status === "Optimal") {
        hints.shiftFloor = screened.unified.virtueShifts;
      }
      if (best && Number.isFinite(best.weightedScore)) {
        // A plan's score is at least its solve objective (slot time over
        // three slots, launch effort and shifts) plus the no-yield prep time
        // and launch effort the solve leaves out.
        hints.objectiveCutoff =
          best.weightedScore * (1 + PLAN_SCORE_TIE_TOLERANCE_FRACTION) -
          tankPrepObjective(screened.input, 1) +
          SCORE_EPS;
      }
      return hints;
    };
    const tankMakespanSeconds = (input: CandidateEvalInput, unified: UnifiedPlan): number =>
      virtueTankMakespanBound([
        ...input.candidateActions.map((action) => ({
          durationSeconds: action.durationSeconds,
          launches: unified.missionCounts[action.key] || 0,
        })),
        ...input.prepNoYieldOptions.map(({ option, launches }) => ({ durationSeconds: option.durationSeconds, launches })),
      ]);
    // Tank mode scores a plan as mission time plus its shifts and launches:
    // VIRTUE_SHIFT_PENALTY_SECONDS per shift and VIRTUE_LAUNCH_EFFORT_SECONDS
    // per launch (prep included), with mission time the makespan bound
    // blended with slot time over three slots (VIRTUE_TANK_SLOT_TIME_WEIGHT);
    // or slot time, launch effort and an overwhelming weight per shift in the
    // fewest-shifts search. Either way it is at least the solve objective's
    // slot time and launch effort.
    const virtueTankScore = (input: CandidateEvalInput, unified: UnifiedPlan, totalSlotSeconds: number): number => {
      const shifts = Math.max(0, unified.virtueShifts || 0);
      const launches =
        Object.values(unified.missionCounts).reduce((sum, count) => sum + Math.max(0, Math.round(count)), 0) +
        input.prepNoYieldLaunches;
      const launchEffortSeconds = VIRTUE_LAUNCH_EFFORT_SECONDS * launches;
      if (tankRun?.objective === "minShift") {
        return (
          (totalSlotSeconds / 3 + launchEffortSeconds + VIRTUE_TANK_MIN_SHIFT_WEIGHT * Math.max(1, timeRef) * shifts) /
          Math.max(1, timeRef)
        );
      }
      const missionSeconds =
        (1 - VIRTUE_TANK_SLOT_TIME_WEIGHT) * tankMakespanSeconds(input, unified) + (VIRTUE_TANK_SLOT_TIME_WEIGHT * totalSlotSeconds) / 3;
      return (missionSeconds + launchEffortSeconds + VIRTUE_SHIFT_PENALTY_SECONDS * shifts) / Math.max(1, timeRef);
    };

    const solveCandidateInput = async (
      input: CandidateEvalInput,
      lpRelaxation: boolean,
      milpProgressContext?: MilpSolveProgressContext,
      tankHints?: TankSolveHints
    ) => {
      const geOnlyCandidateMilp = objectiveMode === "ge" && !lpRelaxation && priorityTime <= SCORE_EPS;
      if (!lpRelaxation) {
        await emitMilpStageProgress(
          milpProgressContext,
          geOnlyCandidateMilp ? "Lowest-GE solve" : "Integer-constrained solve"
        );
      }
      let baselineSolveMetrics: UnifiedSolveMetrics | null = null;
      // Tank mode without the yield index solves over the pruned actions (all
      // of them when the check below wins); plans read their launches
      // against input.candidateActions, which holds them all.
      let solveActions = input.solveActions ?? input.candidateActions;
      // An optional solve (one that only tries to improve on a plan in hand)
      // neither replaces the baseline's metrics nor, stopping short, makes a
      // tank pass inconclusive.
      const solveBaseline = (
        virtueTank: VirtueTankSolveOptions | undefined,
        timeLimitSeconds?: number,
        actions: MissionAction[] = solveActions,
        optional = false
      ) => solveUnifiedCraftMissionPlan({
        profile: representativeBlockProfile,
        targetKey,
        quantity: solveQuantity,
        priorityTime,
        objectiveMode,
        minimumTimePriority: objectiveContext.minimumTimePriority,
        closure,
        actions,
        geRef,
        fuelRef,
        timeRef,
        requiredMissionLaunches: input.requiredMissionLaunches,
        maxMissionLaunchesByOption: input.maxMissionLaunchesByOption,
        phasedChainConstraints: input.phasedChainConstraints,
        lpRelaxation,
        timeLimitSeconds,
        strictGeObjective: geOnlyCandidateMilp,
        targetCraftedOnly,
        targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : undefined,
        consumptionOptions,
        craftSkeleton,
        virtueTank,
        solverFn,
        onSolveMetrics: (metrics) => {
          if (!optional) {
            baselineSolveMetrics = metrics;
          }
          if (lpRelaxation) {
            recordSolveMetrics(lpSolveStats, metrics);
          } else {
            recordSolveMetrics(milpSolveStats, metrics);
          }
          // Infeasible is a proof too; anything else short of Optimal is not.
          if (tankRun && !optional && metrics.status !== "Optimal" && metrics.status !== "Infeasible") {
            tankRun.report.inconclusive = true;
          }
        },
      });
      let baselineUnified = await solveBaseline(tankSolveOptions(input, tankHints));
      // Pruning ranks targets one item at a time, so it can drop the target
      // whose mix of drops fills out a plan best (a short launch that tops
      // up what the long ones leave, say). A pruned solve that finished
      // quickly is checked against one over every action, which has to beat
      // it; a slow one keeps its plan, as the full solve would only run into
      // its time limit.
      const prunedMetrics = baselineSolveMetrics as UnifiedSolveMetrics | null;
      const prunedObjective = baselineUnified.objectiveValue;
      if (
        tankRun?.objective === "budget" &&
        !lpRelaxation &&
        input.solveActions &&
        prunedMetrics?.status === "Optimal" &&
        prunedMetrics.elapsedMs <= VIRTUE_TANK_FULL_CHECK_MAX_PRUNED_SECONDS * 1000 &&
        prunedObjective !== undefined &&
        prunedObjective > 0
      ) {
        await emitMilpStageProgress(milpProgressContext, "Integer-constrained solve (every mission)");
        try {
          const full = await solveBaseline(
            {
              ...tankSolveOptions(input, { shiftFloor: tankHints?.shiftFloor })!,
              objectiveCutoff: prunedObjective * (1 - PLAN_SCORE_TIE_TOLERANCE_FRACTION),
            },
            VIRTUE_TANK_FULL_CHECK_TIME_LIMIT_SECONDS,
            input.candidateActions,
            true
          );
          if (
            virtueTankScore(input, full, input.prepNoYieldSlotSeconds + full.totalSlotSeconds) <
            virtueTankScore(input, baselineUnified, input.prepNoYieldSlotSeconds + baselineUnified.totalSlotSeconds)
          ) {
            baselineUnified = full;
            solveActions = input.candidateActions;
            virtueTankActionCounts.fullChecksWon += 1;
          }
        } catch {
          // Nothing beats the pruned plan.
        }
      }
      let unified = baselineUnified;
      let solveMetrics = baselineSolveMetrics;
      // Tank mode: slot time over three slots misjudges a plan of a few long
      // missions (one 38h mission reads as 13h). When this plan's rounds say
      // it did, re-solve with them in the objective. When they do not, the
      // plan is the fastest by the rounds too, since slot time never exceeds them.
      if (tankRun?.objective === "budget" && !lpRelaxation) {
        const baselineSlotSeconds = input.prepNoYieldSlotSeconds + baselineUnified.totalSlotSeconds;
        if (tankMakespanSeconds(input, baselineUnified) > (baselineSlotSeconds / 3) * (1 + PLAN_SCORE_TIE_TOLERANCE_FRACTION) + 1) {
          const baselineScore = virtueTankScore(input, baselineUnified, baselineSlotSeconds);
          const scoreLimit = Math.min(baselineScore, best ? best.weightedScore : Number.POSITIVE_INFINITY);
          // The rounds count the prep launches; their slot time and launch
          // effort are left out.
          const prepObjective = tankPrepObjective(input, VIRTUE_TANK_SLOT_TIME_WEIGHT);
          await emitMilpStageProgress(milpProgressContext, "Integer-constrained solve (mission rounds)");
          try {
            const rounded = await solveBaseline(
              {
                ...tankSolveOptions(input, { shiftFloor: tankHints?.shiftFloor })!,
                makespanRounds: true,
                objectiveCutoff: scoreLimit * (1 + PLAN_SCORE_TIE_TOLERANCE_FRACTION) - prepObjective + SCORE_EPS,
              },
              VIRTUE_TANK_ROUNDS_TIME_LIMIT_SECONDS
            );
            if (virtueTankScore(input, rounded, input.prepNoYieldSlotSeconds + rounded.totalSlotSeconds) < baselineScore) {
              unified = rounded;
              solveMetrics = baselineSolveMetrics;
            }
          } catch {
            // Nothing beats the slot-time plan on its rounds.
          }
        }
      }
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
      const weightedScore = tankRun
        ? virtueTankScore(input, unified, totalSlotSeconds)
        : normalizedObjectiveScore(
            objectiveResourceCost(objectiveContext, unified.geCost, fuelCost),
            totalSlotSeconds / 3,
            objectiveContext,
            objectiveMode === "virtueFuel" ? fuelRef : geRef,
            timeRef
          );
      const unmetTotal = Object.values(unified.remainingDemand).reduce((sum, qty) => sum + Math.max(0, qty), 0);
      const totalLaunches =
        Object.values(unified.missionCounts).reduce(
          (sum, launches) => sum + Math.max(0, Math.round(launches)),
          0
        ) + input.prepNoYieldLaunches;
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

      if (tankRun) {
        // weightedScore already folds the shifts and launch effort into mission time.
        const tankScoreDiff = a.weightedScore - b.weightedScore;
        const tankScoreScale = Math.max(SCORE_EPS, Math.min(Math.abs(a.weightedScore), Math.abs(b.weightedScore)));
        if (Math.abs(tankScoreDiff) > Math.max(SCORE_EPS, tankScoreScale * PLAN_SCORE_TIE_TOLERANCE_FRACTION)) {
          return tankScoreDiff;
        }
        if (Math.abs(a.totalSlotSeconds - b.totalSlotSeconds) > SCORE_EPS) {
          return a.totalSlotSeconds - b.totalSlotSeconds;
        }
        return a.totalLaunches - b.totalLaunches;
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
        craftFloorByItem,
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
      // Scaling a block multiplies its launches but not its tank loops.
      if (tankRun) {
        return;
      }
      // The block screen solves a scaled-down slice with no closure inventory;
      // neither a second demand row nor a craft-count floor scales with it.
      if (multiTarget || hasCraftGoals || normalizedTargets.demandTargets.length !== 1) {
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
            totalLaunches: sumRecordValues(unified.missionCounts) + input.prepNoYieldLaunches,
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
          const totalLaunches = sumRecordValues(refined.unified.missionCounts) + screened.input.prepNoYieldLaunches;
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
            const result = await solveCandidateInput(
              input,
              false,
              {
                prefix: "Fast mode: ",
                candidateIndex: resolveIndex + 1,
                candidateTotal: fastMilpCandidates.length,
                completed: fastMilpCompleted,
                etaMs: estimateBatchEtaMs(fastMilpStartedAtMs, fastMilpCompleted, fastMilpCandidates.length),
              },
              tankSolveHintsFor(fastMilpCandidates[resolveIndex])
            );
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
      // A rounded relaxed plan knows nothing about whole tanks and loops, so
      // tank mode never falls back to one.
      if (!best && !tankRun) {
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
          const result = await solveCandidateInput(
            input,
            false,
            {
              prefix: "",
              candidateIndex: resolveIndex + 1,
              candidateTotal: milpCandidates.length,
              completed: milpCompleted,
              etaMs: estimateBatchEtaMs(milpStartedAtMs, milpCompleted, milpCandidates.length),
            },
            tankSolveHintsFor(milpCandidates[resolveIndex])
          );
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
      // Candidates the screening kept but no integer solve reached could
      // still have a plan, so this failure proves nothing about the cap.
      if (
        tankRun &&
        (timeBudgetExceeded || prunedCandidateCount > 0 || lpScreened.length > (fastMode ? 1 : LP_SCREENING_MILP_RESOLVES))
      ) {
        tankRun.report.inconclusive = true;
      }
      const details = solverErrors.length > 0 ? solverErrors[0] : "no feasible horizon candidate";
      throw new Error(`unified HiGHS solve failed across all horizon candidates (${details})`);
    }

    // A prep candidate can win on near-tie noise while its plan never touches the
    // ship states the prep paid for. In that case the no-prep state is at least as
    // good by construction, so prefer it unless the solver says it's strictly worse.
    // The fewest-shifts search skips this: its plan is only a shift count to
    // re-plan at.
    if (
      tankRun?.objective !== "minShift" &&
      best.candidate.prepSteps.length > 0 &&
      !planUsesPrepProgression({
        candidate: best.candidate,
        baseShipLevels: profile.shipLevels,
        actions: best.actions,
        missionCounts: best.unified.missionCounts,
      })
    ) {
      const noPrepCandidate = progressionCandidates.find((candidate) => candidate.prepSteps.length === 0);
      if (noPrepCandidate) {
        reportProgress({
          phase: "refinement",
          message: "Winning plan never uses its prep progression; re-solving the no-prep state...",
          etaMs: null,
        });
        await yieldForProgressFlush();
        try {
          const noPrepInput = await prepareCandidateInput(noPrepCandidate);
          if (noPrepInput) {
            const noPrepResult = await solveCandidateInput(
              noPrepInput,
              false,
              undefined,
              tankSolveHintsFor({ input: noPrepInput, unified: best.unified, solveMetrics: null })
            );
            if (comparePlanQuality(noPrepResult, best) <= 0) {
              best = {
                candidate: noPrepInput.candidate,
                actions: noPrepInput.candidateActions,
                unified: noPrepResult.unified,
                solveMetrics: noPrepResult.solveMetrics,
                totalSlotSeconds: noPrepResult.totalSlotSeconds,
                weightedScore: noPrepResult.weightedScore,
                geCost: noPrepResult.geCost,
                fuelCost: noPrepResult.fuelCost,
                unmetTotal: noPrepResult.unmetTotal,
                totalLaunches: noPrepResult.totalLaunches,
                prepNoYieldSlotSeconds: noPrepInput.prepNoYieldSlotSeconds,
              };
              refinementNotes.push(
                "Dropped ship-progression prep launches the winning plan never used; the no-prep state solved at least as well."
              );
            }
          }
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          solverErrors.push(`no-prep fallback solve failed: ${details}`);
        }
      }
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
              const polishedTotalLaunches =
                Object.values(polishedUnified.missionCounts).reduce(
                  (sum, launches) => sum + Math.max(0, Math.round(launches)),
                  0
                ) + polishInput.prepNoYieldLaunches;
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
    // Tank mode skips the monolithic incumbents: they solve without the tank
    // rows, and in benchmarks never beat a tank-mode plan.
    if (outputUnmetTotal <= 1e-6 && !tankRun) {
      const monolithicCombos = chosenCombosForPlan(outputActions, outputUnified.missionCounts);
      if (monolithicCombos.length > 0) {
        const fullQuantityCraftSkeleton = getCraftSkeletonCached({
          profile,
          targetKey,
          quantity: quantityInt,
          closure,
          targetDemandByItem: normalizedTargets.targetDemandByItem,
          craftFloorByItem,
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

    // Output-stage replacements (scaled refinement, monolithic incumbent) can drop
    // the launches a prep step forced without dropping the prep itself. If the
    // final plan neither launches the prep nor uses any ship state it would
    // provide, the prep is orphaned — strip it instead of telling the player to
    // grind launches that benefit nothing in this plan.
    let outputPrepSteps = best.candidate.prepSteps;
    let outputPrepSlotSeconds = best.candidate.prepSlotSeconds;
    let outputPrepNoYieldSlotSeconds = best.prepNoYieldSlotSeconds;
    if (outputPrepSteps.length > 0) {
      const outputLaunchesByOption = aggregateMissionLaunchesByOption(outputActions, outputUnified.missionCounts);
      const prepStillLaunched = Array.from(aggregatePrepOptionRequirements(outputPrepSteps).keys()).some(
        (optionKey) => (outputLaunchesByOption.get(optionKey) || 0) > 0
      );
      const prepUsed = planUsesPrepProgression({
        candidate: best.candidate,
        baseShipLevels: profile.shipLevels,
        actions: outputActions,
        missionCounts: outputUnified.missionCounts,
      });
      if (!prepUsed && !prepStillLaunched) {
        outputPrepSteps = [];
        outputPrepSlotSeconds = 0;
        outputTotalSlotSeconds = Math.max(0, outputTotalSlotSeconds - outputPrepNoYieldSlotSeconds);
        outputPrepNoYieldSlotSeconds = 0;
        refinementNotes.push(
          "Removed orphaned ship-progression prep launches: the final plan neither launches them nor uses any ship level they would provide."
        );
      }
    }

    const actionKeyByRowKey = new Map<string, string>();
    const missionRows = buildMissionRows(outputActions, outputUnified.missionCounts, actionKeyByRowKey);
    const craftRows = buildCraftRows(outputUnified.crafts);
    const consumptionRows = buildConsumptionRows(outputUnified.consumptions, consumptionOptions);
    const targetBreakdowns = buildTargetBreakdowns({
      targetDemandByItem: normalizedTargets.targetDemandByItem,
      crafts: outputUnified.crafts,
      actions: outputActions,
      missionCounts: outputUnified.missionCounts,
      remainingDemand: outputUnified.remainingDemand,
      targetCraftedOnlyKeys: targetCraftedOnly ? normalizedTargets.targetCraftedOnlyKeys : new Set<string>(),
      craftGoalTotals: normalizedTargets.craftGoalTotals,
      craftCounts: profile.craftCounts,
    });
    // The single-goal breakdown is the primary row of the same table; building
    // it separately would describe a craft-count goal as demand for copies.
    const primaryBreakdownRow = targetBreakdowns.find((row) => itemIdToCanonicalKey(row.itemId) === targetKey);
    const targetBreakdown: TargetBreakdown = primaryBreakdownRow
      ? {
          requested: primaryBreakdownRow.requested,
          fromInventory: primaryBreakdownRow.fromInventory,
          fromCraft: primaryBreakdownRow.fromCraft,
          fromMissionsExpected: primaryBreakdownRow.fromMissionsExpected,
          shortfall: primaryBreakdownRow.shortfall,
          ...(primaryBreakdownRow.craftGoal
            ? {
                craftGoal: true,
                craftGoalTotal: primaryBreakdownRow.craftGoalTotal,
                craftedBefore: primaryBreakdownRow.craftedBefore,
              }
            : {}),
        }
      : buildTargetBreakdown({
          quantity: quantityInt,
          targetKey,
          crafts: outputUnified.crafts,
          actions: outputActions,
          missionCounts: outputUnified.missionCounts,
          remainingDemand: outputUnified.remainingDemand,
          targetCraftedOnly,
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

    const compactedPrepLaunches = compactProgressionSteps(outputPrepSteps);
    const prepHours = outputPrepSlotSeconds / 3 / 3600;
    const notes: string[] = [...outputUnified.notes, ...refinementNotes];
    for (const [itemKey, goalTotal] of normalizedTargets.craftGoalTotals.entries()) {
      const craftedBefore = Math.max(0, Math.round(profile.craftCounts[itemKey] || 0));
      const owed = craftFloorByItem.get(itemKey) || 0;
      const label = itemKeyToTierLabel(itemKey);
      notes.push(
        owed > 0
          ? `Craft-count goal: ${label} at ${craftedBefore.toLocaleString()} of ${goalTotal.toLocaleString()} crafts, so the plan crafts at least ${owed.toLocaleString()} more (copies consumed by higher tiers count toward it).`
          : `Craft-count goal: ${label} already at ${craftedBefore.toLocaleString()} of ${goalTotal.toLocaleString()} crafts, so the plan adds nothing for it.`
      );
    }
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
    if (tankRun) {
      notes.push(
        `Path of Virtue tank mode: the fastest plan, counting each shift as ${Math.round(
          VIRTUE_SHIFT_PENALTY_SECONDS / 3600
        )} h of mission time and each launch as ${Math.round(
          VIRTUE_LAUNCH_EFFORT_SECONDS / 60
        )} min, within the shift cap unless the goals need more shifts, packed into fuel tanks from ${
          tankRun.startMode === "ideal" ? "an ideal first fill (not counted toward the cap)" : "what is in the tank now"
        }. Humility is fueled live on its farm and never counted.`
      );
    } else if (objectiveMode === "virtueFuel") {
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
          outputPrepSlotSeconds / 3
        )} at 3-slot throughput) to unlock/level ships before target farming.`
      );
    }
    if (outputPrepNoYieldSlotSeconds > 0) {
      notes.push(
        `Some prep launches (${missionDurationLabel(
          outputPrepNoYieldSlotSeconds / 3
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
    if (virtueTankActionPruning && virtueTankActionCounts.after < virtueTankActionCounts.before) {
      notes.push(
        `Tank mode kept ${virtueTankActionCounts.after.toLocaleString()} of ${virtueTankActionCounts.before.toLocaleString()} candidate mission actions: the top ${VIRTUE_TANK_ACTION_TOP_PER_ITEM} mission/target pairs per required item by time, by fuel and by each egg's fuel.${
          virtueTankActionCounts.fullChecksWon > 0
            ? ` ${virtueTankActionCounts.fullChecksWon.toLocaleString()} solve${virtueTankActionCounts.fullChecksWon === 1 ? "" : "s"} over every action found a better plan.`
            : ""
        }`
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
      prepSteps: outputPrepSteps,
      actions: outputActions,
      missionCounts: outputUnified.missionCounts,
    });

    // Tank mode: packing is the source of truth for the tanks, the shifts and
    // the schedule (it seeds the slots with the in-air ships).
    let virtueTanks: VirtueTankPlannerResult | undefined;
    if (tankRun) {
      reportProgress({
        phase: "finalize",
        message: "Packing fuel tanks…",
        completed: completedCandidateCount,
        total: candidateTotal,
        etaMs: null,
      });
      await yieldForProgressFlush();
      const units = buildVirtueTankUnits({
        actions: outputActions,
        missionRows,
        actionKeyByRowKey,
        prepSteps: outputPrepSteps,
      });
      const pack = await packVirtueTanks({
        units,
        capacity: tankRun.capacity,
        startMode: tankRun.startMode,
        currentContents: tankRun.currentContents,
        currentHumility: tankRun.currentHumility,
        inAirLaneFreeSeconds: tankRun.inAirLaneFreeSeconds,
        solverFn: solverFn ?? (await getDefaultSolverFn()),
        timeLimitSeconds: VIRTUE_TANK_PACK_TIME_LIMIT_SECONDS,
      });
      virtueTanks = {
        shiftCap: tankRun.shiftCap,
        plannedShiftCap: tankRun.plannedShiftCap,
        overCap: false,
        startMode: tankRun.startMode,
        capacity: tankRun.capacity,
        units,
        pack,
        notes: [],
      };
      tankRun.report.solveShifts = outputUnified.virtueShifts;
      if (outputUnified.virtueShifts !== undefined) {
        notes.push(
          `Tank model: the solve counted ${outputUnified.virtueShifts.toLocaleString()} shift${
            outputUnified.virtueShifts === 1 ? "" : "s"
          }; packing the launches into tanks takes ${pack.totalShifts.toLocaleString()}.`
        );
      }
    }

    reportProgress({
      phase: "finalize",
      message: "Plan ready.",
      completed: completedCandidateCount,
      total: candidateTotal,
      etaMs: 0,
    });
    await yieldForProgressFlush();

    const expectedHours = virtueTanks
      ? virtueTanks.pack.schedule.makespanSeconds / 3600
      : estimateThreeSlotExpectedHours({
          actions: outputActions,
          missionCounts: outputUnified.missionCounts,
          residualSlotSeconds: outputPrepNoYieldSlotSeconds,
        });
    // Tank mode also counts prep launches with no useful drops: they burn fuel too.
    const outputFuelCost = virtueTanks
      ? virtueTanks.units.reduce(
          (sum, unit) => sum + unit.launches * getVirtueFuelPerLaunch(unit.ship, unit.durationType),
          0
        )
      : missionFuelCost(outputActions, outputUnified.missionCounts);

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
      ...(virtueTanks ? { virtueTanks } : {}),
    };
    const finalResult = maybeAdoptFastIncumbentResult(result);
    reportBenchmark(finalResult, "primary");
    return finalResult;
  } catch (error) {
    if (error instanceof MissionCoverageError) {
      throw error;
    }
    const details = error instanceof Error ? error.message : String(error);
    // The heuristic fallback is fuel-blind: it would hand back a plan that
    // ignores the tank and the shift cap, so tank mode surfaces the failure.
    if (tankRun) {
      throw new Error(`Path of Virtue tank planning failed (${details}).`);
    }
    reportProgress({
      phase: "fallback",
      message: `Primary solve path unavailable (${details}); running heuristic fallback...`,
      etaMs: null,
    });
    await yieldForProgressFlush();
    const fallbackProfile = missionOptionFilter
      ? { ...profile, missionOptions: missionOptionFilter(profile.missionOptions) }
      : profile;
    // The heuristic path plans one item at a time, so a craft-count goal is
    // approximated as demand for the crafts still owed. That overshoots when
    // the item also feeds a higher tier in the same plan, hence the note.
    const fallbackPrimary = normalizedTargets.demandTargets[0];
    const fallbackTargetItemId = fallbackPrimary ? fallbackPrimary.targetItemId : itemKeyToId(targetKey);
    const fallbackQuantity = fallbackPrimary
      ? fallbackPrimary.quantity
      : Math.max(1, craftFloorByItem.get(targetKey) || 1);
    const fallback = await planForTargetHeuristic(fallbackProfile, fallbackTargetItemId, fallbackQuantity, priorityTime, {
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
    if (hasCraftGoals) {
      fallback.notes.push(
        "The heuristic fallback plans a single goal, so craft-count goals are approximated as crafts still owed and may overshoot where a tier also feeds a higher one."
      );
    }
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
  const normalizedTargets = normalizePlannerTargets(targetItemId, quantity, targets, profile.craftCounts);
  const targetKey = normalizedTargets.primaryTargetKey;
  const quantityInt = normalizedTargets.primaryQuantity;
  const craftFloorByItem = normalizedTargets.craftFloorByItem;
  const missionDropRaritySelection = normalizeShinyRaritySelection(missionDropRarities);
  const selectedConsumptionItemKeys = normalizeConsumptionItemKeys(selectedConsumptionItemIds);

  const closure = new Set(getTargetClosureCached(targetKey));
  for (const itemKey of normalizedTargets.targetDemandByItem.keys()) {
    collectClosure(itemKey, closure);
  }
  for (const itemKey of craftFloorByItem.keys()) {
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
    craftFloorByItem,
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
        targetDemandByItem: normalizedTargets.targetDemandByItem,
        craftFloorByItem,
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
