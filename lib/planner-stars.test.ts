import { describe, expect, it } from "vitest";

import type { LootJson } from "./loot-data";
import { solveWithHighs } from "./highs";
import { planForTarget } from "./planner";
import type { PlayerProfile } from "./profile";
import { computeShipLevelsFromLaunchCounts, getShipOrder, type MissionOption, type ShipLaunchCounts } from "./ship-data";
import { shipStarsItemId } from "./ship-star-goals";
import { TRILLION } from "./virtue-fuel";

const T = TRILLION;
const SOLVER_TIMEOUT_MS = 120_000;

const OPTIONS: MissionOption[] = [
  { ship: "HENERPRISE", missionId: "henerprise-extended", durationType: "EPIC", level: 8, durationSeconds: 20_000, capacity: 1 },
  { ship: "CHICKFIANT", missionId: "chickfiant-extended", durationType: "EPIC", level: 4, durationSeconds: 200_000, capacity: 1 },
];

const LOOT = {
  missions: OPTIONS.map((option) => ({
    afxShip: 0,
    afxDurationType: 0,
    missionId: option.missionId,
    levels: [
      {
        level: 0,
        targets: [
          {
            totalDrops: 5000,
            targetAfxId: 10000,
            items: [{ afxId: 0, afxLevel: 1, itemId: "puzzle-cube-1", counts: [5000, 0, 0, 0] }],
          },
        ],
      },
    ],
  })),
} as LootJson;

/** Every earlier ship flown enough to unlock the next; Henerprise maxed, Chickfiant at `chickfiantPoints`. */
function profileWith(chickfiantPoints: number): PlayerProfile {
  const counts: ShipLaunchCounts = {};
  for (const name of getShipOrder()) {
    counts[name] = { TUTORIAL: 0, SHORT: 1000, LONG: 0, EPIC: 0 };
  }
  counts.CHICKFIANT.SHORT = chickfiantPoints;
  counts.ATREGGIES.SHORT = 0;
  return {
    eid: "EI_TEST",
    inventory: {},
    craftCounts: {},
    craftingXp: 0,
    epicResearchFTLLevel: 0,
    epicResearchZerogLevel: 0,
    shipLevels: computeShipLevelsFromLaunchCounts(counts),
    missionOptions: OPTIONS,
  };
}

// Chickfiant: 180 of the 185 launch points its 5★ takes, so 3 extendeds (1.8 each) max it.
const PROFILE = profileWith(180);

const targets = [
  { targetItemId: "puzzle-cube-1", quantity: 2 },
  { targetItemId: shipStarsItemId("CHICKFIANT"), quantity: 1 },
];

function launchesOf(result: Awaited<ReturnType<typeof planForTarget>>, shipName: string): number {
  return result.missions.filter((mission) => mission.ship === shipName).reduce((sum, mission) => sum + mission.launches, 0);
}

describe("max-stars goals", () => {
  it(
    "launches the ship enough to max its stars alongside the item goals",
    async () => {
      const result = await planForTarget(PROFILE, "puzzle-cube-1", 2, 1, {
        targets,
        lootData: LOOT,
        solverFn: solveWithHighs,
      });
      expect(launchesOf(result, "CHICKFIANT")).toBe(3);
      expect(launchesOf(result, "CHICKFIANT") + launchesOf(result, "HENERPRISE")).toBeGreaterThanOrEqual(2);
      expect(result.unmetItems).toEqual([]);
      expect(result.progression.projectedShipLevels.find((entry) => entry.ship === "CHICKFIANT")?.level).toBe(5);
      // Points aren't drops: no row shows them as a yield.
      expect(result.missions.flatMap((mission) => mission.expectedYields.map((entry) => entry.itemId))).not.toContain(
        shipStarsItemId("CHICKFIANT")
      );
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "counts the stars goal as a goal in a Path of Virtue plan within the cap",
    async () => {
      const result = await planForTarget(PROFILE, "puzzle-cube-1", 2, 1, {
        targets,
        lootData: LOOT,
        solverFn: solveWithHighs,
        objectiveMode: "virtueFuel",
        virtueTank: {
          shiftCap: 0,
          startMode: "current",
          capacity: 500 * T,
          currentContents: { curiosity: 60 * T, kindness: 60 * T, resilience: 40 * T },
          currentHumility: 0,
        },
      });
      expect(launchesOf(result, "CHICKFIANT")).toBe(3);
      expect(result.unmetItems).toEqual([]);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "reports a stars goal the cap leaves short in launch points",
    async () => {
      // 100 of 185 points: 85 to go, far more Chickfiant fuel than the tank holds.
      const result = await planForTarget(profileWith(100), "puzzle-cube-1", 2, 1, {
        targets,
        lootData: LOOT,
        solverFn: solveWithHighs,
        objectiveMode: "virtueFuel",
        virtueTank: {
          shiftCap: 0,
          startMode: "current",
          capacity: 500 * T,
          currentContents: { curiosity: 60 * T, kindness: 60 * T, resilience: 40 * T },
          currentHumility: 0,
        },
      });
      const stars = result.targetBreakdowns.find((goal) => goal.itemId === shipStarsItemId("CHICKFIANT"));
      expect(stars?.requested).toBe(85);
      expect(stars!.shortfall).toBeGreaterThan(0);
      expect(stars!.shortfall).toBeLessThan(85);
      expect(launchesOf(result, "CHICKFIANT")).toBeGreaterThan(0);
      expect(result.notes.some((note) => /^Max stars · Defihent: the plan takes Defihent to 4★, 49\.0 launch points short of 5★\.$/.test(note))).toBe(true);
    },
    SOLVER_TIMEOUT_MS
  );

  it("drops a stars goal the ship already meets", async () => {
    const result = await planForTarget(
      profileWith(185),
      "puzzle-cube-1",
      2,
      1,
      { targets, lootData: LOOT, solverFn: solveWithHighs }
    );
    expect(launchesOf(result, "CHICKFIANT")).toBe(0);
    expect(result.notes.some((note) => note.includes("already has max stars"))).toBe(true);
  });
});

describe("shift-capped plans where a ship levels up mid-plan", () => {
  it(
    "keep the leveling rows apart from the spare-fuel progress rows",
    async () => {
      // Chickfiant (shown as Defihent) at 100 points levels up (125) partway
      // through, which adds leveling rows (pa_/pb_ by index); the T2 goal puts
      // a second item in the model, whose spare-fuel row once shared a name
      // with one of them. The goal is far more than the tank can fly for, so
      // all 20 launches its 60T of each egg fuel go to it.
      const result = await planForTarget(profileWith(100), "puzzle-cube-2", 1000, 1, {
        lootData: LOOT,
        solverFn: solveWithHighs,
        objectiveMode: "virtueFuel",
        allowedShipDurations: [{ ship: "CHICKFIANT", durationType: "EPIC" }],
        virtueTank: {
          shiftCap: 0,
          startMode: "current",
          capacity: 500 * T,
          currentContents: { curiosity: 60 * T, kindness: 60 * T, resilience: 40 * T },
          currentHumility: 0,
        },
      });
      expect(launchesOf(result, "CHICKFIANT")).toBe(20);
      expect(result.targetBreakdowns[0].shortfall).toBeGreaterThan(0);
      expect(result.virtueTanks?.pack.totalShifts).toBe(0);
    },
    SOLVER_TIMEOUT_MS
  );
});
