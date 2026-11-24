import { describe, expect, it } from "vitest";
import {
  bestStartTime,
  isAsleepAt,
  nextAwakeMs,
  scheduleAroundSleep,
  sleepIntervals,
  type ClockScheduleInput,
  type ClockSchedule,
  type SleepWindow,
  type UtcOffsetAt,
} from "./sleep-schedule";

const UTC: UtcOffsetAt = () => 0;
const NIGHT: SleepWindow = { bedMinutes: 23 * 60, wakeMinutes: 7 * 60 };
const HOUR = 3600;
/** Monday Nov 23 2026, 9:00 UTC. */
const MONDAY_9AM = Date.UTC(2026, 10, 23, 9, 0);
const EX_DEF = 28.8 * HOUR;
const EX_HEN = 38.4 * HOUR;

const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, 23 + day, hour, minute);
const clock = (schedule: ClockSchedule, seconds: number) => new Date(schedule.startMs + seconds * 1000).toISOString().slice(5, 16);
const laneKeys = (schedule: ClockSchedule) =>
  schedule.lanes.map((lane) => lane.flatMap((block) => Array.from({ length: block.launches }, () => block.key)).join(""));

function input(overrides: Partial<ClockScheduleInput>): ClockScheduleInput {
  return { startMs: MONDAY_9AM, sleep: NIGHT, utcOffsetAt: UTC, laneFreeSeconds: [0, 0, 0], stages: [], ...overrides };
}

describe("sleep window", () => {
  it("wraps midnight", () => {
    expect(isAsleepAt(at(0, 22, 59), NIGHT, UTC)).toBe(false);
    expect(isAsleepAt(at(0, 23, 0), NIGHT, UTC)).toBe(true);
    expect(isAsleepAt(at(1, 6, 59), NIGHT, UTC)).toBe(true);
    expect(isAsleepAt(at(1, 7, 0), NIGHT, UTC)).toBe(false);
    expect(nextAwakeMs(at(0, 23, 30), NIGHT, UTC)).toBe(at(1, 7, 0));
    expect(nextAwakeMs(at(1, 3, 36), NIGHT, UTC)).toBe(at(1, 7, 0));
    expect(nextAwakeMs(at(1, 12, 0), NIGHT, UTC)).toBe(at(1, 12, 0));
  });

  it("handles a window inside one day", () => {
    const late: SleepWindow = { bedMinutes: 60, wakeMinutes: 9 * 60 };
    expect(isAsleepAt(at(0, 0, 30), late, UTC)).toBe(false);
    expect(isAsleepAt(at(0, 8, 59), late, UTC)).toBe(true);
    expect(nextAwakeMs(at(0, 2, 0), late, UTC)).toBe(at(0, 9, 0));
  });

  it("wakes at the local time across a clock change", () => {
    // UTC-7 until Sun Nov 1 2026 09:00 UTC, then UTC-8 (US fall back).
    const change = Date.UTC(2026, 10, 1, 9, 0);
    const pacific: UtcOffsetAt = (ms) => (ms < change ? -7 * 60 : -8 * 60);
    // 11:30 PM PDT on Saturday Oct 31.
    const bedtime = Date.UTC(2026, 10, 1, 6, 30);
    // 7:00 AM PST on Sunday.
    expect(nextAwakeMs(bedtime, NIGHT, pacific)).toBe(Date.UTC(2026, 10, 1, 15, 0));
  });

  it("lists the nights in a range", () => {
    const nights = sleepIntervals(at(0, 9), at(2, 9), NIGHT, UTC);
    expect(nights).toEqual([
      { fromMs: at(0, 23), toMs: at(1, 7) },
      { fromMs: at(1, 23), toMs: at(2, 7) },
    ]);
    // A night under way at the start begins there.
    expect(sleepIntervals(at(1, 2), at(1, 12), NIGHT, UTC)).toEqual([{ fromMs: at(1, 2), toMs: at(1, 7) }]);
  });
});

describe("scheduleAroundSleep", () => {
  // TechYum's dubcap virtue combo: 6 extended Defihents and 6 extended
  // Henerprises (max FTL). Sending the Henerprises first from 9 AM brings
  // them back at 11:24 PM.
  const combo = (ordered: boolean) =>
    input({
      stages: [{ ordered, kinds: [{ key: "H", durationSeconds: EX_HEN, count: 6 }, { key: "D", durationSeconds: EX_DEF, count: 6 }] }],
    });

  it("waits for the morning when the order is fixed", () => {
    const schedule = scheduleAroundSleep(combo(true));
    expect(laneKeys(schedule)).toEqual(["HHDD", "HHDD", "HHDD"]);
    expect(schedule.waits.length).toBeGreaterThanOrEqual(3);
    expect(clock(schedule, schedule.waits[0].readySeconds)).toBe("11-24T23:24");
    expect(clock(schedule, schedule.waits[0].startSeconds)).toBe("11-25T07:00");
  });

  it("orders the sends so every relaunch lands while awake", () => {
    const schedule = scheduleAroundSleep(combo(false));
    expect(schedule.waits).toEqual([]);
    expect(schedule.alarms).toBe(0);
    expect(schedule.makespanSeconds).toBeCloseTo(2 * EX_DEF + 2 * EX_HEN, 3);
    for (const send of schedule.sends) {
      expect(isAsleepAt(MONDAY_9AM + send.startSeconds * 1000, NIGHT, UTC)).toBe(false);
    }
  });

  it("keeps the given order without a sleep window", () => {
    const schedule = scheduleAroundSleep({ ...combo(false), sleep: null });
    expect(laneKeys(schedule)).toEqual(["HHDD", "HHDD", "HHDD"]);
    expect(schedule.waits).toEqual([]);
    expect(schedule.makespanSeconds).toBeCloseTo(2 * EX_DEF + 2 * EX_HEN, 3);
  });

  it("holds a slot whose ship lands overnight", () => {
    // Slot 1's ship lands at 3:00 AM Tuesday; the other two are free.
    const schedule = scheduleAroundSleep(
      input({ laneFreeSeconds: [18 * HOUR, 0, 0], stages: [{ kinds: [{ key: "S", durationSeconds: 4 * HOUR, count: 3 }] }] })
    );
    // Two shorts go now; the third waits for the first of them to return (1 PM), not the night.
    expect(schedule.waits).toEqual([]);
    expect(Math.max(...schedule.sends.map((send) => send.endSeconds))).toBe(8 * HOUR);
    // The ship in the air still holds its slot until it lands.
    expect(schedule.makespanSeconds).toBe(18 * HOUR);
    const overnight = scheduleAroundSleep(
      input({ laneFreeSeconds: [18 * HOUR, 30 * HOUR, 30 * HOUR], stages: [{ kinds: [{ key: "S", durationSeconds: 4 * HOUR, count: 1 }] }] })
    );
    expect(overnight.waits).toHaveLength(1);
    expect(clock(overnight, overnight.waits[0].startSeconds)).toBe("11-24T07:00");
  });

  it("keeps a chain's ranks in order", () => {
    const schedule = scheduleAroundSleep(
      input({
        stages: [
          {
            kinds: [
              { key: "L2", durationSeconds: 2 * HOUR, count: 2, chain: "ship", rank: 2 },
              { key: "L1", durationSeconds: 10 * HOUR, count: 2, chain: "ship", rank: 1 },
            ],
          },
        ],
      })
    );
    const firstL2 = Math.min(...schedule.sends.filter((send) => send.key === "L2").map((send) => send.startSeconds));
    const lastL1 = Math.max(...schedule.sends.filter((send) => send.key === "L1").map((send) => send.startSeconds));
    expect(firstL2).toBeGreaterThanOrEqual(lastL1);
  });

  it("waits for the stage before to return when asked", () => {
    const schedule = scheduleAroundSleep(
      input({
        sleep: null,
        stages: [
          { kinds: [{ key: "P", durationSeconds: 5 * HOUR, count: 1 }] },
          { gate: "return", kinds: [{ key: "M", durationSeconds: 1 * HOUR, count: 2 }] },
        ],
      })
    );
    expect(schedule.sends.filter((send) => send.key === "M").map((send) => send.startSeconds)).toEqual([5 * HOUR, 5 * HOUR]);
  });

  it("sends at night rather than miss a dubcap's last launch", () => {
    // A live event with 20h left (last launch by 4:55 AM); the slot's ship lands at 3:00 AM.
    const schedule = scheduleAroundSleep(
      input({
        laneFreeSeconds: [18 * HOUR, 100 * HOUR, 100 * HOUR],
        event: { windowSeconds: 20 * HOUR, marginSeconds: 5 * 60, startSeconds: 0 },
        stages: [{ event: true, kinds: [{ key: "E", durationSeconds: EX_HEN, count: 1 }] }],
      })
    );
    expect(schedule.alarms).toBe(1);
    expect(schedule.late).toBe(0);
    expect(clock(schedule, schedule.sends[0].startSeconds)).toBe("11-24T03:00");
  });

  it("starts a fresh event once prep is back and the player is up", () => {
    const schedule = scheduleAroundSleep(
      input({
        fixed: [{ key: "prep", lane: 0, startSeconds: 0, durationSeconds: 16 * HOUR }],
        event: { windowSeconds: 48 * HOUR, marginSeconds: 5 * 60 },
        stages: [
          { event: true, kinds: [{ key: "E", durationSeconds: EX_DEF, count: 3 }] },
          { gate: "return", kinds: [{ key: "O", durationSeconds: 4 * HOUR, count: 1 }] },
        ],
      })
    );
    // Prep lands 1:00 AM Tuesday; the event starts at 7:00.
    expect(clock(schedule, schedule.event!.startSeconds)).toBe("11-24T07:00");
    expect(schedule.sends.filter((send) => send.key === "E").every((send) => send.startSeconds === schedule.event!.startSeconds)).toBe(true);
    // Ordinary launches wait for the window to close.
    const ordinary = schedule.sends.find((send) => send.key === "O")!;
    expect(ordinary.startSeconds).toBeGreaterThanOrEqual(schedule.event!.endSeconds);
  });

  it("pushes fixed launches without reordering them", () => {
    const schedule = scheduleAroundSleep(
      input({
        fixed: [
          { key: "a", lane: 0, startSeconds: 0, durationSeconds: 15 * HOUR },
          // Waits on "a" returning (at midnight) in the plan's own schedule.
          { key: "b", lane: 1, startSeconds: 15 * HOUR, durationSeconds: 1 * HOUR },
        ],
        stages: [],
      })
    );
    const [a, b] = schedule.sends;
    expect(a.key).toBe("a");
    expect(b.key).toBe("b");
    expect(clock(schedule, b.startSeconds)).toBe("11-24T07:00");
  });
});

describe("bestStartTime", () => {
  it("finds a later start that dodges a wait and finishes sooner", () => {
    // 3 PM, slot 1 busy for 16h. Starting at 4:45 PM brings every ship back while awake.
    const result = bestStartTime(
      input({
        startMs: Date.UTC(2026, 10, 23, 15, 0),
        laneFreeSeconds: [16 * HOUR, 0, 0],
        stages: [
          {
            kinds: [
              { key: "H", durationSeconds: EX_HEN, count: 4 },
              { key: "M", durationSeconds: 19.2 * HOUR, count: 2 },
              { key: "S", durationSeconds: 6 * HOUR, count: 4 },
            ],
          },
        ],
      })
    )!;
    expect(result.best.offsetSeconds).toBe(1.75 * HOUR);
    expect(result.best.schedule.waits).toHaveLength(0);
    expect(result.current.finishSeconds - result.best.finishSeconds).toBeGreaterThan(HOUR);
  });

  it("finds no sooner finish when waiting overnight costs what starting later would", () => {
    // Each slot flies an extended Henerprise and then an extended Defihent, in that order: from 9 AM
    // the Henerprises land at 11:24 PM. Starting at 4:45 PM avoids that but finishes 9 minutes later.
    const result = bestStartTime(
      input({
        stages: [{ ordered: true, kinds: [{ key: "H", durationSeconds: EX_HEN, count: 3 }, { key: "D", durationSeconds: EX_DEF, count: 3 }] }],
      })
    )!;
    expect(result.current.schedule.waits).toHaveLength(3);
    // No start gets it done sooner (a later one only trades the night's idle for idle before it).
    expect(result.best.finishSeconds).toBeGreaterThanOrEqual(result.current.finishSeconds - 1e-6);
  });

  it("starts on the clock's quarter hours", () => {
    const result = bestStartTime(
      input({
        startMs: Date.UTC(2026, 10, 23, 15, 7),
        laneFreeSeconds: [16 * HOUR - 7 * 60, 0, 0],
        stages: [
          {
            kinds: [
              { key: "H", durationSeconds: EX_HEN, count: 4 },
              { key: "M", durationSeconds: 19.2 * HOUR, count: 2 },
              { key: "S", durationSeconds: 6 * HOUR, count: 4 },
            ],
          },
        ],
      })
    )!;
    expect(new Date(Date.UTC(2026, 10, 23, 15, 7) + result.best.offsetSeconds * 1000).getUTCMinutes() % 15).toBe(0);
  });

  it("keeps the current start when nothing is better", () => {
    const result = bestStartTime(input({ stages: [{ kinds: [{ key: "S", durationSeconds: 2 * HOUR, count: 3 }] }] }))!;
    expect(result.best.offsetSeconds).toBe(0);
  });

  it("doesn't scan plans tied to an event", () => {
    expect(
      bestStartTime(input({ event: { windowSeconds: 48 * HOUR, marginSeconds: 300 }, stages: [] }))
    ).toBeNull();
  });
});
