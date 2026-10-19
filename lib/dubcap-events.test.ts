import { describe, expect, it } from "vitest";

import { activeDubcapEvent, type GameEventRecord } from "./dubcap-events";

const HOUR = 3600;
const event = (overrides: Partial<GameEventRecord>): GameEventRecord => ({
  id: "event-10-19", type: "mission-capacity", multiplier: 2, message: "DOUBLE CAPACITY!",
  startTimestamp: 1000 * HOUR, endTimestamp: 1048 * HOUR, ultra: false, ...overrides,
});

describe("activeDubcapEvent", () => {
  it("times the running event from now", () => {
    expect(activeDubcapEvent([event({})], 1018 * HOUR, false)).toEqual({
      id: "event-10-19", message: "DOUBLE CAPACITY!", multiplier: 2,
      secondsRemaining: 30 * HOUR, durationSeconds: 48 * HOUR, ultra: false,
    });
  });

  it("ignores other event types and events not running now", () => {
    const events = [
      event({ type: "mission-duration" }),
      event({ startTimestamp: 1019 * HOUR }),
      event({ endTimestamp: 1018 * HOUR }),
    ];
    expect(activeDubcapEvent(events, 1018 * HOUR, true)).toBeNull();
  });

  it("gives Ultra-only events to Ultra subscribers only", () => {
    const ultra = event({ id: "ultra-10-18", ultra: true, endTimestamp: 1040 * HOUR });
    expect(activeDubcapEvent([ultra], 1018 * HOUR, false)).toBeNull();
    expect(activeDubcapEvent([ultra], 1018 * HOUR, true)?.id).toBe("ultra-10-18");
  });

  it("prefers the bigger multiplier, then the later end", () => {
    const events = [event({ id: "a" }), event({ id: "b", endTimestamp: 1050 * HOUR }), event({ id: "c", multiplier: 3 })];
    expect(activeDubcapEvent(events, 1018 * HOUR, false)?.id).toBe("c");
    expect(activeDubcapEvent(events.slice(0, 2), 1018 * HOUR, false)?.id).toBe("b");
  });
});
