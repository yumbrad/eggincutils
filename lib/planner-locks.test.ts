import { describe, expect, it } from "vitest";

import { solveWithHighs } from "./highs";
import type { LootJson } from "./loot-data";
import { assignLockedLaunches, groupLockedLaunches, sanitizeLockedLaunches, type LockedLaunch } from "./locked-launches";
import { planForTarget, type PlannerOptions, type PlannerResult } from "./planner";
import type { PlayerProfile } from "./profile";
import type { MissionOption } from "./ship-data";
import { TRILLION as T } from "./virtue-fuel";

const SOLVER_TIMEOUT_MS = 120_000;

const extended: MissionOption = { ship: "HENERPRISE", durationType: "EPIC", missionId: "henerprise-extended", level: 0, durationSeconds: 138_240, capacity: 1 };
const chickShort: MissionOption = { ship: "CHICKFIANT", durationType: "SHORT", missionId: "chickfiant-short", level: 0, durationSeconds: 11_520, capacity: 1 };
const chickExtended: MissionOption = { ...chickShort, durationType: "EPIC", missionId: "chickfiant-extended", durationSeconds: 200_000 };

function profileFor(options: MissionOption[]): PlayerProfile {
  return { eid: "EI_TEST", inventory: {}, craftCounts: {}, craftingXp: 0,
    epicResearchFTLLevel: 60, epicResearchZerogLevel: 0, shipLevels: [], missionOptions: options };
}

// Every mission drops one puzzle cube untargeted.
function lootFor(options: MissionOption[]): LootJson {
  return { missions: options.map((option) => ({ afxShip: 0, afxDurationType: 0, missionId: option.missionId,
    levels: [{ level: 0, targets: [{ totalDrops: 5000, targetAfxId: 10000,
      items: [{ afxId: 0, afxLevel: 1, itemId: "puzzle-cube-1", counts: [5000, 0, 0, 0] }] }] }] })) } as LootJson;
}

async function plan(
  options: MissionOption[],
  quantity: number,
  lockedLaunches: LockedLaunch[],
  extra: PlannerOptions = {},
  profile = profileFor(options)
): Promise<PlannerResult> {
  return planForTarget(profile, "puzzle-cube-1", quantity, 1, {
    lootData: lootFor(options), solverFn: solveWithHighs, lockedLaunches, ...extra,
  });
}

function launchesOf(result: PlannerResult, ship: string, durationType?: string): number {
  return result.missions
    .filter((row) => !row.inAir && row.ship === ship && (!durationType || row.durationType === durationType))
    .reduce((sum, row) => sum + row.launches, 0);
}

function lockedOf(result: PlannerResult, ship: string): number {
  return result.missions.filter((row) => row.ship === ship).reduce((sum, row) => sum + (row.lockedLaunches || 0), 0);
}

describe("locked launches", () => {
  it(
    "fly a ship the plan wouldn't pick on its own",
    async () => {
      const free = await plan([extended, chickExtended], 2, []);
      expect(launchesOf(free, "CHICKFIANT")).toBe(0);

      const result = await plan([extended, chickExtended], 2, [
        { ship: "CHICKFIANT", durationType: "EPIC", targetAfxId: null, launches: 1 },
      ]);
      expect(launchesOf(result, "CHICKFIANT")).toBe(1);
      expect(lockedOf(result, "CHICKFIANT")).toBe(1);
      expect(result.unmetItems).toEqual([]);
      expect(result.notes).toContain("Locked launches: 1 Defihent extended, any target.");
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "fly a named target even with no recorded drops",
    async () => {
      const result = await plan([extended, chickExtended], 2, [
        { ship: "CHICKFIANT", durationType: "EPIC", targetAfxId: 7, launches: 2 },
      ]);
      const row = result.missions.find((entry) => entry.ship === "CHICKFIANT");
      expect(row).toMatchObject({ targetAfxId: 7, launches: 2, lockedLaunches: 2, expectedYields: [] });
      expect(result.unmetItems).toEqual([]);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "add a ship and length Ships leaves out, flying only what they lock",
    async () => {
      // Chickfiant shorts are the fastest cubes, but Ships allows only Henerprise extendeds.
      const result = await plan([extended, chickShort], 6, [
        { ship: "CHICKFIANT", durationType: "SHORT", targetAfxId: null, launches: 1 },
      ], { allowedShipDurations: [{ ship: "HENERPRISE", durationType: "EPIC" }] });
      expect(launchesOf(result, "CHICKFIANT")).toBe(1);
      expect(launchesOf(result, "HENERPRISE")).toBe(5);
      expect(result.notes).toContain("Defihent short isn't in your Ships selection, so the plan flies only its locked launches.");
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "fly ahead of a fresh dubcap, or inside it",
    async () => {
      const result = await plan([extended, chickShort], 4, [
        { ship: "CHICKFIANT", durationType: "SHORT", targetAfxId: null, launches: 1 },
        { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: null, launches: 2, dubcap: true },
      ], { includeDubcap: true });
      const event = result.dubcap!;
      const locked = event.fullLanes.flat().filter((block) => block.locked);
      expect(locked).toHaveLength(1);
      expect(locked[0]).toMatchObject({ ship: "CHICKFIANT", startSeconds: 0, isPrep: false, dubcap: false });
      // The event starts once the locked launch is back.
      expect(event.startSeconds).toBeGreaterThanOrEqual(chickShort.durationSeconds);
      const doubled = result.missions.filter((row) => row.dubcap && row.ship === "HENERPRISE");
      expect(doubled.reduce((sum, row) => sum + row.launches, 0)).toBeGreaterThanOrEqual(2);
      expect(doubled.reduce((sum, row) => sum + (row.lockedLaunches || 0), 0)).toBe(2);
      expect(result.notes).toContain("Locked in the dubcap: 2 Henerprise extended, any target.");
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "say when a fresh dubcap can't hold them",
    async () => {
      // Two 38.4-hour extendeds fit each slot of a 48-hour event: six in all.
      await expect(
        plan([extended], 4, [{ ship: "HENERPRISE", durationType: "EPIC", targetAfxId: null, launches: 7, dubcap: true }], {
          includeDubcap: true,
        })
      ).rejects.toThrow("Locked launches: a 48-hour dubcap has room for 6 Henerprise extended launches; 7 are locked in it.");
    },
    SOLVER_TIMEOUT_MS
  );

  const live = (secondsRemaining: number) => ({
    id: "event-test", message: "DOUBLE CAPACITY!", multiplier: 2, secondsRemaining, durationSeconds: 48 * 3600, ultra: false,
  });

  it(
    "say when a running dubcap can't hold them",
    async () => {
      const profile = { ...profileFor([extended]), liveDubcap: live(10 * 3600) };
      await expect(
        plan([extended], 4, [{ ship: "HENERPRISE", durationType: "EPIC", targetAfxId: null, launches: 4, dubcap: true }], {
          includeDubcap: true,
        }, profile)
      ).rejects.toThrow(
        "Locked launches: the running dubcap, which ends in 10h 00m, has room for 3 Henerprise extended launches; 4 are locked in it."
      );
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "fly after a running dubcap when not locked in it",
    async () => {
      const profile = { ...profileFor([extended, chickShort]), liveDubcap: live(30 * 3600) };
      const result = await plan([extended, chickShort], 4, [
        { ship: "CHICKFIANT", durationType: "SHORT", targetAfxId: null, launches: 1 },
      ], { includeDubcap: true }, profile);
      const event = result.dubcap!;
      const chick = event.fullLanes.flat().filter((block) => block.ship === "CHICKFIANT" && !block.dubcap);
      expect(chick.reduce((sum, block) => sum + block.launches, 0)).toBeGreaterThanOrEqual(1);
      for (const block of chick) {
        expect(block.startSeconds).toBeGreaterThanOrEqual(event.windowSeconds);
      }
      expect(result.notes).toContain("Locked launches fly after the running dubcap: 1 Defihent short, any target.");
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "go first in a Path of Virtue tank",
    async () => {
      const result = await plan([extended, chickShort], 3, [
        { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: null, launches: 1 },
      ], {
        objectiveMode: "virtueFuel",
        virtueTank: {
          shiftCap: 0,
          startMode: "current",
          capacity: 500 * T,
          currentContents: { curiosity: 100 * T, integrity: 100 * T, kindness: 100 * T, resilience: 100 * T },
          currentHumility: 0,
        },
      });
      const tanks = result.virtueTanks!;
      const lockedUnit = tanks.units.find((unit) => unit.locked);
      expect(lockedUnit).toMatchObject({ ship: "HENERPRISE", launches: 1, isPrep: true });
      expect(tanks.pack.launchOrder[0].unitId).toBe(lockedUnit!.id);
      expect(result.unmetItems).toEqual([]);
    },
    SOLVER_TIMEOUT_MS
  );
});

describe("locked launch rows", () => {
  it("keep valid rows only, untargeted for ships that can't target", () => {
    expect(
      sanitizeLockedLaunches([
        { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 23, launches: 2.4, dubcap: true },
        { ship: "CHICKEN_ONE", durationType: "SHORT", targetAfxId: 23, launches: 1 },
        { ship: "NOT_A_SHIP", durationType: "SHORT", targetAfxId: null, launches: 1 },
        { ship: "HENERPRISE", durationType: "SHORT", targetAfxId: null, launches: 0 },
      ])
    ).toEqual([
      { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 23, launches: 2, dubcap: true },
      { ship: "CHICKEN_ONE", durationType: "SHORT", targetAfxId: 10000, launches: 1 },
    ]);
  });

  it("assign named targets first, then any target, lowest stars first", () => {
    const groups = groupLockedLaunches(
      [
        { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: null, launches: 3 },
        { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 23, launches: 2 },
        // A dubcap lock with no dubcap in the plan counts as ordinary.
        { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: null, launches: 1, dubcap: true },
      ],
      false
    );
    expect(groups).toEqual([
      { ship: "HENERPRISE", durationType: "EPIC", dubcap: false, launches: 6, targets: [{ targetAfxId: 23, launches: 2 }] },
    ]);
    const row = (level: number, targetAfxId: number, launches: number) => ({ ship: "HENERPRISE", durationType: "EPIC", level, targetAfxId, launches });
    expect(assignLockedLaunches([row(8, 10000, 5), row(7, 10000, 2), row(8, 23, 3)], groups)).toEqual([2, 2, 2]);
  });
});
