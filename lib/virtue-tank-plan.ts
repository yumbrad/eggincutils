import { MILLION, VIRTUE_TANK_CAPACITIES, type VirtueTankSnapshot } from "./virtue-fuel";
import {
  nearestVirtueShiftCapDetent,
  VIRTUE_SHIFT_PENALTY_SECONDS,
  type VirtueFuelVector,
  type VirtueTankLaunchUnit,
  type VirtueTankPlan,
  type VirtueTankStartMode,
} from "./virtue-tanks";
import type { VirtueLastTankTopUp } from "./virtue-top-up";

/**
 * Planner input for Path of Virtue tank mode (`PlannerOptions.virtueTank`).
 * Present only with `objectiveMode: "virtueFuel"`; its presence switches the
 * virtue objective from fuel-vs-time weighting to a shift-capped time objective.
 */
export type VirtueTankPlannerOptions = {
  /** Requested shift cap, one of VIRTUE_SHIFT_CAP_DETENTS. */
  shiftCap: number;
  startMode: VirtueTankStartMode;
  /** Tank capacity in eggs, from the profile's tank level. */
  capacity: number;
  /** C/I/K/R in the tank now. Required for "current" mode. */
  currentContents?: VirtueFuelVector;
  /** Humility sitting in the tank now. Only drives the drain instruction. */
  currentHumility?: number;
};

/** A packed launch unit plus the mission row it belongs to. */
export type VirtueTankPlanUnit = VirtueTankLaunchUnit & {
  /** `PlanMissionRow.rowKey` of the row these launches come from; absent for no-yield prep launches, which have no row. */
  missionRowKey?: string;
  targetAfxId?: number | null;
};

/** `PlannerResult.virtueTanks`: the tank-mode summary the UI renders. */
export type VirtueTankPlannerResult = {
  /** Cap the user asked for. */
  shiftCap: number;
  /** Cap the plan was built with; above `shiftCap` only when `overCap`. */
  plannedShiftCap: number;
  /** The goals needed more shifts than `shiftCap` allows. */
  overCap: boolean;
  /** Fewest shifts that meet the goals, when `overCap`. */
  neededShifts?: number;
  /**
   * With `neededShifts`: true when the search proved no plan takes fewer;
   * false when it is only the fewest found within the solver time limits.
   */
  neededShiftsProven?: boolean;
  /**
   * A plan with a few more shifts that scores clearly better
   * (virtueTankPlanScoreSeconds: mission hours + 24 h per shift + 3 min per
   * launch), offered beside the plan; `overCap` tells the two cases apart
   * (virtueFasterOptionQualifies).
   * - Over the cap: up to VIRTUE_FASTER_OPTION_EXTRA_SHIFTS more than the
   *   minimum-shift plan, beating it by VIRTUE_FASTER_OPTION_MIN_GAIN_SECONDS.
   * - Within the cap: more shifts than the cap (at most
   *   VIRTUE_FASTER_OPTION_EXTRA_SHIFTS more, and at most the top detent),
   *   beating the plan by VIRTUE_FASTER_OPTION_MIN_GAIN_SECONDS and by
   *   VIRTUE_FASTER_OPTION_WITHIN_CAP_MIN_GAIN_FRACTION of its score. The
   *   planner only looks when the plan looks slow for its cap, so a plan
   *   without it is not proven to be the fastest a higher cap allows.
   * `shifts` is what it packs into; planning with the cap set to it gives
   * that plan back.
   */
  fasterOption?: { shifts: number; expectedHours: number };
  startMode: VirtueTankStartMode;
  capacity: number;
  /** Every unit in `pack`, keyed by `id`, with its row link. */
  units: VirtueTankPlanUnit[];
  pack: VirtueTankPlan;
  notes: string[];
  /**
   * Advisory only, never part of the plan: when the last refuel loop leaves
   * much of its tank empty (virtueLastTankRoom), limits to raise on that
   * loop's own route eggs (no extra shifts) to also send extra launches for
   * gold meteorite, Tau Ceti geode and solar titanium.
   */
  lastTankTopUp?: VirtueLastTankTopUp;
};

/**
 * Player effort per launch in tank mode, charged as mission time: every
 * launch is a few taps plus a trip back to the game, so a plan of hundreds of
 * short launches is not as fast as its mission hours say. The planner puts it
 * on every launch in the tank objective and in every plan comparison.
 */
export const VIRTUE_LAUNCH_EFFORT_SECONDS = 180;

/**
 * Tank mode's trade: how long a plan takes with its shifts and launches
 * priced as mission time (VIRTUE_SHIFT_PENALTY_SECONDS per shift,
 * VIRTUE_LAUNCH_EFFORT_SECONDS per launch). Lower is better.
 */
export function virtueTankPlanScoreSeconds(plan: { expectedHours: number; shifts: number; launches: number }): number {
  const hours = Number.isFinite(plan.expectedHours) ? Math.max(0, plan.expectedHours) : 0;
  const shifts = Number.isFinite(plan.shifts) ? Math.max(0, plan.shifts) : 0;
  const launches = Number.isFinite(plan.launches) ? Math.max(0, plan.launches) : 0;
  return hours * 3600 + shifts * VIRTUE_SHIFT_PENALTY_SECONDS + launches * VIRTUE_LAUNCH_EFFORT_SECONDS;
}

/**
 * How much better a plan with more shifts must score before it is offered
 * (VirtueTankPlannerResult.fasterOption): one shift's worth.
 */
export const VIRTUE_FASTER_OPTION_MIN_GAIN_SECONDS = VIRTUE_SHIFT_PENALTY_SECONDS;

/**
 * Within the cap, a faster option must also score at least this fraction
 * lower than the plan: the player chose the cap, so only a clearly faster
 * plan is worth raising it for.
 */
export const VIRTUE_FASTER_OPTION_WITHIN_CAP_MIN_GAIN_FRACTION = 0.25;

/**
 * Most shifts a faster option may add: to an over-cap plan's minimum, or to
 * the cap for a plan within it.
 */
export const VIRTUE_FASTER_OPTION_EXTRA_SHIFTS = 4;

/**
 * Whether a plan with more shifts scores enough better to be offered as
 * VirtueTankPlannerResult.fasterOption. Scores are
 * virtueTankPlanScoreSeconds; `withinCap` says the plan fits the cap.
 */
export function virtueFasterOptionQualifies(
  planScoreSeconds: number,
  fasterScoreSeconds: number,
  withinCap: boolean
): boolean {
  if (!Number.isFinite(planScoreSeconds) || !Number.isFinite(fasterScoreSeconds)) {
    return false;
  }
  const gain = planScoreSeconds - fasterScoreSeconds;
  if (gain < VIRTUE_FASTER_OPTION_MIN_GAIN_SECONDS) {
    return false;
  }
  return !withinCap || gain >= planScoreSeconds * VIRTUE_FASTER_OPTION_WITHIN_CAP_MIN_GAIN_FRACTION;
}

/** Shift cap used when a request leaves the slider unset. */
export const DEFAULT_VIRTUE_SHIFT_CAP = 7;

/** Tank capacity assumed without tank data: the maxed tank (level 7, 500T). */
const DEFAULT_VIRTUE_TANK_CAPACITY = VIRTUE_TANK_CAPACITIES[VIRTUE_TANK_CAPACITIES.length - 1];

/**
 * Tank readings this close to a whole million eggs are float noise: the game
 * stores a tank filled to exactly 190T as 190000000000001.9.
 */
const VIRTUE_TANK_READING_NOISE_EGGS = 1_000;

/** A tank reading without its float noise, as the planner reads it (see VIRTUE_TANK_READING_NOISE_EGGS). */
export function snapVirtueTankReading(value: number): number {
  const amount = Number.isFinite(value) ? Math.max(0, value) : 0;
  const snapped = Math.round(amount / MILLION) * MILLION;
  return Math.abs(amount - snapped) <= VIRTUE_TANK_READING_NOISE_EGGS ? snapped : amount;
}

/**
 * Tank-mode planner options from the profile's tank snapshot and the shift-cap
 * slider / start-tank toggle. The plan routes, the snapshot script and the
 * planner page all build `PlannerOptions.virtueTank` through here, so they
 * read the slider and the tank the same way. (The routes still plan on the
 * server's mission yield index, which the page and the snapshot script do
 * without; see `PlannerOptions.disableMissionYieldIndex`.)
 * - `shiftCap`: unset or non-finite means DEFAULT_VIRTUE_SHIFT_CAP; anything
 *   else snaps to the nearest detent.
 * - `startTank`: defaults to "current" when the tank is known and "ideal" when
 *   it is not. "current" without tank data also falls back to "ideal": an
 *   unknown tank is not an empty one.
 * - Tank readings drop their float noise (see VIRTUE_TANK_READING_NOISE_EGGS),
 *   so a full-looking tank does not plan a drain of a stray egg or two.
 * - Humility is passed apart from C/I/K/R: it never counts against the tank
 *   and only drives the drain instruction.
 */
export function buildVirtueTankPlannerOptions(
  tank: VirtueTankSnapshot | null | undefined,
  shiftCap: number | null | undefined,
  startTank?: VirtueTankStartMode | null
): VirtueTankPlannerOptions {
  const cap = nearestVirtueShiftCapDetent(
    shiftCap != null && Number.isFinite(shiftCap) ? shiftCap : DEFAULT_VIRTUE_SHIFT_CAP
  );
  const capacity = tank && Number.isFinite(tank.capacity) && tank.capacity > 0 ? tank.capacity : DEFAULT_VIRTUE_TANK_CAPACITY;
  if (!tank) {
    return { shiftCap: cap, startMode: "ideal", capacity };
  }
  return {
    shiftCap: cap,
    startMode: startTank ?? "current",
    capacity,
    currentContents: {
      curiosity: snapVirtueTankReading(tank.fuels.curiosity),
      integrity: snapVirtueTankReading(tank.fuels.integrity),
      kindness: snapVirtueTankReading(tank.fuels.kindness),
      resilience: snapVirtueTankReading(tank.fuels.resilience),
    },
    currentHumility: snapVirtueTankReading(tank.fuels.humility),
  };
}
