/**
 * Send times around the player's sleep. A launch only leaves while the player
 * is awake: a slot that frees up overnight waits for the morning. Where the
 * plan leaves the order free, the scheduler also picks which launch goes next
 * so ships come back while the player is up.
 *
 * Times are seconds from the plan's start (`startMs`). The sleep window is in
 * local wall-clock time, so it follows the player's time zone and DST.
 */

export type SleepWindow = {
  /** Minutes after local midnight the player goes to bed. */
  bedMinutes: number;
  /** Minutes after local midnight the player gets up. */
  wakeMinutes: number;
};

/** Minutes east of UTC at an instant. */
export type UtcOffsetAt = (ms: number) => number;

export const localUtcOffsetAt: UtcOffsetAt = (ms) => -new Date(ms).getTimezoneOffset();

const DAY_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;
const LANES = 3;

function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

export function localMinuteOfDay(ms: number, offsetAt: UtcOffsetAt = localUtcOffsetAt): number {
  return mod(ms / MINUTE_MS + offsetAt(ms), DAY_MINUTES);
}

/** How long the player sleeps, in minutes (0 when bed and wake are the same time). */
export function sleepLengthMinutes(sleep: SleepWindow): number {
  return mod(sleep.wakeMinutes - sleep.bedMinutes, DAY_MINUTES);
}

export function isAsleepAt(ms: number, sleep: SleepWindow, offsetAt: UtcOffsetAt = localUtcOffsetAt): boolean {
  const length = sleepLengthMinutes(sleep);
  return length > 0 && mod(localMinuteOfDay(ms, offsetAt) - sleep.bedMinutes, DAY_MINUTES) < length;
}

/** The first instant after `ms` (or at it) whose local time of day is `minuteOfDay`. */
function nextLocalMinute(ms: number, minuteOfDay: number, offsetAt: UtcOffsetAt): number {
  let at = ms + mod(minuteOfDay - localMinuteOfDay(ms, offsetAt), DAY_MINUTES) * MINUTE_MS;
  // A DST change in between moves the wall clock an hour: land on the local minute itself.
  const drift = mod(localMinuteOfDay(at, offsetAt) - minuteOfDay + DAY_MINUTES / 2, DAY_MINUTES) - DAY_MINUTES / 2;
  at = Math.round(at - drift * MINUTE_MS);
  return at < ms ? at + DAY_MINUTES * MINUTE_MS : at;
}

/** `ms` when the player is awake then, otherwise when they get up. */
export function nextAwakeMs(ms: number, sleep: SleepWindow, offsetAt: UtcOffsetAt = localUtcOffsetAt): number {
  return isAsleepAt(ms, sleep, offsetAt) ? nextLocalMinute(ms, sleep.wakeMinutes, offsetAt) : ms;
}

/**
 * Every sleep that overlaps [fromMs, toMs), whole (a night under way at
 * `fromMs` starts there).
 */
export function sleepIntervals(
  fromMs: number,
  toMs: number,
  sleep: SleepWindow,
  offsetAt: UtcOffsetAt = localUtcOffsetAt
): Array<{ fromMs: number; toMs: number }> {
  const intervals: Array<{ fromMs: number; toMs: number }> = [];
  if (sleepLengthMinutes(sleep) === 0 || !(toMs > fromMs)) {
    return intervals;
  }
  let cursor = fromMs;
  for (let guard = 0; cursor < toMs && guard < 10_000; guard += 1) {
    const bed = isAsleepAt(cursor, sleep, offsetAt) ? cursor : nextLocalMinute(cursor, sleep.bedMinutes, offsetAt);
    if (bed >= toMs) {
      break;
    }
    const wake = nextLocalMinute(bed + 1, sleep.wakeMinutes, offsetAt);
    intervals.push({ fromMs: bed, toMs: wake });
    cursor = wake;
  }
  return intervals;
}

/** Sleep as seconds from a plan's start, grown as far ahead as the schedule looks. */
class SleepCalendar {
  private readonly from: number[] = [];
  private readonly to: number[] = [];
  private horizon = 0;

  constructor(
    private readonly startMs: number,
    private readonly sleep: SleepWindow,
    private readonly offsetAt: UtcOffsetAt,
    private readonly awakeForSeconds: number
  ) {
    this.extend(14 * 24 * 3600);
  }

  private extend(toSeconds: number): void {
    const horizon = Math.max(toSeconds, this.horizon * 2);
    this.from.length = 0;
    this.to.length = 0;
    for (const night of sleepIntervals(this.startMs, this.startMs + horizon * 1000, this.sleep, this.offsetAt)) {
      const from = Math.max((night.fromMs - this.startMs) / 1000, this.awakeForSeconds);
      const to = (night.toMs - this.startMs) / 1000;
      if (to > from) {
        this.from.push(from);
        this.to.push(to);
      }
    }
    this.horizon = horizon;
  }

  /** `t` when awake then, otherwise when the player gets up. */
  awake(t: number): number {
    if (t >= this.horizon - 2 * 24 * 3600) {
      this.extend(t + 30 * 24 * 3600);
    }
    let lo = 0;
    let hi = this.from.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.from[mid] <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found >= 0 && t < this.to[found] ? this.to[found] : t;
  }
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

/** Launches that may go in any order among themselves (subject to chains). */
export type ClockKind = {
  /** Display key: back-to-back sends of a key in a slot form one block. */
  key: string;
  durationSeconds: number;
  count: number;
  /** Launches of one chain go in rank order (a ship's levels). */
  chain?: string;
  rank?: number;
};

export type ClockStage = {
  kinds: ClockKind[];
  /**
   * When the stage may begin: once the sends before it have all left
   * ("start", the default) or once they are all back ("return").
   */
  gate?: "start" | "return";
  gateDelaySeconds?: number;
  /** A chain's next rank waits for the rank before it to leave (default) or come back. */
  chainGate?: "start" | "return";
  /** Launches in the event: they have to leave by its last-launch time. */
  event?: boolean;
  /** Keep the listed order. */
  ordered?: boolean;
};

/** A launch kept in its slot and order, only pushed later (prep ahead of a dubcap). */
export type ClockFixedLaunch = {
  key: string;
  lane: number;
  startSeconds: number;
  durationSeconds: number;
  /** Slot time with no send of its own: it never waits for the morning. */
  pseudo?: boolean;
  /** An event launch (a live dubcap's partly fueled ship): it doesn't hold the event's other launches. */
  event?: boolean;
};

export type ClockEvent = {
  windowSeconds: number;
  marginSeconds: number;
  /** The event's start, from t=0. Absent: it starts when the slots are free after the fixed launches (a fresh one). */
  startSeconds?: number;
};

export type ClockScheduleInput = {
  startMs: number;
  sleep: SleepWindow | null;
  utcOffsetAt?: UtcOffsetAt;
  /** The player is up for this long from t=0 (planning now), whatever the clock says. */
  awakeForSeconds?: number;
  /** When each slot frees up (ships in the air), from t=0. */
  laneFreeSeconds: number[];
  fixed?: ClockFixedLaunch[];
  stages: ClockStage[];
  event?: ClockEvent;
  /** "quick" skips the look-ahead search (scanning start times). */
  effort?: "quick" | "full";
};

export type ClockSend = {
  key: string;
  lane: number;
  /** When the slot and the plan were ready for it; earlier than `startSeconds` when it waited for the morning. */
  readySeconds: number;
  startSeconds: number;
  endSeconds: number;
  /** Sent while asleep to leave before the event's last-launch time. */
  alarm: boolean;
  /** Left after the event's last-launch time. */
  late: boolean;
  event: boolean;
  pseudo: boolean;
};

export type ClockBlock = {
  key: string;
  launches: number;
  startSeconds: number;
  endSeconds: number;
  /** The block's first send waited for the morning from this time. */
  waitFromSeconds?: number;
  alarm: boolean;
  late: boolean;
  event: boolean;
  pseudo: boolean;
};

export type ClockSchedule = {
  startMs: number;
  /** In send order. */
  sends: ClockSend[];
  /** Three slots; back-to-back sends of a key form one block. */
  lanes: ClockBlock[][];
  makespanSeconds: number;
  /** Sends that waited for the morning. */
  waits: ClockSend[];
  waitSeconds: number;
  alarms: number;
  late: number;
  event?: { startSeconds: number; lastLaunchSeconds: number; endSeconds: number };
};

type Policy = "original" | "lpt" | "spt" | "fit-lpt" | "fit-spt";

type PreparedKind = {
  key: string;
  duration: number;
  chain: number;
  rank: number;
  /** Kinds of the same stage and chain with a lower rank: this one waits for them. */
  blockers: number[];
};

type PreparedStage = {
  kinds: number[];
  total: number;
  gate: "start" | "return";
  delay: number;
  chainReturn: boolean;
  event: boolean;
  ordered: boolean;
  afterEvent: boolean;
};

type Prepared = {
  calendar: SleepCalendar | null;
  kinds: PreparedKind[];
  counts: number[];
  stages: PreparedStage[];
  chainCount: number;
  total: number;
  fixedSends: ClockSend[];
  laneFree: number[];
  lastStart: number;
  maxEnd: number;
  event: { zero: number; open: number; deadline: number; end: number } | null;
};

type State = {
  laneFree: number[];
  counts: number[];
  stage: number;
  stageLeft: number;
  gate: number;
  lastStart: number;
  maxEnd: number;
  /** Per chain: rank, its latest start and return, and the latest start and return of the ranks before it. */
  chains: number[];
  left: number;
  late: number;
  alarms: number;
  waitSeconds: number;
  sends: ClockSend[] | null;
};

type Choice = {
  kind: number;
  ready: number;
  start: number;
  end: number;
  alarm: boolean;
  late: boolean;
  returnWait: number;
};

const CHAIN_FIELDS = 5;
const NO_RANK = -1e18;
const ROLLOUT_CANDIDATES = 4;
const ROLLOUT_WORK_LIMIT = 4e6;

function prepare(input: ClockScheduleInput): Prepared {
  const calendar = input.sleep && sleepLengthMinutes(input.sleep) > 0
    ? new SleepCalendar(input.startMs, input.sleep, input.utcOffsetAt ?? localUtcOffsetAt, Math.max(0, input.awakeForSeconds ?? 0))
    : null;
  const awake = (t: number) => (calendar ? calendar.awake(t) : t);

  const laneFree = Array.from({ length: LANES }, (_, lane) => Math.max(0, Number(input.laneFreeSeconds[lane]) || 0));
  // Only an event with a known start can have fixed launches in it (a live one).
  const knownDeadline =
    input.event?.startSeconds != null ? input.event.startSeconds + input.event.windowSeconds - input.event.marginSeconds : null;
  const fixedSends: ClockSend[] = [];
  let lastStart = 0;
  let maxEnd = 0;
  let holdEnd = 0;
  // Fixed launches keep their slot and order. A launch is pushed at least as
  // far as any launch that left before it, so whatever it waited on still
  // comes first.
  const fixed = (input.fixed ?? []).slice().sort((a, b) => a.startSeconds - b.startSeconds);
  let push = 0;
  for (const launch of fixed) {
    const lane = Math.min(LANES - 1, Math.max(0, Math.round(launch.lane)));
    const ready = Math.max(laneFree[lane], launch.startSeconds + push);
    let start = launch.pseudo ? ready : awake(ready);
    let alarm = false;
    // An event launch the morning would push past the last-launch time goes at night instead.
    if (launch.event && knownDeadline != null && start > knownDeadline && ready <= knownDeadline) {
      start = ready;
      alarm = true;
    }
    push = Math.max(push, start - launch.startSeconds);
    const end = start + launch.durationSeconds;
    laneFree[lane] = end;
    lastStart = Math.max(lastStart, start);
    maxEnd = Math.max(maxEnd, end);
    if (!launch.event) holdEnd = Math.max(holdEnd, end);
    fixedSends.push({
      key: launch.key, lane, readySeconds: ready, startSeconds: start, endSeconds: end,
      alarm, late: Boolean(launch.event) && knownDeadline != null && start > knownDeadline,
      event: Boolean(launch.event), pseudo: Boolean(launch.pseudo),
    });
  }

  let event: Prepared["event"] = null;
  if (input.event) {
    const zero = input.event.startSeconds ?? awake(Math.max(...laneFree));
    const deadline = zero + input.event.windowSeconds - input.event.marginSeconds;
    event = { zero, open: Math.max(zero, holdEnd), deadline, end: zero + input.event.windowSeconds };
  }

  const kinds: PreparedKind[] = [];
  const counts: number[] = [];
  // Chains are per stage: a stage's first rank never waits on an earlier stage's.
  const chainIds = new Map<string, number>();
  const stages: PreparedStage[] = [];
  let seenEvent = false;
  let total = 0;
  for (const [stageIndex, stage] of input.stages.entries()) {
    const indexes: number[] = [];
    let stageTotal = 0;
    for (const kind of stage.kinds) {
      const count = Math.max(0, Math.round(Number(kind.count) || 0));
      if (count <= 0) continue;
      let chain = -1;
      if (kind.chain != null) {
        const chainKey = `${stageIndex}|${kind.chain}`;
        chain = chainIds.get(chainKey) ?? chainIds.size;
        chainIds.set(chainKey, chain);
      }
      indexes.push(kinds.length);
      kinds.push({
        key: kind.key,
        duration: Math.max(0, Number(kind.durationSeconds) || 0),
        chain,
        rank: Number.isFinite(kind.rank) ? Number(kind.rank) : 0,
        blockers: [],
      });
      counts.push(count);
      stageTotal += count;
    }
    if (stageTotal === 0) continue;
    for (const index of indexes) {
      const kind = kinds[index];
      if (kind.chain < 0) continue;
      kind.blockers = indexes.filter((other) => kinds[other].chain === kind.chain && kinds[other].rank < kind.rank);
    }
    const isEvent = Boolean(stage.event) && event !== null;
    stages.push({
      kinds: indexes,
      total: stageTotal,
      gate: stage.gate ?? "start",
      delay: Math.max(0, Number(stage.gateDelaySeconds) || 0),
      chainReturn: stage.chainGate === "return",
      event: isEvent,
      ordered: Boolean(stage.ordered),
      afterEvent: !isEvent && seenEvent,
    });
    if (isEvent) seenEvent = true;
    total += stageTotal;
  }

  return {
    calendar, kinds, counts, stages, chainCount: chainIds.size, total,
    fixedSends, laneFree, lastStart, maxEnd, event,
  };
}

function initialState(prepared: Prepared, record: boolean): State {
  const chains: number[] = [];
  for (let chain = 0; chain < prepared.chainCount; chain += 1) {
    chains.push(NO_RANK, 0, 0, 0, 0);
  }
  return {
    laneFree: prepared.laneFree.slice(),
    counts: prepared.counts.slice(),
    stage: -1,
    stageLeft: 0,
    gate: 0,
    lastStart: prepared.lastStart,
    maxEnd: prepared.maxEnd,
    chains,
    left: prepared.total,
    late: prepared.fixedSends.filter((send) => send.late).length,
    alarms: prepared.fixedSends.filter((send) => send.alarm).length,
    waitSeconds: prepared.fixedSends.reduce((sum, send) => sum + (send.alarm ? 0 : send.startSeconds - send.readySeconds), 0),
    sends: record ? [] : null,
  };
}

function cloneState(state: State): State {
  return {
    ...state,
    laneFree: state.laneFree.slice(),
    counts: state.counts.slice(),
    chains: state.chains.slice(),
    sends: null,
  };
}

function openNextStage(prepared: Prepared, state: State): void {
  state.stage += 1;
  const stage = prepared.stages[state.stage];
  let gate = (stage.gate === "return" ? state.maxEnd : state.lastStart) + stage.delay;
  if (prepared.event && stage.event) gate = Math.max(gate, prepared.event.open);
  if (prepared.event && stage.afterEvent) gate = Math.max(gate, prepared.event.end);
  state.gate = gate;
  state.stageLeft = stage.total;
}

function chainEarliest(prepared: Prepared, state: State, kind: PreparedKind, chainReturn: boolean): number {
  if (kind.chain < 0) return 0;
  const base = kind.chain * CHAIN_FIELDS;
  const rank = state.chains[base];
  const field = chainReturn ? 1 : 0;
  // Ranks before the chain's current one, and the current one when this kind is past it.
  const before = state.chains[base + 3 + field];
  return kind.rank > rank ? Math.max(before, state.chains[base + 1 + field]) : before;
}

function evaluate(prepared: Prepared, state: State, kindIndex: number, base: number, stage: PreparedStage): Choice {
  const kind = prepared.kinds[kindIndex];
  const ready = Math.max(base, chainEarliest(prepared, state, kind, stage.chainReturn));
  const calendar = prepared.calendar;
  let start = calendar ? calendar.awake(ready) : ready;
  let alarm = false;
  let late = false;
  if (stage.event && prepared.event) {
    const deadline = prepared.event.deadline;
    if (start > deadline && ready <= deadline) {
      start = ready;
      alarm = true;
    }
    late = start > deadline;
  }
  const end = start + kind.duration;
  const returnWait = calendar && state.left - 1 >= LANES ? calendar.awake(end) - end : 0;
  return { kind: kindIndex, ready, start, end, alarm, late, returnWait };
}

function candidates(prepared: Prepared, state: State, base: number): Choice[] {
  const stage = prepared.stages[state.stage];
  const choices: Choice[] = [];
  for (const kindIndex of stage.kinds) {
    if (state.counts[kindIndex] <= 0) continue;
    const kind = prepared.kinds[kindIndex];
    if (kind.blockers.some((blocker) => state.counts[blocker] > 0)) continue;
    choices.push(evaluate(prepared, state, kindIndex, base, stage));
    if (stage.ordered) break;
  }
  return choices;
}

function better(policy: Policy, prepared: Prepared, a: Choice, b: Choice): boolean {
  const da = prepared.kinds[a.kind].duration;
  const db = prepared.kinds[b.kind].duration;
  switch (policy) {
    case "original":
      return a.kind < b.kind;
    case "lpt":
      return da !== db ? da > db : a.kind < b.kind;
    case "spt":
      return da !== db ? da < db : a.kind < b.kind;
    default: {
      if (a.late !== b.late) return !a.late;
      if (a.alarm !== b.alarm) return !a.alarm;
      if (a.start !== b.start) return a.start < b.start;
      if (a.returnWait !== b.returnWait) return a.returnWait < b.returnWait;
      if (da !== db) return policy === "fit-lpt" ? da > db : da < db;
      return a.kind < b.kind;
    }
  }
}

function pick(policy: Policy, prepared: Prepared, choices: Choice[]): Choice {
  let best = choices[0];
  for (let index = 1; index < choices.length; index += 1) {
    if (better(policy, prepared, choices[index], best)) best = choices[index];
  }
  return best;
}

function earliestLane(state: State): number {
  let lane = 0;
  for (let candidate = 1; candidate < LANES; candidate += 1) {
    if (state.laneFree[candidate] < state.laneFree[lane]) lane = candidate;
  }
  return lane;
}

function commit(prepared: Prepared, state: State, lane: number, choice: Choice): void {
  const kind = prepared.kinds[choice.kind];
  state.counts[choice.kind] -= 1;
  state.stageLeft -= 1;
  state.left -= 1;
  state.laneFree[lane] = choice.end;
  state.lastStart = Math.max(state.lastStart, choice.start);
  state.maxEnd = Math.max(state.maxEnd, choice.end);
  if (kind.chain >= 0) {
    const base = kind.chain * CHAIN_FIELDS;
    const chains = state.chains;
    if (kind.rank > chains[base]) {
      chains[base + 3] = Math.max(chains[base + 3], chains[base + 1]);
      chains[base + 4] = Math.max(chains[base + 4], chains[base + 2]);
      chains[base] = kind.rank;
      chains[base + 1] = choice.start;
      chains[base + 2] = choice.end;
    } else {
      chains[base + 1] = Math.max(chains[base + 1], choice.start);
      chains[base + 2] = Math.max(chains[base + 2], choice.end);
    }
  }
  if (choice.late) state.late += 1;
  if (choice.alarm) state.alarms += 1;
  else state.waitSeconds += choice.start - choice.ready;
  state.sends?.push({
    key: kind.key, lane, readySeconds: choice.ready, startSeconds: choice.start, endSeconds: choice.end,
    alarm: choice.alarm, late: choice.late, event: prepared.stages[state.stage].event, pseudo: false,
  });
}

function step(prepared: Prepared, state: State, choose: (choices: Choice[], lane: number) => Choice): void {
  while (state.stageLeft <= 0) openNextStage(prepared, state);
  const lane = earliestLane(state);
  const base = Math.max(state.laneFree[lane], state.gate);
  const choices = candidates(prepared, state, base);
  commit(prepared, state, lane, choose(choices, lane));
}

function finishWith(prepared: Prepared, state: State, policy: Policy): State {
  const choose = (choices: Choice[]) => pick(policy, prepared, choices);
  while (state.left > 0) step(prepared, state, choose);
  return state;
}

type Score = [late: number, alarms: number, makespan: number, wait: number];

function score(state: State): Score {
  return [state.late, state.alarms, Math.max(...state.laneFree, state.maxEnd), state.waitSeconds];
}

function scoreBefore(a: readonly number[], b: readonly number[]): boolean {
  for (let index = 0; index < a.length; index += 1) {
    if (Math.abs(a[index] - b[index]) > 1e-6) return a[index] < b[index];
  }
  return false;
}

/** Each decision tries its best few launches, finishing the plan greedily after each, and keeps the best. */
function rollout(prepared: Prepared, base: Policy): State {
  const state = initialState(prepared, true);
  const choose = (choices: Choice[], lane: number): Choice => {
    if (choices.length <= 1) return choices[0];
    const ranked = choices.slice().sort((a, b) => (better(base, prepared, a, b) ? -1 : better(base, prepared, b, a) ? 1 : 0));
    let best: Choice = ranked[0];
    let bestScore: Score | null = null;
    for (const choice of ranked.slice(0, ROLLOUT_CANDIDATES)) {
      const trial = cloneState(state);
      commit(prepared, trial, lane, choice);
      const trialScore = score(finishWith(prepared, trial, base));
      if (!bestScore || scoreBefore(trialScore, bestScore)) {
        best = choice;
        bestScore = trialScore;
      }
    }
    return best;
  };
  while (state.left > 0) step(prepared, state, choose);
  return state;
}

function toSchedule(input: ClockScheduleInput, prepared: Prepared, state: State): ClockSchedule {
  const sends = [...prepared.fixedSends, ...(state.sends ?? [])].sort(
    (a, b) => a.startSeconds - b.startSeconds || a.lane - b.lane
  );
  const lanes: ClockBlock[][] = Array.from({ length: LANES }, () => []);
  for (const send of sends.slice().sort((a, b) => a.lane - b.lane || a.startSeconds - b.startSeconds)) {
    const lane = lanes[send.lane];
    const last = lane.at(-1);
    const waited = !send.alarm && send.startSeconds > send.readySeconds + 1e-6;
    if (
      last && last.key === send.key && !waited && Math.abs(last.endSeconds - send.startSeconds) < 1e-6 &&
      last.alarm === send.alarm && last.late === send.late
    ) {
      last.launches += 1;
      last.endSeconds = send.endSeconds;
    } else {
      lane.push({
        key: send.key, launches: 1, startSeconds: send.startSeconds, endSeconds: send.endSeconds,
        ...(waited ? { waitFromSeconds: send.readySeconds } : {}),
        alarm: send.alarm, late: send.late, event: send.event, pseudo: send.pseudo,
      });
    }
  }
  const waits = sends.filter((send) => !send.alarm && !send.pseudo && send.startSeconds > send.readySeconds + 1e-6);
  return {
    startMs: input.startMs,
    sends,
    lanes,
    makespanSeconds: Math.max(0, ...state.laneFree, state.maxEnd),
    waits,
    waitSeconds: waits.reduce((sum, send) => sum + send.startSeconds - send.readySeconds, 0),
    alarms: sends.filter((send) => send.alarm).length,
    late: sends.filter((send) => send.late).length,
    ...(prepared.event
      ? { event: { startSeconds: prepared.event.zero, lastLaunchSeconds: prepared.event.deadline, endSeconds: prepared.event.end } }
      : {}),
  };
}

/**
 * Time the plan's launches around the player's sleep. Without a sleep window
 * the launches go in the order given; with one, each list order and a
 * look-ahead search are tried and the best schedule wins: fewest event
 * launches missed, then fewest night sends, then the earliest finish, then
 * the least waiting.
 */
export function scheduleAroundSleep(input: ClockScheduleInput): ClockSchedule {
  const prepared = prepare(input);
  if (!prepared.calendar) {
    return toSchedule(input, prepared, finishWith(prepared, initialState(prepared, true), "original"));
  }
  const policies: Policy[] = input.effort === "quick" ? ["original", "fit-lpt", "fit-spt"] : ["original", "lpt", "spt", "fit-lpt", "fit-spt"];
  let best: State | null = null;
  let bestScore: Score | null = null;
  const consider = (state: State) => {
    const stateScore = score(state);
    if (!bestScore || scoreBefore(stateScore, bestScore)) {
      best = state;
      bestScore = stateScore;
    }
  };
  for (const policy of policies) {
    consider(finishWith(prepared, initialState(prepared, true), policy));
  }
  const maxKinds = Math.max(1, ...prepared.stages.map((stage) => stage.kinds.length));
  const work = prepared.total * prepared.total * Math.min(ROLLOUT_CANDIDATES, maxKinds) * maxKinds;
  if (input.effort !== "quick" && maxKinds > 1 && work <= ROLLOUT_WORK_LIMIT) {
    consider(rollout(prepared, "fit-lpt"));
    consider(rollout(prepared, "fit-spt"));
  }
  return toSchedule(input, prepared, best!);
}

export type StartTimeOption = {
  /** Seconds after the given start. */
  offsetSeconds: number;
  schedule: ClockSchedule;
  /** Seconds from the given start to the last return. */
  finishSeconds: number;
};

/**
 * The best time to start within the next `withinSeconds` (on the clock's
 * `stepSeconds` marks, awake times only): ships in the air still land when
 * they land, and the plan's launches all move with the start. Best is the
 * fewest night sends, then the earliest finish, then the fewest relaunches
 * waiting for the morning. A wait overnight usually costs what starting
 * later would, so a later start rarely finishes sooner; it does when one
 * start time dodges several waits at once. Plans with an event are tied to
 * it and aren't scanned.
 */
export function bestStartTime(
  input: ClockScheduleInput,
  options: { stepSeconds?: number; withinSeconds?: number } = {}
): { current: StartTimeOption; best: StartTimeOption } | null {
  if (!input.sleep || sleepLengthMinutes(input.sleep) === 0 || input.event) {
    return null;
  }
  const step = Math.max(60, options.stepSeconds ?? 15 * 60);
  const within = Math.max(0, options.withinSeconds ?? 24 * 3600);
  const offsetAt = input.utcOffsetAt ?? localUtcOffsetAt;
  const shifted = (offset: number, effort: "quick" | "full"): ClockScheduleInput => ({
    ...input,
    effort,
    startMs: input.startMs + offset * 1000,
    awakeForSeconds: offset === 0 ? input.awakeForSeconds : 0,
    laneFreeSeconds: input.laneFreeSeconds.map((seconds) => Math.max(0, seconds - offset)),
    fixed: input.fixed?.map((launch) => ({ ...launch, startSeconds: Math.max(0, launch.startSeconds - offset) })),
  });
  const option = (offset: number, effort: "quick" | "full"): StartTimeOption => {
    const schedule = scheduleAroundSleep(shifted(offset, effort));
    return { offsetSeconds: offset, schedule, finishSeconds: offset + schedule.makespanSeconds };
  };
  const rank = (candidate: StartTimeOption): number[] => [
    candidate.schedule.late,
    candidate.schedule.alarms,
    candidate.finishSeconds,
    candidate.schedule.waits.length,
    candidate.schedule.waitSeconds,
  ];
  let best: StartTimeOption | null = null;
  // On the clock's marks (quarter hours by default), not the plan's start plus steps.
  const firstOffset = (Math.ceil((input.startMs + 1000) / (step * 1000)) * step * 1000 - input.startMs) / 1000;
  for (let offset = firstOffset; offset <= within; offset += step) {
    if (isAsleepAt(input.startMs + offset * 1000, input.sleep, offsetAt)) continue;
    const candidate = option(offset, "quick");
    if (!best || scoreBefore(rank(candidate), rank(best))) best = candidate;
  }
  const current = option(0, input.effort ?? "full");
  if (!best) {
    return { current, best: current };
  }
  const refined = option(best.offsetSeconds, input.effort ?? "full");
  return { current, best: scoreBefore(rank(refined), rank(current)) ? refined : current };
}
