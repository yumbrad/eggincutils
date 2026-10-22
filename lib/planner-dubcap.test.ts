import { describe, expect, it } from "vitest";
import { planForTarget, computeMonolithicPaths, type PlannerOptions, type PlannerResult } from "./planner";
import { solveWithHighs } from "./highs";
import type { LootJson } from "./loot-data";
import type { PlayerProfile } from "./profile";
import { buildMissionOptions, computeShipLevelsFromLaunchCounts, type MissionOption } from "./ship-data";
import { DUBCAP_LAUNCH_MARGIN_SECONDS, DUBCAP_WINDOW_SECONDS, liveDubcapLaneStarts, scheduleAfterDubcap } from "./dubcap";
import { TRILLION as T } from "./virtue-fuel";
import { plannerResultSchema, planRequestSchema, replanRequestSchema, compareRequestSchema } from "./api-schemas";

const extended: MissionOption = { ship: "HENERPRISE", durationType: "EPIC", missionId: "henerprise-extended", level: 0, durationSeconds: 138_240, capacity: 1 };
const short: MissionOption = { ...extended, durationType: "SHORT", missionId: "henerprise-short", durationSeconds: 34_560 };
const chickfiant: MissionOption = { ...short, ship: "CHICKFIANT", missionId: "chickfiant-short", durationSeconds: 11_520 };

function profileFor(options: MissionOption[]): PlayerProfile {
  return { eid: "EI_TEST", inventory: {}, craftCounts: {}, craftingXp: 0,
    epicResearchFTLLevel: 60, epicResearchZerogLevel: 0, shipLevels: [], missionOptions: options };
}

function lootFor(options: MissionOption[]): LootJson {
  return { missions: options.map((option) => ({ afxShip: 0, afxDurationType: 0, missionId: option.missionId,
    levels: [{ level: 0, targets: [{ totalDrops: 5000, targetAfxId: 10000,
      items: [{ afxId: 0, afxLevel: 1, itemId: option.durationType === "EPIC" ? "puzzle-cube-1" : "gold-meteorite-1", counts: [5000, 0, 0, 0] }] }] }] })) } as LootJson;
}

async function plan(options: MissionOption[], quantity: number, extra: PlannerOptions = {}, profile = profileFor(options)): Promise<PlannerResult> {
  return planForTarget(profile, "puzzle-cube-1", quantity, 1, { includeDubcap: true, lootData: lootFor(options), solverFn: solveWithHighs, ...extra });
}

function launches(result: PlannerResult, doubled: boolean): number {
  return result.missions.filter((row) => !row.inAir && Boolean(row.dubcap) === doubled).reduce((sum, row) => sum + row.launches, 0);
}

function expectValidTimeline(result: PlannerResult): void {
  const event = result.dubcap!;
  expect(event.lanes).toHaveLength(3);
  // The partly fueled ship can open the event; it has no mission row.
  expect(event.launches).toBe(launches(result, true) + event.lanes.flat().filter((block) => block.fueling).length);
  for (const lane of event.lanes) {
    let end = 0;
    lane.forEach((block, index) => {
      const previous = lane[index - 1];
      // Back-to-back launches of one mission from one tank read as one run.
      expect(previous && previous.endSeconds === block.startSeconds && previous.missionRowKey === block.missionRowKey &&
        previous.tankIndex === block.tankIndex).toBeFalsy();
    });
    for (const block of lane) {
      expect(block.startSeconds).toBeGreaterThanOrEqual(end);
      const duration = (block.endSeconds - block.startSeconds) / block.launches;
      expect(block.endSeconds - duration).toBeLessThanOrEqual(event.windowSeconds - DUBCAP_LAUNCH_MARGIN_SECONDS + 1e-6);
      end = block.endSeconds;
    }
  }
  for (const lane of event.fullLanes) {
    let end = 0;
    for (const block of lane) {
      expect(block.startSeconds).toBeGreaterThanOrEqual(end);
      if (!block.isPrep && !block.dubcap) {
        expect(block.startSeconds).toBeGreaterThanOrEqual(event.startSeconds + event.windowSeconds);
      }
      end = block.endSeconds;
    }
  }
  // One row per physical mission: event copies for each leveling phase fold together.
  const rowIdentities = result.missions.filter((row) => !row.inAir)
    .map((row) => `${row.missionId}|${row.level}|${row.targetAfxId}|${Boolean(row.dubcap)}`);
  expect(new Set(rowIdentities).size).toBe(rowIdentities.length);
  if (result.virtueTanks) {
    // Packing splits event launches; the finished plan has one unit per row and runs per slot.
    const eventUnits = result.virtueTanks.units.filter((unit) => unit.launchOrder !== undefined);
    expect(new Set(eventUnits.map((unit) => unit.missionRowKey)).size).toBe(eventUnits.length);
    for (const lane of result.virtueTanks.pack.schedule.lanes) {
      lane.forEach((block, index) => {
        const previous = lane[index - 1];
        expect(previous && previous.endSeconds === block.startSeconds && previous.unitId === block.unitId &&
          previous.tankIndex === block.tankIndex).toBeFalsy();
      });
    }
  }
  expect(result.expectedHours * 3600).toBeCloseTo(event.makespanSeconds, 6);
  expect(plannerResultSchema.parse(result)).toEqual(result);
}

describe("one dubcap event", () => {
  it("finds six extended Henerprises and doubles drops without doubling fuel or launch points", async () => {
    const result = await plan([extended], 12);
    expect(result.unmetItems).toEqual([]);
    expect(launches(result, true)).toBe(6);
    expect(launches(result, false)).toBe(0);
    expect(result.expectedHours).toBeCloseTo(76.8);
    expect(result.totalSlotSeconds).toBe(6 * extended.durationSeconds);
    expect(result.fuelCost).toBe(6 * 70 * T);
    expect(result.progression.projectedShipLevels.find((ship) => ship.ship === "HENERPRISE")?.launches).toBe(6);
    expect(result.targetBreakdown.fromMissionsExpected).toBeCloseTo(12);
    expectValidTimeline(result);
  }, 120_000);

  it("uses only one event, including in fast mode, and keeps later launches at normal capacity", async () => {
    const result = await plan([extended], 13, { fastMode: true });
    expect(launches(result, true)).toBe(6);
    expect(launches(result, false)).toBe(1);
    expect(result.expectedHours).toBeCloseTo(115.2);
    expect(result.targetBreakdown.fromMissionsExpected).toBeCloseTo(13);
    expectValidTimeline(result);
  }, 120_000);

  it("inserts useful short missions while retaining both extended waves", async () => {
    const result = await plan([extended, chickfiant], 12, { targets: [
      { targetItemId: "puzzle-cube-1", quantity: 12 }, { targetItemId: "gold-meteorite-1", quantity: 6 },
    ] });
    expect(result.unmetItems).toEqual([]);
    expect(result.missions.filter((row) => row.ship === "HENERPRISE" && row.dubcap).reduce((sum, row) => sum + row.launches, 0)).toBe(6);
    expect(result.missions.filter((row) => row.ship === "CHICKFIANT" && row.dubcap).reduce((sum, row) => sum + row.launches, 0)).toBe(3);
    expect(launches(result, false)).toBe(0);
    expect(result.expectedHours).toBeCloseTo(80);
    expectValidTimeline(result);
  }, 120_000);

  it("rejects the short Henerprise insertion that would launch the last extended ship at hour 48", async () => {
    const result = await plan([extended, short], 12, { targets: [
      { targetItemId: "puzzle-cube-1", quantity: 12 }, { targetItemId: "gold-meteorite-1", quantity: 1 },
    ] });
    expect(launches(result, true)).toBe(6);
    expect(result.missions.filter((row) => row.durationType === "SHORT").map((row) => [row.dubcap ?? false, row.launches])).toEqual([[false, 1]]);
    expectValidTimeline(result);
  }, 120_000);

  it("allows a final mission longer than the event and waits for in-air slots before the fresh window", async () => {
    const long = { ...extended, durationSeconds: 96 * 3600 };
    const profile = profileFor([long]);
    profile.inFlightMissions = [{ ship: "HENERPRISE", durationType: "EPIC", status: "EXPLORING", level: 0,
      capacity: 1, targetAfxId: 10000, secondsRemaining: 24 * 3600 }];
    const result = await plan([long], 7, {}, profile);
    expect(result.dubcap!.startSeconds).toBe(24 * 3600);
    expect(launches(result, true)).toBe(3);
    expect(launches(result, false)).toBe(1);
    expect(result.missions.find((row) => row.inAir)?.dubcap).toBeUndefined();
    expect(result.dubcap!.lanes.every((lane) => lane.length === 1 && lane[0].startSeconds === 0)).toBe(true);
    expectValidTimeline(result);
  }, 120_000);

  it("doubles attainable goals while honoring a zero-shift cap", async () => {
    const result = await plan([extended], 12, { objectiveMode: "virtueFuel", virtueTank: {
      shiftCap: 0, startMode: "current", capacity: 500 * T,
      currentContents: { curiosity: 60 * T, kindness: 60 * T, resilience: 40 * T },
    } });
    expect(result.virtueTanks!.pack.totalShifts).toBe(0);
    expect(result.virtueTanks!.goalsUnmet).toBe(true);
    expect(result.targetBreakdown).toMatchObject({ fromMissionsExpected: 4, shortfall: 8 });
    expect(result.fuelCost).toBe(140 * T);
    expect(result.virtueTanks!.pack.feasible).toBe(true);
    expectValidTimeline(result);
  }, 120_000);

  it("packs event launches before ordinary farming within the selected shift cap", async () => {
    const result = await plan([extended, chickfiant], 13, { objectiveMode: "virtueFuel", virtueTank: {
      shiftCap: 4, startMode: "current", capacity: 500 * T,
      currentContents: { curiosity: 60 * T, kindness: 60 * T, resilience: 40 * T },
    }, targets: [{ targetItemId: "puzzle-cube-1", quantity: 13 }, { targetItemId: "gold-meteorite-1", quantity: 6 }] });
    expect(result.unmetItems).toEqual([]);
    expect(result.virtueTanks!.pack.totalShifts).toBeLessThanOrEqual(4);
    expect(result.virtueTanks!.pack.schedule.makespanSeconds).toBe(result.dubcap!.makespanSeconds);
    expectValidTimeline(result);
  }, 120_000);

  it("keeps the original behavior when the checkbox is off", async () => {
    const result = await plan([extended], 12, { includeDubcap: false });
    expect(result.dubcap).toBeUndefined();
    expect(launches(result, true)).toBe(0);
    expect(launches(result, false)).toBe(12);
  }, 120_000);

  it("shares the three physical slots across different targets on the same ship", async () => {
    const lootData = lootFor([extended]);
    const targets = lootData.missions[0].levels[0].targets;
    targets.push({ ...targets[0], targetAfxId: 12, items: [
      { afxId: 0, afxLevel: 1, itemId: "gold-meteorite-1", counts: [5000, 0, 0, 0] },
    ] });
    const result = await plan([extended], 12, { lootData, targets: [
      { targetItemId: "puzzle-cube-1", quantity: 12 }, { targetItemId: "gold-meteorite-1", quantity: 12 },
    ] });
    expect(result.unmetItems).toEqual([]);
    expect(launches(result, true)).toBe(6);
    expect(launches(result, false)).toBe(12);
    expectValidTimeline(result);
  }, 120_000);

  it("waits for unlock prep to return and counts each physical launch once", async () => {
    const shipLevels = computeShipLevelsFromLaunchCounts({
      CHICKEN_ONE: { SHORT: 4 }, CHICKEN_NINE: { SHORT: 6 }, CHICKEN_HEAVY: { SHORT: 12 }, BCR: { SHORT: 15 },
      MILLENIUM_CHICKEN: { SHORT: 18 }, CORELLIHEN_CORVETTE: { SHORT: 21 }, GALEGGTICA: { SHORT: 24 },
      CHICKFIANT: { SHORT: 27 }, VOYEGGER: { SHORT: 28 },
    });
    const profile = { ...profileFor([]), shipLevels, missionOptions: buildMissionOptions(shipLevels, 60, 0) };
    expect(shipLevels.find((ship) => ship.ship === "HENERPRISE")!.unlocked).toBe(false);
    const result = await plan([extended], 500, {}, profile);
    expect(result.progression.prepLaunches.length).toBeGreaterThan(0);
    const prep = result.dubcap!.fullLanes.flat().filter((block) => block.isPrep);
    expect(result.dubcap!.startSeconds).toBe(Math.max(...prep.map((block) => block.endSeconds)));
    const plannedHenerprises = launches(result, true) + launches(result, false);
    expect(result.progression.projectedShipLevels.find((ship) => ship.ship === "HENERPRISE")!.launches).toBe(plannedHenerprises);
    expect(result.dubcap!.launches).toBeGreaterThan(0);
    const eventReturns = result.dubcap!.startSeconds + Math.max(...result.dubcap!.lanes.flat().map((block) => block.endSeconds));
    expect(result.dubcap!.fullLanes.flat().filter((block) => !block.isPrep && !block.dubcap).every((block) => block.startSeconds >= eventReturns)).toBe(true);
    expectValidTimeline(result);
  }, 120_000);

  it("uses doubled ingredients for a partial craft-count goal without fabricating crafts", async () => {
    const profile = profileFor([extended]);
    profile.inventory = { puzzle_cube_1: 2 };
    profile.craftCounts = { puzzle_cube_2: 1 };
    const result = await plan([extended], 4, { objectiveMode: "virtueFuel", virtueTank: {
      shiftCap: 0, startMode: "current", capacity: 500 * T,
      currentContents: { curiosity: 60 * T, kindness: 60 * T, resilience: 40 * T },
    }, targets: [{ targetItemId: "puzzle-cube-2", quantity: 4, craftGoal: true }] }, profile);
    expect(result.crafts).toEqual([{ itemId: "puzzle-cube-2", count: 2 }]);
    expect(result.targetBreakdown).toMatchObject({ requested: 3, fromCraft: 2, shortfall: 1 });
    expect(result.virtueTanks!.pack.totalShifts).toBe(0);
    expectValidTimeline(result);
  }, 120_000);

  it("applies the same finite window to monolithic comparisons", async () => {
    const [comparison] = await computeMonolithicPaths({ profile: profileFor([extended]), targetItemId: "puzzle-cube-1",
      quantity: 13, priorityTime: 1, includeDubcap: true,
      selectedCombos: [{ ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 10000 }],
      lootData: lootFor([extended]), solverFn: solveWithHighs });
    expect(comparison.feasible).toBe(true);
    expect(comparison.totalLaunches).toBe(7);
    expect(comparison.expectedHours).toBeCloseTo(115.2);
  }, 120_000);

  it("keeps event yields at starting stars and credits leveling to ordinary missions once", async () => {
    const launchCounts = {
      CHICKEN_ONE: { SHORT: 4 }, CHICKEN_NINE: { SHORT: 6 }, CHICKEN_HEAVY: { SHORT: 12 }, BCR: { SHORT: 15 },
      MILLENIUM_CHICKEN: { SHORT: 18 }, CORELLIHEN_CORVETTE: { SHORT: 21 }, GALEGGTICA: { SHORT: 24 },
      CHICKFIANT: { SHORT: 27 }, VOYEGGER: { SHORT: 30 }, HENERPRISE: { SHORT: 9 },
    };
    const shipLevels = computeShipLevelsFromLaunchCounts(launchCounts);
    const missionOptions = buildMissionOptions(shipLevels, 60, 0);
    const option = missionOptions.find((mission) => mission.ship === "HENERPRISE" && mission.durationType === "EPIC")!;
    expect(option.level).toBe(0);
    const lootData = lootFor([option]);
    lootData.missions[0].levels[0].targets[0].items[0].counts[0] = 5000 / option.capacity;
    const profile = { ...profileFor(missionOptions), shipLevels };
    const result = await plan([option], 13, { lootData,
      allowedShipDurations: [{ ship: "HENERPRISE", durationType: "EPIC" }],
      // Exclude optional prep to isolate leveling caused by the event itself.
      solverFn: (model, options) => /\n  r_\d+:/.test(model)
        ? Promise.resolve({ Status: "Infeasible" }) : solveWithHighs(model, options),
    }, profile);
    expect(result.unmetItems).toEqual([]);
    expect(launches(result, true)).toBe(6);
    expect(launches(result, false)).toBe(1);
    expect(result.missions.filter((row) => row.dubcap).every((row) => row.level === 0)).toBe(true);
    expect(result.missions.filter((row) => !row.dubcap).every((row) => row.level === 1)).toBe(true);
    const final = result.progression.projectedShipLevels.find((ship) => ship.ship === "HENERPRISE")!;
    expect(final.launches).toBe(16);
    expect(final.launchPoints).toBeCloseTo(9 + 7 * 1.8);
    expectValidTimeline(result);
  }, 120_000);

  it("does not follow the event with an ordinary launch that event launches alone would beat", async () => {
    // Every mission drops cubes; one ordinary launch after the event would
    // wait out the 48-hour window, so the event launches should cover it all.
    const options = [extended, short, chickfiant];
    const cubes = { EPIC: 5000, SHORT: 1500 } as Record<string, number>;
    const lootData = { missions: options.map((option) => ({ afxShip: 0, afxDurationType: 0, missionId: option.missionId,
      levels: [{ level: 0, targets: [{ totalDrops: 5000, targetAfxId: 10000, items: [{ afxId: 0, afxLevel: 1, itemId: "puzzle-cube-1",
        counts: [option.ship === "CHICKFIANT" ? 600 : cubes[option.durationType], 0, 0, 0] }] }] }] })) } as LootJson;
    const result = await planForTarget(profileFor(options), "puzzle-cube-1", 8, 1, { includeDubcap: true, lootData, solverFn: solveWithHighs });
    expect(launches(result, false)).toBe(0);
    expect(result.expectedHours).toBeCloseTo(38.4, 1);
    expectValidTimeline(result);
  }, 120_000);

  it("shows a leveling ship's event launches as one mission row and one run per slot in tank mode", async () => {
    // BCR levels during the plan, so its event action is copied for each
    // leveling phase, and burns fuel, so packing splits its event launches.
    const shipLevels = computeShipLevelsFromLaunchCounts({
      CHICKEN_ONE: { SHORT: 4 }, CHICKEN_NINE: { SHORT: 6 }, CHICKEN_HEAVY: { SHORT: 12 }, BCR: { SHORT: 15 },
    });
    const missionOptions = buildMissionOptions(shipLevels, 60, 0).filter((option) => option.ship === "BCR");
    const lootData = { missions: missionOptions.map((option) => ({ afxShip: 0, afxDurationType: 0, missionId: option.missionId,
      levels: [0, 1, 2, 3, 4, 5].map((level) => ({ level, targets: [{ totalDrops: 5000, targetAfxId: 10000,
        items: [{ afxId: 0, afxLevel: 1, itemId: "gold-meteorite-1", counts: [30, 0, 0, 0] }] }] })) })) } as LootJson;
    const result = await planForTarget({ ...profileFor(missionOptions), shipLevels }, "gold-meteorite-1", 2500, 1, {
      includeDubcap: true, lootData, solverFn: solveWithHighs, objectiveMode: "virtueFuel",
      virtueTank: { shiftCap: 4, startMode: "current", capacity: 500 * T,
        currentContents: { curiosity: 200 * T, integrity: 200 * T, kindness: 200 * T, resilience: 200 * T } },
    });
    expect(result.unmetItems).toEqual([]);
    const eventRows = result.missions.filter((row) => row.dubcap);
    expect(eventRows.length).toBeGreaterThan(0);
    // Every slot flies a run of event launches, not one block per launch.
    expect(result.dubcap!.lanes.every((lane) => lane.some((block) => block.launches > 1))).toBe(true);
    expectValidTimeline(result);
  }, 120_000);

  it("keeps ordinary launches in tank order when a level-up delays an earlier tank's launch", () => {
    const hour = 3600;
    // Tank 0 levels ship X up; tank 1 flies ship Y. Y must not launch before X's level-up launch.
    const rows = [
      { key: "x0|tank0", durationSeconds: 10 * hour, launches: 1, shape: "X", level: 0 },
      { key: "x1|tank0", durationSeconds: 10 * hour, launches: 1, shape: "X", level: 1 },
      { key: "y0|tank1", durationSeconds: 10 * hour, launches: 1, shape: "Y", level: 0 },
    ];
    const startOf = (lanes: ReturnType<typeof scheduleAfterDubcap>["lanes"], key: string) =>
      lanes.flat().find((block) => block.actionKey === key)!.startSeconds / hour;
    const free = scheduleAfterDubcap({ lanes: [[], [], []] }, rows).lanes;
    expect(startOf(free, "y0|tank1")).toBe(48);
    const ordered = scheduleAfterDubcap({ lanes: [[], [], []] }, rows, 0, true).lanes;
    expect(startOf(ordered, "x1|tank0")).toBe(58);
    expect(startOf(ordered, "y0|tank1")).toBe(58);
  });

  it("defaults old API requests to no event and preserves explicit event requests", () => {
    const request = { targetItemId: "puzzle-cube-1", quantity: 12 };
    expect(planRequestSchema.parse(request).includeDubcap).toBe(false);
    expect(planRequestSchema.parse({ ...request, includeDubcap: "true" }).includeDubcap).toBe(true);
    expect(replanRequestSchema.parse({ ...request, profile: profileFor([extended]), includeDubcap: true }).includeDubcap).toBe(true);
    expect(compareRequestSchema.parse({ ...request, profile: profileFor([extended]), includeDubcap: true,
      selectedCombos: [{ ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 10000 }] }).includeDubcap).toBe(true);
  });
});

// Henerprise EPIC burns C25 K25 R20; this one already holds C25 K25.
const fuelingTank = () => ({
  shiftCap: 0, startMode: "current" as const, capacity: 500 * T,
  currentContents: { curiosity: 60 * T, kindness: 60 * T, resilience: 60 * T },
  fuelingShip: { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: null, loaded: { curiosity: 25 * T, kindness: 25 * T } },
});

const cubeT2 = (quantity: number) => [{ targetItemId: "puzzle-cube-2", quantity }];

describe("a partly fueled ship and a fresh dubcap", () => {
  it("launches it first in the event, with event drops, after prep", async () => {
    // Two T2 cubes take six T1s: its two and two event launches' four. Its
    // drops count like an in-air ship's, toward ingredients.
    const result = await plan([extended], 2, { objectiveMode: "virtueFuel", virtueTank: fuelingTank(), targets: cubeT2(2) });
    const event = result.dubcap!;
    expect(result.unmetItems).toEqual([]);
    expect(event).toMatchObject({ live: false, startSeconds: 0, launches: 3 });
    expect(event.lanes[0]).toEqual([expect.objectContaining({ fueling: true, startSeconds: 0, endSeconds: extended.durationSeconds })]);
    expect(launches(result, true)).toBe(2);
    expect(event.fullLanes.flat().find((block) => block.fueling)).toMatchObject({ isPrep: false, dubcap: true, startSeconds: 0 });
    expect(result.expectedHours).toBeCloseTo(38.4);
    const fueling = result.virtueTanks!.units.find((unit) => unit.preFueled)!;
    expect(result.virtueTanks!.pack.launchOrder[0]).toMatchObject({ unitId: fueling.id, tankIndex: 0 });
    expectValidTimeline(result);
  }, 120_000);
});

describe("a live dubcap event", () => {
  const live = (secondsRemaining: number, multiplier = 2) => ({
    id: "event-test", message: "DOUBLE CAPACITY!", multiplier, secondsRemaining, durationSeconds: 48 * 3600, ultra: false,
  });
  const inAirExtended = (secondsRemaining: number) => ({ ship: "HENERPRISE", durationType: "EPIC", status: "EXPLORING",
    level: 0, capacity: 1, targetAfxId: 10000, secondsRemaining });

  it("launches now from free slots and joins each busy slot when its ship returns", async () => {
    const profile = { ...profileFor([extended]), liveDubcap: live(30 * 3600), inFlightMissions: [inAirExtended(24 * 3600)] };
    // In-air drops feed ingredients, not a goal's own copies: 6 cubes from new launches.
    const result = await plan([extended], 6, {}, profile);
    const event = result.dubcap!;
    expect(event).toMatchObject({ live: true, multiplier: 2, startSeconds: 0, windowSeconds: 30 * 3600 });
    // The in-air ship's slot opens at hour 24, still inside the event.
    expect(event.lanes.map((lane) => lane.map((block) => block.startSeconds))).toEqual([[24 * 3600], [0], [0]]);
    expect(launches(result, true)).toBe(3);
    expect(launches(result, false)).toBe(0);
    expect(result.expectedHours).toBeCloseTo(24 + 38.4);
    expect(result.notes.some((note) => note.includes("the event running now, which ends in 30h 00m"))).toBe(true);
    expectValidTimeline(result);
  }, 120_000);

  it("leaves a slot out of the event when its ship returns after the last launch time", async () => {
    const profile = { ...profileFor([extended]), liveDubcap: live(30 * 3600), inFlightMissions: [inAirExtended(31 * 3600)] };
    const result = await plan([extended], 7, {}, profile);
    const event = result.dubcap!;
    expect(event.lanes[0]).toEqual([]);
    expect(launches(result, true)).toBe(2);
    // 4 cubes from the event and 3 ordinary launches once the event's ships are back.
    expect(launches(result, false)).toBe(3);
    expect(result.expectedHours).toBeCloseTo(76.8);
    expect(Math.min(...event.fullLanes[0].map((block) => block.startSeconds))).toBeGreaterThanOrEqual(31 * 3600);
    expectValidTimeline(result);
  }, 120_000);

  it("uses the event's multiplier", async () => {
    const profile = { ...profileFor([extended]), liveDubcap: live(30 * 3600, 3) };
    const result = await plan([extended], 9, {}, profile);
    expect(result.dubcap!.multiplier).toBe(3);
    expect(launches(result, true)).toBe(3);
    expect(result.targetBreakdown.fromMissionsExpected).toBeCloseTo(9);
    expectValidTimeline(result);
  }, 120_000);

  it("plans a fresh event when too little of the live one is left to launch", async () => {
    const profile = { ...profileFor([extended]), liveDubcap: live(DUBCAP_LAUNCH_MARGIN_SECONDS - 1) };
    const result = await plan([extended], 12, {}, profile);
    expect(result.dubcap).toMatchObject({ live: false, windowSeconds: DUBCAP_WINDOW_SECONDS });
    expect(launches(result, true)).toBe(6);
  }, 120_000);

  it("opens the event's slots once unlock prep returns", async () => {
    const shipLevels = computeShipLevelsFromLaunchCounts({
      CHICKEN_ONE: { SHORT: 4 }, CHICKEN_NINE: { SHORT: 6 }, CHICKEN_HEAVY: { SHORT: 12 }, BCR: { SHORT: 15 },
      MILLENIUM_CHICKEN: { SHORT: 18 }, CORELLIHEN_CORVETTE: { SHORT: 21 }, GALEGGTICA: { SHORT: 24 },
      CHICKFIANT: { SHORT: 27 }, VOYEGGER: { SHORT: 28 },
    });
    const profile = { ...profileFor([]), shipLevels, missionOptions: buildMissionOptions(shipLevels, 60, 0),
      liveDubcap: live(40 * 3600) };
    const result = await plan([extended], 500, {}, profile);
    const event = result.dubcap!;
    expect(event.live).toBe(true);
    const prepEnd = Math.max(...event.fullLanes.flat().filter((block) => block.isPrep).map((block) => block.endSeconds));
    expect(prepEnd).toBeGreaterThan(0);
    expect(event.launches).toBeGreaterThan(0);
    expect(event.lanes.flat().every((block) => block.startSeconds >= prepEnd)).toBe(true);
    expectValidTimeline(result);
  }, 120_000);

  it("packs a live event's launches into tanks with an in-air ship holding a slot", async () => {
    const profile = { ...profileFor([extended, chickfiant]), liveDubcap: live(30 * 3600),
      inFlightMissions: [inAirExtended(10 * 3600)] };
    // One extended wave fits in 30 hours, so most cubes come from the event's 3 launches.
    const result = await plan([extended, chickfiant], 8, { objectiveMode: "virtueFuel", virtueTank: {
      shiftCap: 4, startMode: "current", capacity: 500 * T,
      currentContents: { curiosity: 60 * T, kindness: 60 * T, resilience: 40 * T },
    }, targets: [{ targetItemId: "puzzle-cube-1", quantity: 8 }, { targetItemId: "gold-meteorite-1", quantity: 6 }] }, profile);
    expect(result.unmetItems).toEqual([]);
    expect(result.dubcap!.live).toBe(true);
    expect(result.dubcap!.lanes[0].every((block) => block.startSeconds >= 10 * 3600)).toBe(true);
    expect(result.virtueTanks!.pack.schedule.makespanSeconds).toBe(result.dubcap!.makespanSeconds);
    expectValidTimeline(result);
  }, 120_000);

  it("keeps the partly fueled ship to its own slot but holds every slot for prep", () => {
    const H = 3600;
    const fueling = { id: "fueling", launches: 1, durationSeconds: 10 * H, prepOrder: -1, preFueled: true };
    expect(liveDubcapLaneStarts([fueling], [5 * H])).toEqual([5 * H, 10 * H, 0]);
    const prep = { id: "prep", launches: 2, durationSeconds: 4 * H, prepOrder: 0 };
    expect(liveDubcapLaneStarts([fueling, prep], [5 * H])).toEqual([14 * H, 14 * H, 14 * H]);
  });

  it("launches the partly fueled ship now in the first free slot, with event drops", async () => {
    const profile = { ...profileFor([extended]), liveDubcap: live(30 * 3600), inFlightMissions: [inAirExtended(10 * 3600)] };
    const result = await plan([extended], 2, { objectiveMode: "virtueFuel", virtueTank: fuelingTank(), targets: cubeT2(2) }, profile);
    const event = result.dubcap!;
    expect(result.unmetItems).toEqual([]);
    expect(event.live).toBe(true);
    // Slot 1 holds the in-air ship; the fueled ship takes slot 2 now. Its two
    // cubes leave four for two event launches, one in slot 1 at hour 10.
    expect(event.lanes[1][0]).toMatchObject({ fueling: true, startSeconds: 0, endSeconds: extended.durationSeconds });
    expect(launches(result, true)).toBe(2);
    expect(launches(result, false)).toBe(0);
    expect(result.notes.some((note) => note.includes("launches first in the dubcap, with 2× drops"))).toBe(true);
    expectValidTimeline(result);
  }, 120_000);

  it("launches the partly fueled ship before the event when the tank can't finish fueling it", async () => {
    const profile = { ...profileFor([extended]), liveDubcap: live(30 * 3600) };
    const tank = { ...fuelingTank(), shiftCap: 4, currentContents: { curiosity: 60 * T, kindness: 60 * T } };
    const result = await plan([extended], 2, { objectiveMode: "virtueFuel", virtueTank: tank }, profile);
    expect(result.unmetItems).toEqual([]);
    expect(result.dubcap!.lanes.flat().some((block) => block.fueling)).toBe(false);
    expect(result.dubcap!.fullLanes.flat().find((block) => block.fueling)).toMatchObject({ isPrep: true, dubcap: false });
    expect(result.notes.some((note) => note.includes("launches first, at its current"))).toBe(true);
  }, 120_000);

  it("gives comparisons the time left in the event", async () => {
    const [comparison] = await computeMonolithicPaths({ profile: { ...profileFor([extended]), liveDubcap: live(30 * 3600) },
      targetItemId: "puzzle-cube-1", quantity: 6, priorityTime: 1, includeDubcap: true,
      selectedCombos: [{ ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 10000 }],
      lootData: lootFor([extended]), solverFn: solveWithHighs });
    expect(comparison.feasible).toBe(true);
    // Only one extended wave fits in 30 hours: 3 event launches.
    expect(comparison.totalLaunches).toBe(3);
    expect(comparison.expectedHours).toBeCloseTo(38.4);
  }, 120_000);
});
