import type { HighsSolveResult } from "./highs";

export const DUBCAP_WINDOW_SECONDS = 48 * 3600;
export const DUBCAP_LAUNCH_MARGIN_SECONDS = 5 * 60;

/**
 * The event a plan's dubcap launches fly in. A fresh event starts once prep
 * and current missions return, and every slot gets its whole window. A live
 * event is running now: its zero is now, it ends `windowSeconds` from now,
 * and each slot opens when its in-air ship (and any prep) returns.
 */
export type DubcapWindow = {
  windowSeconds: number;
  multiplier: number;
  live: boolean;
  /** When each slot is free for the event, from the window's zero. */
  laneStartSeconds: number[];
};

export const FRESH_DUBCAP_WINDOW: DubcapWindow = {
  windowSeconds: DUBCAP_WINDOW_SECONDS,
  multiplier: 2,
  live: false,
  laneStartSeconds: [0, 0, 0],
};

/** Seconds of a slot's event before its last launch has to leave (negative: none can). */
export function dubcapLaneCutoffSeconds(window: DubcapWindow, lane: number): number {
  return window.windowSeconds - DUBCAP_LAUNCH_MARGIN_SECONDS - (window.laneStartSeconds[lane] || 0);
}

/** A live event's window, or null when too little of it is left for a launch. */
export function liveDubcapWindow(
  event: { secondsRemaining: number; multiplier: number } | null | undefined,
  laneStartSeconds: number[] = [0, 0, 0]
): DubcapWindow | null {
  if (!event || !(event.multiplier > 1) || !(event.secondsRemaining > DUBCAP_LAUNCH_MARGIN_SECONDS)) {
    return null;
  }
  return {
    windowSeconds: event.secondsRemaining,
    multiplier: event.multiplier,
    live: true,
    laneStartSeconds: [0, 1, 2].map((lane) => Math.max(0, laneStartSeconds[lane] || 0)),
  };
}

export type DubcapAction = {
  key: string;
  optionKey: string;
  durationSeconds: number;
  dubcap?: boolean;
  /** Event copies carry their event (the same for every copy in a solve). */
  dubcapWindow?: DubcapWindow;
};

export type DubcapAllocationBlock = {
  actionKey: string;
  launches: number;
  startSeconds: number;
  endSeconds: number;
};

export type DubcapAllocation = { lanes: DubcapAllocationBlock[][]; window?: DubcapWindow };

export type DubcapTimelineBlock = Omit<DubcapAllocationBlock, "actionKey"> & {
  missionRowKey: string;
  ship: string;
  durationType: string;
  level: number;
  targetAfxId: number;
  tankIndex?: number;
};

export type DubcapScheduleBlock = Omit<DubcapTimelineBlock, "missionRowKey" | "targetAfxId"> & {
  missionRowKey?: string;
  targetAfxId?: number | null;
  isPrep: boolean;
  dubcap: boolean;
};

export type DubcapPlan = {
  /** A fresh event's length, or what was left of a live one when the profile was read. */
  windowSeconds: number;
  launchMarginSeconds: number;
  multiplier: number;
  /** A live event: times are from when the profile was read, and slots open as their ships return. */
  live: boolean;
  /** Fresh events: from the plan's start until prep and existing in-air missions have returned. Live: 0. */
  startSeconds: number;
  launches: number;
  /** Full plan completion, including prep, this event and subsequent ordinary launches. */
  makespanSeconds: number;
  /** Same launch plan timed without current in-air ships holding slots. */
  missionSeconds: number;
  /** Launch and return times from the event's start (fresh) or now (live), one lane per ship slot. */
  lanes: DubcapTimelineBlock[][];
  /** Actual plan schedule, including prep and ordinary launches, from now. */
  fullLanes: DubcapScheduleBlock[][];
};

/** Prep phases wait for their predecessors to return before unlocking/leveling a ship. */
export function scheduleDubcapPrep(
  units: Array<{ id: string; launches: number; durationSeconds: number; prepOrder?: number }>,
  inAirLaneFreeSeconds: number[] = []
): { makespanSeconds: number; lanes: DubcapAllocationBlock[][] } {
  const free = [0, 1, 2].map((lane) => Math.max(0, inAirLaneFreeSeconds[lane] || 0));
  const lanes: DubcapAllocationBlock[][] = [[], [], []];
  const phases = Array.from(new Set(units.map((unit) => unit.prepOrder ?? 0))).sort((a, b) => a - b);
  let barrier = 0;
  for (const phase of phases) {
    for (const unit of units.filter((unit) => (unit.prepOrder ?? 0) === phase)) {
      for (let launch = 0; launch < unit.launches; launch += 1) {
        let lane = 0;
        for (let candidate = 1; candidate < 3; candidate += 1) {
          if (free[candidate] < free[lane]) lane = candidate;
        }
        const startSeconds = Math.max(barrier, free[lane]);
        const endSeconds = startSeconds + unit.durationSeconds;
        lanes[lane].push({ actionKey: unit.id, launches: 1, startSeconds, endSeconds });
        free[lane] = endSeconds;
      }
    }
    barrier = Math.max(...free);
  }
  return { makespanSeconds: Math.max(...free), lanes };
}

/**
 * When each slot is free for a live event: once its in-air ship returns and,
 * when the plan has prep, once every prep launch has returned (event drops
 * use post-prep stars). The partly fueled ship (`preFueled`) only holds the
 * slot it flies from. finishDubcapSchedule replays the same prep, so a solve
 * and its schedule agree on these.
 */
export function liveDubcapLaneStarts(
  prepUnits: Array<{ id: string; launches: number; durationSeconds: number; prepOrder?: number; preFueled?: unknown }>,
  inAirLaneFreeSeconds: number[] = []
): number[] {
  const prep = scheduleDubcapPrep(prepUnits, inAirLaneFreeSeconds);
  const fueled = new Set(prepUnits.filter((unit) => unit.preFueled).map((unit) => unit.id));
  const prepEnd = Math.max(0, ...prep.lanes.flat().filter((block) => !fueled.has(block.actionKey)).map((block) => block.endSeconds));
  return [0, 1, 2].map((lane) =>
    Math.max(prepEnd, inAirLaneFreeSeconds[lane] || 0, prep.lanes[lane].at(-1)?.endSeconds ?? 0)
  );
}

type DubcapGroup = {
  indexes: number[];
  seconds: number;
  prefixes: string[];
  finals: string[];
};

export type DubcapModel = {
  window: DubcapWindow;
  groups: DubcapGroup[];
  constraints: string[];
  bounds: string[];
  integerVars: string[];
};

/** Launches the plan must make before the event (prep), which ordinary farming excludes. */
export type DubcapPrepLaunches = { launches: number; seconds: number };

/** Upper bound on ordinary launches, for the "any ordinary launch" indicator. */
const DUBCAP_ORDINARY_LAUNCH_BOUND = 100_000;

/**
 * Exact event packing for three independent slots at fixed ship levels.
 * All but the final mission in each slot must finish before the launch
 * cutoff. Its final mission can return later: the event applies at launch.
 * Target choices share a physical ship/duration/level group's lane budget.
 *
 * `dbmk` (hours from the window's zero) bounds the plan's finish as the
 * schedule builds it (scheduleAfterDubcap): ordinary launches start only once
 * every event lane has returned and the window has closed, so any ordinary
 * launch costs the rest of the window plus its share of three slots. A live
 * event's slots start late by their in-air ships and prep, which shortens
 * their budget.
 */
export function buildDubcapModel(
  actions: DubcapAction[],
  missionVars: string[],
  prep: DubcapPrepLaunches = { launches: 0, seconds: 0 }
): DubcapModel {
  const groupsByOption = new Map<string, number[]>();
  actions.forEach((action, index) => {
    if (action.dubcap) {
      const indexes = groupsByOption.get(action.optionKey) ?? [];
      indexes.push(index);
      groupsByOption.set(action.optionKey, indexes);
    }
  });
  const groups: DubcapGroup[] = Array.from(groupsByOption.values()).map((indexes, group) => ({
    indexes,
    seconds: Math.max(1, actions[indexes[0]].durationSeconds),
    prefixes: [0, 1, 2].map((lane) => `dbp_${lane}_${group}`),
    finals: [0, 1, 2].map((lane) => `dbf_${lane}_${group}`),
  }));
  const window = actions.find((action) => action.dubcap && action.dubcapWindow)?.dubcapWindow ?? FRESH_DUBCAP_WINDOW;
  const cutoffs = [0, 1, 2].map((lane) => dubcapLaneCutoffSeconds(window, lane));
  const constraints: string[] = [];
  const bounds: string[] = [];
  const integerVars: string[] = [];
  groups.forEach((group, index) => {
    constraints.push(`  db_count_${index}: ${group.indexes.map((i) => missionVars[i]).join(" + ")} - ${[...group.prefixes, ...group.finals].join(" - ")} = 0`);
    for (let lane = 0; lane < 3; lane += 1) {
      bounds.push(`  0 <= ${group.prefixes[lane]} <= ${Math.floor(Math.max(0, cutoffs[lane]) / group.seconds)}`);
      bounds.push(`  0 <= ${group.finals[lane]} <= ${cutoffs[lane] >= 0 ? 1 : 0}`);
      integerVars.push(group.prefixes[lane], group.finals[lane]);
    }
  });
  if (groups.length > 0) {
    bounds.push("  dbmk >= 0", "  0 <= dbor <= 1");
    integerVars.push("dbor");
    // Ordinary work in hours over three slots, and the ordinary launch count;
    // each is what non-event launches add beyond the required prep.
    const ordinary = actions.flatMap((action, index) => (action.dubcap ? [] : [{ action, variable: missionVars[index] }]));
    const ordinaryWork = ordinary.map(({ action, variable }) => `${action.durationSeconds / (3 * 3600)} ${variable}`);
    const prepWorkHours = prep.seconds / (3 * 3600);
    for (let lane = 0; lane < 3; lane += 1) {
      constraints.push(`  db_time_${lane}: ${groups.map((group) => `${group.seconds / 3600} ${group.prefixes[lane]}`).join(" + ")} <= ${Math.max(0, cutoffs[lane]) / 3600}`);
      constraints.push(`  db_last_${lane}: ${groups.map((group) => group.finals[lane]).join(" + ")} <= 1`);
      constraints.push(`  db_finish_${lane}: dbmk - ${[...groups.flatMap((group) => [
        `${group.seconds / 3600} ${group.prefixes[lane]}`, `${group.seconds / 3600} ${group.finals[lane]}`,
      ]), ...ordinaryWork].join(" - ")} >= ${(window.laneStartSeconds[lane] || 0) / 3600 - prepWorkHours}`);
    }
    if (ordinary.length > 0) {
      constraints.push(`  db_any: ${ordinary.map(({ variable }) => variable).join(" + ")} - ${DUBCAP_ORDINARY_LAUNCH_BOUND} dbor <= ${prep.launches}`);
      constraints.push(`  db_after: dbmk - ${window.windowSeconds / 3600} dbor - ${ordinaryWork.join(" - ")} >= ${-prepWorkHours}`);
    }
  }
  return { window, groups, constraints, bounds, integerVars };
}

/** Assign the solver's target counts to its physical lane packing. */
export function readDubcapAllocation(
  model: DubcapModel,
  actions: DubcapAction[],
  missionCounts: Record<string, number>,
  solution: HighsSolveResult
): DubcapAllocation {
  const left = { ...missionCounts };
  const lanes: DubcapAllocationBlock[][] = [[], [], []];
  const take = (group: DubcapGroup, lane: number, count: number) => {
    for (const index of group.indexes) {
      const key = actions[index].key;
      const launches = Math.min(count, Math.max(0, left[key] || 0));
      if (launches > 0) {
        const startSeconds = lanes[lane].at(-1)?.endSeconds ?? (model.window.laneStartSeconds[lane] || 0);
        lanes[lane].push({ actionKey: key, launches, startSeconds, endSeconds: startSeconds + launches * group.seconds });
        left[key] -= launches;
        count -= launches;
      }
    }
    if (count > 0) {
      throw new Error("Dubcap lane counts do not match the planned launches.");
    }
  };
  // Long missions first: their useful drops return sooner. Every prefix
  // finishes before the cutoff regardless of this order.
  const ordered = model.groups.slice().sort((a, b) => b.seconds - a.seconds);
  for (let lane = 0; lane < 3; lane += 1) {
    for (const group of ordered) {
      take(group, lane, Math.max(0, Math.round(solution.Columns?.[group.prefixes[lane]]?.Primal || 0)));
    }
    for (const group of ordered) {
      take(group, lane, Math.max(0, Math.round(solution.Columns?.[group.finals[lane]]?.Primal || 0)));
    }
  }
  if (actions.some((action) => action.dubcap && (left[action.key] || 0) > 0)) {
    throw new Error("Dubcap launches were left out of the event timeline.");
  }
  for (const lane of lanes) {
    for (const block of lane) {
      const seconds = (block.endSeconds - block.startSeconds) / block.launches;
      if (block.endSeconds - seconds > model.window.windowSeconds - DUBCAP_LAUNCH_MARGIN_SECONDS + 1e-6) {
        throw new Error("A dubcap launch would miss the event cutoff.");
      }
    }
  }
  return { lanes, window: model.window };
}

/**
 * Continue after the reserved window and event returns, retaining lane
 * occupancy. A fresh event's lanes shift to `startSeconds`; a live event's
 * are already timed from now, and an empty slot opens at its lane start. `inOrder` keeps launch starts in the given order (fuel-tank
 * order), as scheduleVirtueLaunches does: a level-up wait on one ship must
 * not let a later tank's launch go first.
 */
export function scheduleAfterDubcap(
  allocation: DubcapAllocation,
  ordinary: Array<{ key: string; durationSeconds: number; launches: number; shape?: string; level?: number }>,
  startSeconds = 0,
  inOrder = false
): { makespanSeconds: number; lanes: Array<Array<DubcapAllocationBlock>> } {
  const window = allocation.window ?? FRESH_DUBCAP_WINDOW;
  const offset = window.live ? 0 : startSeconds;
  const lanes = allocation.lanes.map((lane) => lane.map((block) => ({
    ...block, startSeconds: block.startSeconds + offset, endSeconds: block.endSeconds + offset,
  })));
  const free = lanes.map((lane, index) => lane.at(-1)?.endSeconds ?? (window.live ? Math.max(startSeconds, window.laneStartSeconds[index] || 0) : startSeconds));
  const eventReturns = Math.max(offset + window.windowSeconds, ...free);
  const phaseByShape = new Map<string, { level: number; endSeconds: number; readySeconds: number }>();
  let previousStart = 0;
  for (const row of ordinary) {
    const shape = row.shape ?? row.key;
    const previous = phaseByShape.get(shape);
    const readySeconds = previous && (row.level ?? 0) > previous.level ? previous.endSeconds : previous?.readySeconds ?? eventReturns;
    const phase = { level: row.level ?? 0, endSeconds: previous?.endSeconds ?? eventReturns, readySeconds };
    for (let launch = 0; launch < row.launches; launch += 1) {
      let lane = 0;
      for (let candidate = 1; candidate < 3; candidate += 1) {
        if (free[candidate] < free[lane]) lane = candidate;
      }
      const start = Math.max(free[lane], eventReturns, readySeconds, inOrder ? previousStart : 0);
      previousStart = start;
      const last = lanes[lane].at(-1);
      if (last?.actionKey === row.key && last.endSeconds === start) {
        last.launches += 1;
        last.endSeconds += row.durationSeconds;
      } else {
        lanes[lane].push({ actionKey: row.key, launches: 1, startSeconds: start, endSeconds: start + row.durationSeconds });
      }
      free[lane] = start + row.durationSeconds;
      phase.endSeconds = Math.max(phase.endSeconds, free[lane]);
    }
    phaseByShape.set(shape, phase);
  }
  return { makespanSeconds: Math.max(startSeconds, ...free), lanes };
}
