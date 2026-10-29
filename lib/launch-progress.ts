import { isUntargetedTargetAfxId } from "./item-utils";

/**
 * Following a plan's launches from the backup's mission list, which records
 * every launch with its ship, length, stars, target, launch time and farm.
 * Client-safe: no loot or ship config imports.
 */

/** One launched mission, newest last. */
export type LaunchRecord = {
  /** The mission's identifier in the backup. */
  id: string;
  ship: string;
  durationType: string;
  /** null when the mission was sent without a target. */
  targetAfxId: number | null;
  level: number;
  /** Unix seconds. */
  launchedAt: number;
  /** Launched from the Path of Virtue farm. */
  virtue: boolean;
};

/** How many launches a profile keeps, newest first; enough for a long plan. */
export const MAX_RECENT_LAUNCHES = 500;

type ProgressMissionRow = {
  ship: string;
  durationType: string;
  targetAfxId: number;
  level: number;
  launches: number;
  inAir?: boolean;
};

type ProgressPrepLaunch = { ship: string; durationType: string; launches: number };

type ProgressFueling = { ship: string; durationType: string; targetAfxId: number | null };

export type PlanLaunchProgress = {
  /** Launches flown for each mission row, by the row's index in the plan; in-air rows stay 0. */
  missionDone: number[];
  /** Launches flown for each prep row a mission row of its ship and length doesn't already cover. */
  prepDone: number[];
  /** Whether the partly fueled ship has launched. */
  fuelingDone: boolean;
  /** Launches the plan has left to fly (in-air rows excluded), and how many of them are done. */
  planned: number;
  done: number;
  /** New launches on this farm that match nothing left in the plan. */
  offPlan: LaunchRecord[];
  /**
   * The newest launches were kept but the plan's start fell out of the list,
   * so launches early in the plan may be missing from `done`.
   */
  incomplete: boolean;
};

function sameTarget(ship: string, planned: number | null, launched: number | null, untargetedOnly: Set<string>): boolean {
  if (untargetedOnly.has(ship)) {
    return true;
  }
  const plannedUntargeted = planned == null || isUntargetedTargetAfxId(planned);
  const launchedUntargeted = launched == null || isUntargetedTargetAfxId(launched);
  return plannedUntargeted ? launchedUntargeted : planned === launched;
}

const UNTARGETED_ONLY_SHIPS = new Set(["CHICKEN_ONE", "CHICKEN_NINE", "CHICKEN_HEAVY", "BCR"]);

/** Launches in `current` that `baseline` didn't have, oldest first. */
export function launchesSince(baseline: LaunchRecord[], current: LaunchRecord[]): LaunchRecord[] {
  const seen = new Set(baseline.map((launch) => launch.id));
  return current.filter((launch) => !seen.has(launch.id)).sort((a, b) => a.launchedAt - b.launchedAt);
}

/**
 * Match the launches made since the plan's profile was read to the plan, in
 * launch order:
 *
 * 1. the partly fueled ship, which launches first;
 * 2. a mission row of the same ship, length and target, lowest stars first;
 * 3. a prep row of the same ship and length (prep flies at any target), for
 *    the launches mission rows of that shape don't already count.
 *
 * Launches from the other farm are left out: they level the same ships but
 * aren't part of this plan. Whatever is left is off the plan.
 */
export function planLaunchProgress(options: {
  missions: ProgressMissionRow[];
  prepLaunches: ProgressPrepLaunch[];
  fueling: ProgressFueling | null;
  virtue: boolean;
  baseline: LaunchRecord[];
  current: LaunchRecord[];
}): PlanLaunchProgress {
  const { missions, prepLaunches, fueling, virtue, baseline, current } = options;
  const missionDone = missions.map(() => 0);
  const missionLeft = missions.map((row) => (row.inAir ? 0 : Math.max(0, Math.round(row.launches))));
  const coveredByShape = new Map<string, number>();
  missions.forEach((row, index) => {
    const shape = `${row.ship}|${row.durationType}`;
    coveredByShape.set(shape, (coveredByShape.get(shape) || 0) + missionLeft[index]);
  });
  const prepLeft = prepLaunches.map((prep) => {
    const shape = `${prep.ship}|${prep.durationType}`;
    const covered = coveredByShape.get(shape) || 0;
    const left = Math.max(0, Math.round(prep.launches) - covered);
    coveredByShape.set(shape, Math.max(0, covered - Math.round(prep.launches)));
    return left;
  });
  const prepDone = prepLaunches.map(() => 0);
  const planned =
    missionLeft.reduce((sum, left) => sum + left, 0) + prepLeft.reduce((sum, left) => sum + left, 0) + (fueling ? 1 : 0);

  const rowOrder = missions
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.level - b.row.level || a.index - b.index);

  let fuelingDone = false;
  const offPlan: LaunchRecord[] = [];
  for (const launch of launchesSince(baseline, current)) {
    if (launch.virtue !== virtue) {
      continue;
    }
    if (
      fueling &&
      !fuelingDone &&
      launch.ship === fueling.ship &&
      launch.durationType === fueling.durationType &&
      sameTarget(launch.ship, fueling.targetAfxId, launch.targetAfxId, UNTARGETED_ONLY_SHIPS)
    ) {
      fuelingDone = true;
      continue;
    }
    const row = rowOrder.find(
      ({ row: candidate, index }) =>
        missionLeft[index] > 0 &&
        candidate.ship === launch.ship &&
        candidate.durationType === launch.durationType &&
        sameTarget(launch.ship, candidate.targetAfxId, launch.targetAfxId, UNTARGETED_ONLY_SHIPS)
    );
    if (row) {
      missionLeft[row.index] -= 1;
      missionDone[row.index] += 1;
      continue;
    }
    const prepIndex = prepLaunches.findIndex(
      (prep, index) => prepLeft[index] > 0 && prep.ship === launch.ship && prep.durationType === launch.durationType
    );
    if (prepIndex >= 0) {
      prepLeft[prepIndex] -= 1;
      prepDone[prepIndex] += 1;
      continue;
    }
    offPlan.push(launch);
  }

  const baselineNewest = baseline.reduce((max, launch) => Math.max(max, launch.launchedAt), 0);
  const currentOldest = current.reduce((min, launch) => Math.min(min, launch.launchedAt), Number.POSITIVE_INFINITY);
  const done =
    missionDone.reduce((sum, count) => sum + count, 0) + prepDone.reduce((sum, count) => sum + count, 0) + (fuelingDone ? 1 : 0);
  return {
    missionDone,
    prepDone,
    fuelingDone,
    planned,
    done,
    offPlan,
    incomplete: current.length >= MAX_RECENT_LAUNCHES && baseline.length > 0 && currentOldest > baselineNewest,
  };
}
