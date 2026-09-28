/**
 * Path of Virtue tank mode: the last tank's spare room, and an optional top-up
 * that fills it with extra launches for the three common craft ingredients.
 *
 * Advisory only. The top-up raises limit sliders on eggs already on the last
 * refuel loop's route (so it costs no shifts), and never changes the plan, its
 * tanks or its schedule. Client-safe: the planner page runs the planner too.
 */
import { getRecipe } from "./recipes";
import { VIRTUE_LAUNCH_EFFORT_SECONDS } from "./virtue-tank-plan";
import { formatVirtueFuelQuantity, VIRTUE_FUEL_DISPLAY, type VirtueFuelKey } from "./virtue-fuel";
import {
  VIRTUE_REFILL_ROUTE_ORDER,
  virtueFuelTolerance,
  type VirtueFuelVector,
  type VirtueTank,
  type VirtueTankPlan,
  type VirtueTankSolverFunction,
} from "./virtue-tanks";

export type VirtueTopUpFamily = "goldMeteorite" | "tauCetiGeode" | "solarTitanium";

/** Expected ingredients per family, in T1 equivalents. */
export type VirtueTopUpYield = Record<VirtueTopUpFamily, number>;

/** Item-key family prefix of each ingredient ("gold_meteorite_2"). */
export const VIRTUE_TOP_UP_FAMILY_KEYS: Record<VirtueTopUpFamily, string> = {
  goldMeteorite: "gold_meteorite",
  tauCetiGeode: "tau_ceti_geode",
  solarTitanium: "solar_titanium",
};

const FAMILIES = Object.keys(VIRTUE_TOP_UP_FAMILY_KEYS) as VirtueTopUpFamily[];

/** Targets a top-up launch may use: one of the three ingredients, or none (10000). */
export const VIRTUE_TOP_UP_TARGET_AFX_IDS: readonly number[] = [17, 18, 43, 10000];

/** The last tank counts as mostly empty from this much room (a fraction of the tank). */
export const VIRTUE_TOP_UP_MIN_ROOM_FRACTION = 0.2;

/**
 * Every extra launch is charged its time the way the planner charges it: a
 * third of its duration (three mission slots) plus VIRTUE_LAUNCH_EFFORT_SECONDS
 * of player effort. The charge per second (lambda) is this fraction of the
 * value per charged second of the player's Henerprise Extended, whatever the
 * route (see virtueTopUpReferenceRate): a launch has to be at least a quarter
 * as time-efficient as that workhorse. A light charge on purpose: slow,
 * fuel-thrifty ships filling leftover room for days (Defihents, Galeggticas)
 * is how players spend spare fuel, but fewer launches still win when they
 * come close. At 0.5 only the fastest ships survive; at 0 the room fills
 * with as many small launches as fit.
 */
export const VIRTUE_TOP_UP_LAMBDA_FRACTION = 0.25;

/** A top-up is offered only when its value net of the time charge is at least this share of its value. */
export const VIRTUE_TOP_UP_MIN_NET_FRACTION = 0.1;

/**
 * Safety cap on extra launches, for the solver only: the time charge already
 * keeps slow ships out, and the fuel room bounds every ship that burns much.
 */
export const VIRTUE_TOP_UP_MAX_LAUNCHES = 200;

/** Seconds of the planner's objective one launch costs (VIRTUE_LAUNCH_EFFORT_SECONDS plus a third of its duration). */
export function virtueTopUpLaunchCostSeconds(durationSeconds: number): number {
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  return duration / 3 + VIRTUE_LAUNCH_EFFORT_SECONDS;
}

const TOP_UP_TIME_LIMIT_SECONDS = 1;
const TIE_BREAK = 1e-4;

/** Every item key of the three ingredient families, all tiers. */
export function virtueTopUpItemKeys(): string[] {
  const keys: string[] = [];
  for (const family of FAMILIES) {
    for (let tier = 1; tier <= 3; tier += 1) {
      keys.push(`${VIRTUE_TOP_UP_FAMILY_KEYS[family]}_${tier}`);
    }
  }
  return keys;
}

function familyOf(itemKey: string): VirtueTopUpFamily | null {
  const match = itemKey.match(/^(.+)_\d+$/);
  if (!match) {
    return null;
  }
  return FAMILIES.find((family) => VIRTUE_TOP_UP_FAMILY_KEYS[family] === match[1]) ?? null;
}

const t1Cache = new Map<string, number>();

/**
 * T1 pieces one item stands for: its recipe's ingredients of the same family,
 * recursively (a T2 gold meteorite is 9 T1s, a T3 is 11 T2s = 99 T1s). 0 for
 * anything outside the three ingredient families.
 */
export function virtueTopUpT1Equivalent(itemKey: string): number {
  const family = familyOf(itemKey);
  if (!family) {
    return 0;
  }
  const cached = t1Cache.get(itemKey);
  if (cached !== undefined) {
    return cached;
  }
  const recipe = getRecipe(itemKey);
  let value = 1;
  if (recipe) {
    value = 0;
    for (const [ingredient, count] of Object.entries(recipe.ingredients)) {
      if (familyOf(ingredient) === family) {
        value += count * virtueTopUpT1Equivalent(ingredient);
      }
    }
    value = Math.max(1, value);
  }
  t1Cache.set(itemKey, value);
  return value;
}

export function emptyVirtueTopUpYield(): VirtueTopUpYield {
  return { goldMeteorite: 0, tauCetiGeode: 0, solarTitanium: 0 };
}

/** Expected drops per item key (per launch) as T1 equivalents per family. */
export function virtueTopUpYieldOf(yields: Record<string, number>): VirtueTopUpYield {
  const result = emptyVirtueTopUpYield();
  for (const [itemKey, quantity] of Object.entries(yields)) {
    const family = familyOf(itemKey);
    if (family && Number.isFinite(quantity) && quantity > 0) {
      result[family] += quantity * virtueTopUpT1Equivalent(itemKey);
    }
  }
  return result;
}

/** The families weigh the same: value is total T1 equivalents. */
export function virtueTopUpValue(expected: VirtueTopUpYield): number {
  return FAMILIES.reduce((sum, family) => sum + expected[family], 0);
}

// ---------------------------------------------------------------------------
// The last tank's room (the panel's callout)
// ---------------------------------------------------------------------------

export type VirtueLastTankRoom = {
  tank: VirtueTank;
  /** Refuel route eggs, in route order (no Humility). */
  route: VirtueFuelKey[];
  /** Empty space in the tank once the loop has filled it: capacity less its start contents. */
  room: number;
  /** What the loop adds, per egg. */
  add: VirtueFuelVector;
  /** Launches the plan makes from this tank. */
  launches: number;
};

function amount(vector: VirtueFuelVector | undefined, egg: VirtueFuelKey): number {
  const value = vector?.[egg];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * The last refuel loop's tank when at least VIRTUE_TOP_UP_MIN_ROOM_FRACTION of
 * it stays empty; null for a plan without refuel loops or with a fuller tank.
 */
export function virtueLastTankRoom(pack: VirtueTankPlan | null | undefined): VirtueLastTankRoom | null {
  if (!pack || pack.tanks.length < 2 || !(pack.capacity > 0)) {
    return null;
  }
  const tank = pack.tanks[pack.tanks.length - 1];
  if (!tank.refill) {
    return null;
  }
  const route = VIRTUE_REFILL_ROUTE_ORDER.filter((egg) => tank.refill!.route.includes(egg));
  const filled = VIRTUE_REFILL_ROUTE_ORDER.reduce((sum, egg) => sum + amount(tank.startContents, egg), 0);
  const room = Math.max(0, pack.capacity - filled);
  if (route.length === 0 || room < pack.capacity * VIRTUE_TOP_UP_MIN_ROOM_FRACTION) {
    return null;
  }
  const launches = tank.launches.reduce((sum, entry) => sum + Math.max(0, entry.launches), 0);
  return { tank, route, room, add: tank.refill.add, launches };
}

/** "Tank 3 only needs 20T of Resilience for 2 launches, leaving 410T of room." */
export function virtueLastTankRoomText(room: VirtueLastTankRoom): string {
  const needs = room.route
    .filter((egg) => amount(room.add, egg) > 0)
    .map((egg) => `${formatVirtueFuelQuantity(amount(room.add, egg))} of ${eggLabel(egg)}`);
  const needsText = needs.length > 0 ? joinWords(needs) : "no refill";
  const launches = `${room.launches.toLocaleString()} ${room.launches === 1 ? "launch" : "launches"}`;
  return `${room.tank.label} only needs ${needsText} for ${launches}, leaving ${formatVirtueFuelQuantity(room.room)} of room.`;
}

function eggLabel(egg: VirtueFuelKey): string {
  return VIRTUE_FUEL_DISPLAY.find((entry) => entry.key === egg)?.label ?? egg;
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) {
    return parts.join("");
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// The top-up
// ---------------------------------------------------------------------------

/** The mission the top-up's time charge is scaled to: the community's workhorse. */
export const VIRTUE_TOP_UP_REFERENCE_MISSION = { ship: "HENERPRISE", durationType: "EPIC" } as const;

/**
 * Value per charged second the time charge is a fraction of: the player's own
 * Henerprise Extended at their stars, research and loot tier (its best target).
 * A fixed reference keeps the bar from rising with a maxed player's fastest
 * ship, so thrifty ships stay in reach for them too. Without a Henerprise
 * Extended (locked or deselected), the player's best fueled mission stands in.
 */
export function virtueTopUpReferenceRate(candidates: VirtueTopUpCandidate[]): number {
  let referenceRate = 0;
  let bestRate = 0;
  for (const raw of candidates) {
    const fuel = VIRTUE_REFILL_ROUTE_ORDER.reduce((sum, egg) => sum + amount(raw.fuelPerLaunch, egg), 0);
    if (fuel <= 0) {
      continue;
    }
    const rate = virtueTopUpValue(raw.expected) / virtueTopUpLaunchCostSeconds(raw.durationSeconds);
    bestRate = Math.max(bestRate, rate);
    if (raw.ship === VIRTUE_TOP_UP_REFERENCE_MISSION.ship && raw.durationType === VIRTUE_TOP_UP_REFERENCE_MISSION.durationType) {
      referenceRate = Math.max(referenceRate, rate);
    }
  }
  return referenceRate > 0 ? referenceRate : bestRate;
}

export type VirtueTopUpCandidate = {
  ship: string;
  durationType: string;
  /** Ship star level. */
  level: number;
  durationSeconds: number;
  /** null for an untargeted launch. */
  targetAfxId: number | null;
  fuelPerLaunch: VirtueFuelVector;
  /** Expected ingredients per launch, in T1 equivalents. */
  expected: VirtueTopUpYield;
};

/** `VirtueTankPlannerResult.lastTankTopUp`. */
export type VirtueLastTankTopUp = {
  tankIndex: number;
  /** Empty space in the last tank as the plan fills it. */
  roomBefore: number;
  launches: Array<{ ship: string; durationType: string; level: number; targetAfxId: number | null; launches: number }>;
  /** Level each route egg fills to with the raised limits. */
  fillTo: VirtueFuelVector;
  /** Limit per route egg, whole percent (never below the plan's). */
  limitPct: Partial<Record<VirtueFuelKey, number>>;
  /** Expected extra ingredients, in T1 equivalents. */
  expected: VirtueTopUpYield;
  totalValue: number;
  /** totalValue less the time charge (lambda per charged second, see VIRTUE_TOP_UP_LAMBDA_FRACTION). */
  netValue: number;
  /** Mission time of the extra launches, summed over launches (not divided across slots). */
  slotSeconds: number;
};

type TopUpContext = {
  capacity: number;
  pct: number;
  tolerance: number;
  route: VirtueFuelKey[];
  last: VirtueFuelKey;
  /** What the plan's own launches burn from this tank. */
  used: Record<VirtueFuelKey, number>;
  /** Off-route eggs stay as the loop leaves them. */
  fixed: number;
  planLimit: Record<VirtueFuelKey, number>;
};

type Candidate = VirtueTopUpCandidate & {
  fuel: Record<VirtueFuelKey, number>;
  /** Expected T1 equivalents per launch. */
  gross: number;
  /** `gross` less the time charge: what the solve maximizes. */
  value: number;
  maxLaunches: number;
};

type Realized = {
  fillTo: Record<VirtueFuelKey, number>;
  limitPct: Record<VirtueFuelKey, number>;
};

function limitPctFor(need: number, ctx: TopUpContext): number {
  if (need <= 0) {
    return 0;
  }
  return Math.ceil(need / ctx.pct - 1e-9);
}

/**
 * The limits and fill levels that carry the plan's burn plus `extra` in the
 * route eggs, or null when they do not fit. The way every refuel loop fills:
 * each route egg but the last lands on its limit step; the last one fills up
 * to its limit or until the tank is full.
 */
function realize(extra: Record<VirtueFuelKey, number>, ctx: TopUpContext): Realized | null {
  const fillTo = {} as Record<VirtueFuelKey, number>;
  const limitPct = {} as Record<VirtueFuelKey, number>;
  let total = ctx.fixed;
  for (const egg of ctx.route) {
    const need = ctx.used[egg] + extra[egg];
    const limit = Math.min(100, Math.max(ctx.planLimit[egg], limitPctFor(need, ctx)));
    limitPct[egg] = limit;
    if (egg === ctx.last) {
      const level = Math.min(limit * ctx.pct, ctx.capacity - total);
      if (level < need - ctx.tolerance) {
        return null;
      }
      fillTo[egg] = level;
      total += level;
    } else {
      if (limit * ctx.pct < need - ctx.tolerance) {
        return null;
      }
      fillTo[egg] = limit * ctx.pct;
      total += fillTo[egg];
    }
  }
  return total <= ctx.capacity + ctx.tolerance ? { fillTo, limitPct } : null;
}

function extraFuel(counts: number[], candidates: Candidate[]): Record<VirtueFuelKey, number> {
  const extra = { curiosity: 0, integrity: 0, kindness: 0, resilience: 0 };
  counts.forEach((count, j) => {
    for (const egg of VIRTUE_REFILL_ROUTE_ORDER) {
      extra[egg] += candidates[j].fuel[egg] * count;
    }
  });
  return extra;
}

function countsValue(counts: number[], candidates: Candidate[]): number {
  return counts.reduce((sum, count, j) => sum + count * candidates[j].value, 0);
}

function formatLp(value: number): string {
  const normalized = Math.abs(value) < 1e-12 ? 0 : value;
  return Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(9).replace(/\.?0+$/, "");
}

function linear(terms: Array<[number, string]>): string {
  const parts: string[] = [];
  for (const [coefficient, variable] of terms) {
    if (Math.abs(coefficient) < 1e-12) {
      continue;
    }
    const sign = coefficient < 0 ? "-" : "+";
    parts.push(`${parts.length === 0 ? (sign === "-" ? "- " : "") : `${sign} `}${formatLp(Math.abs(coefficient))} ${variable}`);
  }
  return parts.length > 0 ? parts.join(" ") : "0";
}

/**
 * Integer program in 1% steps of the tank. x_j launches of candidate j; y_e
 * the limit of each route egg but the last:
 *   y_e >= used_e + sum_j fuel_je x_j          (lands on its limit step)
 *   sum_e y_e + used_last + sum_j fuel_j,last x_j <= 100 - fixed   (the last fills the rest)
 *   sum_j x_j <= VIRTUE_TOP_UP_MAX_LAUNCHES (a safety cap)
 * maximizing the expected T1 equivalents less the time charge (lower limits break ties).
 */
async function solveTopUp(
  candidates: Candidate[],
  ctx: TopUpContext,
  solverFn: VirtueTankSolverFunction
): Promise<number[] | null> {
  const step = ctx.pct;
  const slack = ctx.tolerance / step;
  const x = candidates.map((_, j) => `x_${j}`);
  const nonLast = ctx.route.filter((egg) => egg !== ctx.last);
  const y = new Map(nonLast.map((egg) => [egg, `y_${egg}`]));
  const lines: string[] = ["Maximize"];
  lines.push(
    `  obj: ${linear([
      ...candidates.map((candidate, j): [number, string] => [candidate.value, x[j]]),
      ...nonLast.map((egg): [number, string] => [-TIE_BREAK, y.get(egg)!]),
    ])}`
  );
  lines.push("Subject To");
  for (const egg of nonLast) {
    const terms: Array<[number, string]> = [[1, y.get(egg)!]];
    candidates.forEach((candidate, j) => terms.push([-candidate.fuel[egg] / step, x[j]]));
    lines.push(`  need_${egg}: ${linear(terms)} >= ${formatLp(ctx.used[egg] / step - slack)}`);
  }
  const capTerms: Array<[number, string]> = nonLast.map((egg) => [1, y.get(egg)!]);
  candidates.forEach((candidate, j) => capTerms.push([candidate.fuel[ctx.last] / step, x[j]]));
  lines.push(`  cap: ${linear(capTerms)} <= ${formatLp((ctx.capacity - ctx.fixed - ctx.used[ctx.last]) / step + slack)}`);
  lines.push(`  launches: ${linear(candidates.map((_, j): [number, string] => [1, x[j]]))} <= ${VIRTUE_TOP_UP_MAX_LAUNCHES}`);
  lines.push("Bounds");
  candidates.forEach((candidate, j) => lines.push(`  0 <= ${x[j]} <= ${candidate.maxLaunches}`));
  for (const egg of nonLast) {
    lines.push(`  ${ctx.planLimit[egg]} <= ${y.get(egg)} <= 100`);
  }
  lines.push("General");
  lines.push(`  ${[...x, ...y.values()].join(" ")}`);
  lines.push("End");
  try {
    const solution = await solverFn(lines.join("\n"), { time_limit: TOP_UP_TIME_LIMIT_SECONDS, mip_rel_gap: 1e-6 });
    const status = solution.Status || "";
    if (status !== "Optimal" && status !== "Time limit reached") {
      return null;
    }
    const counts = x.map((variable) => Math.max(0, Math.round(solution.Columns?.[variable]?.Primal ?? 0)));
    return realize(extraFuel(counts, candidates), ctx) ? counts : null;
  } catch {
    return null;
  }
}

/**
 * Greedy fallback: add the launch with the most net value per egg that still fits,
 * and keep the better of that and the best single-candidate fill.
 */
function greedyTopUp(candidates: Candidate[], ctx: TopUpContext): number[] {
  const fits = (counts: number[]) => realize(extraFuel(counts, candidates), ctx) !== null;
  const order = candidates
    .map((candidate, j) => ({ j, perEgg: candidate.value / Math.max(1, sumFuel(candidate.fuel)), value: candidate.value }))
    .sort((a, b) => b.perEgg - a.perEgg || b.value - a.value || a.j - b.j);
  const greedy = candidates.map(() => 0);
  let total = 0;
  for (let progress = true; progress && total < VIRTUE_TOP_UP_MAX_LAUNCHES; ) {
    progress = false;
    for (const { j } of order) {
      greedy[j] += 1;
      if (greedy[j] <= candidates[j].maxLaunches && fits(greedy)) {
        total += 1;
        progress = true;
        break;
      }
      greedy[j] -= 1;
    }
  }
  let best = greedy;
  candidates.forEach((candidate, j) => {
    const single = candidates.map(() => 0);
    const limit = Math.min(candidate.maxLaunches, VIRTUE_TOP_UP_MAX_LAUNCHES);
    while (single[j] < limit) {
      single[j] += 1;
      if (!fits(single)) {
        single[j] -= 1;
        break;
      }
    }
    if (countsValue(single, candidates) > countsValue(best, candidates) + 1e-9) {
      best = single;
    }
  });
  return best;
}

function sumFuel(fuel: Record<VirtueFuelKey, number>): number {
  return VIRTUE_REFILL_ROUTE_ORDER.reduce((sum, egg) => sum + fuel[egg], 0);
}

/**
 * The top-up for the last tank of `pack`, or null when its room is under
 * VIRTUE_TOP_UP_MIN_ROOM_FRACTION of the tank, when no candidate burns only
 * eggs on its refuel route, or when nothing fits. Candidates are the player's
 * missions, targeted at an ingredient or untargeted, with their expected
 * ingredients; ships that burn no tank fuel are left out.
 */
export async function planVirtueLastTankTopUp(options: {
  pack: VirtueTankPlan;
  candidates: VirtueTopUpCandidate[];
  solverFn?: VirtueTankSolverFunction;
  /** Overrides VIRTUE_TOP_UP_LAMBDA_FRACTION (for experiments and tests). */
  lambdaFraction?: number;
}): Promise<VirtueLastTankTopUp | null> {
  const room = virtueLastTankRoom(options.pack);
  if (!room) {
    return null;
  }
  const { tank } = room;
  const capacity = options.pack.capacity;
  const onRoute = new Set(room.route);
  const used = {} as Record<VirtueFuelKey, number>;
  const planLimit = {} as Record<VirtueFuelKey, number>;
  let fixed = 0;
  for (const egg of VIRTUE_REFILL_ROUTE_ORDER) {
    used[egg] = amount(tank.used, egg);
    planLimit[egg] = Math.max(0, Math.min(100, Math.round(tank.refill?.limitPct[egg] ?? 0)));
    if (!onRoute.has(egg)) {
      fixed += amount(tank.startContents, egg);
    }
  }
  const ctx: TopUpContext = {
    capacity,
    pct: capacity / 100,
    tolerance: virtueFuelTolerance(capacity),
    route: room.route,
    last: room.route[room.route.length - 1],
    used,
    fixed,
    planLimit,
  };
  if (!realize({ curiosity: 0, integrity: 0, kindness: 0, resilience: 0 }, ctx)) {
    return null;
  }

  const lambda = (options.lambdaFraction ?? VIRTUE_TOP_UP_LAMBDA_FRACTION) * virtueTopUpReferenceRate(options.candidates);

  // One candidate per mission (the same fuel and time): the target that brings the most.
  const byMission = new Map<string, Candidate>();
  for (const raw of options.candidates) {
    const fuel = {} as Record<VirtueFuelKey, number>;
    for (const egg of VIRTUE_REFILL_ROUTE_ORDER) {
      fuel[egg] = amount(raw.fuelPerLaunch, egg);
    }
    const total = sumFuel(fuel);
    const gross = virtueTopUpValue(raw.expected);
    const value = gross - lambda * virtueTopUpLaunchCostSeconds(raw.durationSeconds);
    if (total <= 0 || !(value > 1e-9) || VIRTUE_REFILL_ROUTE_ORDER.some((egg) => fuel[egg] > 0 && !onRoute.has(egg))) {
      continue;
    }
    const maxLaunches = Math.min(VIRTUE_TOP_UP_MAX_LAUNCHES, Math.floor((capacity - fixed) / total));
    if (maxLaunches <= 0) {
      continue;
    }
    const key = `${raw.ship}|${raw.durationType}`;
    const existing = byMission.get(key);
    if (!existing || value > existing.value + 1e-9) {
      byMission.set(key, { ...raw, fuel, gross, value, maxLaunches });
    }
  }
  const candidates = Array.from(byMission.values()).sort(
    (a, b) => a.ship.localeCompare(b.ship) || a.durationType.localeCompare(b.durationType)
  );
  if (candidates.length === 0) {
    return null;
  }

  let counts = options.solverFn ? await solveTopUp(candidates, ctx, options.solverFn) : null;
  const greedy = greedyTopUp(candidates, ctx);
  if (!counts || countsValue(greedy, candidates) > countsValue(counts, candidates) + 1e-9) {
    counts = greedy;
  }
  const realized = realize(extraFuel(counts, candidates), ctx);
  if (!realized || counts.every((count) => count <= 0)) {
    return null;
  }

  const expected = emptyVirtueTopUpYield();
  const launches: VirtueLastTankTopUp["launches"] = [];
  let slotSeconds = 0;
  counts.forEach((count, j) => {
    if (count <= 0) {
      return;
    }
    const candidate = candidates[j];
    slotSeconds += candidate.durationSeconds * count;
    for (const family of FAMILIES) {
      expected[family] += candidate.expected[family] * count;
    }
    launches.push({
      ship: candidate.ship,
      durationType: candidate.durationType,
      level: candidate.level,
      targetAfxId: candidate.targetAfxId,
      launches: count,
    });
  });
  launches.sort((a, b) => b.launches - a.launches || a.ship.localeCompare(b.ship));
  const fillTo: VirtueFuelVector = {};
  const limitPct: Partial<Record<VirtueFuelKey, number>> = {};
  for (const egg of room.route) {
    fillTo[egg] = realized.fillTo[egg];
    limitPct[egg] = realized.limitPct[egg];
  }
  const totalValue = virtueTopUpValue(expected);
  const netValue = countsValue(counts, candidates);
  if (!(netValue > 0) || netValue < VIRTUE_TOP_UP_MIN_NET_FRACTION * totalValue) {
    return null;
  }
  return {
    tankIndex: tank.index,
    roomBefore: room.room,
    launches,
    fillTo,
    limitPct,
    expected,
    totalValue,
    netValue,
    slotSeconds,
  };
}
