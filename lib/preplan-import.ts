import { LOCAL_PREF_KEYS, readFirstStoredString, writeStoredString } from "./local-preferences";

/**
 * Turning the attainment planner's saved plan into XP-planner pre-plan sends.
 * Client-safe: no loot or ship config imports, so the XP page bundle stays small.
 */

export const MAX_PRE_PLAN_SEND_ROWS = 200;
export const MAX_PRE_PLAN_LAUNCHES_PER_ROW = 10_000;
export const PRE_PLAN_UNTARGETED_TARGET_AFX_ID = 10000;

// Unlock order, first ship first (lib/ship-data's getShipOrder; a test keeps them in step).
export const SHIP_PROGRESSION_ORDER = [
  "CHICKEN_ONE",
  "CHICKEN_NINE",
  "CHICKEN_HEAVY",
  "BCR",
  "MILLENIUM_CHICKEN",
  "CORELLIHEN_CORVETTE",
  "GALEGGTICA",
  "CHICKFIANT",
  "VOYEGGER",
  "HENERPRISE",
  "ATREGGIES",
];

const UNTARGETED_ONLY_SHIPS = new Set(["CHICKEN_ONE", "CHICKEN_NINE", "CHICKEN_HEAVY", "BCR"]);
const SEND_DURATIONS = ["SHORT", "LONG", "EPIC"] as const;

export type PrePlanSendDuration = (typeof SEND_DURATIONS)[number];

export type PrePlanSendSpec = {
  ship: string;
  durationType: PrePlanSendDuration;
  targetAfxId: number;
  launches: number;
};

type PlannerPlanMission = {
  ship: string;
  durationType: string;
  level: number;
  targetAfxId: number;
  launches: number;
  inAir?: boolean;
};

type PlannerPlanPrepLaunch = {
  ship: string;
  durationType: string;
  launches: number;
};

export type PlannerPlanLaunches = {
  missions: PlannerPlanMission[];
  progression: { prepLaunches: PlannerPlanPrepLaunch[] };
};

export type PlannerPlanSends = {
  sends: PrePlanSendSpec[];
  /** Launches the plan has in the air already: their stars are counted, their loot isn't in hand yet. */
  inAirLaunches: number;
  /** Launches dropped past the row cap. */
  droppedLaunches: number;
};

function isSendDuration(value: string): value is PrePlanSendDuration {
  return (SEND_DURATIONS as readonly string[]).includes(value);
}

function shipRank(ship: string): number {
  const index = SHIP_PROGRESSION_ORDER.indexOf(ship);
  return index < 0 ? SHIP_PROGRESSION_ORDER.length : index;
}

function wholeLaunches(value: unknown): number {
  const launches = Math.round(Number(value));
  return Number.isFinite(launches) ? Math.max(0, launches) : 0;
}

/**
 * The plan's launches as pre-plan send rows, in an order that walks the ships
 * up the way the planner did:
 *
 * - Prep launches a mission row of the same ship and duration doesn't already
 *   cover (the planner counts prep inside those rows) come first, as
 *   untargeted sends, lowest ship first so unlock chains run in order.
 * - Mission rows follow from the lowest planned star level up, so a ship's
 *   low-star rows run before the rows that need its later stars.
 *
 * In-air rows are left out: they're launched already, so the profile's stars
 * count them and replaying them would count them twice.
 */
export function plannerPlanToPrePlanSends(plan: PlannerPlanLaunches): PlannerPlanSends {
  const missions = plan.missions.filter(
    (mission) => !mission.inAir && isSendDuration(mission.durationType) && wholeLaunches(mission.launches) > 0
  );
  const inAirLaunches = plan.missions
    .filter((mission) => mission.inAir)
    .reduce((sum, mission) => sum + wholeLaunches(mission.launches), 0);

  const missionLaunchesByShape = new Map<string, number>();
  for (const mission of missions) {
    const shape = `${mission.ship}|${mission.durationType}`;
    missionLaunchesByShape.set(shape, (missionLaunchesByShape.get(shape) || 0) + wholeLaunches(mission.launches));
  }
  const prepByShape = new Map<string, { ship: string; durationType: PrePlanSendDuration; launches: number }>();
  for (const prep of plan.progression.prepLaunches) {
    if (!isSendDuration(prep.durationType) || wholeLaunches(prep.launches) <= 0) {
      continue;
    }
    const shape = `${prep.ship}|${prep.durationType}`;
    const entry = prepByShape.get(shape) || { ship: prep.ship, durationType: prep.durationType, launches: 0 };
    entry.launches += wholeLaunches(prep.launches);
    prepByShape.set(shape, entry);
  }
  const prepSends: PrePlanSendSpec[] = Array.from(prepByShape.entries())
    .map(([shape, prep]) => ({
      ship: prep.ship,
      durationType: prep.durationType,
      targetAfxId: PRE_PLAN_UNTARGETED_TARGET_AFX_ID,
      launches: Math.max(0, prep.launches - (missionLaunchesByShape.get(shape) || 0)),
    }))
    .filter((send) => send.launches > 0)
    .sort(
      (a, b) =>
        shipRank(a.ship) - shipRank(b.ship) ||
        SEND_DURATIONS.indexOf(a.durationType) - SEND_DURATIONS.indexOf(b.durationType)
    );

  const missionSends = missions
    .map((mission, index) => ({ mission, index }))
    .sort((a, b) => a.mission.level - b.mission.level || a.index - b.index)
    .map(({ mission }): PrePlanSendSpec => ({
      ship: mission.ship,
      durationType: mission.durationType as PrePlanSendDuration,
      targetAfxId: UNTARGETED_ONLY_SHIPS.has(mission.ship)
        ? PRE_PLAN_UNTARGETED_TARGET_AFX_ID
        : Math.round(Number(mission.targetAfxId)),
      launches: wholeLaunches(mission.launches),
    }));

  // Merge neighbours that differ only by planned level, then split rows past the per-row cap.
  const merged: PrePlanSendSpec[] = [];
  for (const send of [...prepSends, ...missionSends]) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.ship === send.ship &&
      last.durationType === send.durationType &&
      last.targetAfxId === send.targetAfxId
    ) {
      last.launches += send.launches;
    } else {
      merged.push({ ...send });
    }
  }
  const sends: PrePlanSendSpec[] = [];
  let droppedLaunches = 0;
  for (const send of merged) {
    let left = send.launches;
    while (left > 0) {
      const launches = Math.min(MAX_PRE_PLAN_LAUNCHES_PER_ROW, left);
      left -= launches;
      if (sends.length < MAX_PRE_PLAN_SEND_ROWS) {
        sends.push({ ...send, launches });
      } else {
        droppedLaunches += launches;
      }
    }
  }
  return { sends, inAirLaunches, droppedLaunches };
}

type PlannerInventorySource = "main" | "virtue";

export type SavedPlannerPlan = PlannerPlanSends & {
  savedAt: string;
  eid: string;
};

/** What the attainment planner saves per inventory source for the import: just the launches. */
type StoredPlannerPlanLaunches = {
  savedAt: string;
  eid: string;
  missions: PlannerPlanMission[];
  prepLaunches: PlannerPlanPrepLaunch[];
};

const PLAN_LAUNCHES_KEYS: Record<PlannerInventorySource, string> = {
  main: LOCAL_PREF_KEYS.plannerPlanLaunchesMain,
  virtue: LOCAL_PREF_KEYS.plannerPlanLaunchesVirtue,
};

/**
 * Save a plan's launches under its inventory source, so a Virtue plan doesn't
 * replace the main-farm plan the XP planner imports (the planner's own session
 * only keeps the latest plan).
 */
export function writeSavedPlannerPlanLaunches(
  source: PlannerInventorySource,
  saved: { savedAt: string; eid: string; plan: PlannerPlanLaunches }
): void {
  const stored: StoredPlannerPlanLaunches = {
    savedAt: saved.savedAt,
    eid: saved.eid,
    missions: saved.plan.missions.map((mission) => ({
      ship: mission.ship,
      durationType: mission.durationType,
      level: mission.level,
      targetAfxId: mission.targetAfxId,
      launches: mission.launches,
      ...(mission.inAir ? { inAir: true } : {}),
    })),
    prepLaunches: saved.plan.progression.prepLaunches.map((prep) => ({
      ship: prep.ship,
      durationType: prep.durationType,
      launches: prep.launches,
    })),
  };
  writeStoredString([PLAN_LAUNCHES_KEYS[source]], JSON.stringify(stored));
}

/** The sends in the attainment planner's last plan for this inventory source, or null when there's none. */
export function readSavedPlannerPlan(source: PlannerInventorySource): SavedPlannerPlan | null {
  return (
    savedPlannerPlanFromStorage(readFirstStoredString([PLAN_LAUNCHES_KEYS[source]])) ??
    savedPlannerPlanFromSession(readFirstStoredString([LOCAL_PREF_KEYS.plannerSession]), source)
  );
}

function isLaunchRow(row: unknown): boolean {
  return (
    Boolean(row) &&
    typeof row === "object" &&
    typeof (row as { ship?: unknown }).ship === "string" &&
    typeof (row as { durationType?: unknown }).durationType === "string"
  );
}

function savedPlannerPlan(savedAt: unknown, eid: unknown, missions: unknown, prepLaunches: unknown): SavedPlannerPlan | null {
  if (!Array.isArray(missions)) {
    return null;
  }
  const converted = plannerPlanToPrePlanSends({
    missions: missions.filter(isLaunchRow) as PlannerPlanMission[],
    progression: {
      prepLaunches: (Array.isArray(prepLaunches) ? prepLaunches.filter(isLaunchRow) : []) as PlannerPlanPrepLaunch[],
    },
  });
  return {
    ...converted,
    savedAt: typeof savedAt === "string" ? savedAt : "",
    eid: typeof eid === "string" ? eid : "",
  };
}

export function savedPlannerPlanFromStorage(raw: string | null): SavedPlannerPlan | null {
  if (!raw) {
    return null;
  }
  try {
    const stored = JSON.parse(raw) as Partial<Record<keyof StoredPlannerPlanLaunches, unknown>>;
    return savedPlannerPlan(stored.savedAt, stored.eid, stored.missions, stored.prepLaunches);
  } catch {
    return null;
  }
}

/**
 * The planner's own session, for plans saved before the per-source copies
 * existed. It holds only the latest plan, so it counts only when that plan
 * was for this source.
 */
export function savedPlannerPlanFromSession(raw: string | null, source: PlannerInventorySource): SavedPlannerPlan | null {
  if (!raw) {
    return null;
  }
  try {
    const session = JSON.parse(raw) as {
      savedAt?: unknown;
      response?: { plan?: { missions?: unknown; progression?: { prepLaunches?: unknown } } };
      lastSolveRequest?: { eid?: unknown; sourceFilters?: { inventorySource?: unknown } };
    };
    if ((session.lastSolveRequest?.sourceFilters?.inventorySource ?? "main") !== source) {
      return null;
    }
    const plan = session.response?.plan;
    return savedPlannerPlan(session.savedAt, session.lastSolveRequest?.eid, plan?.missions, plan?.progression?.prepLaunches);
  } catch {
    return null;
  }
}
