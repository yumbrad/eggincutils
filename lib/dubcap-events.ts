/**
 * Live double-capacity ("dubcap") events. The calendar comes from the egg
 * repo's events.json, which a GitHub Action refreshes from the game's
 * get_periodicals feed (wasmegg's event calendar and ascension planner read
 * the same file). It lags the game by up to an hour around an event's start.
 */

export const GAME_EVENTS_URL = "https://raw.githubusercontent.com/carpetsage/egg/main/periodicals/data/events.json";
const GAME_EVENTS_CACHE_MS = 10 * 60 * 1000;
const GAME_EVENTS_TIMEOUT_MS = 5000;

export type GameEventRecord = {
  id: string;
  type: string;
  multiplier: number;
  message?: string;
  startTimestamp: number;
  endTimestamp: number;
  /** Only Ultra subscribers get it. */
  ultra?: boolean;
};

/** A dubcap running now, timed from when the profile was read (like its in-air missions). */
export type LiveDubcapEvent = {
  id: string;
  message: string;
  multiplier: number;
  secondsRemaining: number;
  durationSeconds: number;
  ultra: boolean;
};

/**
 * The mission-capacity event running at `nowSeconds` that applies to this
 * player: Ultra-only events need Ultra. The biggest multiplier wins, then the
 * latest end.
 */
export function activeDubcapEvent(
  events: GameEventRecord[],
  nowSeconds: number,
  isUltra: boolean
): LiveDubcapEvent | null {
  let best: GameEventRecord | null = null;
  for (const event of events) {
    if (
      event.type !== "mission-capacity" ||
      !(event.multiplier > 1) ||
      !(event.startTimestamp <= nowSeconds && nowSeconds < event.endTimestamp) ||
      (event.ultra && !isUltra)
    ) {
      continue;
    }
    if (
      !best ||
      event.multiplier > best.multiplier ||
      (event.multiplier === best.multiplier && event.endTimestamp > best.endTimestamp)
    ) {
      best = event;
    }
  }
  return best
    ? {
        id: best.id,
        message: best.message || "",
        multiplier: best.multiplier,
        secondsRemaining: Math.max(0, best.endTimestamp - nowSeconds),
        durationSeconds: Math.max(0, best.endTimestamp - best.startTimestamp),
        ultra: Boolean(best.ultra),
      }
    : null;
}

let cachedEvents: { fetchedAtMs: number; events: GameEventRecord[] } | null = null;

function parseGameEvents(raw: unknown): GameEventRecord[] {
  if (!Array.isArray(raw)) {
    throw new Error("events.json is not a list");
  }
  return raw.flatMap((entry): GameEventRecord[] => {
    const record = entry as Partial<GameEventRecord>;
    return typeof record?.type === "string" &&
      Number.isFinite(record.multiplier) &&
      Number.isFinite(record.startTimestamp) &&
      Number.isFinite(record.endTimestamp)
      ? [
          {
            id: String(record.id ?? ""),
            type: record.type,
            multiplier: Number(record.multiplier),
            message: typeof record.message === "string" ? record.message : undefined,
            startTimestamp: Number(record.startTimestamp),
            endTimestamp: Number(record.endTimestamp),
            ultra: Boolean(record.ultra),
          },
        ]
      : [];
  });
}

/**
 * The live dubcap for this player, or null when none is running. A calendar
 * that can't be read counts as no event, so plans fall back to a fresh one.
 */
export async function fetchLiveDubcapEvent(
  isUltra: boolean,
  nowSeconds = Date.now() / 1000
): Promise<LiveDubcapEvent | null> {
  try {
    if (!cachedEvents || Date.now() - cachedEvents.fetchedAtMs > GAME_EVENTS_CACHE_MS) {
      const response = await fetch(GAME_EVENTS_URL, { signal: AbortSignal.timeout(GAME_EVENTS_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      cachedEvents = { fetchedAtMs: Date.now(), events: parseGameEvents(await response.json()) };
    }
    return activeDubcapEvent(cachedEvents.events, nowSeconds, isUltra);
  } catch (error) {
    console.warn(`Could not read the game event calendar: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function resetGameEventsCacheForTests(): void {
  cachedEvents = null;
}

/** The profile with the dubcap running now, if any, timed from now like its in-air missions. */
export async function withLiveDubcap<T extends { isUltra?: boolean; liveDubcap?: LiveDubcapEvent }>(
  profile: T
): Promise<T> {
  const liveDubcap = await fetchLiveDubcapEvent(Boolean(profile.isUltra));
  return liveDubcap ? { ...profile, liveDubcap } : profile;
}
