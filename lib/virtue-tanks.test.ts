import { describe, expect, it } from "vitest";

import { solveWithHighs } from "./highs";
import { getVirtueFuelConfig, TRILLION, type VirtueFuelKey } from "./virtue-fuel";
import {
  nearestVirtueShiftCapDetent,
  packVirtueTanks,
  packVirtueTanksHeuristic,
  refillShiftCount,
  scheduleVirtueLaunches,
  VIRTUE_REFILL_ROUTE_ORDER,
  VIRTUE_SHIFT_CAP_DETENTS,
  type VirtueFuelVector,
  type VirtueTankLaunchUnit,
  type VirtueTankPackInput,
  type VirtueTankPlan,
} from "./virtue-tanks";

const T = TRILLION;
const EGGS: VirtueFuelKey[] = ["curiosity", "integrity", "kindness", "resilience"];
const SOLVER_TIMEOUT_MS = 60_000;

function unit(
  id: string,
  ship: string,
  durationType: string,
  launches: number,
  extra: Partial<VirtueTankLaunchUnit> = {}
): VirtueTankLaunchUnit {
  const durationSeconds = { SHORT: 3_600, LONG: 20_000, EPIC: 60_000 }[durationType] ?? 3_600;
  return { id, ship, durationType, level: 0, durationSeconds, launches, ...extra };
}

function fuelOf(input: VirtueTankPackInput, unitId: string): VirtueFuelVector {
  const found = input.units.find((candidate) => candidate.id === unitId)!;
  return found.fuelPerLaunch ?? getVirtueFuelConfig(found.ship, found.durationType);
}

function total(vector: VirtueFuelVector): number {
  return EGGS.reduce((sum, egg) => sum + (vector[egg] || 0), 0);
}

/** Drains the plan asks for, as the levels they leave: every one must sit on a 1% step of the tank. */
type DrainRecord = { tankIndex: number; egg: VirtueFuelKey; from: number; to: number };

/** How far `level` is from the nearest 1% step of the tank (0 = empty counts as a step). */
function offStep(level: number, capacity: number): number {
  const step = capacity / 100;
  return Math.abs(level - Math.round(level / step) * step);
}

/**
 * Replays a plan the way the game would: carry the leftover, drain what the
 * loop says (the drain slider snaps to 1% of the tank, so each drain must leave
 * its egg on a whole step or empty, and the drained fuel is gone), then visit
 * each egg on the route and let it fill up to its limit slider or until the
 * tank is full. What the game leaves in the tank must be what the plan says it
 * starts with, and every tank must hold what its launches burn. An ideal plan
 * with known contents is replayed from them: drains first, then the fill.
 * Returns the drains, with the level each one leaves.
 */
function expectPlanPlaysOut(plan: VirtueTankPlan, input: VirtueTankPackInput, tolerance = 1): DrainRecord[] {
  const capacity = input.capacity;
  const drains: DrainRecord[] = [];
  // Players set limits as egg amounts ("Set limit 175T"), so nothing the player reads names a percent.
  for (const text of [...plan.notes, ...plan.unplaced.map((entry) => entry.reason)]) {
    expect(text).not.toMatch(/%/);
  }
  const fill = (contents: Record<VirtueFuelKey, number>, egg: VirtueFuelKey, limitPct: number) => {
    const others = total(contents) - contents[egg];
    contents[egg] = Math.max(contents[egg], Math.min((limitPct / 100) * capacity, capacity - others));
  };
  const drain = (contents: Record<VirtueFuelKey, number>, tankIndex: number, egg: VirtueFuelKey, amount: number) => {
    const from = contents[egg];
    contents[egg] -= amount;
    expect(contents[egg]).toBeGreaterThanOrEqual(-tolerance);
    const what = `drain ${egg} before tank ${tankIndex + 1} to ${contents[egg]}`;
    expect(offStep(contents[egg], capacity), what).toBeLessThanOrEqual(tolerance);
    drains.push({ tankIndex, egg, from, to: contents[egg] });
  };
  const expectStartsAsPlanned = (contents: Record<VirtueFuelKey, number>, startContents: VirtueFuelVector) => {
    for (const egg of EGGS) {
      expect(Math.abs(contents[egg] - (startContents[egg] || 0)), `${egg} at the start`).toBeLessThanOrEqual(tolerance);
    }
  };

  let contents: Record<VirtueFuelKey, number> = { curiosity: 0, integrity: 0, kindness: 0, resilience: 0 };
  if (plan.startMode === "current") {
    for (const egg of EGGS) {
      contents[egg] = input.currentContents?.[egg] || 0;
    }
  } else {
    const idealFill = plan.tanks[0].idealFill!;
    expect(idealFill).toBeDefined();
    if (input.currentContents) {
      expect(idealFill.changeFromCurrent).toBeDefined();
      for (const egg of EGGS) {
        contents[egg] = input.currentContents[egg] || 0;
        const change = idealFill.changeFromCurrent?.[egg] || 0;
        if (change < 0) {
          drain(contents, 0, egg, -change);
        } else if (change > 0) {
          expect(contents[egg] + change).toBeCloseTo(idealFill.fillTo[egg] || 0, -3);
        }
      }
    } else {
      expect(idealFill.changeFromCurrent).toBeUndefined();
    }
    // The fill shifts to each egg that starts above what it holds now, in route order. An egg that
    // already holds what the plan needs may stay as it is, below its limit step: no shift to it.
    const start = plan.tanks[0].startContents;
    for (const egg of VIRTUE_REFILL_ROUTE_ORDER) {
      if (idealFill.limitPct[egg] !== undefined) {
        if ((start[egg] || 0) > contents[egg] + tolerance) {
          fill(contents, egg, idealFill.limitPct[egg]!);
        }
        expect(contents[egg]).toBeGreaterThanOrEqual((idealFill.fillTo[egg] || 0) - tolerance);
      }
    }
    // Every egg starts on a step, as it is now (left alone), or at the brim of a full tank.
    const full = total(start) >= capacity - tolerance;
    for (const egg of EGGS) {
      const level = start[egg] || 0;
      const asNow = Math.abs(level - (input.currentContents?.[egg] || 0)) <= tolerance;
      expect(offStep(level, capacity) <= tolerance || asNow || full, `${egg} starts at ${level}`).toBe(true);
    }
  }

  let shifts = 0;
  const placed = new Map<string, number>();
  plan.tanks.forEach((tank, index) => {
    expect(tank.index).toBe(index);
    expect(tank.label).toBe(index === 0 ? "Initial Tank" : `Tank ${index + 1}`);
    if (index === 0) {
      expect(tank.refill).toBeNull();
    } else {
      const refill = tank.refill!;
      expect(refill.route[refill.route.length - 1]).toBe("humility");
      expect(refill.shifts).toBe(refill.route.length);
      const eggs = refill.route.slice(0, -1) as VirtueFuelKey[];
      expect(eggs.length).toBeGreaterThan(0);
      expect(eggs).toEqual(VIRTUE_REFILL_ROUTE_ORDER.filter((egg) => eggs.includes(egg)));
      shifts += refill.shifts;
      for (const egg of EGGS) {
        if ((refill.drain[egg] || 0) > 0) {
          drain(contents, index, egg, refill.drain[egg]!);
        }
      }
      for (const egg of eggs) {
        const limit = refill.limitPct[egg]!;
        expect(limit).toBe(Math.ceil(((refill.fillTo[egg] || 0) / capacity) * 100 - 1e-9));
        fill(contents, egg, limit);
        expect(contents[egg]).toBeGreaterThanOrEqual((refill.fillTo[egg] || 0) - tolerance);
      }
    }
    expect(total(contents)).toBeLessThanOrEqual(capacity + tolerance);
    expectStartsAsPlanned(contents, tank.startContents);

    const burned: Record<VirtueFuelKey, number> = { curiosity: 0, integrity: 0, kindness: 0, resilience: 0 };
    for (const launch of tank.launches) {
      placed.set(launch.unitId, (placed.get(launch.unitId) || 0) + launch.launches);
      const fuel = fuelOf(input, launch.unitId);
      for (const egg of EGGS) {
        burned[egg] += (fuel[egg] || 0) * launch.launches;
      }
    }
    for (const egg of EGGS) {
      expect(burned[egg]).toBeLessThanOrEqual(contents[egg] + tolerance);
      expect(tank.used[egg] || 0).toBeCloseTo(burned[egg], -3);
      contents[egg] -= burned[egg];
      expect(Math.abs(Math.max(0, contents[egg]) - (tank.leftover[egg] || 0)), `${egg} left over`).toBeLessThanOrEqual(tolerance);
    }
  });

  expect(plan.totalShifts).toBe(shifts);
  expect(plan.refillLoops).toBe(plan.tanks.length - 1);
  const unplaced = new Map(plan.unplaced.map((entry) => [entry.unitId, entry.launches]));
  for (const input_unit of input.units) {
    expect((placed.get(input_unit.id) || 0) + (unplaced.get(input_unit.id) || 0)).toBe(input_unit.launches);
  }
  expect(plan.launchOrder).toEqual(
    plan.tanks.flatMap((tank) => tank.launches.map((launch) => ({ ...launch, tankIndex: tank.index })))
  );
  return drains;
}

async function packBoth(input: VirtueTankPackInput, tolerance?: number) {
  const heuristic = packVirtueTanksHeuristic(input);
  const exact = await packVirtueTanks({ ...input, solverFn: solveWithHighs, timeLimitSeconds: 20 });
  expectPlanPlaysOut(heuristic, input, tolerance);
  expectPlanPlaysOut(exact, input, tolerance);
  return { heuristic, exact };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe("virtue tank helpers", () => {
  it("counts a refill loop as one shift per egg plus the shift back to Humility", () => {
    expect(refillShiftCount([])).toBe(0);
    expect(refillShiftCount(["integrity"])).toBe(2);
    expect(refillShiftCount(["curiosity", "resilience", "kindness"])).toBe(4);
    expect(refillShiftCount(["kindness", "kindness"])).toBe(2);
  });

  it("snaps the shift cap to its detents, treating 1 as 0", () => {
    expect(VIRTUE_SHIFT_CAP_DETENTS).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(nearestVirtueShiftCapDetent(1)).toBe(0);
    expect(nearestVirtueShiftCapDetent(1.6)).toBe(2);
    expect(nearestVirtueShiftCapDetent(7.4)).toBe(7);
    expect(nearestVirtueShiftCapDetent(40)).toBe(15);
    expect(nearestVirtueShiftCapDetent(-3)).toBe(0);
    expect(nearestVirtueShiftCapDetent(Number.NaN)).toBe(0);
  });

  it("list-schedules launches onto three slots, waiting for each refuel", () => {
    const schedule = scheduleVirtueLaunches(
      [
        { unitId: "long", tankIndex: 0, launches: 2 },
        { unitId: "short", tankIndex: 0, launches: 2 },
        { unitId: "short", tankIndex: 1, launches: 1 },
      ],
      { durations: { long: 100, short: 10 }, refuelDelaySeconds: 5 }
    );
    // Tank 0: long@0 (slot 0), long@0 (slot 1), short@0 (slot 2), short@10 (slot 2).
    // Tank 1 waits for the last tank-0 launch (t=10) plus the 5s refuel.
    expect(schedule.lanes[2]).toEqual([
      { unitId: "short", tankIndex: 0, launches: 2, startSeconds: 0, endSeconds: 20 },
      { unitId: "short", tankIndex: 1, launches: 1, startSeconds: 20, endSeconds: 30 },
    ]);
    expect(schedule.makespanSeconds).toBe(100);

    const delayed = scheduleVirtueLaunches(
      [
        { unitId: "short", tankIndex: 0, launches: 1 },
        { unitId: "short", tankIndex: 1, launches: 1 },
      ],
      { durations: { short: 10 }, refuelDelaySeconds: 50 }
    );
    expect(delayed.lanes[1][0].startSeconds).toBe(50);
  });

  it("matches plain LPT list scheduling for a single tank, with in-air ships holding slots", async () => {
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "ideal",
      inAirLaneFreeSeconds: [7_000, 30_000],
      units: [
        unit("voy", "VOYEGGER", "EPIC", 4, { durationSeconds: 50_000 }),
        unit("chick", "CHICKFIANT", "LONG", 5, { durationSeconds: 21_000 }),
        unit("bcr", "BCR", "SHORT", 7, { durationSeconds: 4_000 }),
      ],
    };
    const { exact } = await packBoth(input);
    expect(exact.tanks).toHaveLength(1);

    const durations = [...Array(4).fill(50_000), ...Array(5).fill(21_000), ...Array(7).fill(4_000)];
    const lanes = [7_000, 30_000, 0];
    for (const duration of durations) {
      const lane = lanes.indexOf(Math.min(...lanes));
      lanes[lane] += duration;
    }
    expect(exact.schedule.makespanSeconds).toBe(Math.max(...lanes));
    const scheduled = exact.schedule.lanes.flat().reduce((sum, block) => sum + block.launches, 0);
    expect(scheduled).toBe(16);
  }, SOLVER_TIMEOUT_MS);
});

describe("packVirtueTanks", () => {
  it("needs no shifts when the current tank already holds the whole plan", async () => {
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: { curiosity: 200 * T, kindness: 150 * T, integrity: 1 * T },
      units: [unit("voy", "VOYEGGER", "EPIC", 6), unit("bcr", "BCR", "EPIC", 10)],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(0);
      expect(plan.tanks).toHaveLength(1);
      expect(plan.exact).toBe(true);
      expect(plan.feasible).toBe(true);
      expect(plan.tanks[0].used).toEqual({ curiosity: 150 * T, kindness: 90 * T, integrity: 300_000_000 });
      expect(plan.tanks[0].leftover.curiosity).toBe(50 * T);
    }
  }, SOLVER_TIMEOUT_MS);

  it("adds refuel loops when the current tank runs short", async () => {
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: { curiosity: 100 * T, kindness: 100 * T },
      units: [unit("voy", "VOYEGGER", "EPIC", 12)],
    };
    const { heuristic, exact } = await packBoth(input);
    // 12 Voyegger epics burn 300T Curiosity and 180T Kindness; the tank holds 4 of them now.
    // One loop refilling both eggs covers the other 8 (and would also cover all 12).
    expect(exact.totalShifts).toBe(3);
    expect(heuristic.totalShifts).toBe(3);
    expect(exact.tanks).toHaveLength(2);
    expect(exact.tanks[1].refill?.route).toEqual(["curiosity", "kindness", "humility"]);
    expect(exact.exact).toBe(true);
  }, SOLVER_TIMEOUT_MS);

  it("fits three Henliner epics per 500T tank (limit sliders land exactly on 30/24/45%)", async () => {
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: {},
      units: [unit("henliner", "ATREGGIES", "EPIC", 9)],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(12);
      expect(plan.tanks.map((tank) => tank.launches.reduce((sum, launch) => sum + launch.launches, 0))).toEqual([0, 3, 3, 3]);
      for (const tank of plan.tanks.slice(1)) {
        expect(tank.refill?.route).toEqual(["curiosity", "resilience", "kindness", "humility"]);
        expect(tank.refill?.limitPct).toEqual({ curiosity: 30, resilience: 24, kindness: 45 });
        expect(tank.refill?.fillTo).toEqual({ curiosity: 150 * T, resilience: 120 * T, kindness: 225 * T });
      }
    }
    expect(exact.exact).toBe(true);
  }, SOLVER_TIMEOUT_MS);

  it("keeps Curiosity/Kindness launches apart from Resilience ones when that saves shifts", async () => {
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: {},
      units: [unit("henliner", "ATREGGIES", "EPIC", 6), unit("voy", "VOYEGGER", "EPIC", 12)],
    };
    const { heuristic, exact } = await packBoth(input);
    // Two C/R/K loops of 3 Henliners (8 shifts) + one C/K loop of 12 Voyeggers (3 shifts).
    expect(exact.totalShifts).toBe(11);
    expect(heuristic.totalShifts).toBe(11);
    const routes = exact.tanks.slice(1).map((tank) => tank.refill?.route.join(">")).sort();
    expect(routes).toEqual([
      "curiosity>kindness>humility",
      "curiosity>resilience>kindness>humility",
      "curiosity>resilience>kindness>humility",
    ]);
  }, SOLVER_TIMEOUT_MS);

  it("piggybacks Integrity-only ships on another loop instead of a loop of their own", async () => {
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: {},
      units: [unit("henliner", "ATREGGIES", "EPIC", 3), unit("bcr", "BCR", "SHORT", 10)],
    };
    const { heuristic, exact } = await packBoth(input);
    // 495T of Henliner fuel + 100M Integrity: the Integrity slider rounds up to 1% (5T) and still fits.
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(5);
      expect(plan.tanks).toHaveLength(2);
      expect(plan.tanks[1].refill?.route).toEqual(["curiosity", "resilience", "integrity", "kindness", "humility"]);
      expect(plan.tanks[1].refill?.limitPct.integrity).toBe(1);
    }
  }, SOLVER_TIMEOUT_MS);

  it("carries leftover fuel so a later loop skips an egg", async () => {
    const fromEmpty: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: {},
      units: [unit("henliner", "ATREGGIES", "EPIC", 4)],
    };
    const { heuristic, exact } = await packBoth(fromEmpty);
    // 3 + 1 would be 8 shifts; filling Curiosity and Resilience for all four up front leaves only Kindness.
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(6);
      expect(plan.tanks[1].refill?.route).toEqual(["curiosity", "resilience", "kindness", "humility"]);
      expect(plan.tanks[2].refill?.route).toEqual(["kindness", "humility"]);
    }

    const leftoverCuriosity: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: { curiosity: 300 * T },
      units: [unit("voy", "VOYEGGER", "EPIC", 6)],
    };
    const carried = await packBoth(leftoverCuriosity);
    expect(carried.exact.totalShifts).toBe(2);
    expect(carried.exact.tanks[1].refill?.route).toEqual(["kindness", "humility"]);
    expect(carried.exact.tanks[1].refill?.add).toEqual({ kindness: 90 * T });
    expect(carried.exact.tanks[1].startContents.curiosity).toBe(300 * T);
  }, SOLVER_TIMEOUT_MS);

  it("accounts for limit sliders rounding up to whole percents", async () => {
    const input: VirtueTankPackInput = {
      capacity: 100 * T,
      startMode: "current",
      currentContents: {},
      units: [
        unit("ck", "CUSTOM", "EPIC", 4, { fuelPerLaunch: { curiosity: 10.1 * T, kindness: 10 * T } }),
        unit("i", "CUSTOM", "SHORT", 1, { fuelPerLaunch: { integrity: 19.5 * T } }),
      ],
    };
    const { heuristic, exact } = await packBoth(input);
    // Everything is 99.9T, but Curiosity (40.4T -> 41%) and Integrity (19.5T -> 20%) round up
    // before Kindness fills last, so one C/I/K loop (4 shifts) overflows: C/K + I loops it is.
    expect(exact.totalShifts).toBe(5);
    expect(heuristic.totalShifts).toBe(5);
    const ckTank = exact.tanks.find((tank) => tank.refill?.route.includes("kindness"))!;
    expect(ckTank.refill?.limitPct).toEqual({ curiosity: 41, kindness: 40 });
  }, SOLVER_TIMEOUT_MS);

  it("plans an ideal initial tank and shows the change from the current contents", async () => {
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "ideal",
      currentContents: { curiosity: 200 * T, integrity: 50 * T },
      currentHumility: 20 * T,
      units: [unit("henliner", "ATREGGIES", "EPIC", 9)],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(8);
      expect(plan.tanks[0].launches).toEqual([{ unitId: "henliner", launches: 3 }]);
      const idealFill = plan.tanks[0].idealFill!;
      expect(idealFill.fillTo.curiosity).toBe(150 * T);
      expect(idealFill.fillTo.kindness).toBe(225 * T);
      expect(total(idealFill.fillTo)).toBeLessThanOrEqual(500 * T);
      expect(idealFill.changeFromCurrent?.curiosity).toBe(-50 * T);
      expect(idealFill.changeFromCurrent?.integrity).toBe(-50 * T);
      // The ideal fill is the first fill, so that is where Humility gets drained (and its limit zeroed).
      expect(idealFill.drainHumility).toBe(true);
      expect(plan.tanks.slice(1).map((tank) => tank.refill?.drainHumility)).toEqual([false, false]);
      expect(plan.notes.some((note) => note.startsWith("Drain the leftover Humility") && note.includes("set its limit to 0:"))).toBe(true);
    }
    expect(exact.exact).toBe(true);
  }, SOLVER_TIMEOUT_MS);

  it("launches every prep step before any mission, in prep order", async () => {
    const input: VirtueTankPackInput = {
      capacity: 200 * T,
      startMode: "current",
      currentContents: { curiosity: 50 * T, kindness: 20 * T },
      units: [
        unit("mission-a", "HENERPRISE", "EPIC", 5),
        unit("mission-b", "VOYEGGER", "LONG", 6),
        unit("prep-2", "GALEGGTICA", "SHORT", 3, { isPrep: true, prepOrder: 1 }),
        unit("mission-c", "BCR", "EPIC", 10),
        unit("prep-1", "MILLENIUM_CHICKEN", "SHORT", 4, { isPrep: true, prepOrder: 0 }),
      ],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      const order = plan.launchOrder.map((entry) => entry.unitId);
      const lastPrep1 = order.lastIndexOf("prep-1");
      const firstPrep2 = order.indexOf("prep-2");
      const lastPrep2 = order.lastIndexOf("prep-2");
      const firstMission = order.findIndex((id) => id.startsWith("mission"));
      expect(lastPrep1).toBeLessThan(firstPrep2);
      expect(lastPrep2).toBeLessThan(firstMission);
      const tankOf = (id: string) => plan.launchOrder.filter((entry) => entry.unitId === id).map((entry) => entry.tankIndex);
      expect(Math.max(...tankOf("prep-2"))).toBeLessThanOrEqual(
        Math.min(...["mission-a", "mission-b", "mission-c"].flatMap(tankOf))
      );
    }
    expect(exact.totalShifts).toBeLessThanOrEqual(heuristic.totalShifts);
  }, SOLVER_TIMEOUT_MS);

  it("launches lower levels of the same ship and duration first", async () => {
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: { curiosity: 100 * T, kindness: 150 * T, resilience: 80 * T },
      units: [
        unit("henliner-l3", "ATREGGIES", "EPIC", 2, { level: 3 }),
        unit("henliner-l1", "ATREGGIES", "EPIC", 3, { level: 1 }),
        unit("henliner-l2", "ATREGGIES", "EPIC", 3, { level: 2 }),
      ],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      const levels = plan.launchOrder.flatMap((entry) =>
        Array(entry.launches).fill(Number(entry.unitId.slice(-1)))
      );
      expect(levels).toEqual([1, 1, 1, 2, 2, 2, 3, 3]);
      expect(plan.tanks[0].launches).toEqual([{ unitId: "henliner-l1", launches: 2 }]);
    }
  }, SOLVER_TIMEOUT_MS);

  it("keeps levels ascending for ships that burn no virtue fuel, across tanks", () => {
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: {},
      inAirLaneFreeSeconds: [60_000, 60_000],
      units: [
        unit("henliner", "ATREGGIES", "EPIC", 4),
        unit("chicken-l0", "CHICKEN_ONE", "SHORT", 3),
        unit("chicken-l1", "CHICKEN_ONE", "SHORT", 1, { level: 1 }),
      ],
    };
    const plan = packVirtueTanksHeuristic(input);
    expectPlanPlaysOut(plan, input);
    const order = plan.launchOrder.map((entry) => entry.unitId);
    expect(order.lastIndexOf("chicken-l0")).toBeLessThan(order.indexOf("chicken-l1"));
  });

  it("reports launches that can never fit and packs the rest", async () => {
    const input: VirtueTankPackInput = {
      capacity: 100 * T,
      startMode: "current",
      currentContents: { curiosity: 100 * T },
      units: [unit("henliner", "ATREGGIES", "EPIC", 2), unit("voy", "VOYEGGER", "SHORT", 3)],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.feasible).toBe(false);
      expect(plan.unplaced).toEqual([
        { unitId: "henliner", launches: 2, reason: expect.stringContaining("165T") },
      ]);
      expect(plan.notes.some((note) => note.includes("2× Henliner Extended can never launch"))).toBe(true);
      expect(plan.launchOrder.some((entry) => entry.unitId === "henliner")).toBe(false);
      expect(plan.totalShifts).toBe(2);
      expect(plan.tanks[1].refill?.route).toEqual(["kindness", "humility"]);
    }
  }, SOLVER_TIMEOUT_MS);

  it("slots in ships that burn no virtue fuel without touching the tanks", async () => {
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: {},
      units: [
        unit("henliner", "ATREGGIES", "EPIC", 3),
        unit("chicken", "CHICKEN_ONE", "SHORT", 5, { durationSeconds: 1_200 }),
      ],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(4);
      expect(plan.totalFuel).toEqual({ curiosity: 150 * T, resilience: 120 * T, kindness: 225 * T });
      expect(plan.launchOrder.filter((entry) => entry.unitId === "chicken")).toEqual([
        { unitId: "chicken", tankIndex: expect.any(Number), launches: 5 },
      ]);
    }

    const onlyFree = packVirtueTanksHeuristic({
      capacity: 500 * T,
      startMode: "ideal",
      units: [unit("chicken", "CHICKEN_NINE", "LONG", 2)],
    });
    expect(onlyFree.totalShifts).toBe(0);
    expect(onlyFree.tanks).toHaveLength(1);
    expect(onlyFree.launchOrder).toEqual([{ unitId: "chicken", tankIndex: 0, launches: 2 }]);
    expect(onlyFree.tanks[0].idealFill?.fillTo).toEqual({});
  }, SOLVER_TIMEOUT_MS);

  it("falls back to the heuristic packing when the solver fails", async () => {
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: {},
      units: [unit("henliner", "ATREGGIES", "EPIC", 4)],
      solverFn: async () => ({ Status: "Infeasible" }),
    };
    const plan = await packVirtueTanks(input);
    expectPlanPlaysOut(plan, input);
    expect(plan.exact).toBe(false);
    expect(plan.totalShifts).toBe(6);
    expect(plan.diagnostics.some((line) => line.includes("HiGHS status 'Infeasible'"))).toBe(true);
    expect(plan.notes).toEqual([]);

    const throwing = await packVirtueTanks({ ...input, solverFn: async () => Promise.reject(new Error("boom")) });
    expect(throwing.exact).toBe(false);
    expect(throwing.diagnostics.some((line) => line.includes("boom"))).toBe(true);

    const empty = await packVirtueTanks({
      ...input,
      solverFn: async () => undefined as unknown as Awaited<ReturnType<typeof solveWithHighs>>,
    });
    expectPlanPlaysOut(empty, input);
    expect(empty.exact).toBe(false);
    expect(empty.totalShifts).toBe(6);
  });

  it("only claims a proof when the packing meets the solver's own shift count", async () => {
    // A solver that reports Optimal with every refill switch off: its packing is realizable, but
    // needs refills it never paid for, so the result is not proven.
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: {},
      units: [unit("henliner", "ATREGGIES", "EPIC", 4)],
      solverFn: async () => ({
        Status: "Optimal",
        ObjectiveValue: 0,
        Columns: { n_0_0: { Primal: 0 }, n_0_1: { Primal: 3 }, n_0_2: { Primal: 1 } },
      }),
    };
    const plan = await packVirtueTanks(input);
    expectPlanPlaysOut(plan, input);
    expect(plan.totalShifts).toBe(6);
    expect(plan.exact).toBe(false);
    expect(plan.diagnostics.some((line) => line.includes("not proven"))).toBe(true);
  });

  it("does not let tiny Integrity burns ride on a nearly-off refill switch", async () => {
    // With HiGHS's default integrality tolerance the Integrity refill switch could sit at ~1e-6 and
    // still carry the BCR fuel, "proving" 7 shifts; the real optimum is 8.
    const input: VirtueTankPackInput = {
      capacity: 100 * T,
      startMode: "current",
      currentContents: {},
      units: [
        unit("bcr", "BCR", "LONG", 4, { durationSeconds: 3_600 }),
        unit("atreggies", "ATREGGIES", "SHORT", 2),
        unit("voy", "VOYEGGER", "LONG", 4),
      ],
    };
    let objective: number | undefined;
    const exact = await packVirtueTanks({
      ...input,
      timeLimitSeconds: 20,
      solverFn: async (model, options) => {
        const solution = await solveWithHighs(model, options);
        objective = solution.ObjectiveValue;
        return solution;
      },
    });
    expectPlanPlaysOut(exact, input);
    expect(exact.totalShifts).toBe(8);
    expect(exact.exact).toBe(true);
    expect(Math.floor(objective! / 1000)).toBe(8);
  }, SOLVER_TIMEOUT_MS);

  it("lets a refill tank hold more than a fully rounded refill would", async () => {
    // Five Voyegger epics are exactly 200T. Rounding every refilled egg would allow only four per
    // tank, but here Curiosity carries over and Kindness alone fills to the brim.
    const input: VirtueTankPackInput = {
      capacity: 200 * T,
      startMode: "current",
      currentContents: { curiosity: 125 * T },
      units: [unit("voy", "VOYEGGER", "EPIC", 5)],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(2);
      expect(plan.tanks[1].launches).toEqual([{ unitId: "voy", launches: 5 }]);
      expect(plan.tanks[1].refill?.route).toEqual(["kindness", "humility"]);
    }
    expect(exact.exact).toBe(true);
    expect(exact.diagnostics).toEqual([]);
  }, SOLVER_TIMEOUT_MS);

  it("skips the exact solve when told to, or when the plan is past the top shift cap", async () => {
    const calls: string[] = [];
    const spy: VirtueTankPackInput["solverFn"] = async (model, options) => {
      calls.push(model);
      return solveWithHighs(model, options);
    };
    const small: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: {},
      units: [unit("henliner", "ATREGGIES", "EPIC", 4)],
    };
    const noTime = await packVirtueTanks({ ...small, solverFn: spy, timeLimitSeconds: 0 });
    expect(calls).toHaveLength(0);
    expect(noTime.exact).toBe(false);
    expect(noTime.totalShifts).toBe(6);

    // 12 Henliner epics from empty need 16 shifts: over any cap, so only the heuristic runs.
    const big: VirtueTankPackInput = { ...small, units: [unit("henliner", "ATREGGIES", "EPIC", 12)] };
    const overCap = await packVirtueTanks({ ...big, solverFn: spy });
    expectPlanPlaysOut(overCap, big);
    expect(calls).toHaveLength(0);
    expect(overCap.totalShifts).toBe(16);
    expect(overCap.exact).toBe(false);
    expect(overCap.diagnostics.some((line) => line.includes("skipped"))).toBe(true);
  }, SOLVER_TIMEOUT_MS);

  it("drops float noise from the game's tank readings", () => {
    const ideal = packVirtueTanksHeuristic({
      capacity: 500 * T,
      startMode: "ideal",
      currentContents: { curiosity: 150 * T + 0.9, resilience: 120 * T - 0.4 },
      units: [unit("henliner", "ATREGGIES", "EPIC", 3)],
    });
    expect(ideal.tanks[0].idealFill?.changeFromCurrent).toEqual({ kindness: 225 * T });

    const current = packVirtueTanksHeuristic({
      capacity: 500 * T,
      startMode: "current",
      currentContents: { curiosity: 150 * T - 0.5, resilience: 120 * T, kindness: 225 * T },
      units: [unit("henliner", "ATREGGIES", "EPIC", 3)],
    });
    expect(current.totalShifts).toBe(0);
    expect(current.tanks[0].leftover).toEqual({});
  });

  it("keeps an ideal fill-to target within what its limit slider gives", () => {
    const capacity = 400 * T;
    const plan = packVirtueTanksHeuristic({
      capacity,
      startMode: "ideal",
      currentContents: { integrity: 80 * T, kindness: 40 * T - 0.4, resilience: 120 * T + 0.02 },
      units: [
        unit("voy-epic", "VOYEGGER", "EPIC", 4),
        unit("voy-short", "VOYEGGER", "SHORT", 2),
        unit("quintillion", "MILLENIUM_CHICKEN", "LONG", 4),
        unit("henliner", "ATREGGIES", "SHORT", 6),
      ],
    });
    const idealFill = plan.tanks[0].idealFill!;
    for (const egg of EGGS) {
      if (idealFill.fillTo[egg] !== undefined) {
        expect(idealFill.fillTo[egg]).toBeLessThanOrEqual((idealFill.limitPct[egg]! / 100) * capacity);
      }
    }
  });

  it("schedules units that share an id by their own durations", () => {
    const plan = packVirtueTanksHeuristic({
      capacity: 500 * T,
      startMode: "ideal",
      units: [
        unit("x", "VOYEGGER", "EPIC", 3, { durationSeconds: 50_000 }),
        unit("x", "BCR", "SHORT", 5, { durationSeconds: 100 }),
      ],
    });
    // Three Voyeggers fill the slots until 50000s, then five BCRs take two more rounds of 100s.
    expect(plan.schedule.makespanSeconds).toBe(50_200);
    expect(plan.diagnostics.some((line) => line.includes("'x'"))).toBe(true);
  });

  it("drains Humility and zeroes its limit only at the plan's first fill", async () => {
    // 8 Henerprise epics from an empty tank need two loops, so the second loop shows the flag stays off.
    const current: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "current",
      currentContents: {},
      currentHumility: 40 * T,
      units: [unit("henerprise", "HENERPRISE", "EPIC", 8)],
    };
    const ideal: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "ideal",
      currentContents: { curiosity: 100 * T },
      currentHumility: 40 * T,
      units: [unit("henerprise", "HENERPRISE", "EPIC", 15)],
    };
    const humilityNotes = (plan: VirtueTankPlan) => plan.notes.filter((note) => /humility/i.test(note));

    const withHumility = await packBoth(current);
    for (const plan of [withHumility.heuristic, withHumility.exact]) {
      expect(plan.refillLoops).toBe(2);
      // Humility never re-enters the tank at 0%, so only the first refill drains it.
      expect(plan.tanks.map((tank) => tank.refill?.drainHumility ?? null)).toEqual([null, true, false]);
      expect(plan.tanks[0].idealFill).toBeUndefined();
      expect(humilityNotes(plan)).toEqual([
        "Drain the leftover Humility in the tank before the first refuel loop and set its limit to 0: " +
          "ships fuel Humility straight from the Humility farm.",
      ]);
    }

    const idealWithHumility = await packBoth(ideal);
    for (const plan of [idealWithHumility.heuristic, idealWithHumility.exact]) {
      expect(plan.refillLoops).toBeGreaterThanOrEqual(2);
      expect(plan.tanks[0].idealFill?.drainHumility).toBe(true);
      expect(plan.tanks.slice(1).every((tank) => tank.refill?.drainHumility === false)).toBe(true);
      expect(humilityNotes(plan)).toEqual([
        "Drain the leftover Humility in the tank before filling the initial tank and set its limit to 0: " +
          "ships fuel Humility straight from the Humility farm.",
      ]);
    }

    for (const input of [current, ideal]) {
      for (const currentHumility of [0, undefined]) {
        const plan = packVirtueTanksHeuristic({ ...input, currentHumility });
        expectPlanPlaysOut(plan, input);
        expect(plan.tanks.slice(1).map((tank) => tank.refill?.drainHumility)).toEqual(
          plan.tanks.slice(1).map(() => false)
        );
        expect(plan.tanks[0].idealFill?.drainHumility ?? false).toBe(false);
        expect(humilityNotes(plan)).toEqual([]);
      }
    }

    // No note ever asks for room for Humility or a Humility limit above 0, or names a percent.
    for (const plan of [withHumility.heuristic, withHumility.exact, idealWithHumility.heuristic, idealWithHumility.exact]) {
      for (const note of humilityNotes(plan)) {
        expect(note).not.toMatch(/room/i);
        expect(note).not.toMatch(/%/);
        expect(note.match(/limit to [\d.]+\w*/g)).toEqual(["limit to 0"]);
      }
    }
  }, SOLVER_TIMEOUT_MS);

  it("is never beaten by the heuristic on random small plans", async () => {
    const random = seededRandom(20260924);
    const ships: Array<[string, string]> = [
      ["ATREGGIES", "EPIC"],
      ["ATREGGIES", "SHORT"],
      ["HENERPRISE", "LONG"],
      ["HENERPRISE", "SHORT"],
      ["VOYEGGER", "EPIC"],
      ["CHICKFIANT", "EPIC"],
      ["GALEGGTICA", "LONG"],
      ["BCR", "SHORT"],
      ["MILLENIUM_CHICKEN", "EPIC"],
    ];
    const capacities = [100 * T, 200 * T, 300 * T, 500 * T];
    for (let round = 0; round < 12; round += 1) {
      const capacity = capacities[Math.floor(random() * capacities.length)];
      const units = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, index) => {
        const [ship, durationType] = ships[Math.floor(random() * ships.length)];
        return unit(`u${index}`, ship, durationType, 1 + Math.floor(random() * 6));
      });
      const currentContents: VirtueFuelVector = {};
      for (const egg of EGGS) {
        currentContents[egg] = Math.floor(random() * 4) * 0.1 * capacity;
      }
      const input: VirtueTankPackInput = {
        capacity,
        startMode: random() < 0.5 ? "current" : "ideal",
        currentContents,
        units,
      };
      const { heuristic, exact } = await packBoth(input);
      expect(exact.totalShifts * 100 + exact.refillLoops).toBeLessThanOrEqual(
        heuristic.totalShifts * 100 + heuristic.refillLoops
      );
    }
  }, 240_000);
});

describe("Path of Virtue meta tanks (maxed stars, 500T tank)", () => {
  const capacity = 500 * T;
  const pct = capacity / 100;
  const EMPTY_TANK: VirtueFuelVector = { curiosity: 0, integrity: 0, kindness: 0, resilience: 0 };
  const META_FILL: VirtueFuelVector = { curiosity: 175 * T, resilience: 140 * T, integrity: 10 * T, kindness: 175 * T };
  const META_LIMITS = { curiosity: 35, resilience: 28, integrity: 2, kindness: 35 };
  /** The Integrity-only ships that ride along: 10T of Integrity each way. */
  const INTEGRITY_RIDERS: Array<[string, number]> = [
    ["MILLENIUM_CHICKEN", 200],
    ["CORELLIHEN_CORVETTE", 1000],
  ];

  function launchesByUnit(plan: VirtueTankPlan, tankIndex: number): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const launch of plan.tanks[tankIndex].launches) {
      counts[launch.unitId] = (counts[launch.unitId] || 0) + launch.launches;
    }
    return counts;
  }

  /**
   * Every refilled egg but the last in the route lands exactly on its whole-percent slider, the
   * last one fills the rest, and what the sliders deliver never tops the tank.
   */
  function expectSlidersFit(plan: VirtueTankPlan): void {
    for (const tank of plan.tanks) {
      expect(total(tank.startContents)).toBeLessThanOrEqual(capacity + 1);
      const limits = tank.refill?.limitPct ?? tank.idealFill?.limitPct ?? {};
      const fillTo = tank.refill?.fillTo ?? tank.idealFill?.fillTo ?? {};
      const eggs = tank.refill
        ? (tank.refill.route.slice(0, -1) as VirtueFuelKey[])
        : VIRTUE_REFILL_ROUTE_ORDER.filter((egg) => limits[egg] !== undefined);
      for (const [index, egg] of eggs.entries()) {
        expect(limits[egg]).toBe(Math.ceil(((fillTo[egg] || 0) / capacity) * 100 - 1e-9));
        expect(fillTo[egg] || 0).toBeLessThanOrEqual(limits[egg]! * pct + 1);
        if (index < eggs.length - 1) {
          expect(Math.abs((tank.startContents[egg] || 0) - limits[egg]! * pct)).toBeLessThanOrEqual(1);
        }
      }
    }
  }

  it("fits 7 Henerprise epics plus 10T of Integrity riders in one C>R>I>K>H loop: 5 shifts, exactly 500T", async () => {
    for (const [ship, launches] of INTEGRITY_RIDERS) {
      const input: VirtueTankPackInput = {
        capacity,
        startMode: "current",
        currentContents: EMPTY_TANK,
        units: [unit("henerprise", "HENERPRISE", "EPIC", 7), unit("integrity", ship, "EPIC", launches)],
      };
      expect(total(fuelOf(input, "integrity")) * launches).toBe(10 * T);
      const { heuristic, exact } = await packBoth(input);
      for (const plan of [heuristic, exact]) {
        expect(plan.totalShifts).toBe(5);
        expect(plan.refillLoops).toBe(1);
        expect(plan.feasible).toBe(true);
        expect(plan.unplaced).toEqual([]);
        expect(plan.tanks[0].launches).toEqual([]);
        expect(launchesByUnit(plan, 1)).toEqual({ henerprise: 7, integrity: launches });
        const refill = plan.tanks[1].refill!;
        expect(refill.route).toEqual(["curiosity", "resilience", "integrity", "kindness", "humility"]);
        expect(refill.shifts).toBe(5);
        // Kindness is last in the route, so it fills the rest (exactly its 35%).
        expect(refill.limitPct).toEqual(META_LIMITS);
        expect(refill.fillTo).toEqual(META_FILL);
        expect(refill.add).toEqual(META_FILL);
        expect(refill.drain).toEqual({});
        expect(refill.drainHumility).toBe(false);
        expect(plan.tanks[1].startContents).toEqual(META_FILL);
        expect(Math.abs(total(plan.tanks[1].startContents) - capacity)).toBeLessThanOrEqual(1);
        expect(plan.tanks[1].leftover).toEqual({});
        expectSlidersFit(plan);
      }
      expect(exact.exact).toBe(true);
      expect(exact.diagnostics).toEqual([]);
    }
  }, SOLVER_TIMEOUT_MS * 2);

  it("holds the whole meta load in the ideal initial tank with no shifts", async () => {
    for (const [ship, launches] of INTEGRITY_RIDERS) {
      const input: VirtueTankPackInput = {
        capacity,
        startMode: "ideal",
        currentContents: EMPTY_TANK,
        units: [unit("henerprise", "HENERPRISE", "EPIC", 7), unit("integrity", ship, "EPIC", launches)],
      };
      const { heuristic, exact } = await packBoth(input);
      for (const plan of [heuristic, exact]) {
        expect(plan.totalShifts).toBe(0);
        expect(plan.refillLoops).toBe(0);
        expect(plan.exact).toBe(true);
        expect(plan.feasible).toBe(true);
        expect(launchesByUnit(plan, 0)).toEqual({ henerprise: 7, integrity: launches });
        const idealFill = plan.tanks[0].idealFill!;
        expect(idealFill.fillTo).toEqual(META_FILL);
        expect(idealFill.limitPct).toEqual(META_LIMITS);
        expect(idealFill.changeFromCurrent).toEqual(META_FILL);
        expect(idealFill.drainHumility).toBe(false);
        expect(plan.tanks[0].startContents).toEqual(META_FILL);
        expect(Math.abs(total(plan.tanks[0].startContents) - capacity)).toBeLessThanOrEqual(1);
        expectSlidersFit(plan);
      }
    }
  }, SOLVER_TIMEOUT_MS * 2);

  it("refuels 7 Henerprise epics alone with one C>R>K>H loop: 4 shifts, 490T", async () => {
    const input: VirtueTankPackInput = {
      capacity,
      startMode: "current",
      currentContents: EMPTY_TANK,
      units: [unit("henerprise", "HENERPRISE", "EPIC", 7)],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(4);
      expect(plan.refillLoops).toBe(1);
      expect(launchesByUnit(plan, 1)).toEqual({ henerprise: 7 });
      const refill = plan.tanks[1].refill!;
      expect(refill.route).toEqual(["curiosity", "resilience", "kindness", "humility"]);
      expect(refill.limitPct).toEqual({ curiosity: 35, resilience: 28, kindness: 35 });
      expect(plan.tanks[1].startContents).toEqual({ curiosity: 175 * T, resilience: 140 * T, kindness: 175 * T });
      expect(total(plan.tanks[1].startContents)).toBe(490 * T);
      expectSlidersFit(plan);
    }
    expect(exact.exact).toBe(true);
  }, SOLVER_TIMEOUT_MS);

  it("needs a second loop for an 8th Henerprise epic, and no tank tops 500T", async () => {
    const input: VirtueTankPackInput = {
      capacity,
      startMode: "current",
      currentContents: EMPTY_TANK,
      units: [unit("henerprise", "HENERPRISE", "EPIC", 8)],
    };
    const { heuristic, exact } = await packBoth(input);
    // 560T of fuel needs two tanks. The first loop fills all three eggs (4 shifts); carrying the
    // surplus of two of them leaves the second loop one egg (2 shifts), beating 7 + 1 (8 shifts).
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(6);
      expect(plan.refillLoops).toBe(2);
      expect(plan.tanks[1].refill?.route).toEqual(["curiosity", "resilience", "kindness", "humility"]);
      expect(plan.tanks[2].refill?.route).toHaveLength(2);
      expect(plan.tanks.reduce((sum, tank) => sum + (launchesByUnit(plan, tank.index).henerprise || 0), 0)).toBe(8);
      expectSlidersFit(plan);
    }
    expect(exact.exact).toBe(true);
  }, SOLVER_TIMEOUT_MS);

  it("runs two full meta tanks as two C>R>I>K>H loops: 10 shifts", async () => {
    const input: VirtueTankPackInput = {
      capacity,
      startMode: "current",
      currentContents: EMPTY_TANK,
      units: [unit("henerprise", "HENERPRISE", "EPIC", 14), unit("integrity", "MILLENIUM_CHICKEN", "EPIC", 400)],
    };
    const { heuristic, exact } = await packBoth(input);
    // 1000T of fuel is two exactly-full tanks, so nothing can carry over and both loops refill all four eggs.
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(10);
      expect(plan.refillLoops).toBe(2);
      for (const tank of plan.tanks.slice(1)) {
        expect(tank.refill?.route).toEqual(["curiosity", "resilience", "integrity", "kindness", "humility"]);
        expect(tank.refill?.limitPct).toEqual(META_LIMITS);
        expect(tank.startContents).toEqual(META_FILL);
      }
      expectSlidersFit(plan);
    }
    expect(exact.exact).toBe(true);
  }, SOLVER_TIMEOUT_MS);
});

describe("fuel tolerance: game float noise vs real amounts", () => {
  const capacity = 500 * T;
  /** What the packer treats as equal on a 500T tank: capacity x 1e-9, i.e. 0.5M eggs. */
  const noiseTolerance = capacity * 1e-9;
  const META_FILL: VirtueFuelVector = { curiosity: 175 * T, resilience: 140 * T, integrity: 10 * T, kindness: 175 * T };
  const B = 1_000_000_000;
  const M = 1_000_000;
  const drainNote = (plan: VirtueTankPlan) => plan.notes.some((note) => /drain/i.test(note));

  it("plans no drain for a full tank that reads a few eggs over (C/R/I/K +3/+5/+2/+4 eggs)", async () => {
    const input: VirtueTankPackInput = {
      capacity,
      startMode: "current",
      currentContents: {
        curiosity: 175 * T + 3,
        resilience: 140 * T + 5,
        integrity: 10 * T + 2,
        kindness: 175 * T + 4,
      },
      currentHumility: 2,
      units: [unit("henerprise", "HENERPRISE", "EPIC", 14)],
    };
    const { heuristic, exact } = await packBoth(input, noiseTolerance);
    for (const plan of [heuristic, exact]) {
      // The tank holds 7; one C>R>K>H loop covers the other 7. The 10T of Integrity (plus its noise)
      // carries over: no drain to make room, and the 2 eggs of Humility are noise, not a drain step.
      expect(plan.totalShifts).toBe(4);
      expect(plan.refillLoops).toBe(1);
      const refill = plan.tanks[1].refill!;
      expect(refill.route).toEqual(["curiosity", "resilience", "kindness", "humility"]);
      expect(refill.drain).toEqual({});
      expect(refill.drainHumility).toBe(false);
      expect(refill.limitPct).toEqual({ curiosity: 35, resilience: 28, kindness: 35 });
      expect(plan.tanks[0].leftover).toEqual({ integrity: 10 * T + 2 });
      expect(plan.notes).toEqual([]);
      expect(drainNote(plan)).toBe(false);
    }
    expect(exact.exact).toBe(true);
  }, SOLVER_TIMEOUT_MS);

  it("plans no refill for a meta tank that reads a few eggs short (C/R/I/K -3/-2/-4/-5 eggs)", async () => {
    const input: VirtueTankPackInput = {
      capacity,
      startMode: "current",
      currentContents: {
        curiosity: 175 * T - 3,
        resilience: 140 * T - 2,
        integrity: 10 * T - 4,
        kindness: 175 * T - 5,
      },
      units: [unit("henerprise", "HENERPRISE", "EPIC", 7), unit("integrity", "MILLENIUM_CHICKEN", "EPIC", 200)],
    };
    const { heuristic, exact } = await packBoth(input, noiseTolerance);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(0);
      expect(plan.tanks).toHaveLength(1);
      expect(plan.exact).toBe(true);
      expect(plan.tanks[0].used).toEqual(META_FILL);
      expect(plan.tanks[0].leftover).toEqual({});
      expect(plan.notes).toEqual([]);
    }
  }, SOLVER_TIMEOUT_MS);

  it("shows no change for an ideal fill the tank already holds, give or take a few eggs", async () => {
    const input: VirtueTankPackInput = {
      capacity,
      startMode: "ideal",
      currentContents: {
        curiosity: 175 * T + 2,
        resilience: 140 * T - 3,
        integrity: 10 * T + 4,
        kindness: 175 * T - 5,
      },
      currentHumility: 3,
      units: [unit("henerprise", "HENERPRISE", "EPIC", 7), unit("integrity", "MILLENIUM_CHICKEN", "EPIC", 200)],
    };
    const { heuristic, exact } = await packBoth(input, noiseTolerance);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(0);
      const idealFill = plan.tanks[0].idealFill!;
      expect(idealFill.fillTo).toEqual(META_FILL);
      expect(idealFill.changeFromCurrent).toEqual({});
      expect(idealFill.drainHumility).toBe(false);
      expect(plan.notes).toEqual([]);
    }
  }, SOLVER_TIMEOUT_MS);

  it("still counts a BCR's 10M Integrity and a 5M shortfall on a 500T tank", async () => {
    const bcr = unit("bcr", "BCR", "SHORT", 1);
    expect(fuelOf({ capacity, startMode: "ideal", units: [bcr] }, "bcr")).toEqual({ integrity: 10 * M });

    // 5M of the 10M is in the tank: the other 5M is real, so Integrity gets a loop of its own.
    const short: VirtueTankPackInput = { capacity, startMode: "current", currentContents: { integrity: 5 * M }, units: [bcr] };
    const shortPlans = await packBoth(short);
    for (const plan of [shortPlans.heuristic, shortPlans.exact]) {
      expect(plan.totalShifts).toBe(2);
      expect(plan.tanks[0].launches).toEqual([]);
      expect(plan.tanks[0].startContents).toEqual({ integrity: 5 * M });
      const refill = plan.tanks[1].refill!;
      expect(refill.route).toEqual(["integrity", "humility"]);
      expect(refill.add).toEqual({ integrity: 5 * M });
      expect(refill.fillTo).toEqual({ integrity: 10 * M });
      expect(refill.limitPct).toEqual({ integrity: 1 });
      expect(plan.tanks[1].used).toEqual({ integrity: 10 * M });
      expect(plan.totalFuel).toEqual({ integrity: 10 * M });
    }
    expect(shortPlans.exact.exact).toBe(true);

    // Exactly 10M, less a few eggs of noise: the tank holds it.
    const noisy = await packBoth({ ...short, currentContents: { integrity: 10 * M - 3 } }, noiseTolerance);
    for (const plan of [noisy.heuristic, noisy.exact]) {
      expect(plan.totalShifts).toBe(0);
      expect(plan.tanks[0].used).toEqual({ integrity: 10 * M });
      expect(plan.tanks[0].leftover).toEqual({});
    }

    // From the ideal start the 10M is part of the fill.
    const ideal = await packBoth({ capacity, startMode: "ideal", currentContents: {}, units: [unit("bcr", "BCR", "SHORT", 3)] });
    for (const plan of [ideal.heuristic, ideal.exact]) {
      expect(plan.totalShifts).toBe(0);
      expect(plan.tanks[0].idealFill?.fillTo).toEqual({ integrity: 30 * M });
      expect(plan.tanks[0].idealFill?.changeFromCurrent).toEqual({ integrity: 30 * M });
      expect(plan.tanks[0].idealFill?.limitPct).toEqual({ integrity: 1 });
    }
  }, SOLVER_TIMEOUT_MS);

  it("keeps the tolerance at a couple of eggs on the smallest (2B) tank", async () => {
    const small = 2 * B;
    const input: VirtueTankPackInput = {
      capacity: small,
      startMode: "current",
      currentContents: { integrity: 20 * M - 10 },
      units: [unit("bcr", "BCR", "SHORT", 2)],
    };
    // 10 eggs short of 20M is more than 2 eggs (2B x 1e-9): only one BCR fits, the second needs a loop.
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(2);
      expect(plan.tanks[0].launches).toEqual([{ unitId: "bcr", launches: 1 }]);
      expect(plan.tanks[1].refill?.route).toEqual(["integrity", "humility"]);
      expect(plan.tanks[1].refill?.fillTo).toEqual({ integrity: 10 * M });
    }

    const exactFit = await packBoth({ ...input, currentContents: { integrity: 20 * M - 1 } });
    for (const plan of [exactFit.heuristic, exactFit.exact]) {
      expect(plan.totalShifts).toBe(0);
      expect(plan.tanks[0].launches).toEqual([{ unitId: "bcr", launches: 2 }]);
    }
  }, SOLVER_TIMEOUT_MS);
});

describe("drains snap to 1% steps", () => {
  const B = 1_000_000_000;
  const M = 1_000_000;

  it("drains to the step below the exact room and still replays (100T tank, 1T steps)", async () => {
    const input: VirtueTankPackInput = {
      capacity: 100 * T,
      startMode: "current",
      currentContents: { curiosity: 60_500 * B },
      units: [unit("ck", "CUSTOM", "EPIC", 1, { fuelPerLaunch: { curiosity: 5 * T, kindness: 45_200 * B } })],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      // Kindness needs 45.2T, so Curiosity must drop to 54.8T at most: an exact drain would take
      // 5.7T and leave 54.8T, between steps. The slider takes it to 54T (6.5T drained, gone for good),
      // and Kindness, last in the route, fills its 46T limit up to the brim.
      expect(plan.totalShifts).toBe(2);
      expect(plan.tanks[0].launches).toEqual([]);
      const refill = plan.tanks[1].refill!;
      expect(refill.route).toEqual(["kindness", "humility"]);
      expect(refill.drain).toEqual({ curiosity: 6_500 * B });
      expect(refill.limitPct).toEqual({ kindness: 46 });
      expect(plan.tanks[1].startContents).toEqual({ curiosity: 54 * T, kindness: 46 * T });
      expect(plan.tanks[1].leftover).toEqual({ curiosity: 49 * T, kindness: 800 * B });
      expect(expectPlanPlaysOut(plan, input)).toEqual([{ tankIndex: 1, egg: "curiosity", from: 60_500 * B, to: 54 * T }]);
      expect(plan.notes.some((note) => note.startsWith("Some refuel loops drain"))).toBe(true);
    }
    expect(exact.exact).toBe(true);
  }, SOLVER_TIMEOUT_MS);

  it("loses the drained fuel: a launch that needed it gets a loop of its own", async () => {
    // The prep launch needs Kindness, so it waits for a loop; the Curiosity-only launch comes after
    // it. Both in the Kindness loop need 54.5T of Curiosity next to 45.2T of Kindness (99.7T): fine
    // with an exact drain, but Curiosity can only drain to 55T (Kindness then gets 45T) or 54T (too
    // little Curiosity). So the loop drains to 54T, the prep launch burns 5T, and the 49T left is
    // short of the 49.5T the next launch needs: a Curiosity loop refills it.
    const input: VirtueTankPackInput = {
      capacity: 100 * T,
      startMode: "current",
      currentContents: { curiosity: 60_500 * B },
      units: [
        unit("ck", "CUSTOM", "EPIC", 1, { fuelPerLaunch: { curiosity: 5 * T, kindness: 45_200 * B }, isPrep: true, prepOrder: 0 }),
        unit("c", "CUSTOM", "SHORT", 1, { fuelPerLaunch: { curiosity: 49_500 * B } }),
      ],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(4);
      expect(plan.tanks.map((tank) => tank.launches)).toEqual([
        [],
        [{ unitId: "ck", launches: 1 }],
        [{ unitId: "c", launches: 1 }],
      ]);
      expect(plan.tanks[1].refill?.route).toEqual(["kindness", "humility"]);
      expect(plan.tanks[1].refill?.drain).toEqual({ curiosity: 6_500 * B });
      expect(plan.tanks[1].leftover.curiosity).toBe(49 * T);
      expect(plan.tanks[2].refill?.route).toEqual(["curiosity", "humility"]);
      expect(plan.tanks[2].refill?.fillTo).toEqual({ curiosity: 49_500 * B });
      expect(expectPlanPlaysOut(plan, input).map((drain) => drain.to)).toEqual([54 * T]);
    }
    expect(exact.exact).toBe(true);
    expect(exact.diagnostics).toEqual([]);

    // The first solve lets drains stop anywhere and bounds the plan at 2 shifts; no packing meets
    // that, so a second solve with drains on steps proves the 4.
    const models: string[] = [];
    const proven = await packVirtueTanks({
      ...input,
      timeLimitSeconds: 20,
      solverFn: async (model, options) => {
        models.push(model);
        return solveWithHighs(model, options);
      },
    });
    expect(proven.totalShifts).toBe(4);
    expect(proven.exact).toBe(true);
    expect(models.map((model) => /\bd_1_\d\b/.test(model))).toEqual([false, true]);
  }, SOLVER_TIMEOUT_MS);

  it("drains the route's last egg below its room and refills it when no step fits in between", async () => {
    // Curiosity needs 40.9T (a 41T limit), the 3.5T of Integrity must stay, and Kindness needs 55.5T of
    // the 55.8T it holds. Kept as it is, Kindness leaves Curiosity 40.7T; its next step down (55T) is
    // below its need. So the loop refills Kindness after Curiosity: drained to 55T, it fills back up
    // to the brim, 55.5T. The solver finds this; the heuristic packing needs a loop more.
    const input: VirtueTankPackInput = {
      capacity: 100 * T,
      startMode: "current",
      currentContents: { integrity: 3_500 * B, kindness: 55_800 * B },
      units: [
        unit("ck", "CUSTOM", "EPIC", 1, { fuelPerLaunch: { curiosity: 40_900 * B, kindness: 55_500 * B }, isPrep: true, prepOrder: 0 }),
        unit("i", "CUSTOM2", "SHORT", 1, { fuelPerLaunch: { integrity: 3_500 * B } }),
      ],
    };
    const { heuristic, exact } = await packBoth(input);
    expect(heuristic.totalShifts).toBeGreaterThanOrEqual(3);
    expect(exact.totalShifts).toBe(3);
    expect(exact.exact).toBe(true);
    expect(exact.tanks.map((tank) => tank.launches.map((launch) => launch.unitId))).toEqual([[], ["ck", "i"]]);
    const refill = exact.tanks[1].refill!;
    expect(refill.route).toEqual(["curiosity", "kindness", "humility"]);
    expect(refill.drain).toEqual({ kindness: 800 * B });
    expect(refill.limitPct).toEqual({ curiosity: 41, kindness: 56 });
    expect(exact.tanks[1].startContents).toEqual({ curiosity: 41 * T, integrity: 3_500 * B, kindness: 55_500 * B });
    expect(expectPlanPlaysOut(exact, input)).toEqual([{ tankIndex: 1, egg: "kindness", from: 55_800 * B, to: 55 * T }]);
  }, SOLVER_TIMEOUT_MS);

  it("drains the egg that loses the least fuel to its step, not the biggest surplus", async () => {
    // Kindness needs 49.8T, so 1.2T has to go. Integrity has the bigger surplus, but its next step
    // down (29T) drains 1.9T; Curiosity's (19T) drains 1.5T.
    const input: VirtueTankPackInput = {
      capacity: 100 * T,
      startMode: "current",
      currentContents: { curiosity: 20_500 * B, integrity: 30_900 * B },
      units: [unit("k", "CUSTOM", "EPIC", 1, { fuelPerLaunch: { kindness: 49_800 * B } })],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(2);
      expect(plan.tanks[1].refill?.drain).toEqual({ curiosity: 1_500 * B });
      expect(plan.tanks[1].startContents).toEqual({ curiosity: 19 * T, integrity: 30_900 * B, kindness: 50 * T });
    }
  }, SOLVER_TIMEOUT_MS);

  it("drains the ideal first fill to a step, and leaves an egg that covers its need as it is", async () => {
    const input: VirtueTankPackInput = {
      capacity: 100 * T,
      startMode: "ideal",
      currentContents: { curiosity: 60 * T, integrity: 3_300 * B, kindness: 40_700 * B },
      units: [unit("ck", "CUSTOM", "EPIC", 1, { fuelPerLaunch: { curiosity: 40_400 * B, kindness: 40_400 * B } })],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(0);
      const idealFill = plan.tanks[0].idealFill!;
      expect(idealFill.fillTo).toEqual({ curiosity: 40_400 * B, kindness: 40_400 * B });
      expect(idealFill.limitPct).toEqual({ curiosity: 41, kindness: 41 });
      // Curiosity drains to its 41T start (not to the 40.4T it needs, between steps), Integrity drains
      // out, and Kindness (40.7T, above its need but below its 41T limit) stays as it is: the first
      // fill needs no shift at all.
      expect(plan.tanks[0].startContents).toEqual({ curiosity: 41 * T, kindness: 40_700 * B });
      expect(idealFill.changeFromCurrent).toEqual({ curiosity: -19 * T, integrity: -3_300 * B });
      expect(expectPlanPlaysOut(plan, input)).toEqual([
        { tankIndex: 0, egg: "curiosity", from: 60 * T, to: 41 * T },
        { tankIndex: 0, egg: "integrity", from: 3_300 * B, to: 0 },
      ]);
    }
  }, SOLVER_TIMEOUT_MS);

  it("skips the first-fill shift to an egg that already holds what the plan needs", async () => {
    // Integrity holds 618B and the Millenium Chickens need 80B: filling from empty would top it up
    // to its 5T step, one shift for nothing.
    const input: VirtueTankPackInput = {
      capacity: 500 * T,
      startMode: "ideal",
      currentContents: { curiosity: 10 * T, integrity: 618 * B },
      units: [unit("chicken", "MILLENIUM_CHICKEN", "SHORT", 8), unit("hen", "HENERPRISE", "SHORT", 1)],
    };
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.totalShifts).toBe(0);
      const idealFill = plan.tanks[0].idealFill!;
      expect(idealFill.fillTo).toEqual({ curiosity: 15 * T, integrity: 80 * B, kindness: 10 * T });
      expect(plan.tanks[0].startContents).toEqual({ curiosity: 15 * T, integrity: 618 * B, kindness: 10 * T });
      expect(idealFill.changeFromCurrent).toEqual({ curiosity: 5 * T, kindness: 10 * T });
      expect(plan.tanks[0].leftover).toEqual({ integrity: 538 * B });
      expect(expectPlanPlaysOut(plan, input)).toEqual([]);
    }
  }, SOLVER_TIMEOUT_MS);

  it("snaps drains to the step on the smallest tanks (2B: 20M steps, 10T: 100B steps)", async () => {
    const small: VirtueTankPackInput = {
      capacity: 2 * B,
      startMode: "current",
      currentContents: { curiosity: 1_234 * M },
      units: [unit("ck", "CUSTOM", "EPIC", 1, { fuelPerLaunch: { curiosity: 10 * M, kindness: 905 * M } })],
    };
    const smallPlans = await packBoth(small);
    for (const plan of [smallPlans.heuristic, smallPlans.exact]) {
      // An exact drain would leave 1.095B of Curiosity (54.75 steps); the slider stops at 1.08B.
      expect(plan.totalShifts).toBe(2);
      expect(plan.tanks[1].refill?.drain).toEqual({ curiosity: 154 * M });
      expect(plan.tanks[1].refill?.limitPct).toEqual({ kindness: 46 });
      expect(plan.tanks[1].startContents).toEqual({ curiosity: 1_080 * M, kindness: 920 * M });
      expect(expectPlanPlaysOut(plan, small).map((drain) => drain.to)).toEqual([1_080 * M]);
    }
    expect(smallPlans.exact.exact).toBe(true);

    const medium: VirtueTankPackInput = {
      capacity: 10 * T,
      startMode: "current",
      currentContents: { curiosity: 6_150 * B },
      units: [unit("ck", "CUSTOM", "EPIC", 1, { fuelPerLaunch: { curiosity: 100 * B, kindness: 4_050 * B } })],
    };
    const mediumPlans = await packBoth(medium);
    for (const plan of [mediumPlans.heuristic, mediumPlans.exact]) {
      // Exactly 5.95T would do; the slider stops at 5.9T.
      expect(plan.totalShifts).toBe(2);
      expect(plan.tanks[1].refill?.drain).toEqual({ curiosity: 250 * B });
      expect(plan.tanks[1].startContents).toEqual({ curiosity: 5_900 * B, kindness: 4_100 * B });
      expect(expectPlanPlaysOut(plan, medium).map((drain) => drain.to)).toEqual([5_900 * B]);
    }
    expect(mediumPlans.exact.exact).toBe(true);
  }, SOLVER_TIMEOUT_MS);

  it("lands every drain on a step on random plans with off-step fuel", async () => {
    const random = seededRandom(20260925);
    const capacities = [2 * B, 200 * B, 10 * T, 100 * T, 300 * T, 400 * T];
    const eggs: VirtueFuelKey[] = ["curiosity", "resilience", "integrity", "kindness"];
    let drained = 0;
    for (let round = 0; round < 40; round += 1) {
      const capacity = capacities[Math.floor(random() * capacities.length)];
      const units = Array.from({ length: 2 + Math.floor(random() * 2) }, (_, index) => {
        const fuelPerLaunch: VirtueFuelVector = {};
        for (const egg of eggs.filter(() => random() < 0.5)) {
          fuelPerLaunch[egg] = Math.round((0.01 + random() * 0.3) * capacity);
        }
        if (Object.keys(fuelPerLaunch).length === 0) {
          fuelPerLaunch.kindness = Math.round(0.137 * capacity);
        }
        return unit(`u${index}`, "CUSTOM", "EPIC", 1 + Math.floor(random() * 3), { fuelPerLaunch });
      });
      const currentContents: VirtueFuelVector = {};
      let room = capacity;
      for (const egg of eggs) {
        if (random() < 0.6) {
          currentContents[egg] = Math.round(random() * 0.4 * room);
          room -= currentContents[egg]!;
        }
      }
      const input: VirtueTankPackInput = { capacity, startMode: random() < 0.6 ? "current" : "ideal", currentContents, units };
      const plans = round < 8 ? Object.values(await packBoth(input)) : [packVirtueTanksHeuristic(input)];
      for (const plan of plans) {
        drained += expectPlanPlaysOut(plan, input, Math.max(1, capacity * 1e-9)).length;
      }
    }
    expect(drained).toBeGreaterThan(0);
  }, 240_000);
});

describe("player-facing wording", () => {
  it("names the limit-slider step as an egg amount when rounding keeps a launch out", async () => {
    const input: VirtueTankPackInput = {
      capacity: 100 * T,
      startMode: "current",
      currentContents: {},
      units: [unit("ck", "CUSTOM", "EPIC", 2, { fuelPerLaunch: { curiosity: 50.5 * T, kindness: 49.5 * T } })],
    };
    // 100T fits the tank exactly, but Curiosity's slider rounds 50.5T up to 51T before Kindness fills.
    const { heuristic, exact } = await packBoth(input);
    for (const plan of [heuristic, exact]) {
      expect(plan.feasible).toBe(false);
      expect(plan.unplaced).toEqual([
        {
          unitId: "ck",
          launches: 2,
          reason: "burns 100T of fuel per launch, more than the tank holds once each egg's limit slider rounds up to its next 1T step",
        },
      ]);
      expect(plan.notes.some((note) => note.startsWith("2× Custom Extended can never launch") && note.includes("1T step"))).toBe(true);
    }
  }, SOLVER_TIMEOUT_MS);
});
