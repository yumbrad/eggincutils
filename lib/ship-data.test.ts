import { describe, expect, it } from "vitest";

import {
  buildMissionOptions,
  capacityEventMultiplier,
  computeShipLevels,
  computeShipLevelsFromLaunchCounts,
  shipLevelsToLaunchCounts,
  ShipLevelInfo,
} from "./ship-data";

function shipLevel(ship: string, unlocked: boolean, level = 0): ShipLevelInfo {
  return {
    ship,
    unlocked,
    launches: 0,
    launchPoints: 0,
    level,
    maxLevel: 10,
    launchesByDuration: {
      TUTORIAL: 0,
      SHORT: 0,
      LONG: 0,
      EPIC: 0,
    },
  };
}

describe("computeShipLevels", () => {
  it("tracks launched missions and unlocks next ships", () => {
    const levels = computeShipLevels([
      { ship: "CHICKEN_ONE", durationType: "SHORT", status: "RETURNED" },
      { ship: "CHICKEN_ONE", durationType: "LONG", status: "COMPLETE" },
      { ship: "CHICKEN_ONE", durationType: "EPIC", status: "ARCHIVED" },
      { ship: "CHICKEN_ONE", durationType: "SHORT", status: "EXPLORING" },
      { ship: "CHICKEN_ONE", durationType: "SHORT", status: "IDLE" },
    ]);

    const chickenOne = levels.find((entry) => entry.ship === "CHICKEN_ONE");
    const chickenNine = levels.find((entry) => entry.ship === "CHICKEN_NINE");

    expect(chickenOne).toBeDefined();
    expect(chickenNine).toBeDefined();
    expect(chickenOne?.launches).toBe(4);
    expect(chickenOne?.launchesByDuration.SHORT).toBe(2);
    expect(chickenOne?.launchesByDuration.LONG).toBe(1);
    expect(chickenOne?.launchesByDuration.EPIC).toBe(1);
    expect(chickenOne?.launchPoints).toBeCloseTo(5.2);
    expect(chickenNine?.unlocked).toBe(true);
  });
});

describe("buildMissionOptions", () => {
  it("applies FTL duration reduction only to FTL ships and applies Zero-G capacity boost", () => {
    const levels = [
      shipLevel("CHICKEN_ONE", true, 0),
      shipLevel("MILLENIUM_CHICKEN", true, 0),
    ];

    const base = buildMissionOptions(levels, 0, 0);
    const boosted = buildMissionOptions(levels, 10, 3);

    const baseChickenOneShort = base.find((entry) => entry.ship === "CHICKEN_ONE" && entry.durationType === "SHORT");
    const boostedChickenOneShort = boosted.find((entry) => entry.ship === "CHICKEN_ONE" && entry.durationType === "SHORT");
    const baseMilleniumShort = base.find((entry) => entry.ship === "MILLENIUM_CHICKEN" && entry.durationType === "SHORT");
    const boostedMilleniumShort = boosted.find((entry) => entry.ship === "MILLENIUM_CHICKEN" && entry.durationType === "SHORT");

    expect(baseChickenOneShort).toBeDefined();
    expect(boostedChickenOneShort).toBeDefined();
    expect(baseMilleniumShort).toBeDefined();
    expect(boostedMilleniumShort).toBeDefined();

    expect(boostedChickenOneShort?.durationSeconds).toBe(baseChickenOneShort?.durationSeconds);
    expect((boostedMilleniumShort?.durationSeconds || 0)).toBeLessThan(baseMilleniumShort?.durationSeconds || 0);

    expect((boostedMilleniumShort?.capacity || 0)).toBeGreaterThan(baseMilleniumShort?.capacity || 0);
  });
});

describe("ship launch count helpers", () => {
  it("round-trips ship launch counts through ship level snapshots", () => {
    const fromMissions = computeShipLevels([
      { ship: "CHICKEN_ONE", durationType: "SHORT", status: "RETURNED" },
      { ship: "CHICKEN_ONE", durationType: "SHORT", status: "RETURNED" },
      { ship: "CHICKEN_ONE", durationType: "LONG", status: "RETURNED" },
      { ship: "CHICKEN_NINE", durationType: "SHORT", status: "RETURNED" },
    ]);

    const launchCounts = shipLevelsToLaunchCounts(fromMissions);
    const fromLaunchCounts = computeShipLevelsFromLaunchCounts(launchCounts);

    const chickenOne = fromLaunchCounts.find((entry) => entry.ship === "CHICKEN_ONE");
    const chickenNine = fromLaunchCounts.find((entry) => entry.ship === "CHICKEN_NINE");

    expect(chickenOne?.launchesByDuration.SHORT).toBe(2);
    expect(chickenOne?.launchesByDuration.LONG).toBe(1);
    expect(chickenNine?.launchesByDuration.SHORT).toBe(1);
  });
});

describe("capacityEventMultiplier", () => {
  const henerprise = (capacity: number) => ({ ship: "HENERPRISE", durationType: "EPIC", level: 7, capacity });

  it("reads ordinary, doubled and tripled launches against the player's Zero-G", () => {
    // 105 at 7 stars; 157 with Zero-G 10, 131 with Zero-G 5.
    expect(capacityEventMultiplier(henerprise(157), 10)).toBe(1);
    expect(capacityEventMultiplier(henerprise(314), 10)).toBe(2);
    expect(capacityEventMultiplier(henerprise(471), 10)).toBe(3);
    expect(capacityEventMultiplier(henerprise(131), 5)).toBe(1);
    expect(capacityEventMultiplier(henerprise(262), 5)).toBe(2);
  });

  it("calls a launch ordinary when there's nothing to judge it by", () => {
    expect(capacityEventMultiplier(henerprise(0), 10)).toBe(1);
    expect(capacityEventMultiplier({ ship: "HENERPRISE", durationType: "TUTORIAL", level: 0, capacity: 500 }, 10)).toBe(1);
    expect(capacityEventMultiplier({ ship: "NOT_A_SHIP", durationType: "EPIC", level: 0, capacity: 500 }, 10)).toBe(1);
  });
});
