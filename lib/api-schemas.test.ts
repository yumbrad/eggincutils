import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import {
  planApiResponseSchema,
  plannerResultSchema,
  planRequestSchema,
  replanRequestSchema,
  virtueTankPlannerResultSchema,
} from "./api-schemas";
import { createDemoProfile } from "./demo-profile";
import type { PlannerResult } from "./planner";
import { TRILLION, type VirtueTankSnapshot } from "./virtue-fuel";
import {
  buildVirtueTankPlannerOptions,
  DEFAULT_VIRTUE_SHIFT_CAP,
  type VirtueTankPlannerOptions,
  type VirtueTankPlannerResult,
  type VirtueTankPlanUnit,
} from "./virtue-tank-plan";
import { packVirtueTanksHeuristic } from "./virtue-tanks";

const T = TRILLION;
const QUANTUM_METRONOME_AFX_ID = 24;

/**
 * Flattens intersections (VirtueTankPlanUnit is one) so expectTypeOf compares
 * fields, keeping optional markers, rather than how the type was written.
 */
type DeepFlat<T> = T extends readonly (infer U)[] ? DeepFlat<U>[] : T extends object ? { [K in keyof T]: DeepFlat<T[K]> } : T;

// The tank in the real backup the feature was built against.
function sampleTank(overrides: Partial<VirtueTankSnapshot> = {}): VirtueTankSnapshot {
  return {
    tankLevel: 7,
    capacity: 500 * T,
    fuels: { curiosity: 108.68 * T, integrity: 41.97 * T, humility: 60 * T, resilience: 0, kindness: 190 * T },
    limits: { curiosity: 0.5, integrity: 0.12, humility: 0.12, resilience: 1, kindness: 0.38 },
    fillingEnabled: false,
    shiftCount: 21,
    soulEggs: 1.05e21,
    currentEgg: "humility",
    backupTimeSeconds: 1_790_000_000,
    ...overrides,
  };
}

function missionRowKey(ship: string, durationType: string, level: number, targetAfxId: number): string {
  return `${ship}|${durationType}|${level}|${targetAfxId}`;
}

// Mission rows the tank units point back at, a prep launch with no row, a
// Humility-only ship that burns no tank fuel, and one unit with its own burn.
function sampleUnits(): VirtueTankPlanUnit[] {
  return [
    {
      id: "prep-0",
      ship: "CHICKFIANT",
      durationType: "SHORT",
      level: 0,
      durationSeconds: 4 * 3600,
      launches: 2,
      isPrep: true,
      prepOrder: 0,
      targetAfxId: null,
    },
    {
      id: "row-0",
      ship: "HENERPRISE",
      durationType: "EPIC",
      level: 8,
      durationSeconds: 96 * 3600,
      launches: 9,
      missionRowKey: missionRowKey("HENERPRISE", "EPIC", 8, QUANTUM_METRONOME_AFX_ID),
      targetAfxId: QUANTUM_METRONOME_AFX_ID,
    },
    {
      id: "row-1",
      ship: "BCR",
      durationType: "SHORT",
      level: 4,
      durationSeconds: 3 * 3600,
      launches: 3,
      missionRowKey: missionRowKey("BCR", "SHORT", 4, 10_000),
      targetAfxId: 10_000,
    },
    {
      id: "row-2",
      ship: "CHICKEN_ONE",
      durationType: "SHORT",
      level: 2,
      durationSeconds: 1200,
      launches: 2,
      missionRowKey: missionRowKey("CHICKEN_ONE", "SHORT", 2, 10_000),
      targetAfxId: 10_000,
    },
    {
      id: "row-3",
      ship: "CHICKFIANT",
      durationType: "EPIC",
      level: 5,
      durationSeconds: 48 * 3600,
      launches: 4,
      fuelPerLaunch: { curiosity: 3 * T, kindness: 3 * T },
      missionRowKey: missionRowKey("CHICKFIANT", "EPIC", 5, QUANTUM_METRONOME_AFX_ID),
      targetAfxId: QUANTUM_METRONOME_AFX_ID,
    },
  ];
}

function tankResult(options: VirtueTankPlannerOptions, units: VirtueTankPlanUnit[]): VirtueTankPlannerResult {
  const pack = packVirtueTanksHeuristic({
    units,
    capacity: options.capacity,
    startMode: options.startMode,
    currentContents: options.currentContents,
    currentHumility: options.currentHumility,
    inAirLaneFreeSeconds: [9 * 3600, 14 * 3600],
  });
  return {
    shiftCap: options.shiftCap,
    plannedShiftCap: Math.max(options.shiftCap, pack.totalShifts),
    overCap: pack.totalShifts > options.shiftCap,
    ...(pack.totalShifts > options.shiftCap ? { neededShifts: pack.totalShifts, neededShiftsProven: false } : {}),
    startMode: options.startMode,
    capacity: options.capacity,
    units,
    pack,
    notes: ["Planned with a tank note."],
  };
}

function plannerResult(virtueTanks: VirtueTankPlannerResult): PlannerResult {
  const missionRows = virtueTanks.units.filter((unit) => unit.missionRowKey);
  return {
    targetItemId: "quantum-metronome-4",
    quantity: 1,
    targets: [
      { targetItemId: "quantum-metronome-4", quantity: 1 },
      { targetItemId: "puzzle-cube-3", quantity: 40, craftGoal: true },
    ],
    priorityTime: 0.5,
    objectiveMode: "virtueFuel",
    geCost: 1_234_567,
    fuelCost: 1_500 * T,
    totalSlotSeconds: 1_000_000,
    expectedHours: 330.5,
    weightedScore: 12.25,
    crafts: [{ itemId: "quantum-metronome-4", count: 1 }],
    consumptions: [],
    missions: [
      ...missionRows.map((unit) => ({
        missionId: `${unit.ship}_${unit.durationType}`,
        ship: unit.ship,
        durationType: unit.durationType as "SHORT" | "EPIC",
        level: unit.level,
        targetAfxId: unit.targetAfxId ?? 10_000,
        launches: unit.launches,
        durationSeconds: unit.durationSeconds,
        expectedYields: [{ itemId: "quantum-metronome-1", quantity: 1.5 }],
        rowKey: unit.missionRowKey,
      })),
      {
        missionId: "HENERPRISE_EPIC",
        ship: "HENERPRISE",
        durationType: "EPIC",
        level: 8,
        targetAfxId: QUANTUM_METRONOME_AFX_ID,
        launches: 2,
        durationSeconds: 96 * 3600,
        expectedYields: [{ itemId: "quantum-metronome-1", quantity: 0.5 }],
        inAir: true,
        secondsRemaining: 14 * 3600,
        launchSecondsRemaining: [14 * 3600, 9 * 3600],
      },
    ],
    unmetItems: [],
    targetBreakdown: { requested: 1, fromInventory: 0, fromCraft: 1, fromMissionsExpected: 0, shortfall: 0 },
    targetBreakdowns: [
      { itemId: "quantum-metronome-4", requested: 1, fromInventory: 0, fromCraft: 1, fromMissionsExpected: 0, shortfall: 0 },
      {
        itemId: "puzzle-cube-3",
        requested: 12,
        fromInventory: 0,
        fromCraft: 12,
        fromMissionsExpected: 0,
        shortfall: 0,
        craftGoal: true,
        craftGoalTotal: 40,
        craftedBefore: 28,
      },
    ],
    progression: {
      prepHours: 8,
      prepLaunches: [{ ship: "CHICKFIANT", durationType: "SHORT", launches: 2, durationSeconds: 4 * 3600, reason: "level up" }],
      projectedShipLevels: [{ ship: "CHICKFIANT", unlocked: true, level: 5, maxLevel: 8, launches: 120, launchPoints: 300 }],
    },
    inFlight: { missionCount: 2, secondsRemaining: 14 * 3600 },
    schedule: { missionSeconds: 900_000, inAirSeconds: 23 * 3600, totalSeconds: 950_000 },
    notes: ["Solved."],
    availableCombos: [{ ship: "HENERPRISE", durationType: "EPIC", targetAfxId: QUANTUM_METRONOME_AFX_ID }],
    virtueTanks,
  };
}

/** What a client gets back from a plan route: the schema's output, through JSON. */
function throughRoute(result: PlannerResult): unknown {
  return JSON.parse(JSON.stringify(plannerResultSchema.parse(JSON.parse(JSON.stringify(result)))));
}

describe("plannerResultSchema virtue tanks", () => {
  it("mirrors the planner's result types exactly, so no field is stripped", () => {
    // z.object drops keys it does not list: a field added to the planner or
    // packer types must be added to the schema too, or this fails the typecheck.
    expectTypeOf<DeepFlat<z.infer<typeof virtueTankPlannerResultSchema>>>().toEqualTypeOf<
      DeepFlat<VirtueTankPlannerResult>
    >();
    expectTypeOf<DeepFlat<z.infer<typeof plannerResultSchema>>>().toEqualTypeOf<DeepFlat<PlannerResult>>();
  });

  it("round-trips a current-tank plan with refuel loops unchanged", () => {
    const options = buildVirtueTankPlannerOptions(sampleTank(), 2, "current");
    const virtueTanks = tankResult(options, sampleUnits());
    virtueTanks.fasterOption = { shifts: virtueTanks.pack.totalShifts + 2, expectedHours: 120.5 };
    // The fixture must exercise the optional and nullable parts of the shape.
    expect(virtueTanks.pack.tanks.length).toBeGreaterThan(1);
    expect(virtueTanks.pack.tanks[0].refill).toBeNull();
    expect(virtueTanks.pack.tanks[1].refill?.drainHumility).toBe(true);
    expect(virtueTanks.pack.tanks[1].refill?.route.at(-1)).toBe("humility");
    expect(virtueTanks.overCap).toBe(true);
    expect(virtueTanks.neededShifts).toBe(virtueTanks.pack.totalShifts);
    expect(virtueTanks.pack.schedule.lanes.flat().length).toBeGreaterThan(0);

    const result = plannerResult(virtueTanks);
    expect(throughRoute(result)).toStrictEqual(result);
  });

  it("round-trips an ideal-tank plan, including the change from the current tank", () => {
    const options = buildVirtueTankPlannerOptions(sampleTank(), 15, "ideal");
    const virtueTanks = tankResult(options, sampleUnits());
    expect(virtueTanks.pack.tanks[0].idealFill?.changeFromCurrent).toBeDefined();
    expect(virtueTanks.overCap).toBe(false);

    const result = plannerResult(virtueTanks);
    expect(throughRoute(result)).toStrictEqual(result);
  });

  it("round-trips a faster option on a plan within the cap", () => {
    // The cap set to exactly the shifts the sample packs into.
    const options = buildVirtueTankPlannerOptions(sampleTank(), 15, "current");
    const shifts = tankResult(options, sampleUnits()).pack.totalShifts;
    const virtueTanks = tankResult({ ...options, shiftCap: shifts }, sampleUnits());
    expect(virtueTanks.overCap).toBe(false);
    expect(virtueTanks.shiftCap).toBeLessThan(11);
    virtueTanks.fasterOption = { shifts: virtueTanks.shiftCap + 4, expectedHours: 240 };

    const result = plannerResult(virtueTanks);
    expect(throughRoute(result)).toStrictEqual(result);
  });

  it("round-trips a last-tank top-up", () => {
    const options = buildVirtueTankPlannerOptions(sampleTank(), 2, "current");
    const virtueTanks = tankResult(options, sampleUnits());
    const last = virtueTanks.pack.tanks[virtueTanks.pack.tanks.length - 1];
    virtueTanks.lastTankTopUp = {
      tankIndex: last.index,
      roomBefore: 310 * T,
      launches: [
        { ship: "HENERPRISE", durationType: "EPIC", level: 8, targetAfxId: 18, launches: 4 },
        { ship: "HENERPRISE", durationType: "SHORT", level: 8, targetAfxId: null, launches: 1 },
      ],
      fillTo: { curiosity: 215 * T, kindness: 142.5 * T },
      limitPct: { curiosity: 43, kindness: 29 },
      expected: { goldMeteorite: 12.5, tauCetiGeode: 210.25, solarTitanium: 0 },
      totalValue: 222.75,
      netValue: 101.5,
      slotSeconds: 4 * 96 * 3600 + 24 * 3600,
    };

    const result = plannerResult(virtueTanks);
    expect(throughRoute(result)).toStrictEqual(result);
  });

  it("round-trips an infeasible plan with unplaced launches", () => {
    const options = buildVirtueTankPlannerOptions(sampleTank({ tankLevel: 3, capacity: 100 * T }), 0);
    const units: VirtueTankPlanUnit[] = [
      {
        id: "row-0",
        ship: "ATREGGIES",
        durationType: "EPIC",
        level: 0,
        durationSeconds: 120 * 3600,
        launches: 2,
        missionRowKey: missionRowKey("ATREGGIES", "EPIC", 0, QUANTUM_METRONOME_AFX_ID),
        targetAfxId: QUANTUM_METRONOME_AFX_ID,
      },
    ];
    const virtueTanks = tankResult(options, units);
    expect(virtueTanks.pack.feasible).toBe(false);
    expect(virtueTanks.pack.unplaced).toEqual([expect.objectContaining({ unitId: "row-0", launches: 2 })]);

    const result = plannerResult(virtueTanks);
    expect(throughRoute(result)).toStrictEqual(result);
  });

  it("still parses plans without tank data", () => {
    const { virtueTanks: _virtueTanks, ...withoutTanks } = plannerResult(
      tankResult(buildVirtueTankPlannerOptions(undefined, 7), sampleUnits())
    );
    const parsed = plannerResultSchema.parse(withoutTanks);
    expect(parsed.virtueTanks).toBeUndefined();
    expect("virtueTanks" in parsed).toBe(false);
  });

  it("rejects a malformed tank plan", () => {
    const result = plannerResult(tankResult(buildVirtueTankPlannerOptions(sampleTank(), 7), sampleUnits()));
    const broken = JSON.parse(JSON.stringify(result));
    broken.virtueTanks.pack.tanks[1].refill.route = ["curiosity", "dilithium"];
    expect(plannerResultSchema.safeParse(broken).success).toBe(false);
  });

  it("keeps the profile's tank snapshot in the plan response", () => {
    const profile = createDemoProfile("virtue");
    const result = plannerResult(tankResult(buildVirtueTankPlannerOptions(profile.virtueTank, 7), sampleUnits()));
    const response = {
      profile: {
        eid: profile.eid,
        epicResearchFTLLevel: profile.epicResearchFTLLevel,
        epicResearchZerogLevel: profile.epicResearchZerogLevel,
        shipLevels: profile.shipLevels,
        virtueTank: profile.virtueTank,
      },
      plan: result,
    };
    expect(planApiResponseSchema.parse(response)).toStrictEqual(response);
  });
});

describe("virtue plan requests", () => {
  const baseRequest = { targetItemId: "quantum-metronome-4" };

  it("feeds the slider and start-tank toggle into the tank options", () => {
    const request = planRequestSchema.parse({
      ...baseRequest,
      inventorySource: "virtue",
      virtueShiftCap: "3",
      virtueStartTank: "ideal",
    });
    expect(request.inventorySource).toBe("virtue");
    const options = buildVirtueTankPlannerOptions(sampleTank(), request.virtueShiftCap, request.virtueStartTank);
    expect(options.shiftCap).toBe(3);
    expect(options.startMode).toBe("ideal");
  });

  it("leaves both settings unset when omitted, so the helper's defaults apply", () => {
    const request = planRequestSchema.parse({ ...baseRequest, inventorySource: "virtue" });
    expect(request.virtueShiftCap).toBeUndefined();
    expect(request.virtueStartTank).toBeUndefined();
    const options = buildVirtueTankPlannerOptions(sampleTank(), request.virtueShiftCap, request.virtueStartTank);
    expect(options.shiftCap).toBe(DEFAULT_VIRTUE_SHIFT_CAP);
    expect(options.startMode).toBe("current");
  });

  it("reads blank settings as unset", () => {
    const request = planRequestSchema.parse({
      ...baseRequest,
      inventorySource: "virtue",
      virtueShiftCap: "",
      virtueStartTank: "",
    });
    expect(request.virtueShiftCap).toBeUndefined();
    expect(request.virtueStartTank).toBeUndefined();
    expect(planRequestSchema.safeParse({ ...baseRequest, virtueStartTank: "full" }).success).toBe(false);
  });

  it("carries a replan profile's tank snapshot and the virtue settings", () => {
    const profile = createDemoProfile("virtue");
    const parsed = replanRequestSchema.parse({
      ...baseRequest,
      profile,
      inventorySource: "virtue",
      virtueShiftCap: 5,
      virtueStartTank: "current",
    });
    expect(parsed.profile.virtueTank).toStrictEqual(profile.virtueTank);
    expect(parsed.virtueShiftCap).toBe(5);
    expect(parsed.virtueStartTank).toBe("current");
  });

  it("keeps craft-count goals on request targets", () => {
    const request = planRequestSchema.parse({
      ...baseRequest,
      targets: [
        { targetItemId: "quantum-metronome-4", quantity: 1 },
        { targetItemId: "puzzle-cube-3", quantity: 40, craftGoal: true },
      ],
    });
    expect(request.targets).toStrictEqual([
      { targetItemId: "quantum-metronome-4", quantity: 1 },
      { targetItemId: "puzzle-cube-3", quantity: 40, craftGoal: true },
    ]);
  });
});

describe("buildVirtueTankPlannerOptions", () => {
  it("plans an ideal 500T tank when there is no tank data", () => {
    expect(buildVirtueTankPlannerOptions(undefined, 7)).toStrictEqual({
      shiftCap: 7,
      startMode: "ideal",
      capacity: 500 * T,
    });
    // An unknown tank is not an empty one, so "current" cannot be honored.
    expect(buildVirtueTankPlannerOptions(undefined, 4, "current").startMode).toBe("ideal");
    expect(buildVirtueTankPlannerOptions(null, 4).startMode).toBe("ideal");
  });

  it("starts from the current tank when it is known, with Humility kept apart", () => {
    expect(buildVirtueTankPlannerOptions(sampleTank(), 7)).toStrictEqual({
      shiftCap: 7,
      startMode: "current",
      capacity: 500 * T,
      currentContents: { curiosity: 108.68 * T, integrity: 41.97 * T, kindness: 190 * T, resilience: 0 },
      currentHumility: 60 * T,
    });
  });

  it("drops the float noise the game stores in tank readings", () => {
    const noisy = sampleTank({
      fuels: {
        curiosity: 175 * T + 1.9,
        integrity: 10 * T - 0.6,
        humility: 2 * T + 3,
        resilience: 140 * T + 1_500,
        kindness: 175 * T + 0.25,
      },
    });
    const options = buildVirtueTankPlannerOptions(noisy, 7);
    expect(options.currentContents).toStrictEqual({
      curiosity: 175 * T,
      integrity: 10 * T,
      kindness: 175 * T,
      // Too far from a whole million to be noise: kept as read.
      resilience: 140 * T + 1_500,
    });
    expect(options.currentHumility).toBe(2 * T);
  });

  it("keeps the current contents in ideal mode for the change-from-current amounts", () => {
    const options = buildVirtueTankPlannerOptions(sampleTank(), 7, "ideal");
    expect(options.startMode).toBe("ideal");
    expect(options.currentContents).toStrictEqual({
      curiosity: 108.68 * T,
      integrity: 41.97 * T,
      kindness: 190 * T,
      resilience: 0,
    });
    expect(options.currentHumility).toBe(60 * T);
  });

  it("uses the tank's own capacity, and 500T when it is unusable", () => {
    expect(buildVirtueTankPlannerOptions(sampleTank({ tankLevel: 5, capacity: 300 * T }), 7).capacity).toBe(300 * T);
    expect(buildVirtueTankPlannerOptions(sampleTank({ capacity: 0 }), 7).capacity).toBe(500 * T);
    expect(buildVirtueTankPlannerOptions(sampleTank({ capacity: Number.NaN }), 7).capacity).toBe(500 * T);
  });

  it("defaults an unset cap and snaps the rest to the slider detents", () => {
    expect(buildVirtueTankPlannerOptions(undefined, undefined).shiftCap).toBe(DEFAULT_VIRTUE_SHIFT_CAP);
    expect(buildVirtueTankPlannerOptions(undefined, null).shiftCap).toBe(DEFAULT_VIRTUE_SHIFT_CAP);
    expect(buildVirtueTankPlannerOptions(undefined, Number.NaN).shiftCap).toBe(DEFAULT_VIRTUE_SHIFT_CAP);
    expect(buildVirtueTankPlannerOptions(undefined, 0).shiftCap).toBe(0);
    // A refuel loop is at least two shifts, so a cap of 1 is the same as 0.
    expect(buildVirtueTankPlannerOptions(undefined, 1).shiftCap).toBe(0);
    expect(buildVirtueTankPlannerOptions(undefined, 12).shiftCap).toBe(12);
    expect(buildVirtueTankPlannerOptions(undefined, 40).shiftCap).toBe(15);
  });
});
