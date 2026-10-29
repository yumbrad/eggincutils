import { describe, expect, it } from "vitest";

import {
  MAX_PRE_PLAN_SEND_ROWS,
  PRE_PLAN_UNTARGETED_TARGET_AFX_ID,
  plannerPlanFueling,
  plannerPlanToPrePlanSends,
  savedPlannerPlanFromSession,
  savedPlannerPlanFromStorage,
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

  it("gives the plan's dubcap rows its drop multiplier and keeps them apart from ordinary ones", () => {
    const { sends } = plannerPlanToPrePlanSends({
      missions: [
        mission("HENERPRISE", "EPIC", 6, 3, 2),
        { ...mission("HENERPRISE", "EPIC", 6, 3, 3), dubcap: true },
      ],
      progression: { prepLaunches: [] },
      dubcap: { multiplier: 3 },
    });
    expect(sends).toEqual([
      { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 3, launches: 2 },
      { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 3, launches: 3, multiplier: 3 },
    ]);
  });

  it("sends the partly fueled ship first, or after prep when it opens a fresh dubcap", () => {
    const base = {
      missions: [mission("HENERPRISE", "EPIC", 6, 3, 2)],
      progression: { prepLaunches: [{ ship: "VOYEGGER", durationType: "SHORT", launches: 4 }] },
    };
    const fueling = { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: null, dubcap: false, afterPrep: false };
    expect(plannerPlanToPrePlanSends({ ...base, fueling }).sends[0]).toEqual({
      ship: "HENERPRISE",
      durationType: "EPIC",
      targetAfxId: PRE_PLAN_UNTARGETED_TARGET_AFX_ID,
      launches: 1,
    });
    const inEvent = plannerPlanToPrePlanSends({
      ...base,
      dubcap: { multiplier: 2 },
      fueling: { ...fueling, targetAfxId: 7, dubcap: true, afterPrep: true },
    }).sends;
    expect(inEvent.map((send) => [send.ship, send.launches, send.multiplier ?? 1])).toEqual([
      ["VOYEGGER", 4, 1],
      ["HENERPRISE", 1, 2],
      ["HENERPRISE", 2, 1],
    ]);
  });

  it("reads the partly fueled ship from a plan's tank units and dubcap lanes", () => {
    const units = [{ ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 7, preFueled: false }];
    expect(plannerPlanFueling({ virtueTanks: { units } })).toEqual({
      ship: "HENERPRISE",
      durationType: "EPIC",
      targetAfxId: 7,
      dubcap: false,
      afterPrep: false,
    });
    expect(
      plannerPlanFueling({ virtueTanks: { units }, dubcap: { live: false, lanes: [[{ fueling: true }], [], []] } })
    ).toMatchObject({ dubcap: true, afterPrep: true });
    expect(plannerPlanFueling({ virtueTanks: { units: [{ ship: "HENERPRISE", durationType: "EPIC" }] } })).toBeNull();
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

describe("saved planner plans", () => {
  const virtueSession = {
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

  it("reads a per-source copy of the plan launches", () => {
    const stored = {
      savedAt: "2026-10-05T09:00:00.000Z",
      eid: "EI123",
      missions: [mission("ATREGGIES", "LONG", 3, 9, 5)],
      prepLaunches: [{ ship: "VOYEGGER", durationType: "SHORT", launches: 2 }],
    };
    expect(savedPlannerPlanFromStorage(JSON.stringify(stored))).toMatchObject({
      savedAt: "2026-10-05T09:00:00.000Z",
      eid: "EI123",
      sends: [
        { ship: "VOYEGGER", durationType: "SHORT", targetAfxId: PRE_PLAN_UNTARGETED_TARGET_AFX_ID, launches: 2 },
        { ship: "ATREGGIES", durationType: "LONG", targetAfxId: 9, launches: 5 },
      ],
    });
  });

  it("only takes the planner's session plan for the source it was made for", () => {
    const raw = JSON.stringify(virtueSession);
    expect(savedPlannerPlanFromSession(raw, "virtue")).toMatchObject({
      eid: "EI123",
      sends: [{ ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 3, launches: 2 }],
    });
    expect(savedPlannerPlanFromSession(raw, "main")).toBeNull();
  });

  it("returns null for missing or malformed saves", () => {
    expect(savedPlannerPlanFromStorage(null)).toBeNull();
    expect(savedPlannerPlanFromStorage("{not json")).toBeNull();
    expect(savedPlannerPlanFromSession(null, "main")).toBeNull();
    expect(savedPlannerPlanFromSession(JSON.stringify({ response: {} }), "main")).toBeNull();
  });
});
