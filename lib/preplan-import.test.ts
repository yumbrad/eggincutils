import { describe, expect, it } from "vitest";

import {
  MAX_PRE_PLAN_SEND_ROWS,
  PRE_PLAN_UNTARGETED_TARGET_AFX_ID,
  plannerPlanToPrePlanSends,
  savedPlannerPlanFromSession,
  SHIP_PROGRESSION_ORDER,
} from "./preplan-import";
import { getShipOrder } from "./ship-data";

const mission = (
  ship: string,
  durationType: string,
  level: number,
  targetAfxId: number,
  launches: number,
  inAir = false
) => ({ ship, durationType, level, targetAfxId, launches, ...(inAir ? { inAir } : {}) });

describe("plannerPlanToPrePlanSends", () => {
  it("keeps the ship order in step with ship-data", () => {
    expect(SHIP_PROGRESSION_ORDER).toEqual(getShipOrder());
  });

  it("puts uncovered prep first, then missions from the lowest planned star up", () => {
    const { sends, inAirLaunches } = plannerPlanToPrePlanSends({
      missions: [
        mission("HENERPRISE", "EPIC", 6, 3, 40),
        mission("HENERPRISE", "SHORT", 4, 3, 10),
        mission("VOYEGGER", "EPIC", 2, 5, 4, true),
      ],
      progression: {
        prepLaunches: [
          // Covered by the Henerprise short row (the planner counts prep inside it).
          { ship: "HENERPRISE", durationType: "SHORT", launches: 8 },
          // Unlock chain: Voyegger then Chickfiant, listed out of order.
          { ship: "VOYEGGER", durationType: "SHORT", launches: 12 },
          { ship: "CHICKFIANT", durationType: "SHORT", launches: 7 },
        ],
      },
    });

    expect(sends).toEqual([
      { ship: "CHICKFIANT", durationType: "SHORT", targetAfxId: PRE_PLAN_UNTARGETED_TARGET_AFX_ID, launches: 7 },
      { ship: "VOYEGGER", durationType: "SHORT", targetAfxId: PRE_PLAN_UNTARGETED_TARGET_AFX_ID, launches: 12 },
      { ship: "HENERPRISE", durationType: "SHORT", targetAfxId: 3, launches: 10 },
      { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 3, launches: 40 },
    ]);
    expect(inAirLaunches).toBe(4);
  });

  it("merges neighbouring rows that only differ by level and splits rows over 10,000", () => {
    const { sends } = plannerPlanToPrePlanSends({
      missions: [mission("ATREGGIES", "EPIC", 1, 9, 6_000), mission("ATREGGIES", "EPIC", 2, 9, 6_000)],
      progression: { prepLaunches: [] },
    });
    expect(sends.map((send) => send.launches)).toEqual([10_000, 2_000]);
  });

  it("caps the rows and counts what it leaves out", () => {
    const missions = Array.from({ length: MAX_PRE_PLAN_SEND_ROWS + 5 }, (_, index) =>
      mission("ATREGGIES", index % 2 ? "EPIC" : "LONG", 1, 9, 3)
    );
    const { sends, droppedLaunches } = plannerPlanToPrePlanSends({ missions, progression: { prepLaunches: [] } });
    expect(sends).toHaveLength(MAX_PRE_PLAN_SEND_ROWS);
    expect(droppedLaunches).toBe(15);
  });
});

describe("savedPlannerPlanFromSession", () => {
  it("reads the plan, source and EID from a saved session", () => {
    const session = {
      schemaVersion: 1,
      savedAt: "2026-10-04T12:00:00.000Z",
      response: {
        plan: {
          missions: [mission("HENERPRISE", "EPIC", 6, 3, 2)],
          progression: { prepLaunches: [] },
        },
      },
      lastSolveRequest: { eid: "EI123", sourceFilters: { inventorySource: "virtue" } },
    };
    expect(savedPlannerPlanFromSession(JSON.stringify(session))).toMatchObject({
      savedAt: "2026-10-04T12:00:00.000Z",
      eid: "EI123",
      inventorySource: "virtue",
      sends: [{ ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 3, launches: 2 }],
    });
  });

  it("returns null for missing or malformed sessions", () => {
    expect(savedPlannerPlanFromSession(null)).toBeNull();
    expect(savedPlannerPlanFromSession("{not json")).toBeNull();
    expect(savedPlannerPlanFromSession(JSON.stringify({ response: {} }))).toBeNull();
  });
});
