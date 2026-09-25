import type { HighsSolveResult } from "./highs";
import { formatVirtueFuelQuantity, formatVirtueTankLimit, getVirtueFuelConfig, type VirtueFuelKey } from "./virtue-fuel";

// ---------------------------------------------------------------------------
// Path of Virtue fuel-tank packing. Client-safe: no node APIs, and HiGHS is
// only reached through an injected solver function.
//
// Given the launches a virtue plan already chose, split them into tanks: the
// initial tank (what is in it now, or an ideal fill), then one tank per refuel
// loop. A loop shifts to each fuel egg that needs topping up and back to
// Humility (missions only launch from Humility), so it costs one shift per
// egg refilled plus one. Leftover fuel carries into the next tank and
// draining is free, so a loop only refills the eggs the carry cannot cover.
// The drain slider moves in the same 1% steps as the limit sliders, so a
// drain always leaves an egg on a step (or empty): it takes the egg to the
// highest step that frees enough room, often a little more than the room
// needed, and what it drains is gone for good.
// Humility itself is fueled straight from the Humility farm and never counted
// against the tank: its limit stays at 0, so Humility sitting in the tank is
// drained once, at the plan's first fill, and never comes back.
// ---------------------------------------------------------------------------

/** Shift-cap slider stops. A refuel loop is at least two shifts (one egg and back), so 1 buys nothing over 0. */
export const VIRTUE_SHIFT_CAP_DETENTS: number[] = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** Mission time a shift is charged as in the planner objective. */
export const VIRTUE_SHIFT_PENALTY_SECONDS = 4 * 3600;

/** Order a refuel loop visits the fuel eggs in, before shifting back to Humility. */
export const VIRTUE_REFILL_ROUTE_ORDER: VirtueFuelKey[] = ["curiosity", "resilience", "integrity", "kindness"];

/** Tank limit sliders move in 1% steps of the tank capacity. */
export const VIRTUE_TANK_LIMIT_STEP = 0.01;

export type VirtueFuelVector = Partial<Record<VirtueFuelKey, number>>;

/**
 * "current": the initial tank is exactly what is in the tank now.
 * "ideal": the initial tank is the best fill for the plan (filling it is not counted in shifts).
 */
export type VirtueTankStartMode = "current" | "ideal";

export type VirtueTankSolverFunction = (
  model: string,
  options?: Record<string, string | number | boolean>
) => Promise<HighsSolveResult>;

export type VirtueTankLaunchUnit = {
  id: string;
  ship: string;
  durationType: string;
  level: number;
  durationSeconds: number;
  /** Launches still to make (integer >= 0). */
  launches: number;
  /** Prep launches (ship leveling) all go before any non-prep launch. */
  isPrep?: boolean;
  /** Dependency order among prep units, ascending (missing counts as 0). */
  prepOrder?: number;
  /** Fuel burned per launch; defaults to getVirtueFuelConfig(ship, durationType). */
  fuelPerLaunch?: VirtueFuelVector;
};

export type VirtueTankPackInput = {
  units: VirtueTankLaunchUnit[];
  capacity: number;
  startMode: VirtueTankStartMode;
  /** C/I/K/R in the tank now: the initial tank in "current" mode, the baseline for `changeFromCurrent` in "ideal" mode. */
  currentContents?: VirtueFuelVector;
  /**
   * Humility in the tank now. It never counts against the tank (ships fuel Humility straight from
   * the Humility farm); it only flags draining it and setting its limit to 0 at the plan's first fill.
   */
  currentHumility?: number;
  /**
   * Refuel loops the exact solve may use. By default it searches as many as the heuristic's shift
   * count allows (a loop is at least two shifts), which is what makes the result a proof, and skips
   * the solve when the heuristic needs more shifts than the top shift-cap detent. An explicit value
   * always runs the solve; below what the heuristic allows, its result is not proven optimal.
   */
  maxRefillLoops?: number;
  /** Seconds until each busy mission slot frees up (up to 3); seeds the schedule lanes. */
  inAirLaneFreeSeconds?: number[];
  /** Wait between the last launch of a tank and the first launch of the next (default 0). */
  refuelDelaySeconds?: number;
  /** Exact MILP solve (CPLEX LP text, as lib/planner.ts uses); the heuristic packing is used without it. */
  solverFn?: VirtueTankSolverFunction;
  /**
   * Solver time limit (default 2s; 0 or less skips the exact solve). On a limit the solver's best
   * packing is used if it beats the heuristic. When the first solve's optimum needs drains between
   * slider steps, a second solve with drains on steps gets what is left of it, at least half.
   */
  timeLimitSeconds?: number;
};

export type VirtueTankRefill = {
  /** Ordered shifts; always ends with "humility". */
  route: Array<VirtueFuelKey | "humility">;
  /** Shifts this loop costs (=== route.length). */
  shifts: number;
  /** Fuel to add per refilled egg. */
  add: VirtueFuelVector;
  /** Level each refilled egg must reach. */
  fillTo: VirtueFuelVector;
  /** Limit slider to set per refilled egg, in whole percent (ceil(fillTo / capacity * 100)). */
  limitPct: Partial<Record<VirtueFuelKey, number>>;
  /**
   * Fuel to drain per egg before refilling, to make room (usually empty). The drain slider snaps to
   * 1% of the tank, so each drain leaves its egg on a whole step or empty (the leftover minus the
   * drain); it may take a little more than the room needs, and the drained fuel is lost.
   */
  drain: VirtueFuelVector;
  /**
   * Before this loop, drain the Humility sitting in the tank and set its limit to 0. Only the first
   * loop in "current" mode, when there is some: at 0 Humility never comes back into the tank.
   */
  drainHumility: boolean;
};

export type VirtueTankIdealFill = {
  /** Level each egg should start at (never above what its limit slider gives). */
  fillTo: VirtueFuelVector;
  limitPct: Partial<Record<VirtueFuelKey, number>>;
  /**
   * Change from what is in the tank now, when current contents are known. Negative = drain: the egg
   * holds more than the tank starts with, so it is drained to its start level, which is always a
   * whole 1% step (or empty). Positive = fillTo minus what is in it now. An egg that already holds
   * its fillTo is usually left as it is (its start level is what it holds now); it is only topped up
   * to its limit step when the tanks would not replay without that, and then its change stays 0.
   */
  changeFromCurrent?: VirtueFuelVector;
  /** Before the fill, drain the Humility sitting in the tank and set its limit to 0 (when there is some). */
  drainHumility: boolean;
};

export type VirtueTank = {
  index: number;
  /** "Initial Tank", "Tank 2", "Tank 3", ... */
  label: string;
  /** How this tank is refilled from the previous one; null for the initial tank. */
  refill: VirtueTankRefill | null;
  /** Ideal mode, initial tank only. */
  idealFill?: VirtueTankIdealFill;
  /** Contents once filled (limit sliders round refilled eggs up to whole percents). */
  startContents: VirtueFuelVector;
  used: VirtueFuelVector;
  leftover: VirtueFuelVector;
  /** In launch order. */
  launches: Array<{ unitId: string; launches: number }>;
  capacity: number;
};

export type VirtueTankScheduleBlock = {
  unitId: string;
  tankIndex: number;
  launches: number;
  startSeconds: number;
  endSeconds: number;
};

export type VirtueTankSchedule = {
  makespanSeconds: number;
  /** Three mission slots; consecutive launches of a unit in a slot form one block. */
  lanes: VirtueTankScheduleBlock[][];
};

export type VirtueTankLaunchOrderEntry = { unitId: string; tankIndex: number; launches: number };

export type VirtueTankPlan = {
  startMode: VirtueTankStartMode;
  capacity: number;
  tanks: VirtueTank[];
  totalShifts: number;
  refillLoops: number;
  /** Fuel burned by every placed launch. */
  totalFuel: VirtueFuelVector;
  /** False when some launches can never fit in the tank; they are listed in `unplaced` and `notes`. */
  feasible: boolean;
  /** True when proven optimal: by the MILP, or trivially when no shifts are needed. */
  exact: boolean;
  launchOrder: VirtueTankLaunchOrderEntry[];
  schedule: VirtueTankSchedule;
  /** Launches left out of the plan because they can never fit in the tank. */
  unplaced: Array<{ unitId: string; launches: number; reason: string }>;
  /** For the player. */
  notes: string[];
  /** Solver and input details for developers (exact solve skipped or failed, duplicate ids, ...). */
  diagnostics: string[];
};

const EGGS = VIRTUE_REFILL_ROUTE_ORDER;
const EGG_INDICES = [0, 1, 2, 3];
/**
 * Fuel amounts closer than the tolerance count as equal. The game's tank readings carry float
 * noise that grows with the tank (a tank filled to exactly 190T reads 190000000000001.9), so the
 * tolerance is relative to the capacity, with a floor of one egg: 0.5M eggs on a 500T tank, 2 on
 * the 2B one. Real amounts stay far above it: the smallest burn is a BCR's 10M Integrity, and a
 * limit-slider step is 1% of the tank.
 */
const FUEL_TOLERANCE_MIN_EGGS = 1;
const FUEL_TOLERANCE_OF_CAPACITY = 1e-9;
/** In percent, as the limit sliders read (spec: ceil(fillTo / capacity * 100 - 1e-9)). */
const LIMIT_PCT_EPSILON = 1e-9;
const DEFAULT_TIME_LIMIT_SECONDS = 2;
/** By default the exact solve is skipped past the top shift-cap detent: such a plan is over any cap. */
const MAX_EXACT_SHIFTS = VIRTUE_SHIFT_CAP_DETENTS[VIRTUE_SHIFT_CAP_DETENTS.length - 1];
const COST_SHIFT = 1_000_000;
const COST_LOOP = 1_000;
/** MILP objective weights: shifts, then loops, then fuel added (which stays below 1 in total). */
const MILP_SHIFT_WEIGHT = 1000;
const MILP_LOOP_WEIGHT = 100;
/** Below MILP_LOOP_WEIGHT minus the fuel tie-breaks (< 4 in total). */
const MILP_PROOF_GAP = 50;
const REFILL_DP_STATES_PER_CALL = 20_000;
const HEURISTIC_DP_STATE_BUDGET = 600_000;
const HEURISTIC_EVALUATION_BUDGET = 2_000;
const ILS_ROUNDS = 400;
const FINAL_POLISH_EVALUATIONS = 500;
const FINAL_POLISH_DP_STATES = 100_000;
const ILS_RESTART_AFTER = 25;
const REORDER_PERMUTATION_LIMIT = 6;
const REORDER_REALIZE_LIMIT = 40;
const IDEAL_EXTRA_SEARCH_STEPS = 60;

type Fuel4 = number[];

type PackContext = {
  capacity: number;
  /** One limit-slider step (1% of capacity). */
  pct: number;
  /** Fuel amounts closer than this are equal (see FUEL_TOLERANCE_OF_CAPACITY). */
  tolerance: number;
  mode: VirtueTankStartMode;
  /** Current C/R/I/K contents in route order. */
  current: Fuel4;
};

type PackUnit = {
  index: number;
  id: string;
  /** Unique per unit (ids may repeat); keys the schedule. */
  key: string;
  ship: string;
  durationType: string;
  level: number;
  durationSeconds: number;
  /** Longest duration of this ship and duration type: orders launches so levels stay ascending. */
  orderSeconds: number;
  launches: number;
  /** Precedence phase: prep units by prepOrder, then everything else. */
  phase: number;
  fuel: Fuel4;
  size: number;
};

/** Units with the same ship, duration, phase and fuel burn: packed as one pool of launches. */
type PackGroup = {
  index: number;
  phase: number;
  fuel: Fuel4;
  size: number;
  mask: number;
  launches: number;
  /** Ascending level: the lower levels launch first. */
  units: PackUnit[];
  /** Launches a tank of this group alone holds when every egg is refilled (and rounded up). */
  maxPerRefillTank: number;
  /** Launches the current tank holds as-is ("current"), or maxPerRefillTank ("ideal"). */
  maxInInitialTank: number;
};

type PreparedPack = {
  input: VirtueTankPackInput;
  ctx: PackContext;
  groups: PackGroup[];
  freeUnits: PackUnit[];
  phases: number[];
  totalFuel: Fuel4;
  unplaced: VirtueTankPlan["unplaced"];
  notes: string[];
  diagnostics: string[];
};

/** Launch counts per group, per tank; tank 0 is the initial tank. */
type Assignment = number[][];

type Evaluation = {
  cost: number;
  shifts: number;
  loops: number;
  /** Eggs refilled per tank (bit e = VIRTUE_REFILL_ROUTE_ORDER[e]); masks[0] is always 0. */
  masks: number[];
};

type TankState = {
  counts: number[];
  usage: Fuel4;
  start: Fuel4;
  refillMask: number;
  fillTo: Fuel4;
  add: Fuel4;
  drain: Fuel4;
};

type Realized = {
  tanks: TankState[];
  shifts: number;
  loops: number;
  cost: number;
  /** Ideal mode: the initial tank's fill targets. */
  idealFillTo: Fuel4 | null;
};

type DpBudget = { states: number };
type SearchBudget = DpBudget & { evaluations: number; cache: Map<string, Evaluation | null> };

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Shifts a refuel loop costs: one per egg refilled plus the shift back to Humility. */
export function refillShiftCount(eggs: VirtueFuelKey[]): number {
  const distinct = new Set(eggs).size;
  return distinct === 0 ? 0 : distinct + 1;
}

/** Snap a slider value to the closest shift-cap detent (ties go to the lower one, so 1 -> 0). */
export function nearestVirtueShiftCapDetent(value: number): number {
  if (!Number.isFinite(value)) {
    return VIRTUE_SHIFT_CAP_DETENTS[0];
  }
  let best = VIRTUE_SHIFT_CAP_DETENTS[0];
  for (const detent of VIRTUE_SHIFT_CAP_DETENTS) {
    if (Math.abs(detent - value) < Math.abs(best - value)) {
      best = detent;
    }
  }
  return best;
}

/**
 * List-schedule launches onto the three mission slots: each launch takes the
 * slot that frees first, and start times never go backwards. A tank's first
 * launch waits for the previous tank's last launch plus the refuel delay.
 */
export function scheduleVirtueLaunches(
  order: VirtueTankLaunchOrderEntry[],
  options: { inAirLaneFreeSeconds?: number[]; refuelDelaySeconds?: number; durations: Record<string, number> }
): VirtueTankSchedule {
  const seeds = (options.inAirLaneFreeSeconds || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(0, value))
    .sort((a, b) => b - a)
    .slice(0, 3);
  const laneFree = [0, 1, 2].map((lane) => seeds[lane] ?? 0);
  const lanes: VirtueTankScheduleBlock[][] = [[], [], []];
  const refuelDelay = Math.max(0, finiteOr(options.refuelDelaySeconds, 0));
  let previousStart = 0;
  let barrier = 0;
  let currentTank: number | null = null;

  for (const entry of order) {
    const launches = Math.max(0, Math.round(finiteOr(entry.launches, 0)));
    if (launches <= 0) {
      continue;
    }
    if (entry.tankIndex !== currentTank) {
      // Every tank after the initial one waits for its refuel loop.
      if (currentTank !== null || entry.tankIndex > 0) {
        barrier = Math.max(barrier, previousStart + refuelDelay);
      }
      currentTank = entry.tankIndex;
    }
    const duration = Math.max(0, finiteOr(options.durations[entry.unitId], 0));
    for (let launch = 0; launch < launches; launch += 1) {
      let lane = 0;
      for (let candidate = 1; candidate < 3; candidate += 1) {
        if (laneFree[candidate] < laneFree[lane]) {
          lane = candidate;
        }
      }
      const startSeconds = Math.max(laneFree[lane], barrier, previousStart);
      const endSeconds = startSeconds + duration;
      laneFree[lane] = endSeconds;
      previousStart = startSeconds;
      const blocks = lanes[lane];
      const last = blocks[blocks.length - 1];
      if (last && last.unitId === entry.unitId && last.tankIndex === entry.tankIndex && last.endSeconds === startSeconds) {
        last.launches += 1;
        last.endSeconds = endSeconds;
      } else {
        blocks.push({ unitId: entry.unitId, tankIndex: entry.tankIndex, launches: 1, startSeconds, endSeconds });
      }
    }
  }

  return { makespanSeconds: Math.max(0, ...laneFree), lanes };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Pack the launches into tanks. With `solverFn` the packing is also solved as
 * a MILP: an Optimal status proves the shift count; on a time limit the
 * solver's best packing is used only if it beats the heuristic; any other
 * failure falls back to the heuristic packing. Without it the heuristic
 * packing is returned.
 */
export async function packVirtueTanks(input: VirtueTankPackInput): Promise<VirtueTankPlan> {
  const prepared = preparePack(input);
  const heuristic = searchHeuristicAssignment(prepared);
  const heuristicRealized = realizeWithFallback(prepared, heuristic.tanks);
  if (!input.solverFn || !heuristicRealized || heuristicRealized.shifts === 0) {
    return finishPlan(prepared, heuristicRealized, { exact: false, diagnostics: [] });
  }
  const timeLimit = finiteOr(input.timeLimitSeconds, DEFAULT_TIME_LIMIT_SECONDS);
  if (timeLimit <= 0) {
    return finishPlan(prepared, heuristicRealized, {
      exact: false,
      diagnostics: ["Exact tank packing skipped (no solver time allowed); using the heuristic packing."],
    });
  }

  // The realized count can dip below the DP's thanks to limit-slider overfill the MILP does not
  // model, so cap the MILP at the DP's count, which it can always match.
  const cutoff = Math.max(heuristic.evaluation.shifts, heuristicRealized.shifts);
  // First with any drain allowed. Its bound holds for drains on whole steps too, so a packing that
  // meets it is optimal; only when none does is it solved again with the drains on steps.
  const solveStart = Date.now();
  let solved = await solveExactAssignment(prepared, cutoff, input.solverFn, timeLimit, false);
  if ("failure" in solved) {
    return finishPlan(prepared, heuristicRealized, {
      exact: false,
      diagnostics: [`Exact tank packing unavailable (${solved.failure}); using the heuristic packing.`],
    });
  }
  // The solver's packing, with its own refill sets and with the refill DP's; the cheaper replay wins.
  const realizeSolved = (packing: { tanks: Assignment; masks: number[] }) =>
    [realizeAssignment(prepared, packing.tanks, packing.masks), realizeWithFallback(prepared, packing.tanks)]
      .filter((realized): realized is Realized => realized !== null)
      .reduce<Realized | null>((best, realized) => (!best || realized.cost < best.cost - 1e-6 ? realized : best), null);
  // Cost orders by shifts, then loops.
  const cheaper = (a: Realized, b: Realized | null) => (b && b.cost < a.cost - 1e-6 ? b : a);
  let better = cheaper(heuristicRealized, realizeSolved(solved));
  const meets = (bound: { shifts: number; loops: number }) =>
    better.shifts < bound.shifts || (better.shifts === bound.shifts && better.loops <= bound.loops);
  if (solved.proven && !meets(solved)) {
    // What is left of the time limit, but at least half of it.
    const remaining = Math.max(timeLimit / 2, timeLimit - (Date.now() - solveStart) / 1000);
    const stepped = await solveExactAssignment(prepared, better.shifts, input.solverFn, remaining, true);
    if ("failure" in stepped) {
      return finishPlan(prepared, better, {
        exact: false,
        diagnostics: [
          `Exact tank packing bound (${solved.shifts} shifts) needs drains between slider steps, and the ` +
            `solve with drains on steps is unavailable (${stepped.failure}); using the best packing found.`,
        ],
      });
    }
    better = cheaper(better, realizeSolved(stepped));
    solved = stepped;
  }
  if (!solved.proven) {
    return finishPlan(prepared, better, {
      exact: false,
      diagnostics: [`Exact tank packing stopped early (${solved.reason}); using the best packing found.`],
    });
  }
  // The MILP's counts bound every packing it models. Solver tolerances can still let a nearly-off
  // refill switch carry a little fuel for free, so only a packing that meets them is proven.
  const meetsBound = meets(solved);
  return finishPlan(prepared, better, {
    exact: meetsBound,
    diagnostics: meetsBound
      ? []
      : [`Exact tank packing bound (${solved.shifts} shifts) is below every packing found (${better.shifts}); not proven.`],
  });
}

/** Synchronous heuristic packing: always valid, usually optimal or close to it. */
export function packVirtueTanksHeuristic(input: VirtueTankPackInput): VirtueTankPlan {
  const prepared = preparePack(input);
  const heuristic = searchHeuristicAssignment(prepared);
  return finishPlan(prepared, realizeWithFallback(prepared, heuristic.tanks), { exact: false, diagnostics: [] });
}

// ---------------------------------------------------------------------------
// Fuel vectors and tank footprints
// ---------------------------------------------------------------------------

function finiteOr(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function zeroFuel(): Fuel4 {
  return [0, 0, 0, 0];
}

function fromVector(vector: VirtueFuelVector | undefined): Fuel4 {
  return EGGS.map((egg) => Math.max(0, finiteOr(vector?.[egg], 0)));
}

/**
 * Fuel amounts closer than this count as equal on a tank of `capacity` (see
 * FUEL_TOLERANCE_OF_CAPACITY). Anything the plan drains or fills beyond it is real, so a page
 * showing the plan compares with this too: a 0.5M drain on the 2B tank matters.
 */
export function virtueFuelTolerance(capacity: number): number {
  return Math.max(FUEL_TOLERANCE_MIN_EGGS, Math.max(0, capacity) * FUEL_TOLERANCE_OF_CAPACITY);
}

/**
 * Output vector. Amounts within the fuel tolerance of zero are float noise from the game's
 * readings (a leftover of -0.5, a change of 3 eggs on a 500T tank) and are left out. The packing
 * compares with the same tolerance, so it never plans a drain or a refill this small.
 */
function toVector(fuel: Fuel4, tolerance: number): VirtueFuelVector {
  const vector: VirtueFuelVector = {};
  for (const e of EGG_INDICES) {
    if (Math.abs(fuel[e]) > tolerance) {
      vector[EGGS[e]] = fuel[e];
    }
  }
  return vector;
}

function sumFuel(fuel: Fuel4): number {
  return fuel[0] + fuel[1] + fuel[2] + fuel[3];
}

function fuelMask(fuel: Fuel4, threshold = 0): number {
  let mask = 0;
  for (const e of EGG_INDICES) {
    if (fuel[e] > threshold) {
      mask |= 1 << e;
    }
  }
  return mask;
}

function popcount(mask: number): number {
  let count = 0;
  for (let rest = mask; rest; rest &= rest - 1) {
    count += 1;
  }
  return count;
}

function highestEgg(mask: number): number {
  for (let e = 3; e >= 0; e -= 1) {
    if (mask & (1 << e)) {
      return e;
    }
  }
  return -1;
}

function hasEgg(mask: number, e: number): boolean {
  return (mask & (1 << e)) !== 0;
}

function limitPctFor(amount: number, ctx: PackContext): number {
  if (amount <= 0 || ctx.pct <= 0) {
    return 0;
  }
  return Math.ceil(amount / ctx.pct - LIMIT_PCT_EPSILON);
}

function roundUpToLimit(amount: number, ctx: PackContext): number {
  return Math.max(amount, limitPctFor(amount, ctx) * ctx.pct);
}

/**
 * Drain-slider steps (1% of the tank, like the limit sliders): the highest step at or below
 * `amount`, and the lowest at or above it. Amounts within the fuel tolerance of a step count as on it.
 */
function stepAtOrBelow(amount: number, ctx: PackContext): number {
  if (ctx.pct <= 0) {
    return Math.max(0, amount);
  }
  return Math.max(0, Math.floor((amount + ctx.tolerance) / ctx.pct)) * ctx.pct;
}

function stepAtOrAbove(amount: number, ctx: PackContext): number {
  if (amount <= ctx.tolerance) {
    return 0;
  }
  if (ctx.pct <= 0) {
    return amount;
  }
  return Math.ceil((amount - ctx.tolerance) / ctx.pct) * ctx.pct;
}

/**
 * Tank space a fill needs to guarantee `needs`. Refilled eggs other than the
 * last one in the route land on their limit slider, rounded up to a whole
 * percent; the last one stops when the tank is full; carried eggs are drained
 * down to what they need.
 */
function refillFootprint(needs: Fuel4, refillMask: number, ctx: PackContext): number {
  const last = highestEgg(refillMask);
  let total = 0;
  for (const e of EGG_INDICES) {
    const need = Math.max(0, needs[e]);
    total += hasEgg(refillMask, e) && e !== last ? roundUpToLimit(need, ctx) : need;
  }
  return total;
}

function fitsCapacity(amount: number, ctx: PackContext): boolean {
  return amount <= ctx.capacity + ctx.tolerance;
}

/** A tank on its own: every egg it burns refilled (or the current tank as-is). */
function tankFitsAlone(usage: Fuel4, tankIndex: number, ctx: PackContext): boolean {
  if (tankIndex === 0 && ctx.mode === "current") {
    return EGG_INDICES.every((e) => usage[e] <= ctx.current[e] + ctx.tolerance);
  }
  return fitsCapacity(refillFootprint(usage, fuelMask(usage), ctx), ctx);
}

/** Can the initial tank hold everything burned until each egg's first refill? */
function initialTankHolds(needs: Fuel4, ctx: PackContext): boolean {
  if (ctx.mode === "current") {
    return EGG_INDICES.every((e) => needs[e] <= ctx.current[e] + ctx.tolerance);
  }
  return fitsCapacity(refillFootprint(needs, fuelMask(needs, ctx.tolerance), ctx), ctx);
}

function tankUsage(counts: number[], groups: PackGroup[]): Fuel4 {
  const usage = zeroFuel();
  for (let g = 0; g < groups.length; g += 1) {
    const launches = counts[g] || 0;
    if (launches <= 0) {
      continue;
    }
    for (const e of EGG_INDICES) {
      usage[e] += groups[g].fuel[e] * launches;
    }
  }
  return usage;
}

function formatFuel(value: number): string {
  return formatVirtueFuelQuantity(value);
}

const SHIP_DISPLAY_NAMES: Record<string, string> = {
  ATREGGIES: "Henliner",
  CHICKFIANT: "Defihent",
  CORELLIHEN_CORVETTE: "Cornish-Hen Corvette",
  MILLENIUM_CHICKEN: "Quintillion Chicken",
  BCR: "BCR",
};

const DURATION_DISPLAY_NAMES: Record<string, string> = {
  TUTORIAL: "Tutorial",
  SHORT: "Short",
  LONG: "Standard",
  EPIC: "Extended",
};

/** "Henliner Extended", for notes the player reads. */
function missionDisplayName(ship: string, durationType: string): string {
  const shipName = SHIP_DISPLAY_NAMES[ship] ?? ship
    .toLowerCase()
    .split("_")
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
  return `${shipName} ${DURATION_DISPLAY_NAMES[durationType] ?? durationType.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

function maxLaunchesPerRefillTank(fuel: Fuel4, ctx: PackContext): number {
  const mask = fuelMask(fuel);
  const fits = (launches: number) =>
    fitsCapacity(refillFootprint(fuel.map((value) => value * launches), mask, ctx), ctx);
  const size = sumFuel(fuel);
  if (size <= 0 || !fits(1)) {
    return 0;
  }
  // Above this even unrounded fuel overflows the tank.
  let lo = 1;
  let hi = Math.max(1, Math.floor((ctx.capacity + ctx.tolerance) / size));
  if (fits(hi)) {
    return hi;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function preparePack(input: VirtueTankPackInput): PreparedPack {
  const capacity = Math.max(0, finiteOr(input.capacity, 0));
  const ctx: PackContext = {
    capacity,
    pct: capacity / 100,
    tolerance: virtueFuelTolerance(capacity),
    mode: input.startMode === "ideal" ? "ideal" : "current",
    current: fromVector(input.currentContents),
  };
  const rawUnits = Array.isArray(input.units) ? input.units : [];
  const prepOrderOf = (unit: VirtueTankLaunchUnit) => finiteOr(unit.prepOrder, 0);
  const prepOrders = Array.from(
    new Set(rawUnits.filter((unit) => unit.isPrep).map(prepOrderOf))
  ).sort((a, b) => a - b);
  const notes: string[] = [];
  const diagnostics: string[] = [];
  if (ctx.mode === "current" && !input.currentContents) {
    notes.push("The current tank contents are unknown, so the plan starts from an empty tank.");
  }

  const units: PackUnit[] = [];
  rawUnits.forEach((unit, index) => {
    const launches = Math.max(0, Math.round(finiteOr(unit.launches, 0)));
    if (launches <= 0) {
      return;
    }
    const fuel = fromVector(unit.fuelPerLaunch ?? getVirtueFuelConfig(unit.ship, unit.durationType));
    const durationSeconds = Math.max(0, finiteOr(unit.durationSeconds, 0));
    units.push({
      index,
      id: String(unit.id),
      key: `#${index}`,
      ship: String(unit.ship),
      durationType: String(unit.durationType),
      level: finiteOr(unit.level, 0),
      durationSeconds,
      orderSeconds: durationSeconds,
      launches,
      phase: unit.isPrep ? prepOrders.indexOf(prepOrderOf(unit)) : prepOrders.length,
      fuel,
      size: sumFuel(fuel),
    });
  });
  const longestByMission = new Map<string, number>();
  for (const unit of units) {
    const mission = `${unit.ship}|${unit.durationType}`;
    longestByMission.set(mission, Math.max(longestByMission.get(mission) || 0, unit.durationSeconds));
  }
  for (const unit of units) {
    unit.orderSeconds = longestByMission.get(`${unit.ship}|${unit.durationType}`) || 0;
  }
  const idCounts = new Map<string, number>();
  for (const unit of units) {
    idCounts.set(unit.id, (idCounts.get(unit.id) || 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      diagnostics.push(`Unit id '${id}' is used by ${count} units; the launch order cannot tell them apart.`);
    }
  }

  const freeUnits = units.filter((unit) => unit.size <= 0);
  const unitsByGroup = new Map<string, PackUnit[]>();
  for (const unit of units) {
    if (unit.size <= 0) {
      continue;
    }
    const key = `${unit.ship}|${unit.durationType}|${unit.phase}|${unit.fuel.join(",")}`;
    const members = unitsByGroup.get(key);
    if (members) {
      members.push(unit);
    } else {
      unitsByGroup.set(key, [unit]);
    }
  }

  const groups: PackGroup[] = [];
  const unplaced: VirtueTankPlan["unplaced"] = [];
  const totalFuel = zeroFuel();
  for (const members of unitsByGroup.values()) {
    members.sort((a, b) => a.level - b.level || a.index - b.index);
    const { fuel, size, phase } = members[0];
    const launches = members.reduce((sum, unit) => sum + unit.launches, 0);
    const maxPerRefillTank = maxLaunchesPerRefillTank(fuel, ctx);
    if (maxPerRefillTank <= 0) {
      const reason = size > capacity
        ? `burns ${formatFuel(size)} of fuel per launch but the tank holds ${formatFuel(capacity)}`
        : `burns ${formatFuel(size)} of fuel per launch, more than the tank holds once each egg's limit slider rounds up to its next ${formatVirtueTankLimit(1, capacity)} step`;
      for (const unit of members) {
        unplaced.push({ unitId: unit.id, launches: unit.launches, reason });
      }
      notes.push(`${launches.toLocaleString()}× ${missionDisplayName(members[0].ship, members[0].durationType)} can never launch: it ${reason}.`);
      continue;
    }
    const maxInInitialTank = ctx.mode === "current"
      ? Math.min(
          ...EGG_INDICES.filter((e) => fuel[e] > 0).map((e) =>
            Math.floor((ctx.current[e] + ctx.tolerance) / fuel[e])
          )
        )
      : maxPerRefillTank;
    for (const e of EGG_INDICES) {
      totalFuel[e] += fuel[e] * launches;
    }
    groups.push({
      index: groups.length,
      phase,
      fuel,
      size,
      mask: fuelMask(fuel),
      launches,
      units: members,
      maxPerRefillTank,
      maxInInitialTank: Math.max(0, maxInInitialTank),
    });
  }

  const phases = Array.from(new Set(groups.map((group) => group.phase))).sort((a, b) => a - b);
  return { input, ctx, groups, freeUnits, phases, totalFuel, unplaced, notes, diagnostics };
}

// ---------------------------------------------------------------------------
// Refill sets for a fixed packing
// ---------------------------------------------------------------------------

/**
 * Fuel each tank must hold per egg: what it and the following tanks burn until
 * that egg is next refilled.
 */
function segmentDemands(usage: Fuel4[], masks: number[]): Fuel4[] {
  const lastTank = usage.length - 1;
  const demand = usage.map(() => zeroFuel());
  for (let t = lastTank; t >= 0; t -= 1) {
    for (const e of EGG_INDICES) {
      const carried = t < lastTank && !hasEgg(masks[t + 1] || 0, e) ? demand[t + 1][e] : 0;
      demand[t][e] = usage[t][e] + carried;
    }
  }
  return demand;
}

function refillCost(masks: number[]): { shifts: number; loops: number } {
  let shifts = 0;
  let loops = 0;
  for (let t = 1; t < masks.length; t += 1) {
    if (masks[t]) {
      shifts += popcount(masks[t]) + 1;
      loops += 1;
    }
  }
  return { shifts, loops };
}

const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
const HIGHEST_EGG = [-1, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3];

/** refillFootprint on four scalars (the DP's hot path). */
function footprintOf(d0: number, d1: number, d2: number, d3: number, mask: number, pct: number): number {
  const last = HIGHEST_EGG[mask];
  const round = (need: number, e: number) => {
    if (!(mask & (1 << e)) || e === last || need <= 0) {
      return need;
    }
    const rounded = Math.ceil(need / pct - LIMIT_PCT_EPSILON) * pct;
    return rounded > need ? rounded : need;
  };
  return round(d0, 0) + round(d1, 1) + round(d2, 2) + round(d3, 3);
}

/** Every egg on its next whole step: an upper bound on what a loop holds once its drains are done. */
function footprintAllStepped(d0: number, d1: number, d2: number, d3: number, pct: number): number {
  const round = (need: number) =>
    need <= 0 ? 0 : pct > 0 ? Math.max(need, Math.ceil(need / pct - LIMIT_PCT_EPSILON) * pct) : need;
  return round(d0) + round(d1) + round(d2) + round(d3);
}

/**
 * Cheapest refill sets for tanks in a fixed order. Backward DP over "next
 * refill tank" per egg: that pins every tank's minimum contents, so a loop's
 * capacity check only needs the state. A loop with no eggs merges the tank
 * into the previous one. Returns undefined when the state budget runs out.
 *
 * By default a carried egg counts at exactly what it still needs, as if it
 * could be drained to that amount. Drains snap to whole steps, so that is a
 * relaxation (exact whenever the needs sit on steps, or the carry is exact)
 * and its refill sets are checked by replaying them. `stepped` counts every
 * egg at its next whole step instead, which every replay can meet: the fallback
 * when the relaxed sets do not replay.
 */
function planRefillsExact(
  usage: Fuel4[],
  ctx: PackContext,
  budget: DpBudget,
  stepped = false
): number[] | null | undefined {
  const lastTank = usage.length - 1;
  const width = lastTank + 2;
  // prefix[e * width + t]: egg e burned by tanks before t.
  const prefix = new Float64Array(4 * width);
  for (const e of EGG_INDICES) {
    for (let t = 0; t <= lastTank; t += 1) {
      prefix[e * width + t + 1] = prefix[e * width + t] + usage[t][e];
    }
  }
  const burned = (e: number, from: number, to: number) => prefix[e * width + to] - prefix[e * width + from];
  const tol = ctx.tolerance;
  let refillable = 0;
  for (const e of EGG_INDICES) {
    if (burned(e, 1, lastTank + 1) > tol) {
      refillable |= 1 << e;
    }
  }
  const subsets: number[] = [];
  for (let mask = 0; mask < 16; mask += 1) {
    if ((mask & refillable) === mask) {
      subsets.push(mask);
    }
  }
  subsets.sort((a, b) => POPCOUNT[a] - POPCOUNT[b] || a - b);
  const capacity = ctx.capacity + tol;
  const heldBound = (ctx.mode === "current" ? Math.max(ctx.capacity, sumFuel(ctx.current)) : ctx.capacity) + tol;
  const initialHolds = (n0: number, n1: number, n2: number, n3: number) => {
    const needs = [burned(0, 0, n0), burned(1, 0, n1), burned(2, 0, n2), burned(3, 0, n3)];
    return initialTankHolds(needs, ctx);
  };
  const memo = new Map<number, number>();
  const choice = new Map<number, number>();
  const keyOf = (t: number, n0: number, n1: number, n2: number, n3: number) =>
    (((t * width + n0) * width + n1) * width + n2) * width + n3;
  let callStates = REFILL_DP_STATES_PER_CALL;
  let exhausted = false;

  const solve = (t: number, n0: number, n1: number, n2: number, n3: number): number => {
    if (exhausted) {
      return Number.POSITIVE_INFINITY;
    }
    const key = keyOf(t, n0, n1, n2, n3);
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (t === 0) {
      const value = initialHolds(n0, n1, n2, n3) ? 0 : Number.POSITIVE_INFINITY;
      memo.set(key, value);
      return value;
    }
    callStates -= 1;
    budget.states -= 1;
    if (callStates < 0 || budget.states < 0) {
      exhausted = true;
      return Number.POSITIVE_INFINITY;
    }
    const d0 = burned(0, t, n0);
    const d1 = burned(1, t, n1);
    const d2 = burned(2, t, n2);
    const d3 = burned(3, t, n3);
    let best = Number.POSITIVE_INFINITY;
    let bestMask = 0;
    for (const mask of subsets) {
      let step = 0;
      if (mask) {
        // Refilling an egg nothing burns before its next refill is never useful.
        if (
          (mask & 1 && d0 <= tol) ||
          (mask & 2 && d1 <= tol) ||
          (mask & 4 && d2 <= tol) ||
          (mask & 8 && d3 <= tol)
        ) {
          continue;
        }
        step = (POPCOUNT[mask] + 1) * COST_SHIFT + COST_LOOP;
        const footprint = stepped
          ? footprintAllStepped(d0, d1, d2, d3, ctx.pct)
          : footprintOf(d0, d1, d2, d3, mask, ctx.pct);
        if (step >= best || footprint > capacity) {
          continue;
        }
      }
      const m0 = mask & 1 ? t : n0;
      const m1 = mask & 2 ? t : n1;
      const m2 = mask & 4 ? t : n2;
      const m3 = mask & 8 ? t : n3;
      // The tank before must already hold all of this, so it cannot exceed a full tank.
      const held = burned(0, t - 1, m0) + burned(1, t - 1, m1) + burned(2, t - 1, m2) + burned(3, t - 1, m3);
      if (held > heldBound) {
        continue;
      }
      const total = step + solve(t - 1, m0, m1, m2, m3);
      if (total < best) {
        best = total;
        bestMask = mask;
      }
    }
    memo.set(key, best);
    choice.set(key, bestMask);
    return best;
  };

  const end = lastTank + 1;
  const total = solve(lastTank, end, end, end, end);
  if (exhausted) {
    return undefined;
  }
  if (!Number.isFinite(total)) {
    return null;
  }
  const masks = new Array(lastTank + 1).fill(0);
  const next = [end, end, end, end];
  for (let t = lastTank; t >= 1; t -= 1) {
    const mask = choice.get(keyOf(t, next[0], next[1], next[2], next[3])) || 0;
    masks[t] = mask;
    for (const e of EGG_INDICES) {
      if (hasEgg(mask, e)) {
        next[e] = t;
      }
    }
  }
  return masks;
}

/**
 * Fallback when the DP is too big: walk the tanks, refill only what the carry
 * cannot cover, and fill refilled eggs ahead for later tanks while they fit.
 */
function planRefillsGreedy(usage: Fuel4[], ctx: PackContext): number[] | null {
  const lastTank = usage.length - 1;
  const extend = (t: number, levels: Fuel4, refillMask: number, carry: Fuel4 | null): Fuel4 => {
    const active = [true, true, true, true];
    for (let k = t + 1; k <= lastTank; k += 1) {
      const order = EGG_INDICES.filter((e) => usage[k][e] > 0).sort((a, b) => usage[k][a] - usage[k][b]);
      for (const e of order) {
        if (!active[e]) {
          continue;
        }
        const candidate = levels.slice();
        candidate[e] += usage[k][e];
        const mask = carry ? refillMask : fuelMask(candidate, ctx.tolerance);
        const refilled = carry === null || hasEgg(refillMask, e);
        if ((!refilled && carry && candidate[e] > carry[e] + ctx.tolerance) || !fitsCapacity(refillFootprint(candidate, mask, ctx), ctx)) {
          active[e] = false;
          continue;
        }
        levels = candidate;
      }
    }
    return levels;
  };

  let contents: Fuel4;
  if (ctx.mode === "current") {
    contents = ctx.current.slice();
  } else {
    if (!tankFitsAlone(usage[0], 0, ctx)) {
      return null;
    }
    contents = extend(0, usage[0].slice(), 0, null);
  }
  if (EGG_INDICES.some((e) => usage[0][e] > contents[e] + ctx.tolerance)) {
    return null;
  }
  const masks = [0];
  for (let t = 1; t <= lastTank; t += 1) {
    const carry = contents.map((value, e) => Math.max(0, value - usage[t - 1][e]));
    let must = 0;
    for (const e of EGG_INDICES) {
      if (usage[t][e] > carry[e] + ctx.tolerance) {
        must |= 1 << e;
      }
    }
    if (!must) {
      masks.push(0);
      contents = carry;
      continue;
    }
    const levels = usage[t].slice();
    if (!fitsCapacity(refillFootprint(levels, must, ctx), ctx)) {
      return null;
    }
    masks.push(must);
    contents = extend(t, levels, must, carry);
  }
  return masks;
}

function allRefillMasks(usage: Fuel4[]): number[] {
  return usage.map((tank, t) => (t === 0 ? 0 : fuelMask(tank)));
}

/**
 * Refill sets for tanks in a fixed order that replay with drains on whole steps. The relaxed DP
 * is a lower bound, so its sets are optimal whenever they replay; otherwise the stepped DP's, then
 * the greedy walk's, then refilling every egg a tank burns.
 */
function planRefills(usage: Fuel4[], ctx: PackContext, budget: DpBudget): number[] | null {
  const relaxed = planRefillsExact(usage, ctx, budget);
  if (relaxed === null) {
    // Not even the relaxation fits.
    return null;
  }
  const replays = (masks: number[] | null | undefined): masks is number[] =>
    !!masks && realizeUsage(usage, masks, ctx, true) !== null;
  if (replays(relaxed)) {
    return relaxed;
  }
  if (relaxed) {
    const stepped = planRefillsExact(usage, ctx, budget, true);
    if (replays(stepped)) {
      return stepped;
    }
  }
  const greedy = planRefillsGreedy(usage, ctx);
  if (replays(greedy)) {
    return greedy;
  }
  const allRefill = allRefillMasks(usage);
  return usage.every((tank, t) => tankFitsAlone(tank, t, ctx)) && replays(allRefill) ? allRefill : null;
}

// ---------------------------------------------------------------------------
// Turning a packing into concrete tanks
// ---------------------------------------------------------------------------

/**
 * Ideal initial tank: what the tanks burn until each egg's first refill, plus
 * as much of that first refill's share as still fits, so later loops add less.
 * Without `withExtra` it is only the first part.
 */
function planIdealFill(masks: number[], demand: Fuel4[], ctx: PackContext, withExtra = true): Fuel4 | null {
  const fill = demand[0].slice();
  if (!initialTankHolds(fill, ctx)) {
    return null;
  }
  const adjusted = demand.map((needs) => needs.slice());
  const firstRefill = EGG_INDICES.map((e) => {
    for (let t = 1; t < masks.length; t += 1) {
      if (hasEgg(masks[t], e)) {
        return t;
      }
    }
    return -1;
  });
  const candidates = withExtra
    ? EGG_INDICES.filter((e) => firstRefill[e] > 0).sort(
        (a, b) => demand[firstRefill[a]][a] - demand[firstRefill[b]][b] || a - b
      )
    : [];
  // The extra is optional, so it is sized against the tank to the egg rather than within the
  // noise tolerance: a fill-to target never asks for more than the tank takes.
  const exactTank: PackContext = { ...ctx, tolerance: FUEL_TOLERANCE_MIN_EGGS };
  for (const e of candidates) {
    const refillTank = firstRefill[e];
    const fits = (extra: number) => {
      const trial = fill.slice();
      trial[e] += extra;
      if (!initialTankHolds(trial, exactTank)) {
        return false;
      }
      for (let t = 1; t < refillTank; t += 1) {
        const needs = adjusted[t].slice();
        needs[e] += extra;
        if (masks[t] && !fitsCapacity(refillFootprint(needs, masks[t], exactTank), exactTank)) {
          return false;
        }
      }
      return true;
    };
    const maxExtra = demand[refillTank][e];
    let extra = 0;
    if (fits(maxExtra)) {
      extra = maxExtra;
    } else {
      let lo = 0;
      let hi = maxExtra;
      for (let step = 0; step < IDEAL_EXTRA_SEARCH_STEPS && hi - lo > FUEL_TOLERANCE_MIN_EGGS; step += 1) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      extra = Math.floor(lo);
    }
    if (extra <= ctx.tolerance) {
      continue;
    }
    fill[e] += extra;
    for (let t = 1; t < refillTank; t += 1) {
      adjusted[t][e] += extra;
    }
  }
  // The extra is optional: trim it to what the egg's limit slider gives, so the fill-to target is
  // never above the slider (the slider epsilon is in percent, worth thousands of eggs on a big tank).
  return fill.map((value, e) => Math.max(demand[0][e], Math.min(value, limitPctFor(value, ctx) * ctx.pct)));
}

/** Fill eggs in route order the way the game does: up to the limit slider or until the tank is full. */
function applyFill(levels: Fuel4, fillTo: Fuel4, refillMask: number, ctx: PackContext): Fuel4 {
  const result = levels.slice();
  for (const e of EGG_INDICES) {
    if (!hasEgg(refillMask, e)) {
      continue;
    }
    const others = sumFuel(result) - result[e];
    const target = limitPctFor(fillTo[e], ctx) * ctx.pct;
    result[e] = Math.max(result[e], Math.min(target, ctx.capacity - others));
  }
  return result;
}

/**
 * The ideal fill leaving as it is every egg that already holds what the plan needs without being
 * above its step level: no shift to top it up. Filling from empty puts every egg on a step, so the
 * other eggs are filled again around what stays, and every egg drained must still land on a step
 * (or empty). Null when no egg stays below its step, or when a drain would land between steps.
 */
function keepCoveredIdealStart(stepStart: Fuel4, fillTo: Fuel4, fillMask: number, ctx: PackContext): Fuel4 | null {
  const tol = ctx.tolerance;
  let keptMask = 0;
  let belowStep = false;
  for (const e of EGG_INDICES) {
    if (hasEgg(fillMask, e) && ctx.current[e] >= fillTo[e] - tol && ctx.current[e] <= stepStart[e] + tol) {
      keptMask |= 1 << e;
      belowStep = belowStep || ctx.current[e] < stepStart[e] - tol;
    }
  }
  if (!belowStep) {
    return null;
  }
  const base = EGG_INDICES.map((e) => (hasEgg(keptMask, e) ? ctx.current[e] : 0));
  const start = applyFill(base, fillTo, fillMask & ~keptMask, ctx);
  for (const e of EGG_INDICES) {
    if (hasEgg(keptMask, e)) {
      continue;
    }
    if (start[e] < fillTo[e] - tol) {
      return null;
    }
    if (ctx.current[e] > start[e] + tol && start[e] > tol && Math.abs(stepAtOrBelow(start[e], ctx) - start[e]) > tol) {
      return null;
    }
  }
  return start;
}

/**
 * Ideal mode: the plan is sized as if the initial tank filled from empty, which tops every egg up to
 * its limit step. An egg in the tank that already covers what the plan needs is left alone instead
 * when the tanks still replay with no more shifts or loops: one shift less in the first fill.
 */
function keepCoveredIdealEggs(prepared: PreparedPack, realized: Realized): Realized {
  const { ctx, input } = prepared;
  if (ctx.mode !== "ideal" || !input.currentContents || realized.tanks.length === 0) {
    return realized;
  }
  // As a page shows the first fill: a shift to each egg that starts above what it holds now, then home.
  const firstFillShifts = (start: Fuel4) => {
    const eggs = EGG_INDICES.filter((e) => start[e] > ctx.current[e] + ctx.tolerance).length;
    return eggs > 0 ? eggs + 1 : 0;
  };
  const shiftsBefore = firstFillShifts(realized.tanks[0].start);
  if (shiftsBefore === 0) {
    return realized;
  }
  const usage = realized.tanks.map((tank) => tank.usage);
  const masks = realized.tanks.map((tank) => tank.refillMask);
  for (const option of REALIZE_OPTIONS_IDEAL) {
    const result = simulateTanks(usage, masks, ctx, { ...option, keepCovered: true });
    if (result.kind !== "ok") {
      continue;
    }
    const { simulated } = result;
    if (
      simulated.tanks.length !== realized.tanks.length ||
      simulated.shifts > realized.shifts ||
      simulated.loops > realized.loops ||
      firstFillShifts(simulated.tanks[0].start) >= shiftsBefore
    ) {
      continue;
    }
    const { shifts, loops, addedFuel } = simulated;
    return {
      tanks: simulated.tanks.map((tank, index) => ({ ...tank, counts: realized.tanks[index].counts })),
      shifts,
      loops,
      cost: shifts * COST_SHIFT + loops * COST_LOOP + (ctx.capacity > 0 ? addedFuel / ctx.capacity : 0),
      idealFillTo: simulated.idealFillTo,
    };
  }
  return realized;
}

/**
 * How a loop drains. "asNeeded": only to make room for the refill, losing as little fuel as the
 * steps allow. "everything": every carried egg down to the lowest step that still covers what it
 * needs, room or not. That loses more fuel and adds drain steps, but leaves every later tank as
 * little as it can carry, so it can replay refill sets the first one cannot.
 */
type DrainPolicy = "asNeeded" | "everything";

/**
 * `keepCovered` (ideal mode): leave alone an egg that already holds what the plan needs, rather
 * than topping it up to its limit step (see keepCoveredIdealStart).
 */
type RealizeOption = { drains: DrainPolicy; idealExtra: boolean; keepCovered?: boolean };

const REALIZE_OPTIONS_CURRENT: RealizeOption[] = [
  { drains: "asNeeded", idealExtra: true },
  { drains: "everything", idealExtra: true },
];
/** An ideal fill's optional extra can leave a later loop more to drain than the steps allow. */
const REALIZE_OPTIONS_IDEAL: RealizeOption[] = [
  ...REALIZE_OPTIONS_CURRENT,
  { drains: "asNeeded", idealExtra: false },
  { drains: "everything", idealExtra: false },
];
/** To only check that refill sets replay: sizing the ideal fill's extra is the slow part, so skip it first. */
const CHECK_OPTIONS_IDEAL: RealizeOption[] = [...REALIZE_OPTIONS_IDEAL.slice(2), ...REALIZE_OPTIONS_CURRENT];

type LoopPlan = {
  /** Eggs refilled. */
  mask: number;
  /** Levels once drained, before the refill. */
  before: Fuel4;
  drain: Fuel4;
};

/**
 * Drains before a refuel loop. A carried egg is drained to a whole step (or empty): the highest one
 * that frees enough room, which may drain a little more than needed, and never below the lowest step
 * that still covers what it needs until its next refill. Among the eggs with a surplus, the drains
 * that lose the least fuel win (then the fewest drain steps).
 *
 * With `refillLast`, the route's last egg is in the loop although its carry covers its need (the
 * refill set counts it at its need, and no step between its need and its room exists): it is drained
 * to the step below its room and fills back up until the tank is full.
 */
function planLoopDrains(
  carry: Fuel4,
  need: Fuel4,
  mask: number,
  ctx: PackContext,
  policy: DrainPolicy,
  refillLast = false
): LoopPlan | null {
  const tol = ctx.tolerance;
  const before = carry.slice();
  const drain = zeroFuel();
  const lowest = EGG_INDICES.map((e) => stepAtOrAbove(need[e], ctx));
  const drainable = EGG_INDICES.filter((e) => !hasEgg(mask, e) && lowest[e] < carry[e] - tol);
  const contents = () => EGG_INDICES.map((e) => (hasEgg(mask, e) ? need[e] : before[e]));

  if (policy === "everything") {
    for (const e of drainable) {
      before[e] = lowest[e];
      drain[e] = carry[e] - lowest[e];
    }
  }
  const excess = refillFootprint(contents(), mask, ctx) - ctx.capacity;
  if (excess > tol) {
    if (policy === "everything") {
      return null;
    }
    let best: { levels: Fuel4; drain: Fuel4; total: number; eggs: number } | null = null;
    // Biggest surplus first breaks ties between equally lossy drains.
    const ordered = drainable.slice().sort((a, b) => carry[b] - lowest[b] - (carry[a] - lowest[a]) || a - b);
    for (const order of permutations(ordered)) {
      let rest = excess;
      const levels = carry.slice();
      const drained = zeroFuel();
      for (const e of order) {
        if (rest <= tol) {
          break;
        }
        const level = Math.max(lowest[e], stepAtOrBelow(carry[e] - rest, ctx));
        if (level >= carry[e] - tol) {
          continue;
        }
        levels[e] = level;
        drained[e] = carry[e] - level;
        rest -= drained[e];
      }
      if (rest > tol) {
        continue;
      }
      const total = sumFuel(drained);
      const eggs = popcount(fuelMask(drained));
      if (!best || total < best.total - tol || (total <= best.total + tol && eggs < best.eggs)) {
        best = { levels, drain: drained, total, eggs };
      }
    }
    if (!best) {
      return null;
    }
    for (const e of EGG_INDICES) {
      before[e] = best.levels[e];
      drain[e] = best.drain[e];
    }
  }

  if (refillLast) {
    const last = highestEgg(mask);
    const others = EGG_INDICES.reduce(
      (sum, e) => (e === last ? sum : sum + (hasEgg(mask, e) ? roundUpToLimit(need[e], ctx) : before[e])),
      0
    );
    const room = ctx.capacity - others;
    if (carry[last] > room + tol) {
      before[last] = stepAtOrBelow(room, ctx);
      drain[last] = carry[last] - before[last];
    }
  }
  return { mask, before, drain };
}

type SimulatedTank = { usage: Fuel4; start: Fuel4; refillMask: number; fillTo: Fuel4; add: Fuel4; drain: Fuel4 };
type Simulated = { tanks: SimulatedTank[]; shifts: number; loops: number; addedFuel: number; idealFillTo: Fuel4 | null };
type SimulateResult = { kind: "ok"; simulated: Simulated } | { kind: "merge"; tank: number } | { kind: "invalid" };

/**
 * Replay tanks in order the way the game plays them: carry the leftover, drain on whole steps,
 * refill each egg of the loop that runs short up to its limit slider (or until the tank is full).
 * An egg the carry already covers is left out of its loop, and a loop left with no eggs is merged
 * into the tank before it.
 */
function simulateTanks(usage: Fuel4[], masks: number[], ctx: PackContext, option: RealizeOption): SimulateResult {
  const lastTank = usage.length - 1;
  const demand = segmentDemands(usage, masks);
  let idealFillTo: Fuel4 | null = null;
  let start: Fuel4;
  if (ctx.mode === "current") {
    start = ctx.current.slice();
  } else {
    idealFillTo = planIdealFill(masks, demand, ctx, option.idealExtra);
    if (!idealFillTo) {
      return { kind: "invalid" };
    }
    // Filled from empty, every egg lands on a step (the last one where the tank is full), so an
    // egg that holds more now is drained to a step.
    const fillMask = fuelMask(idealFillTo, ctx.tolerance);
    start = applyFill(zeroFuel(), idealFillTo, fillMask, ctx);
    if (option.keepCovered) {
      const kept = keepCoveredIdealStart(start, idealFillTo, fillMask, ctx);
      if (!kept) {
        return { kind: "invalid" };
      }
      start = kept;
    }
  }
  if (EGG_INDICES.some((e) => usage[0][e] > start[e] + ctx.tolerance)) {
    return { kind: "invalid" };
  }
  const tanks: SimulatedTank[] = [
    { usage: usage[0], start, refillMask: 0, fillTo: zeroFuel(), add: zeroFuel(), drain: zeroFuel() },
  ];
  let addedFuel = 0;

  for (let t = 1; t <= lastTank; t += 1) {
    const previous = tanks[t - 1];
    const carry = previous.start.map((value, e) => value - previous.usage[e]);
    if (carry.some((value) => value < -ctx.tolerance)) {
      return { kind: "invalid" };
    }
    for (const e of EGG_INDICES) {
      carry[e] = Math.max(0, carry[e]);
    }
    let mask = 0;
    for (const e of EGG_INDICES) {
      if (hasEgg(masks[t], e) && carry[e] < demand[t][e] - ctx.tolerance) {
        mask |= 1 << e;
      }
    }
    if (!mask) {
      return { kind: "merge", tank: t };
    }

    let loop = planLoopDrains(carry, demand[t], mask, ctx, option.drains);
    const last = highestEgg(masks[t]);
    if (!loop && !hasEgg(mask, last)) {
      loop = planLoopDrains(carry, demand[t], mask | (1 << last), ctx, option.drains, true);
    }
    if (!loop) {
      return { kind: "invalid" };
    }
    const { mask: refillMask, before, drain } = loop;
    const fillTo = EGG_INDICES.map((e) => (hasEgg(refillMask, e) ? demand[t][e] : 0));
    const levels = applyFill(before, fillTo, refillMask, ctx);
    if (EGG_INDICES.some((e) => hasEgg(refillMask, e) && levels[e] < fillTo[e] - ctx.tolerance)) {
      return { kind: "invalid" };
    }
    if (EGG_INDICES.some((e) => usage[t][e] > levels[e] + ctx.tolerance)) {
      return { kind: "invalid" };
    }
    const add = EGG_INDICES.map((e) => (hasEgg(refillMask, e) ? Math.max(0, fillTo[e] - before[e]) : 0));
    addedFuel += sumFuel(add);
    tanks.push({ usage: usage[t], start: levels, refillMask, fillTo, add, drain });
  }

  const { shifts, loops } = refillCost(tanks.map((tank) => tank.refillMask));
  return { kind: "ok", simulated: { tanks, shifts, loops, addedFuel, idealFillTo } };
}

type UsageRealization = {
  simulated: Simulated;
  /** Tanks of the input that each replayed tank merges, in order. */
  merged: number[][];
};

/** Replay a refill plan, merging tanks that need no loop; tries the drain policies in turn. */
function realizeUsage(usage: Fuel4[], masks: number[], ctx: PackContext, checkOnly = false): UsageRealization | null {
  const options = ctx.mode === "ideal" ? (checkOnly ? CHECK_OPTIONS_IDEAL : REALIZE_OPTIONS_IDEAL) : REALIZE_OPTIONS_CURRENT;
  for (const option of options) {
    let tanks = usage.map((tank) => tank.slice());
    let tankMasks = masks.slice();
    let merged = usage.map((_, t) => [t]);
    for (let attempt = 0; attempt <= usage.length; attempt += 1) {
      const result = simulateTanks(tanks, tankMasks, ctx, option);
      if (result.kind === "ok") {
        return { simulated: result.simulated, merged };
      }
      if (result.kind === "invalid") {
        break;
      }
      const t = result.tank;
      tanks = [...tanks.slice(0, t - 1), tanks[t - 1].map((value, e) => value + tanks[t][e]), ...tanks.slice(t + 1)];
      tankMasks = [...tankMasks.slice(0, t), ...tankMasks.slice(t + 1)];
      merged = [...merged.slice(0, t - 1), [...merged[t - 1], ...merged[t]], ...merged.slice(t + 1)];
    }
  }
  return null;
}

/** Pick refill sets for the packing and turn it into concrete tanks, merging tanks that need no refill. */
function realizeAssignment(prepared: PreparedPack, assignment: Assignment, masksHint?: number[]): Realized | null {
  const { ctx, groups } = prepared;
  const usage = assignment.map((tank) => tankUsage(tank, groups));
  const masks = masksHint && masksHint.length === assignment.length
    ? masksHint.slice()
    : planRefills(usage, ctx, { states: HEURISTIC_DP_STATE_BUDGET });
  if (!masks) {
    return null;
  }
  const realization = realizeUsage(usage, masks, ctx);
  if (!realization) {
    return null;
  }
  const { simulated, merged } = realization;
  const tanks: TankState[] = simulated.tanks.map((tank, index) => ({
    counts: groups.map((group) => merged[index].reduce((sum, t) => sum + (assignment[t][group.index] || 0), 0)),
    usage: tank.usage,
    start: tank.start,
    refillMask: tank.refillMask,
    fillTo: tank.fillTo,
    add: tank.add,
    drain: tank.drain,
  }));
  const { shifts, loops, addedFuel } = simulated;
  const cost = shifts * COST_SHIFT + loops * COST_LOOP + (ctx.capacity > 0 ? addedFuel / ctx.capacity : 0);
  return { tanks, shifts, loops, cost, idealFillTo: simulated.idealFillTo };
}

function realizeWithFallback(prepared: PreparedPack, assignment: Assignment): Realized | null {
  const realized = realizeAssignment(prepared, assignment);
  if (realized) {
    return realized;
  }
  // Refilling every egg a tank burns always replays for tanks that fit on their own (a route's last
  // egg the carry covers is drained below its room and refilled).
  const usage = assignment.map((tank) => tankUsage(tank, prepared.groups));
  return realizeAssignment(prepared, assignment, allRefillMasks(usage));
}

// ---------------------------------------------------------------------------
// Heuristic packing
// ---------------------------------------------------------------------------

function emptyTank(prepared: PreparedPack): number[] {
  return new Array(prepared.groups.length).fill(0);
}

/** Most launches of a group that fit on top of a tank (binary search; fit is monotone). */
function maxAddable(prepared: PreparedPack, counts: number[], group: PackGroup, tankIndex: number, limit: number): number {
  if (limit <= 0) {
    return 0;
  }
  const base = tankUsage(counts, prepared.groups);
  const fits = (launches: number) =>
    tankFitsAlone(base.map((value, e) => value + group.fuel[e] * launches), tankIndex, prepared.ctx);
  if (!fits(1)) {
    return 0;
  }
  let lo = 1;
  let hi = Math.min(limit, tankIndex === 0 ? group.maxInInitialTank : group.maxPerRefillTank);
  if (hi <= lo) {
    return lo;
  }
  if (fits(hi)) {
    return hi;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

type Bin = { mask: number; counts: number[] };

function binCost(mask: number): number {
  return popcount(mask) + 1;
}

/**
 * First-fit decreasing into bins of one egg set each, bigger egg sets first;
 * then merge bins whose union saves shifts and absorb small bins into others.
 */
function packTypedBins(prepared: PreparedPack, phaseGroups: PackGroup[], remaining: number[]): number[][] {
  const bins: Bin[] = [];
  const pending = phaseGroups.filter((group) => remaining[group.index] > 0);
  const classFuel = new Map<number, number>();
  for (const group of pending) {
    classFuel.set(group.mask, (classFuel.get(group.mask) || 0) + group.size * remaining[group.index]);
  }
  const classes = Array.from(classFuel.keys()).sort(
    (a, b) => popcount(b) - popcount(a) || (classFuel.get(b) || 0) - (classFuel.get(a) || 0) || a - b
  );
  for (const mask of classes) {
    const classGroups = pending.filter((group) => group.mask === mask).sort((a, b) => b.size - a.size || a.index - b.index);
    for (const group of classGroups) {
      while (remaining[group.index] > 0) {
        let placed = false;
        for (const bin of bins) {
          if (bin.mask !== mask) {
            continue;
          }
          const launches = maxAddable(prepared, bin.counts, group, 1, remaining[group.index]);
          if (launches > 0) {
            bin.counts[group.index] += launches;
            remaining[group.index] -= launches;
            placed = true;
            if (remaining[group.index] <= 0) {
              break;
            }
          }
        }
        if (!placed) {
          bins.push({ mask, counts: emptyTank(prepared) });
        }
      }
    }
  }

  const usageOf = (bin: Bin) => tankUsage(bin.counts, prepared.groups);
  for (;;) {
    let best: { i: number; j: number; saving: number; fill: number } | null = null;
    for (let i = 0; i < bins.length; i += 1) {
      for (let j = i + 1; j < bins.length; j += 1) {
        const usage = usageOf(bins[i]).map((value, e) => value + usageOf(bins[j])[e]);
        if (!tankFitsAlone(usage, 1, prepared.ctx)) {
          continue;
        }
        const saving = binCost(bins[i].mask) + binCost(bins[j].mask) - binCost(bins[i].mask | bins[j].mask);
        const fill = sumFuel(usage);
        if (!best || saving > best.saving || (saving === best.saving && fill > best.fill)) {
          best = { i, j, saving, fill };
        }
      }
    }
    if (!best) {
      break;
    }
    const target = bins[best.i];
    const source = bins[best.j];
    target.mask |= source.mask;
    target.counts = target.counts.map((value, g) => value + source.counts[g]);
    bins.splice(best.j, 1);
  }

  // Empty small bins into the spare room of the others while that saves shifts.
  const absorbSmallestBin = (): boolean => {
    const bySize = bins.slice().sort((a, b) => sumFuel(usageOf(a)) - sumFuel(usageOf(b)));
    for (const victim of bySize) {
      const others = bins.filter((bin) => bin !== victim).map((bin) => ({ mask: bin.mask, counts: bin.counts.slice() }));
      const victimGroups = prepared.groups
        .filter((group) => victim.counts[group.index] > 0)
        .sort((a, b) => b.size - a.size);
      const absorbed = others.length > 0 && victimGroups.every((group) => {
        let left = victim.counts[group.index];
        const targets = others
          .map((bin, order) => ({ bin, order, growth: popcount(group.mask & ~bin.mask) }))
          .sort((a, b) => a.growth - b.growth || a.order - b.order);
        for (const { bin } of targets) {
          const launches = maxAddable(prepared, bin.counts, group, 1, left);
          if (launches > 0) {
            bin.counts[group.index] += launches;
            bin.mask |= group.mask;
            left -= launches;
          }
          if (left <= 0) {
            break;
          }
        }
        return left <= 0;
      });
      const before = bins.reduce((sum, bin) => sum + binCost(bin.mask), 0);
      const after = others.reduce((sum, bin) => sum + binCost(bin.mask), 0);
      if (absorbed && after < before) {
        bins.splice(0, bins.length, ...others);
        return true;
      }
    }
    return false;
  };
  while (absorbSmallestBin()) {
    // Each pass removes a bin.
  }

  // Fullest bins first so the next phase can top up the last one.
  return bins
    .map((bin) => bin.counts)
    .sort((a, b) => sumFuel(tankUsage(b, prepared.groups)) - sumFuel(tankUsage(a, prepared.groups)));
}

function constructAssignment(prepared: PreparedPack, compare: (a: PackGroup, b: PackGroup) => number): Assignment {
  const remaining = prepared.groups.map((group) => group.launches);
  const tanks: Assignment = [emptyTank(prepared)];
  let boundary = 0;
  for (const phase of prepared.phases) {
    const phaseGroups = prepared.groups.filter((group) => group.phase === phase).sort(compare);
    for (const group of phaseGroups) {
      const launches = maxAddable(prepared, tanks[boundary], group, boundary, remaining[group.index]);
      tanks[boundary][group.index] += launches;
      remaining[group.index] -= launches;
    }
    const bins = packTypedBins(prepared, phaseGroups, remaining);
    if (bins.length > 0) {
      tanks.push(...bins);
      boundary = tanks.length - 1;
    }
  }
  return tanks;
}

/** Orders to try when filling the initial tank (and topping up phase boundaries). */
function constructionStrategies(prepared: PreparedPack): Array<(a: PackGroup, b: PackGroup) => number> {
  const { groups, ctx } = prepared;
  const rareEggs = (1 << EGGS.indexOf("resilience")) | (1 << EGGS.indexOf("integrity"));
  const eggUsers = EGG_INDICES.map((e) => groups.filter((group) => hasEgg(group.mask, e)).length);
  const rarity = (group: PackGroup) =>
    EGG_INDICES.reduce((sum, e) => sum + (hasEgg(group.mask, e) ? 1 / Math.max(1, eggUsers[e]) : 0), 0);
  const coverage = (group: PackGroup) =>
    Math.min(...EGG_INDICES.filter((e) => group.fuel[e] > 0).map((e) => ctx.current[e] / (group.fuel[e] * group.launches)));
  const byIndex = (a: PackGroup, b: PackGroup) => a.index - b.index;
  const strategies: Array<(a: PackGroup, b: PackGroup) => number> = [
    // Resilience and Integrity feed the fewest ships, so they are the costliest eggs to refill later.
    (a, b) => popcount(b.mask & rareEggs) - popcount(a.mask & rareEggs) || b.size - a.size || byIndex(a, b),
    (a, b) => b.size - a.size || byIndex(a, b),
    (a, b) => rarity(b) - rarity(a) || b.size - a.size || byIndex(a, b),
    (a, b) => a.size - b.size || byIndex(a, b),
  ];
  if (ctx.mode === "current") {
    strategies.push((a, b) => coverage(b) - coverage(a) || b.size - a.size || byIndex(a, b));
  }
  return strategies;
}

function precedenceValid(prepared: PreparedPack, tanks: Assignment): boolean {
  if (prepared.phases.length <= 1) {
    return true;
  }
  let maxBefore = -1;
  for (const phase of prepared.phases) {
    let minTank = Number.POSITIVE_INFINITY;
    let maxTank = -1;
    for (let t = 0; t < tanks.length; t += 1) {
      if (prepared.groups.some((group) => group.phase === phase && tanks[t][group.index] > 0)) {
        minTank = Math.min(minTank, t);
        maxTank = Math.max(maxTank, t);
      }
    }
    if (maxTank < 0) {
      continue;
    }
    if (minTank < maxBefore) {
      return false;
    }
    maxBefore = Math.max(maxBefore, maxTank);
  }
  return true;
}

function evaluateAssignment(prepared: PreparedPack, tanks: Assignment, budget: SearchBudget): Evaluation | null {
  const key = tanks.map((tank) => tank.join(",")).join("|");
  const cached = budget.cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const evaluation = evaluateUncached(prepared, tanks, budget);
  budget.cache.set(key, evaluation);
  return evaluation;
}

function evaluateUncached(prepared: PreparedPack, tanks: Assignment, budget: SearchBudget): Evaluation | null {
  budget.evaluations -= 1;
  const usage = tanks.map((tank) => tankUsage(tank, prepared.groups));
  const masks = planRefills(usage, prepared.ctx, budget);
  if (!masks) {
    return null;
  }
  const { shifts, loops } = refillCost(masks);
  // Tie-break: burn more of the initial tank (free fuel) and less from refills.
  const total = sumFuel(prepared.totalFuel);
  const refilledShare = total > 0 ? usage.slice(1).reduce((sum, tank) => sum + sumFuel(tank), 0) / total : 0;
  return { cost: shifts * COST_SHIFT + loops * COST_LOOP + refilledShare * 100, shifts, loops, masks };
}

/** Merge tanks the refill plan does not refill into the tank before, and drop empty refill tanks. */
function compactAssignment(tanks: Assignment, masks: number[]): Assignment {
  const compacted: Assignment = [tanks[0].slice()];
  for (let t = 1; t < tanks.length; t += 1) {
    if (!masks[t] || tanks[t].every((value) => value === 0)) {
      const last = compacted[compacted.length - 1];
      tanks[t].forEach((value, g) => {
        last[g] += value;
      });
    } else {
      compacted.push(tanks[t].slice());
    }
  }
  return compacted;
}

function withoutEmptyRefillTanks(tanks: Assignment): Assignment {
  return tanks.filter((tank, t) => t === 0 || tank.some((value) => value > 0));
}

/** Cheap necessary condition before running the refill DP. */
function tanksRoughlyFit(prepared: PreparedPack, tanks: Assignment, changed?: number[]): boolean {
  const { ctx, groups } = prepared;
  return (changed ?? tanks.map((_, t) => t)).every((t) => {
    const usage = tankUsage(tanks[t], groups);
    return t === 0 && ctx.mode === "current" ? tankFitsAlone(usage, 0, ctx) : fitsCapacity(sumFuel(usage), ctx);
  });
}

type Scored = { tanks: Assignment; evaluation: Evaluation };

function scoreAssignment(prepared: PreparedPack, tanks: Assignment, budget: SearchBudget): Scored | null {
  const evaluation = evaluateAssignment(prepared, tanks, budget);
  if (!evaluation) {
    return null;
  }
  const compacted = compactAssignment(tanks, evaluation.masks);
  if (compacted.length === tanks.length) {
    return { tanks: compacted, evaluation };
  }
  const recompacted = evaluateAssignment(prepared, compacted, budget);
  return { tanks: compacted, evaluation: recompacted || evaluation };
}

/**
 * First-improvement local search, scored by the exact refill DP: move a
 * group's launches (all, half or one) to another tank or a new one, swap
 * single launches between tanks, and swap neighbouring refill tanks. The
 * quick pass (inside iterated-search rounds) skips half moves and swaps.
 */
function improveAssignment(prepared: PreparedPack, start: Scored, budget: SearchBudget, thorough = true): Scored {
  const { groups } = prepared;
  let current = start;

  function* candidates(tanks: Assignment): Generator<{ tanks: Assignment; changed: number[] }> {
    const count = tanks.length;
    for (let from = 0; from < count; from += 1) {
      for (const group of groups) {
        const available = tanks[from][group.index];
        if (available <= 0) {
          continue;
        }
        const amounts = Array.from(new Set(thorough ? [available, Math.ceil(available / 2), 1] : [available, 1]));
        for (let to = 0; to < count; to += 1) {
          if (to === from) {
            continue;
          }
          for (const amount of amounts) {
            const next = tanks.map((tank) => tank.slice());
            next[from][group.index] -= amount;
            next[to][group.index] += amount;
            yield { tanks: next, changed: [to] };
          }
        }
        for (const position of Array.from(new Set(thorough ? [Math.max(1, from + 1), count] : [count]))) {
          for (const amount of amounts) {
            const next = tanks.map((tank) => tank.slice());
            next[from][group.index] -= amount;
            const added = emptyTank(prepared);
            added[group.index] = amount;
            next.splice(position, 0, added);
            yield { tanks: next, changed: [position] };
          }
        }
      }
    }
    for (let a = 0; thorough && a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        for (const g of groups) {
          if (tanks[a][g.index] <= 0) {
            continue;
          }
          for (const h of groups) {
            if (h.index === g.index || tanks[b][h.index] <= 0) {
              continue;
            }
            const next = tanks.map((tank) => tank.slice());
            next[a][g.index] -= 1;
            next[b][g.index] += 1;
            next[b][h.index] -= 1;
            next[a][h.index] += 1;
            yield { tanks: next, changed: [a, b] };
          }
        }
      }
    }
    for (let t = 1; t + 1 < count; t += 1) {
      const next = tanks.map((tank) => tank.slice());
      [next[t], next[t + 1]] = [next[t + 1], next[t]];
      yield { tanks: next, changed: [] };
    }
  }

  let improved = true;
  while (improved && budget.evaluations > 0 && budget.states > 0) {
    improved = false;
    for (const candidate of candidates(current.tanks)) {
      const tanks = withoutEmptyRefillTanks(candidate.tanks);
      const changed = candidate.changed.filter((t) => t < tanks.length);
      if (!tanksRoughlyFit(prepared, tanks, changed) || !precedenceValid(prepared, tanks)) {
        continue;
      }
      const scored = scoreAssignment(prepared, tanks, budget);
      if (scored && scored.evaluation.cost < current.evaluation.cost - 1e-9) {
        current = scored;
        improved = true;
        break;
      }
      if (budget.evaluations <= 0 || budget.states <= 0) {
        break;
      }
    }
  }
  return current;
}

/** Deterministic PRNG (mulberry32) so the same input always packs the same way. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kick a packing: move a few random slices of launches, sometimes into a new tank. */
function perturbAssignment(prepared: PreparedPack, tanks: Assignment, random: () => number): Assignment | null {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let next = tanks.map((tank) => tank.slice());
    const kicks = 1 + Math.floor(random() * 3);
    for (let kick = 0; kick < kicks; kick += 1) {
      const sources: Array<[number, number]> = [];
      next.forEach((tank, t) => tank.forEach((value, g) => {
        if (value > 0) {
          sources.push([t, g]);
        }
      }));
      if (sources.length === 0) {
        break;
      }
      let [from, g] = sources[Math.floor(random() * sources.length)];
      const amount = 1 + Math.floor(random() * next[from][g]);
      let to: number;
      if (random() < 0.3) {
        to = 1 + Math.floor(random() * next.length);
        next.splice(to, 0, emptyTank(prepared));
        if (to <= from) {
          from += 1;
        }
      } else {
        to = Math.floor(random() * (next.length - 1));
        if (to >= from) {
          to += 1;
        }
      }
      if (to === from || to >= next.length) {
        continue;
      }
      next[from][g] -= amount;
      next[to][g] += amount;
    }
    next = withoutEmptyRefillTanks(next);
    if (tanksRoughlyFit(prepared, next) && precedenceValid(prepared, next)) {
      return next;
    }
  }
  return null;
}

/**
 * Heuristic packing: a few constructions (FFD into per-egg-set bins, merged
 * where the union saves shifts), then iterated local search from the best.
 */
function searchHeuristicAssignment(prepared: PreparedPack): Scored {
  if (prepared.groups.length === 0) {
    return { tanks: [emptyTank(prepared)], evaluation: { cost: 0, shifts: 0, loops: 0, masks: [0] } };
  }
  const budget: SearchBudget = {
    states: HEURISTIC_DP_STATE_BUDGET,
    evaluations: HEURISTIC_EVALUATION_BUDGET,
    cache: new Map(),
  };
  let constructed: Scored | null = null;
  for (const strategy of constructionStrategies(prepared)) {
    const scored = scoreAssignment(prepared, constructAssignment(prepared, strategy), budget);
    if (scored && (!constructed || scored.evaluation.cost < constructed.evaluation.cost)) {
      constructed = scored;
    }
  }
  if (!constructed) {
    // Construction only makes tanks that fit alone, so refilling every egg always works.
    const tanks = constructAssignment(prepared, (a, b) => a.index - b.index);
    const masks = allRefillMasks(tanks.map((tank) => tankUsage(tank, prepared.groups)));
    const { shifts, loops } = refillCost(masks);
    return { tanks, evaluation: { cost: shifts * COST_SHIFT + loops * COST_LOOP, shifts, loops, masks } };
  }

  let current = improveAssignment(prepared, constructed, budget);
  let best = current;
  let sinceBest = 0;
  const random = seededRandom(0x5eed1e55);
  for (let round = 0; round < ILS_ROUNDS && budget.evaluations > 0 && budget.states > 0; round += 1) {
    if (best.evaluation.shifts === 0) {
      break;
    }
    const kicked = perturbAssignment(prepared, current.tanks, random);
    const scored = kicked ? scoreAssignment(prepared, kicked, budget) : null;
    if (!scored) {
      continue;
    }
    const candidate = improveAssignment(prepared, scored, budget, false);
    if (candidate.evaluation.cost < best.evaluation.cost - 1e-9) {
      best = candidate;
      sinceBest = 0;
    } else {
      sinceBest += 1;
    }
    // Take sideways (and now and then slightly worse) packings to get across plateaus.
    if (
      candidate.evaluation.cost <= current.evaluation.cost + 1e-9 ||
      (random() < 0.2 && candidate.evaluation.shifts <= best.evaluation.shifts + 1)
    ) {
      current = candidate;
    }
    if (sinceBest > 0 && sinceBest % ILS_RESTART_AFTER === 0) {
      current = best;
    }
  }
  // Full neighbourhood on the best packing, with its own allowance even if the rounds used theirs up.
  return improveAssignment(prepared, best, {
    ...budget,
    evaluations: Math.max(budget.evaluations, FINAL_POLISH_EVALUATIONS),
    states: Math.max(budget.states, FINAL_POLISH_DP_STATES),
  });
}

// ---------------------------------------------------------------------------
// Exact packing (MILP)
// ---------------------------------------------------------------------------

function formatLpNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`invalid LP coefficient: ${value}`);
  }
  const normalized = Math.abs(value) < 1e-12 ? 0 : value;
  if (Number.isInteger(normalized)) {
    return String(normalized);
  }
  return normalized.toFixed(12).replace(/\.?0+$/, "");
}

type LpTerm = { coefficient: number; variable: string };

function formatLinearExpression(terms: LpTerm[]): string {
  const parts: string[] = [];
  for (const term of terms) {
    if (Math.abs(term.coefficient) < 1e-12) {
      continue;
    }
    const coefficient = formatLpNumber(Math.abs(term.coefficient));
    if (parts.length === 0) {
      parts.push(term.coefficient < 0 ? `- ${coefficient} ${term.variable}` : `${coefficient} ${term.variable}`);
    } else {
      parts.push(`${term.coefficient < 0 ? "-" : "+"} ${coefficient} ${term.variable}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : "0";
}

/**
 * Exact packing, in units of 1% of the tank (one slider step). Per tank t and egg e, L[t,e] is what
 * the tank holds at its start, and U[t,e] = sum_g fuel[g,e] n[g,t] <= L[t,e] what its launches burn.
 * The ideal initial tank holds whole steps (filled from empty, every egg stops on one). At refuel
 * loop t, with carry C = L[t-1,e] - U[t-1,e] (the current contents less U[0,e] at the first loop):
 *   refills: L <= C + a, a <= M_e v (v: e is refilled);
 *   limit sliders: a refilled egg has an integer limit p >= L and fills up to it, except that the
 *     route's last refilled egg (h) may stop short when the tank is full (sum_e L = 100);
 *   capacity: sum_e L <= 100;
 *   drains (with `steppedDrains`): L >= C unless d, and a drained egg that is not refilled lands on a
 *     whole step (L = q + r, q integer, r <= 0 when d = 1 and v = 0). A refilled egg drained first
 *     (the route's last one, drained below its room) fills back up. Without it any drain is allowed:
 *     a relaxation that solves much faster, and whose optimum usually replays anyway.
 * So with stepped drains L is exactly what the game leaves in the tank. Minimizes shifts (w + sum v),
 * then loops, then fuel added. A proven result carries the shift and loop counts of the solver's own
 * solution, which bound every packing the model allows.
 */
async function solveExactAssignment(
  prepared: PreparedPack,
  incumbentShifts: number,
  solverFn: VirtueTankSolverFunction,
  timeLimitSeconds: number,
  steppedDrains: boolean
): Promise<
  | { tanks: Assignment; masks: number[]; proven: true; shifts: number; loops: number }
  | { tanks: Assignment; masks: number[]; proven: false; reason: string }
  | { failure: string }
> {
  const { groups, ctx, input } = prepared;
  const scale = ctx.capacity / 100;
  const eggs = EGG_INDICES.filter((e) => groups.some((group) => group.fuel[e] > 0));
  // A loop costs at least two shifts, so no plan within the incumbent's shifts has more loops than this.
  const neededLoops = Math.floor(incumbentShifts / 2);
  const explicitLoops = Number.isFinite(input.maxRefillLoops);
  if (!explicitLoops && incumbentShifts > MAX_EXACT_SHIFTS) {
    return { failure: `skipped: the heuristic packing needs ${incumbentShifts} shifts, more than the top cap of ${MAX_EXACT_SHIFTS}` };
  }
  const loops = explicitLoops ? Math.min(Math.max(0, Math.floor(Number(input.maxRefillLoops))), neededLoops) : neededLoops;
  if (loops <= 0) {
    return { failure: "no refill loops allowed" };
  }
  const tankIndices = Array.from({ length: loops + 1 }, (_, t) => t);
  const refillTanks = tankIndices.slice(1);
  const ideal = ctx.mode === "ideal";
  const tol = ctx.tolerance / scale;
  const f = groups.map((group) => group.fuel.map((value) => value / scale));
  const current = ctx.current.map((value) => value / scale);
  // Refill switches only need to open up what the plan burns (plus the slider's round-up). A tight
  // big-M keeps what a nearly-off switch (within the solver's integrality tolerance) lets through
  // far below a launch's fuel.
  const eggBigM = EGG_INDICES.map((e) =>
    Math.min(100, Math.ceil(groups.reduce((sum, group) => sum + f[group.index][e] * group.launches, 0) - 1e-9) + 1)
  );
  // No egg ever needs to hold more than that, or than the current tank holds already: this bounds
  // every level, limit and drained step, and keeps the big-Ms tight (the step integers are what
  // makes the solve slow).
  const maxLevel = EGG_INDICES.map((e) => Math.min(100, Math.max(eggBigM[e], ideal ? 0 : Math.ceil(current[e] + tol))));
  const n = (g: number, t: number) => `n_${g}_${t}`;
  const L = (t: number, e: number) => `l_${t}_${e}`;
  const a = (t: number, e: number) => `a_${t}_${e}`;
  const v = (t: number, e: number) => `v_${t}_${e}`;
  const p = (t: number, e: number) => `p_${t}_${e}`;
  const h = (t: number, e: number) => `h_${t}_${e}`;
  const d = (t: number, e: number) => `d_${t}_${e}`;
  const q = (t: number, e: number) => `q_${t}_${e}`;
  const r = (t: number, e: number) => `r_${t}_${e}`;
  const w = (t: number) => `w_${t}`;
  const z = (k: number, t: number) => `z_${k}_${t}`;
  const usageTerms = (t: number, e: number): LpTerm[] =>
    groups.filter((group) => f[group.index][e] > 0).map((group) => ({ coefficient: f[group.index][e], variable: n(group.index, t) }));

  const rows: string[] = [];
  const addRow = (terms: LpTerm[], sense: "<=" | ">=" | "=", rhs: number) => {
    if (terms.every((term) => Math.abs(term.coefficient) < 1e-12)) {
      return;
    }
    rows.push(`  c${rows.length}: ${formatLinearExpression(terms)} ${sense} ${formatLpNumber(rhs)}`);
  };
  const bounds: string[] = [];
  const generals: string[] = [];
  const binaries: string[] = [];

  for (const group of groups) {
    addRow(tankIndices.map((t) => ({ coefficient: 1, variable: n(group.index, t) })), "=", group.launches);
    // A refill tank that carries an egg over, or refills only one, skips that egg's slider rounding,
    // so only the tank itself bounds it (group.maxPerRefillTank rounds every egg); the capacity rows
    // handle the rounding. The ideal initial tank fills every egg from empty, so its bound holds.
    const maxPerRefillTank = Math.min(group.launches, Math.floor((ctx.capacity + ctx.tolerance) / group.size));
    for (const t of tankIndices) {
      const cap = t > 0 ? maxPerRefillTank : Math.min(group.launches, group.maxInInitialTank);
      bounds.push(`  0 <= ${n(group.index, t)} <= ${cap}`);
      generals.push(n(group.index, t));
    }
    for (const t of refillTanks) {
      addRow([{ coefficient: 1, variable: n(group.index, t) }, { coefficient: -maxPerRefillTank, variable: w(t) }], "<=", 0);
    }
  }
  // A loop is only worth its shifts with launches after it (and empty tanks are not realized).
  for (const t of refillTanks) {
    addRow([
      ...groups.map((group) => ({ coefficient: 1, variable: n(group.index, t) })),
      { coefficient: -1, variable: w(t) },
    ], ">=", 0);
  }

  const levelTerms = (t: number): LpTerm[] => eggs.map((e) => ({ coefficient: 1, variable: L(t, e) }));
  for (const t of tankIndices) {
    for (const e of eggs) {
      if (t === 0 && !ideal) {
        addRow(usageTerms(0, e), "<=", current[e] + tol);
      } else {
        addRow([...usageTerms(t, e), { coefficient: -1, variable: L(t, e) }], "<=", 0);
        bounds.push(`  0 <= ${L(t, e)} <= ${maxLevel[e]}`);
      }
    }
  }
  if (ideal) {
    // Filled from empty: every egg stops on a whole step, and any whole steps within the tank can be set.
    generals.push(...eggs.map((e) => L(0, e)));
    addRow(levelTerms(0), "<=", 100 + tol);
  }
  for (const t of refillTanks) {
    for (const [index, e] of eggs.entries()) {
      // Carry: L[t] - C (C = L[t-1] - U[t-1], or current - U[0] at the first loop from the current tank).
      const fromCarry: LpTerm[] = [{ coefficient: 1, variable: L(t, e) }, ...usageTerms(t - 1, e)];
      const firstFromCurrent = t === 1 && !ideal;
      if (!firstFromCurrent) {
        fromCarry.push({ coefficient: -1, variable: L(t - 1, e) });
      }
      const carryRhs = firstFromCurrent ? current[e] : 0;
      addRow([...fromCarry, { coefficient: -1, variable: a(t, e) }], "<=", carryRhs + tol);
      if (steppedDrains) {
        addRow([...fromCarry, { coefficient: maxLevel[e], variable: d(t, e) }], ">=", carryRhs - tol);
        addRow([
          { coefficient: 1, variable: L(t, e) },
          { coefficient: -1, variable: q(t, e) },
          { coefficient: -1, variable: r(t, e) },
        ], "=", 0);
        addRow([
          { coefficient: 1, variable: r(t, e) },
          { coefficient: 1, variable: d(t, e) },
          { coefficient: -1, variable: v(t, e) },
        ], "<=", 1);
        addRow([{ coefficient: 1, variable: d(t, e) }, { coefficient: -1, variable: w(t) }], "<=", 0);
        bounds.push(`  0 <= ${q(t, e)} <= ${maxLevel[e]}`, `  0 <= ${r(t, e)} <= 1`);
        generals.push(q(t, e));
        binaries.push(d(t, e));
      }
      addRow([{ coefficient: 1, variable: a(t, e) }, { coefficient: -eggBigM[e], variable: v(t, e) }], "<=", 0);
      addRow([{ coefficient: 1, variable: v(t, e) }, { coefficient: -1, variable: w(t) }], "<=", 0);
      // Limit slider: p >= L for a refilled egg, which fills up to p unless it is the route's last
      // refilled egg (h) and the tank is full first.
      addRow([{ coefficient: 1, variable: p(t, e) }, { coefficient: -maxLevel[e], variable: v(t, e) }], "<=", 0);
      addRow([
        { coefficient: 1, variable: p(t, e) },
        { coefficient: -1, variable: L(t, e) },
        { coefficient: -maxLevel[e], variable: v(t, e) },
      ], ">=", -maxLevel[e]);
      addRow([
        { coefficient: 1, variable: L(t, e) },
        { coefficient: -1, variable: p(t, e) },
        { coefficient: -maxLevel[e], variable: v(t, e) },
        { coefficient: maxLevel[e], variable: h(t, e) },
      ], ">=", -maxLevel[e]);
      addRow([{ coefficient: 1, variable: h(t, e) }, { coefficient: -1, variable: v(t, e) }], "<=", 0);
      for (const later of eggs.slice(index + 1)) {
        addRow([{ coefficient: 1, variable: h(t, e) }, { coefficient: 1, variable: v(t, later) }], "<=", 1);
      }
      addRow([...levelTerms(t), { coefficient: -100, variable: h(t, e) }], ">=", -tol);
      bounds.push(`  0 <= ${a(t, e)} <= ${eggBigM[e]}`, `  0 <= ${p(t, e)} <= ${maxLevel[e]}`);
      generals.push(p(t, e));
      binaries.push(v(t, e), h(t, e));
    }
    addRow(levelTerms(t), "<=", 100 + tol);
    if (t >= 2) {
      addRow([{ coefficient: 1, variable: w(t) }, { coefficient: -1, variable: w(t - 1) }], "<=", 0);
    }
    binaries.push(w(t));
  }
  addRow(
    refillTanks.flatMap((t) => [{ coefficient: 1, variable: w(t) }, ...eggs.map((e) => ({ coefficient: 1, variable: v(t, e) }))]),
    "<=",
    incumbentShifts
  );

  // Precedence: z[k,t] = 1 while tank t may still hold launches of phase <= k.
  const phaseIndex = new Map(prepared.phases.map((phase, index) => [phase, index]));
  const boundaries = prepared.phases.length - 1;
  for (let k = 0; k < boundaries; k += 1) {
    for (const t of refillTanks) {
      binaries.push(z(k, t));
      if (t + 1 <= loops) {
        addRow([{ coefficient: 1, variable: z(k, t + 1) }, { coefficient: -1, variable: z(k, t) }], "<=", 0);
      }
      if (k + 1 < boundaries) {
        addRow([{ coefficient: 1, variable: z(k, t) }, { coefficient: -1, variable: z(k + 1, t) }], "<=", 0);
      }
    }
  }
  for (const group of groups) {
    const j = phaseIndex.get(group.phase) ?? 0;
    const bigM = group.launches;
    for (const t of tankIndices) {
      if (j < boundaries && t >= 1) {
        addRow([{ coefficient: 1, variable: n(group.index, t) }, { coefficient: -bigM, variable: z(j, t) }], "<=", 0);
      }
      if (j >= 1 && t + 1 <= loops) {
        addRow([{ coefficient: 1, variable: n(group.index, t) }, { coefficient: bigM, variable: z(j - 1, t + 1) }], "<=", bigM);
      }
    }
  }

  const objective: LpTerm[] = [];
  for (const t of refillTanks) {
    objective.push({ coefficient: MILP_SHIFT_WEIGHT + MILP_LOOP_WEIGHT, variable: w(t) });
    for (const e of eggs) {
      objective.push({ coefficient: MILP_SHIFT_WEIGHT, variable: v(t, e) });
      objective.push({ coefficient: 1 / (100 * (loops + 1)), variable: a(t, e) });
    }
  }
  if (ideal) {
    for (const e of eggs) {
      objective.push({ coefficient: -1e-4, variable: L(0, e) });
    }
  }

  const lines = [
    "Minimize",
    `  obj: ${formatLinearExpression(objective)}`,
    "Subject To",
    ...rows,
    "Bounds",
    ...bounds,
    "General",
    ...chunkNames(generals),
    "Binary",
    ...chunkNames(binaries),
    "End",
  ];

  let solution: HighsSolveResult | undefined;
  try {
    const model = lines.join("\n");
    const options = {
      mip_rel_gap: 0,
      // Shifts and loops move the objective in steps of 100, so a smaller gap already proves them optimal.
      mip_abs_gap: MILP_PROOF_GAP,
      // The default (1e-6) lets a refill switch sit just above 0 and carry fuel without costing a shift.
      mip_feasibility_tolerance: 1e-9,
      time_limit: timeLimitSeconds,
    };
    solution = await solverFn(model, options);
    // Unless the loops are capped below the incumbent's, the packing its shifts come from is a
    // solution, so "Infeasible" is presolve tripping over that tight tolerance (seen on HiGHS): solve
    // once more without it.
    if (solution?.Status === "Infeasible" && loops >= neededLoops) {
      solution = await solverFn(model, { ...options, presolve: "off" });
    }
  } catch (error) {
    return { failure: `solver error: ${error instanceof Error ? error.message : String(error)}` };
  }
  const status = solution?.Status || "Unknown";
  const optimal = status === "Optimal";
  // A time or node limit can still leave a usable incumbent.
  if (!optimal && !(/limit/i.test(status) && solution?.Columns)) {
    return { failure: `HiGHS status '${status}'` };
  }
  const primal = (name: string) => Math.max(0, Math.round(solution?.Columns?.[name]?.Primal || 0));
  const tanks: Assignment = tankIndices.map((t) => groups.map((group) => primal(n(group.index, t))));
  if (groups.some((group) => tanks.reduce((sum, tank) => sum + tank[group.index], 0) !== group.launches)) {
    return optimal ? { failure: "solver returned inconsistent launch counts" } : { failure: `HiGHS status '${status}'` };
  }
  // The solver's own refill sets, for the tanks that are realized (empty refill tanks are dropped).
  const kept = refillTanks.filter((t) => tanks[t].some((value) => value > 0));
  const packed = [tanks[0], ...kept.map((t) => tanks[t])];
  const masks = [0, ...kept.map((t) => eggs.reduce((mask, e) => (primal(v(t, e)) ? mask | (1 << e) : mask), 0))];
  if (!optimal) {
    return { tanks: packed, masks, proven: false, reason: `HiGHS status '${status}'` };
  }
  // Optimal under a loop cap below what the incumbent allows is not a proof.
  if (loops < neededLoops) {
    return { tanks: packed, masks, proven: false, reason: `searched up to ${loops} refuel loops` };
  }
  const usedLoops = refillTanks.reduce((sum, t) => sum + primal(w(t)), 0);
  const shifts = refillTanks.reduce((sum, t) => sum + primal(w(t)) + eggs.reduce((count, e) => count + primal(v(t, e)), 0), 0);
  return { tanks: packed, masks, proven: true, shifts, loops: usedLoops };
}

function chunkNames(names: string[]): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < names.length; index += 24) {
    chunks.push(`  ${names.slice(index, index + 24).join(" ")}`);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Launch order, schedule and the plan
// ---------------------------------------------------------------------------

type TankEntry = { unit: PackUnit; launches: number };

/** Prep phase, then longest mission first, then ascending level within a ship and duration. */
function compareEntries(a: TankEntry, b: TankEntry): number {
  return compareUnits(a.unit, b.unit);
}

function compareUnits(a: PackUnit, b: PackUnit): number {
  return (
    a.phase - b.phase ||
    b.orderSeconds - a.orderSeconds ||
    `${a.ship}|${a.durationType}`.localeCompare(`${b.ship}|${b.durationType}`) ||
    a.level - b.level ||
    a.index - b.index
  );
}

/** Hand each group's launches to the tanks in order, lowest levels first. */
function expandTankEntries(prepared: PreparedPack, counts: Assignment): TankEntry[][] {
  const entries: TankEntry[][] = counts.map(() => []);
  for (const group of prepared.groups) {
    let unitIndex = 0;
    let unitLeft = group.units[0]?.launches || 0;
    for (let t = 0; t < counts.length; t += 1) {
      let needed = counts[t][group.index] || 0;
      while (needed > 0 && unitIndex < group.units.length) {
        const take = Math.min(needed, unitLeft);
        if (take > 0) {
          entries[t].push({ unit: group.units[unitIndex], launches: take });
          needed -= take;
          unitLeft -= take;
        }
        if (unitLeft <= 0) {
          unitIndex += 1;
          unitLeft = group.units[unitIndex]?.launches || 0;
        }
      }
    }
  }
  for (const tank of entries) {
    tank.sort(compareEntries);
  }
  return entries;
}

function entriesMakespan(prepared: PreparedPack, entries: TankEntry[][]): number {
  const durations: Record<string, number> = {};
  const order: VirtueTankLaunchOrderEntry[] = [];
  entries.forEach((tank, tankIndex) => {
    for (const entry of tank) {
      durations[entry.unit.key] = entry.unit.durationSeconds;
      order.push({ unitId: entry.unit.key, tankIndex, launches: entry.launches });
    }
  });
  return scheduleVirtueLaunches(order, {
    inAirLaneFreeSeconds: prepared.input.inAirLaneFreeSeconds,
    refuelDelaySeconds: prepared.input.refuelDelaySeconds,
    durations,
  }).makespanSeconds;
}

/**
 * Units that burn no virtue fuel go in whichever tank (allowed by precedence)
 * finishes soonest, never before a lower level of the same ship and duration.
 */
function placeFreeUnits(prepared: PreparedPack, entries: TankEntry[][]): void {
  const free = prepared.freeUnits.slice().sort(compareUnits);
  const placedTank = new Map<string, number>();
  for (const unit of free) {
    const mission = `${unit.ship}|${unit.durationType}`;
    const earliest = placedTank.get(mission) ?? 0;
    const phaseRange = entries.map((tank) => ({
      min: Math.min(...tank.map((entry) => entry.unit.phase)),
      max: Math.max(...tank.map((entry) => entry.unit.phase)),
    }));
    let bestTank = -1;
    let bestMakespan = Number.POSITIVE_INFINITY;
    for (let t = earliest; t < entries.length; t += 1) {
      const maxBefore = Math.max(-1, ...phaseRange.slice(0, t).map((range) => range.max));
      const minAfter = Math.min(Number.POSITIVE_INFINITY, ...phaseRange.slice(t + 1).map((range) => range.min));
      if (unit.phase < maxBefore || unit.phase > minAfter) {
        continue;
      }
      const trial = entries.map((tank, index) =>
        index === t ? [...tank, { unit, launches: unit.launches }].sort(compareEntries) : tank
      );
      const makespan = entriesMakespan(prepared, trial);
      if (makespan < bestMakespan - 1e-9) {
        bestMakespan = makespan;
        bestTank = t;
      }
    }
    const target = bestTank >= 0 ? bestTank : entries.length - 1;
    entries[target] = [...entries[target], { unit, launches: unit.launches }].sort(compareEntries);
    placedTank.set(mission, target);
  }
}

function* permutations(values: number[]): Generator<number[]> {
  if (values.length <= 1) {
    yield values.slice();
    return;
  }
  for (let index = 0; index < values.length; index += 1) {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of permutations(rest)) {
      yield [values[index], ...tail];
    }
  }
}

/** Put refill tanks with the longer missions first when that keeps the shift count, to shorten the schedule. */
function reorderForMakespan(prepared: PreparedPack, realized: Realized): Realized {
  const refillCount = realized.tanks.length - 1;
  if (refillCount < 2) {
    return realized;
  }
  const counts = realized.tanks.map((tank) => tank.counts);
  const refillIndices = Array.from({ length: refillCount }, (_, index) => index + 1);
  const orders: number[][] = [];
  if (refillCount <= REORDER_PERMUTATION_LIMIT) {
    for (const order of permutations(refillIndices)) {
      orders.push(order);
    }
  } else {
    const longest = (t: number) =>
      Math.max(0, ...prepared.groups.filter((group) => counts[t][group.index] > 0).flatMap((group) => group.units.map((unit) => unit.durationSeconds)));
    orders.push(refillIndices.slice().sort((a, b) => longest(b) - longest(a) || a - b));
  }
  const baseline = entriesMakespan(prepared, expandTankEntries(prepared, counts));
  const scored = orders
    .map((order) => {
      const permuted = [counts[0], ...order.map((t) => counts[t])];
      return { permuted, makespan: entriesMakespan(prepared, expandTankEntries(prepared, permuted)) };
    })
    .filter((candidate) => candidate.makespan < baseline - 1e-6 && precedenceValid(prepared, candidate.permuted))
    .sort((a, b) => a.makespan - b.makespan);
  for (const candidate of scored.slice(0, REORDER_REALIZE_LIMIT)) {
    const reordered = realizeAssignment(prepared, candidate.permuted);
    if (reordered && reordered.shifts <= realized.shifts && reordered.loops <= realized.loops) {
      return reordered;
    }
  }
  return realized;
}

function finishPlan(
  prepared: PreparedPack,
  realizedInput: Realized | null,
  options: { exact: boolean; diagnostics: string[] }
): VirtueTankPlan {
  const { ctx, input } = prepared;
  const notes = [...prepared.notes];
  const diagnostics = [...prepared.diagnostics, ...options.diagnostics];
  let realized = realizedInput;
  if (!realized) {
    // Only reachable on inconsistent input; keep the plan well-formed.
    notes.push("Could not pack the launches into tanks.");
    realized = {
      tanks: [{
        counts: prepared.groups.map(() => 0),
        usage: zeroFuel(),
        start: ctx.mode === "current" ? ctx.current.slice() : zeroFuel(),
        refillMask: 0,
        fillTo: zeroFuel(),
        add: zeroFuel(),
        drain: zeroFuel(),
      }],
      shifts: 0,
      loops: 0,
      cost: 0,
      idealFillTo: ctx.mode === "ideal" ? zeroFuel() : null,
    };
  } else {
    realized = keepCoveredIdealEggs(prepared, reorderForMakespan(prepared, realized));
  }

  const entries = expandTankEntries(prepared, realized.tanks.map((tank) => tank.counts));
  placeFreeUnits(prepared, entries);
  const hasHumility = finiteOr(input.currentHumility, 0) > ctx.tolerance;
  const limitPcts = (fillTo: Fuel4, mask: number) => {
    const limits: Partial<Record<VirtueFuelKey, number>> = {};
    for (const e of EGG_INDICES) {
      if (hasEgg(mask, e)) {
        limits[EGGS[e]] = Math.max(0, Math.min(100, limitPctFor(fillTo[e], ctx)));
      }
    }
    return limits;
  };

  // Humility sitting in the tank is drained, and its limit set to 0, once: at the plan's first fill
  // (the ideal fill, or else the first loop). At 0 it never comes back, so later loops skip it.
  // A few eggs of it are float noise, not something to drain.
  const idealStart = ctx.mode === "ideal";
  const tanks: VirtueTank[] = realized.tanks.map((state, index) => {
    const tank: VirtueTank = {
      index,
      label: index === 0 ? "Initial Tank" : `Tank ${index + 1}`,
      refill: null,
      startContents: toVector(state.start, ctx.tolerance),
      used: toVector(state.usage, ctx.tolerance),
      leftover: toVector(state.start.map((value, e) => Math.max(0, value - state.usage[e])), ctx.tolerance),
      launches: entries[index].map((entry) => ({ unitId: entry.unit.id, launches: entry.launches })),
      capacity: ctx.capacity,
    };
    if (index > 0) {
      const eggs = EGGS.filter((_, e) => hasEgg(state.refillMask, e));
      tank.refill = {
        route: [...eggs, "humility"],
        shifts: refillShiftCount(eggs),
        add: toVector(state.add, ctx.tolerance),
        fillTo: toVector(state.fillTo, ctx.tolerance),
        limitPct: limitPcts(state.fillTo, state.refillMask),
        drain: toVector(state.drain, ctx.tolerance),
        drainHumility: !idealStart && index === 1 && hasHumility,
      };
    } else if (idealStart && realized?.idealFillTo) {
      const fillTo = realized.idealFillTo;
      // An egg holding more than the tank starts with is drained to its start level, a whole step
      // (every ideal-fill level is one); otherwise the change is what the fill-to target asks for.
      const change = EGG_INDICES.map((e) =>
        ctx.current[e] > state.start[e] + ctx.tolerance
          ? state.start[e] - ctx.current[e]
          : Math.max(0, fillTo[e] - ctx.current[e])
      );
      tank.idealFill = {
        fillTo: toVector(fillTo, ctx.tolerance),
        limitPct: limitPcts(fillTo, fuelMask(fillTo, ctx.tolerance)),
        ...(input.currentContents ? { changeFromCurrent: toVector(change, ctx.tolerance) } : {}),
        drainHumility: hasHumility,
      };
    }
    return tank;
  });

  const launchOrder = tanks.flatMap((tank) =>
    tank.launches.map((launch) => ({ unitId: launch.unitId, tankIndex: tank.index, launches: launch.launches }))
  );
  // Schedule by unit key (ids may repeat), then report blocks by id.
  const durations: Record<string, number> = {};
  const idByKey = new Map<string, string>();
  const keyedOrder: VirtueTankLaunchOrderEntry[] = [];
  entries.forEach((tank, tankIndex) => {
    for (const entry of tank) {
      durations[entry.unit.key] = entry.unit.durationSeconds;
      idByKey.set(entry.unit.key, entry.unit.id);
      keyedOrder.push({ unitId: entry.unit.key, tankIndex, launches: entry.launches });
    }
  });
  const keyedSchedule = scheduleVirtueLaunches(keyedOrder, {
    inAirLaneFreeSeconds: input.inAirLaneFreeSeconds,
    refuelDelaySeconds: input.refuelDelaySeconds,
    durations,
  });
  const schedule: VirtueTankSchedule = {
    makespanSeconds: keyedSchedule.makespanSeconds,
    lanes: keyedSchedule.lanes.map((lane) =>
      lane.map((block) => ({ ...block, unitId: idByKey.get(block.unitId) ?? block.unitId }))
    ),
  };

  if (hasHumility && (tanks.length > 1 || idealStart)) {
    notes.push(
      `Drain the leftover Humility in the tank ${idealStart ? "before filling the initial tank" : "before the first refuel loop"} ` +
        "and set its limit to 0: ships fuel Humility straight from the Humility farm."
    );
  }
  const drained = realized.tanks.reduce((sum, state) => sum + sumFuel(state.drain), 0);
  if (drained > ctx.tolerance) {
    notes.push("Some refuel loops drain leftover fuel first to make room; see each loop's drain amounts.");
  }
  const totalShifts = realized.shifts;
  const exact = realizedInput !== null && (options.exact || totalShifts === 0);

  return {
    startMode: ctx.mode,
    capacity: ctx.capacity,
    tanks,
    totalShifts,
    refillLoops: tanks.length - 1,
    totalFuel: toVector(prepared.totalFuel, ctx.tolerance),
    feasible: prepared.unplaced.length === 0 && realizedInput !== null,
    exact,
    launchOrder,
    schedule,
    unplaced: prepared.unplaced,
    notes,
    diagnostics,
  };
}
