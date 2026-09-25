import { describe, expect, it } from "vitest";

import { planRequestSchema, replanRequestSchema } from "./api-schemas";
import {
  formatVirtueFuelQuantity,
  formatVirtueTankAmount,
  formatVirtueTankLimit,
  parseVirtueTankFuels,
  parseVirtueTankLimits,
  VIRTUE_FUEL_DISPLAY,
  VIRTUE_HUMILITY_DISPLAY,
  VIRTUE_TANK_CAPACITIES,
  VIRTUE_TANK_FUEL_INDEX,
  virtueShiftCostSoulEggs,
  virtueShiftsCostSoulEggs,
  virtueTankCapacityForLevel,
  virtueTankLimitAmount,
} from "./virtue-fuel";

function expectRelativelyClose(actual: number, expected: number) {
  expect(actual / expected).toBeCloseTo(1, 12);
}

describe("virtue tank capacity", () => {
  it("maps each tank level to its capacity", () => {
    expect(VIRTUE_TANK_CAPACITIES).toEqual([2e9, 200e9, 10e12, 100e12, 200e12, 300e12, 400e12, 500e12]);
    expect(virtueTankCapacityForLevel(0)).toBe(2e9);
    expect(virtueTankCapacityForLevel(3)).toBe(100e12);
    expect(virtueTankCapacityForLevel(7)).toBe(500e12);
  });

  it("clamps out-of-range and non-finite levels", () => {
    expect(virtueTankCapacityForLevel(8)).toBe(500e12);
    expect(virtueTankCapacityForLevel(-1)).toBe(2e9);
    expect(virtueTankCapacityForLevel(3.7)).toBe(100e12);
    expect(virtueTankCapacityForLevel(Number.NaN)).toBe(2e9);
    expect(virtueTankCapacityForLevel(Number.POSITIVE_INFINITY)).toBe(2e9);
  });
});

describe("virtue tank values", () => {
  it("reads the virtue eggs from indices 20-24 in C/I/H/R/K order", () => {
    expect(VIRTUE_TANK_FUEL_INDEX).toEqual({ curiosity: 20, integrity: 21, humility: 22, resilience: 23, kindness: 24 });
    const values = Array.from({ length: 25 }, (_, index) => index * 1000);
    expect(parseVirtueTankFuels(values)).toEqual({
      curiosity: 20_000,
      integrity: 21_000,
      humility: 22_000,
      resilience: 23_000,
      kindness: 24_000,
    });
  });

  it("zeroes missing, negative, and non-finite fuel", () => {
    const zero = { curiosity: 0, integrity: 0, humility: 0, resilience: 0, kindness: 0 };
    expect(parseVirtueTankFuels(undefined)).toEqual(zero);
    expect(parseVirtueTankFuels([])).toEqual(zero);
    const values = new Array(25).fill(0);
    values[20] = -5;
    values[21] = Number.NaN;
    values[23] = Number.POSITIVE_INFINITY;
    values[24] = 7;
    expect(parseVirtueTankFuels(values)).toEqual({ ...zero, kindness: 7 });
    // A short array (older backup) leaves the tail missing rather than throwing.
    expect(parseVirtueTankFuels(new Array(22).fill(3))).toEqual({ ...zero, curiosity: 3, integrity: 3 });
  });

  it("defaults missing limits to uncapped and snaps float noise to 1% steps", () => {
    expect(parseVirtueTankLimits(undefined)).toEqual({
      curiosity: 1,
      integrity: 1,
      humility: 1,
      resilience: 1,
      kindness: 1,
    });
    const values = new Array(25).fill(1);
    values[20] = 0.5;
    values[21] = 0.12000000000000001;
    values[22] = 0.37999999999999995;
    values[23] = 1.2;
    values[24] = -0.1;
    expect(parseVirtueTankLimits(values)).toEqual({
      curiosity: 0.5,
      integrity: 0.12,
      humility: 0.38,
      resilience: 1,
      kindness: 0,
    });
  });

  it("keeps humility out of the fuel display list", () => {
    expect(VIRTUE_FUEL_DISPLAY.map((fuel) => fuel.key)).not.toContain("humility");
    expect(VIRTUE_HUMILITY_DISPLAY).toEqual({
      key: "humility",
      label: "Humility",
      imageSrc: "/media/Egg_humility.webp",
    });
  });
});

describe("virtue shift cost", () => {
  // Expected values computed by hand from carpetsage's shiftCost:
  //   basis = SE * (0.02 * (shiftCount / 120)^3 + 0.0001)
  //   cost  = 1e11 + 0.6 * basis + (0.4 * basis)^0.9
  it("matches the carpetsage formula", () => {
    // basis = 1e17: 1e11 + 6e16 + (4e16)^0.9
    expectRelativelyClose(virtueShiftCostSoulEggs(1e21, 0), 6.087478965915462e16);
    // basis = 1e21 * 0.0201
    expectRelativelyClose(virtueShiftCostSoulEggs(1e21, 120), 1.2163450087821152e19);
    expectRelativelyClose(virtueShiftCostSoulEggs(1.05e21, 21), 1.3228878794305611e17);
  });

  it("costs the flat 1e11 with no Soul Eggs and treats bad inputs as zero", () => {
    expect(virtueShiftCostSoulEggs(0, 50)).toBe(1e11);
    expect(virtueShiftCostSoulEggs(-1e21, 50)).toBe(1e11);
    expect(virtueShiftCostSoulEggs(Number.NaN, 50)).toBe(1e11);
    expect(virtueShiftCostSoulEggs(1e21, -5)).toBe(virtueShiftCostSoulEggs(1e21, 0));
  });

  it("sums consecutive shifts at an incrementing shift count", () => {
    expectRelativelyClose(virtueShiftsCostSoulEggs(1e21, 20, 1), 1.171333744032661e17);
    expectRelativelyClose(
      virtueShiftsCostSoulEggs(1e21, 20, 3),
      1.171333744032661e17 + 1.2599752737867162e17 + 1.3574652500508133e17
    );
    expect(virtueShiftsCostSoulEggs(1e21, 20, 3)).toBeGreaterThan(3 * virtueShiftCostSoulEggs(1e21, 20));
    expect(virtueShiftsCostSoulEggs(1e21, 20, 0)).toBe(0);
    expect(virtueShiftsCostSoulEggs(1e21, 20, -2)).toBe(0);
  });
});

describe("virtue plan request options", () => {
  const baseRequest = { targetItemId: "puzzle_cube_3" };

  it("coerces and clamps the shift cap to 0..15", () => {
    expect(planRequestSchema.parse(baseRequest).virtueShiftCap).toBeUndefined();
    expect(planRequestSchema.parse({ ...baseRequest, virtueShiftCap: "4" }).virtueShiftCap).toBe(4);
    expect(planRequestSchema.parse({ ...baseRequest, virtueShiftCap: 2.6 }).virtueShiftCap).toBe(3);
    expect(planRequestSchema.parse({ ...baseRequest, virtueShiftCap: 99 }).virtueShiftCap).toBe(15);
    expect(planRequestSchema.parse({ ...baseRequest, virtueShiftCap: -3 }).virtueShiftCap).toBe(0);
    expect(planRequestSchema.safeParse({ ...baseRequest, virtueShiftCap: "lots" }).success).toBe(false);
  });

  it("reads a null or blank shift cap as not given, and rejects non-numeric types", () => {
    expect(planRequestSchema.parse({ ...baseRequest, virtueShiftCap: null }).virtueShiftCap).toBeUndefined();
    expect(planRequestSchema.parse({ ...baseRequest, virtueShiftCap: "" }).virtueShiftCap).toBeUndefined();
    expect(planRequestSchema.parse({ ...baseRequest, virtueShiftCap: "  " }).virtueShiftCap).toBeUndefined();
    expect(planRequestSchema.parse({ ...baseRequest, virtueShiftCap: " 0 " }).virtueShiftCap).toBe(0);
    for (const virtueShiftCap of [true, false, [], [3], {}]) {
      expect(planRequestSchema.safeParse({ ...baseRequest, virtueShiftCap }).success).toBe(false);
    }
  });

  it("accepts only the known start-tank modes", () => {
    expect(planRequestSchema.parse(baseRequest).virtueStartTank).toBeUndefined();
    expect(planRequestSchema.parse({ ...baseRequest, virtueStartTank: "ideal" }).virtueStartTank).toBe("ideal");
    expect(planRequestSchema.parse({ ...baseRequest, virtueStartTank: null }).virtueStartTank).toBeUndefined();
    expect(planRequestSchema.safeParse({ ...baseRequest, virtueStartTank: "full" }).success).toBe(false);
  });

  it("passes both options through a replan request", () => {
    const profile = {
      eid: "DEMO",
      inventory: {},
      craftCounts: {},
      craftingXp: 0,
      epicResearchFTLLevel: 0,
      epicResearchZerogLevel: 0,
      shipLevels: [],
      missionOptions: [],
    };
    const parsed = replanRequestSchema.parse({
      ...baseRequest,
      profile,
      virtueShiftCap: 20,
      virtueStartTank: "current",
    });
    expect(parsed.virtueShiftCap).toBe(15);
    expect(parsed.virtueStartTank).toBe("current");
    const unset = replanRequestSchema.parse({ ...baseRequest, profile, virtueShiftCap: null, virtueStartTank: null });
    expect(unset.virtueShiftCap).toBeUndefined();
    expect(unset.virtueStartTank).toBeUndefined();
  });
});

describe("virtue tank limit amounts", () => {
  it("shows limits as egg amounts on the 1% slider grid", () => {
    expect(formatVirtueTankLimit(35, 500e12)).toBe("175T");
    expect(formatVirtueTankLimit(28, 500e12)).toBe("140T");
    expect(formatVirtueTankLimit(2, 500e12)).toBe("10T");
    expect(formatVirtueTankLimit(1, 500e12)).toBe("5T");
  });

  it("scales the step with smaller tanks", () => {
    expect(formatVirtueTankLimit(35, 200e12)).toBe("70T");
    expect(formatVirtueTankLimit(34, 10e12)).toBe("3.4T");
    expect(formatVirtueTankLimit(1, 2e9)).toBe("20M");
  });

  it("tells every step apart, even on the 2B tank's 20M steps", () => {
    expect(formatVirtueTankLimit(50, 2e9)).toBe("1B");
    expect(formatVirtueTankLimit(51, 2e9)).toBe("1.02B");
    expect(formatVirtueTankLimit(55, 2e9)).toBe("1.1B");
    expect(formatVirtueTankLimit(99, 2e9)).toBe("1.98B");
    expect(formatVirtueTankLimit(49, 2e9)).toBe("980M");
    for (const capacity of VIRTUE_TANK_CAPACITIES) {
      const labels = new Set<string>();
      for (let pct = 0; pct <= 100; pct += 1) {
        const label = formatVirtueTankLimit(pct, capacity);
        labels.add(label);
        // A drain target on a step reads the same as that step's limit.
        if (pct > 0) {
          expect(formatVirtueTankAmount(virtueTankLimitAmount(pct, capacity), capacity)).toBe(label);
        }
      }
      expect(labels.size, `${capacity}`).toBe(101);
    }
    // Without a tank, amounts keep one decimal below 10 and none above.
    expect(formatVirtueFuelQuantity(1.02e9)).toBe("1B");
    expect(formatVirtueFuelQuantity(108.7e12)).toBe("109T");
  });

  it("reads 0 for a closed slider and clamps out-of-range percents", () => {
    expect(formatVirtueTankLimit(0, 500e12)).toBe("0");
    expect(virtueTankLimitAmount(140, 500e12)).toBe(500e12);
    expect(virtueTankLimitAmount(-3, 500e12)).toBe(0);
    expect(virtueTankLimitAmount(Number.NaN, 500e12)).toBe(0);
  });

  it("lands every whole percent on a multiple of 1% of capacity", () => {
    for (const capacity of VIRTUE_TANK_CAPACITIES) {
      for (let pct = 0; pct <= 100; pct += 1) {
        const steps = virtueTankLimitAmount(pct, capacity) / (capacity / 100);
        expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
      }
    }
  });
});
