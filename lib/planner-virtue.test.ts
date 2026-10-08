import { describe, expect, it } from "vitest";

import type { LootJson } from "./loot-data";
import { solveWithHighs } from "./highs";
import { MissionCoverageError, planForTarget, type PlannerOptions, type PlannerResult, type SolverFunction } from "./planner";
import type { InFlightMission, PlayerProfile } from "./profile";
import { buildMissionOptions, computeShipLevelsFromLaunchCounts, type MissionOption } from "./ship-data";
import { getVirtueFuelConfig, TRILLION, VIRTUE_FUEL_DISPLAY } from "./virtue-fuel";
import {
  VIRTUE_FASTER_OPTION_MIN_GAIN_SECONDS,
  VIRTUE_FASTER_OPTION_WITHIN_CAP_MIN_GAIN_FRACTION,
  VIRTUE_LAUNCH_EFFORT_SECONDS,
  virtueFasterOptionQualifies,
  virtueTankPlanScoreSeconds,
  type VirtueTankPlannerOptions,
} from "./virtue-tank-plan";
import { VIRTUE_SHIFT_PENALTY_SECONDS } from "./virtue-tanks";

// Path of Virtue tank mode against the real HiGHS solver. The loot tables are
// tiny and injected, so every solve is small: one untargeted mission per ship
// that drops one Puzzle Cube (T1, no recipe) per launch.

const T = TRILLION;
const SOLVER_TIMEOUT_MS = 120_000;
const TANK_500T = 500 * T;
const HENERPRISE_EPIC_SECONDS = 20_000;
const CHICKFIANT_EPIC_SECONDS = 200_000;

type TestShip = { ship: string; durationType: "SHORT" | "LONG" | "EPIC"; missionId: string; durationSeconds: number };

const HENERPRISE_EPIC: TestShip = {
  ship: "HENERPRISE",
  durationType: "EPIC",
  missionId: "henerprise-extended",
  durationSeconds: HENERPRISE_EPIC_SECONDS,
};
const HENERPRISE_LONG: TestShip = {
  ship: "HENERPRISE",
  durationType: "LONG",
  missionId: "henerprise-long",
  durationSeconds: 60_000,
};
const CHICKFIANT_EPIC: TestShip = {
  ship: "CHICKFIANT",
  durationType: "EPIC",
  missionId: "chickfiant-extended",
  durationSeconds: CHICKFIANT_EPIC_SECONDS,
};

function lootFor(ships: TestShip[], targetAfxIds: number[] = [10000]): LootJson {
  return {
    missions: ships.map((ship) => ({
      afxShip: 0,
      afxDurationType: 0,
      missionId: ship.missionId,
      levels: [
        {
          level: 0,
          targets: targetAfxIds.map((targetAfxId) => ({
            totalDrops: 5000,
            targetAfxId,
            items: [{ afxId: 0, afxLevel: 1, itemId: "puzzle-cube-1", counts: [5000, 0, 0, 0] }],
          })),
        },
      ],
    })),
  } as LootJson;
}

/** One untargeted mission per ship, each launch dropping `cubes` Puzzle Cubes. */
function lootForCubes(ships: Array<TestShip & { cubes: number }>): LootJson {
  return {
    missions: ships.map((ship) => ({
      afxShip: 0,
      afxDurationType: 0,
      missionId: ship.missionId,
      levels: [
        {
          level: 0,
          targets: [
            {
              totalDrops: 5000,
              targetAfxId: 10000,
              items: [{ afxId: 0, afxLevel: 1, itemId: "puzzle-cube-1", counts: [5000 * ship.cubes, 0, 0, 0] }],
            },
          ],
        },
      ],
    })),
  } as LootJson;
}

function profileFor(ships: TestShip[], inFlightMissions?: InFlightMission[]): PlayerProfile {
  const missionOptions: MissionOption[] = ships.map((ship) => ({
    ship: ship.ship,
    missionId: ship.missionId,
    durationType: ship.durationType,
    level: 0,
    durationSeconds: ship.durationSeconds,
    capacity: 1,
  }));
  return {
    eid: "EI_TEST",
    inventory: {},
    craftCounts: {},
    craftingXp: 0,
    epicResearchFTLLevel: 0,
    epicResearchZerogLevel: 0,
    shipLevels: [],
    missionOptions,
    ...(inFlightMissions ? { inFlightMissions } : {}),
  };
}

/** Records every model so tests can check which rows a solve carried. */
function recordingSolver(): { solverFn: SolverFunction; models: string[] } {
  const models: string[] = [];
  return {
    models,
    solverFn: async (model, options) => {
      models.push(model);
      return solveWithHighs(model, options);
    },
  };
}

function tankOptions(overrides: Partial<VirtueTankPlannerOptions>): VirtueTankPlannerOptions {
  return {
    shiftCap: 0,
    startMode: "current",
    capacity: TANK_500T,
    currentContents: { curiosity: 60 * T, kindness: 60 * T, resilience: 40 * T },
    currentHumility: 0,
    ...overrides,
  };
}

async function planTank(
  ships: TestShip[],
  quantity: number,
  tank: VirtueTankPlannerOptions,
  extra: Partial<PlannerOptions> & { inFlightMissions?: InFlightMission[]; targetAfxIds?: number[] } = {}
): Promise<{ result: PlannerResult; models: string[] }> {
  const { inFlightMissions, targetAfxIds, ...plannerExtra } = extra;
  const { solverFn, models } = recordingSolver();
  const result = await planForTarget(profileFor(ships, inFlightMissions), "puzzle-cube-1", quantity, 1, {
    objectiveMode: "virtueFuel",
    virtueTank: tank,
    lootData: lootFor(ships, targetAfxIds),
    solverFn,
    ...plannerExtra,
  });
  return { result, models };
}

function plannedLaunches(result: PlannerResult, ship: string): number {
  return result.missions
    .filter((mission) => !mission.inAir && mission.ship === ship)
    .reduce((sum, mission) => sum + mission.launches, 0);
}

/** Non-Humility fuel the plan's launches burn, straight from the fuel table. */
function plannedFuel(result: PlannerResult): number {
  return result.missions
    .filter((mission) => !mission.inAir)
    .reduce((sum, mission) => {
      const config = getVirtueFuelConfig(mission.ship, mission.durationType);
      const perLaunch = VIRTUE_FUEL_DISPLAY.reduce((total, fuel) => total + (config[fuel.key] || 0), 0);
      return sum + perLaunch * mission.launches;
    }, 0);
}

describe("Path of Virtue tank mode", () => {
  it(
    "keeps the plan and its packing within the shift cap",
    async () => {
      // Two Henerprise EPICs fit the current tank; every refuel loop costs
      // shifts, so at a cap of 4 the plan mixes slow Chickfiants from the
      // tank's leftovers with fast Henerprises from at most one loop.
      const { result, models } = await planTank([HENERPRISE_EPIC, CHICKFIANT_EPIC], 8, tankOptions({ shiftCap: 4 }));
      const tanks = result.virtueTanks!;
      expect(tanks).toBeDefined();
      expect(result.unmetItems).toEqual([]);
      expect(tanks.overCap).toBe(false);
      expect(tanks.shiftCap).toBe(4);
      expect(tanks.plannedShiftCap).toBe(4);
      expect(tanks.pack.feasible).toBe(true);
      expect(tanks.pack.totalShifts).toBeLessThanOrEqual(4);
      expect(plannedLaunches(result, "HENERPRISE") + plannedLaunches(result, "CHICKFIANT")).toBeGreaterThanOrEqual(8);
      // The tank rows reached the solver, with the shift cap on them.
      expect(models.some((model) => model.includes("vy_") && /vs_0: .* <= 4\b/.test(model))).toBe(true);
      expect(result.notes.some((note) => note.startsWith("Path of Virtue tank mode:"))).toBe(true);
      expect(result.notes.some((note) => note.includes("fuel versus mission time"))).toBe(false);
      expect(result.fuelCost).toBe(plannedFuel(result));
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "plans at the fewest shifts that meet the goals when the cap is too low",
    async () => {
      // Only Henerprise EPICs (C25 K25 R20 each): the tank holds 2, and the
      // other 10 (700T) need two refuel loops. The first refills C, R and K
      // (4 shifts) and overfills Kindness so the second only refills C and R
      // (3 shifts).
      const { result } = await planTank([HENERPRISE_EPIC], 12, tankOptions({ shiftCap: 0 }));
      const tanks = result.virtueTanks!;
      expect(result.unmetItems).toEqual([]);
      expect(plannedLaunches(result, "HENERPRISE")).toBe(12);
      expect(tanks.overCap).toBe(true);
      expect(tanks.shiftCap).toBe(0);
      expect(tanks.neededShifts).toBe(7);
      expect(tanks.plannedShiftCap).toBe(7);
      expect(tanks.pack.totalShifts).toBe(7);
      expect(tanks.pack.tanks.map((tank) => tank.refill?.shifts ?? 0)).toEqual([0, 4, 3]);
      // Three loops could fit in 6 shifts, and the solve models only two
      // loops one by one, so 7 is not called the minimum.
      expect(tanks.neededShiftsProven).toBe(false);
      expect(result.notes[0]).toBe("No plan without shifts was found; this plan takes 7 shifts, and fewer may be possible.");
      // Every plan flies the same twelve launches, so more shifts buy nothing.
      expect(tanks.fasterOption).toBeUndefined();
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "finds a cap just too low by trying the next caps in turn",
    async () => {
      // Chickfiants burn only C and K, so one C+K loop (3 shifts) fuels
      // enough of them; no refuel at all cannot.
      const events: string[] = [];
      const { result } = await planTank([HENERPRISE_EPIC, CHICKFIANT_EPIC], 30, tankOptions({ shiftCap: 0 }), {
        onProgress: (event) => {
          if (event.phase === "refinement") {
            events.push(event.message);
          }
        },
      });
      const tanks = result.virtueTanks!;
      expect(result.unmetItems).toEqual([]);
      expect(tanks.overCap).toBe(true);
      expect(tanks.neededShifts).toBe(3);
      expect(tanks.neededShiftsProven).toBe(true);
      expect(tanks.pack.totalShifts).toBe(3);
      expect(events).toEqual(expect.arrayContaining(["Trying 2 shifts…", "Trying 3 shifts…"]));
      expect(events.some((event) => event.startsWith("Finding the fewest shifts"))).toBe(false);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "does not claim a fewest-shifts count the search could not prove",
    async () => {
      // The fewest-shifts solve times out with nothing to show, so the plan
      // comes from the open-cap fallback and is not called the minimum.
      const { solverFn } = recordingSolver();
      const result = await planForTarget(profileFor([HENERPRISE_EPIC]), "puzzle-cube-1", 12, 1, {
        objectiveMode: "virtueFuel",
        virtueTank: tankOptions({ shiftCap: 0 }),
        lootData: lootFor([HENERPRISE_EPIC]),
        solverFn: async (model, options) =>
          options?.mip_abs_gap !== undefined
            ? { Status: "Time limit reached", ObjectiveValue: null as unknown as number, Columns: {} }
            : solverFn(model, options),
      });
      const tanks = result.virtueTanks!;
      expect(result.unmetItems).toEqual([]);
      expect(tanks.overCap).toBe(true);
      expect(tanks.neededShifts).toBe(tanks.pack.totalShifts);
      expect(tanks.neededShiftsProven).toBe(false);
      expect(result.notes[0]).toBe(
        `No plan without shifts was found; this plan takes ${tanks.neededShifts} shifts, and fewer may be possible.`
      );
      expect(result.notes.some((note) => note.startsWith("These goals need at least"))).toBe(false);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "falls back to the fewest shifts, re-planned for time, when the cap cannot be solved",
    async () => {
      // Every solve at the full cap of 15 times out, so the plan is built
      // around the fewest shifts instead, and still within the cap.
      const { solverFn } = recordingSolver();
      const ships = [HENERPRISE_EPIC, CHICKFIANT_EPIC];
      const result = await planForTarget(profileFor(ships), "puzzle-cube-1", 30, 1, {
        objectiveMode: "virtueFuel",
        virtueTank: tankOptions({ shiftCap: 15 }),
        lootData: lootFor(ships),
        solverFn: async (model, options) =>
          /vs_0: .* <= 15\n/.test(model)
            ? { Status: "Time limit reached", ObjectiveValue: null as unknown as number, Columns: {} }
            : solverFn(model, options),
      });
      const tanks = result.virtueTanks!;
      expect(result.unmetItems).toEqual([]);
      expect(tanks.overCap).toBe(false);
      expect(tanks.plannedShiftCap).toBe(15);
      expect(tanks.pack.totalShifts).toBeLessThanOrEqual(15);
      expect(result.notes[0]).toMatch(/^Planning with up to 15 shifts did not finish/);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "times a plan of a few long missions by its rounds, not its slot time",
    async () => {
      // Real mission lengths: a Henerprise EPIC (38.4h) drops 5 cubes, a
      // LONG (19.2h) 3 and a Voyegger EPIC (28.8h) 1. The tank has no
      // Resilience, so any Henerprise costs an R loop (2 shifts, charged a
      // day each); seven Voyeggers need no shift but fly three rounds
      // (86.4h). Slot time over three slots reads an EPIC and a LONG as
      // 19.2h, the same as three LONGs in one fewer launch, and would take
      // them; they really fly 38.4h. Three LONGs finish in 19.2h.
      const ships: Array<TestShip & { cubes: number }> = [
        { ship: "HENERPRISE", durationType: "EPIC", missionId: "henerprise-extended", durationSeconds: 138_240, cubes: 5 },
        { ship: "HENERPRISE", durationType: "LONG", missionId: "henerprise-long", durationSeconds: 69_120, cubes: 3 },
        { ship: "VOYEGGER", durationType: "EPIC", missionId: "voyegger-extended", durationSeconds: 103_680, cubes: 1 },
      ];
      const lootData = {
        missions: ships.map((ship) => ({
          afxShip: 0,
          afxDurationType: 0,
          missionId: ship.missionId,
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [{ afxId: 0, afxLevel: 1, itemId: "puzzle-cube-1", counts: [5000 * ship.cubes, 0, 0, 0] }],
                },
              ],
            },
          ],
        })),
      } as LootJson;
      const { solverFn } = recordingSolver();
      const result = await planForTarget(profileFor(ships), "puzzle-cube-1", 7, 1, {
        objectiveMode: "virtueFuel",
        virtueTank: tankOptions({ shiftCap: 3, currentContents: { curiosity: 200 * T, kindness: 120 * T } }),
        lootData,
        solverFn,
      });
      const tanks = result.virtueTanks!;
      expect(result.unmetItems).toEqual([]);
      expect(tanks.overCap).toBe(false);
      expect(plannedLaunches(result, "HENERPRISE")).toBe(3);
      expect(plannedLaunches(result, "VOYEGGER")).toBe(0);
      expect(result.missions.find((mission) => mission.ship === "HENERPRISE")?.durationType).toBe("LONG");
      expect(result.expectedHours).toBeCloseTo(19.2, 6);
      expect(tanks.pack.totalShifts).toBe(2);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "keeps a ship that drops lower tiers when another drops the tier above",
    async () => {
      // Six Puzzle Cube T2s, crafted from three T1s each or dropped whole.
      // Chickfiant EPICs (19.2h, C3 K3) drop three T1s, Voyegger EPICs
      // (28.8h, C25 K15) one T2. The tank fuels six Chickfiants but only two
      // Voyeggers, so the Chickfiants alone finish in two rounds with no
      // shift. Offering the Voyegger too can only help: its T2 drops must
      // not take the T1 source out of the plan.
      const chickfiant = {
        ship: "CHICKFIANT",
        durationType: "EPIC" as const,
        missionId: "chickfiant-extended",
        durationSeconds: 69_120,
        itemId: "puzzle-cube-1",
        perLaunch: 3,
      };
      const voyegger = {
        ship: "VOYEGGER",
        durationType: "EPIC" as const,
        missionId: "voyegger-extended",
        durationSeconds: 103_680,
        itemId: "puzzle-cube-2",
        perLaunch: 1,
      };
      const plan = (ships: Array<typeof chickfiant>) =>
        planForTarget(profileFor(ships), "puzzle-cube-2", 6, 1, {
          objectiveMode: "virtueFuel",
          virtueTank: tankOptions({ shiftCap: 0 }),
          lootData: {
            missions: ships.map((ship) => ({
              afxShip: 0,
              afxDurationType: 0,
              missionId: ship.missionId,
              levels: [
                {
                  level: 0,
                  targets: [
                    {
                      totalDrops: 5000,
                      targetAfxId: 10000,
                      items: [{ afxId: 0, afxLevel: 1, itemId: ship.itemId, counts: [5000 * ship.perLaunch, 0, 0, 0] }],
                    },
                  ],
                },
              ],
            })),
          } as LootJson,
          solverFn: recordingSolver().solverFn,
        });
      const alone = await plan([chickfiant]);
      expect(alone.virtueTanks!.overCap).toBe(false);
      expect(alone.expectedHours).toBeCloseTo(38.4, 6);
      const both = await plan([chickfiant, voyegger]);
      expect(both.unmetItems).toEqual([]);
      expect(both.virtueTanks!.overCap).toBe(false);
      expect(plannedLaunches(both, "CHICKFIANT")).toBe(6);
      expect(both.expectedHours).toBeLessThanOrEqual(alone.expectedHours + 1e-6);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "credits fuel carried into every refuel loop, not just the first",
    async () => {
      // 16 more cubes from Henerprise EPICs (C25 K25 R20) or LONGs (C20 K15
      // R10). Two loops fit in 6 shifts only if the first also tops up
      // Resilience and Kindness for the second, which then refills just
      // Curiosity (C, R, K, then C: 4 + 2 shifts).
      const { result } = await planTank([HENERPRISE_EPIC, HENERPRISE_LONG], 16, tankOptions({ shiftCap: 6 }));
      const tanks = result.virtueTanks!;
      expect(result.unmetItems).toEqual([]);
      expect(tanks.overCap).toBe(false);
      expect(tanks.pack.totalShifts).toBeLessThanOrEqual(6);
      expect(result.notes).toContain(
        `Tank model: the solve counted ${tanks.pack.totalShifts} shifts; packing the launches into tanks takes ${tanks.pack.totalShifts}.`
      );
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "starts from an ideal first fill that is not counted toward the cap",
    async () => {
      // Seven Henerprise EPICs are 490T: exactly one ideal tank, no shifts.
      const { result } = await planTank([HENERPRISE_EPIC], 7, tankOptions({ shiftCap: 0, startMode: "ideal" }));
      const tanks = result.virtueTanks!;
      expect(result.unmetItems).toEqual([]);
      expect(tanks.overCap).toBe(false);
      expect(tanks.startMode).toBe("ideal");
      expect(tanks.pack.totalShifts).toBe(0);
      expect(tanks.pack.tanks).toHaveLength(1);
      expect(tanks.pack.tanks[0].idealFill?.limitPct).toEqual({ curiosity: 35, resilience: 28, kindness: 35 });
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "credits fuel carried from the first tank to the first refuel loop",
    async () => {
      // The tank holds Curiosity and Kindness for three Henerprises but no
      // Resilience. Refilling just Resilience (2 shifts) and keeping the
      // carried eggs beats the full C, K, R loop (4 shifts).
      const { result } = await planTank(
        [HENERPRISE_EPIC],
        3,
        tankOptions({ shiftCap: 2, currentContents: { curiosity: 80 * T, kindness: 80 * T } })
      );
      const tanks = result.virtueTanks!;
      expect(result.unmetItems).toEqual([]);
      expect(tanks.overCap).toBe(false);
      expect(plannedLaunches(result, "HENERPRISE")).toBe(3);
      expect(tanks.pack.totalShifts).toBe(2);
      expect(tanks.pack.tanks[1].refill?.route).toEqual(["resilience", "humility"]);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "gives every mission row a unique key and ties every unit to its row",
    async () => {
      const inFlightMissions: InFlightMission[] = [
        {
          ship: "HENERPRISE",
          durationType: "EPIC",
          status: "EXPLORING",
          level: 0,
          capacity: 1,
          targetAfxId: null,
          secondsRemaining: 7_000,
        },
      ];
      const { result } = await planTank(
        [HENERPRISE_EPIC, CHICKFIANT_EPIC],
        10,
        tankOptions({ shiftCap: 6, currentHumility: 20 * T }),
        { inFlightMissions, targetAfxIds: [10000, 26] }
      );
      const tanks = result.virtueTanks!;
      const rowKeys = result.missions.map((mission) => mission.rowKey);
      expect(rowKeys.every((rowKey) => typeof rowKey === "string" && rowKey.length > 0)).toBe(true);
      expect(new Set(rowKeys).size).toBe(rowKeys.length);

      const inAirRows = result.missions.filter((mission) => mission.inAir);
      expect(inAirRows).toHaveLength(1);
      expect(inAirRows[0].rowKey).toBe("henerprise-extended|0|10000|air");

      const plannedRows = result.missions.filter((mission) => !mission.inAir);
      const unitIds = tanks.units.map((unit) => unit.id);
      expect(new Set(unitIds).size).toBe(unitIds.length);
      for (const row of plannedRows) {
        const rowUnits = tanks.units.filter((unit) => unit.missionRowKey === row.rowKey);
        expect(rowUnits.length).toBeGreaterThan(0);
        expect(rowUnits.reduce((sum, unit) => sum + unit.launches, 0)).toBe(row.launches);
        for (const unit of rowUnits) {
          expect(unit.ship).toBe(row.ship);
          expect(unit.durationType).toBe(row.durationType);
          expect(unit.level).toBe(row.level);
          expect(unit.durationSeconds).toBe(row.durationSeconds);
          expect(unit.targetAfxId).toBe(row.targetAfxId);
        }
      }
      expect(tanks.units.every((unit) => plannedRows.some((row) => row.rowKey === unit.missionRowKey))).toBe(true);

      // Every unit's launches are packed, and the pack's launches are the plan's.
      const packedByUnit = new Map<string, number>();
      for (const entry of tanks.pack.launchOrder) {
        packedByUnit.set(entry.unitId, (packedByUnit.get(entry.unitId) || 0) + entry.launches);
      }
      for (const unit of tanks.units) {
        expect(packedByUnit.get(unit.id)).toBe(unit.launches);
      }
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "reports the packed schedule, in-air ships included, as the plan's hours",
    async () => {
      // A long in-air mission holds one slot past the end of the new launches.
      const inFlightMissions: InFlightMission[] = [
        {
          ship: "CHICKFIANT",
          durationType: "EPIC",
          status: "EXPLORING",
          level: 0,
          capacity: 1,
          targetAfxId: null,
          secondsRemaining: 200_000,
        },
      ];
      const { result } = await planTank([HENERPRISE_EPIC], 5, tankOptions({ shiftCap: 4 }), { inFlightMissions });
      const pack = result.virtueTanks!.pack;
      expect(result.unmetItems).toEqual([]);
      expect(pack.schedule.makespanSeconds).toBe(200_000);
      expect(result.expectedHours).toBeCloseTo(200_000 / 3600, 9);
      expect(result.schedule.totalSeconds).toBe(200_000);
      expect(result.schedule.inAirSeconds).toBe(200_000);
      // The new launches alone, replayed on empty slots.
      expect(result.schedule.missionSeconds).toBeGreaterThan(0);
      expect(result.schedule.missionSeconds).toBeLessThan(200_000);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "fuels prep launches with no useful drops and packs them first",
    async () => {
      // Two more Voyegger launches unlock the Henerprise, the only ship with
      // Puzzle Cube drops. Those prep launches have no mission row but burn
      // C10 K5 each; with them the current tank (C30 K30 R20) cannot also
      // fuel the Henerprise EPIC (C25 K25 R20), so a cap of 0 is too low.
      const shipLevels = computeShipLevelsFromLaunchCounts({
        CHICKEN_ONE: { SHORT: 4 },
        CHICKEN_NINE: { SHORT: 6 },
        CHICKEN_HEAVY: { SHORT: 12 },
        BCR: { SHORT: 15 },
        MILLENIUM_CHICKEN: { SHORT: 18 },
        CORELLIHEN_CORVETTE: { SHORT: 21 },
        GALEGGTICA: { SHORT: 24 },
        CHICKFIANT: { SHORT: 27 },
        VOYEGGER: { SHORT: 28 },
      });
      expect(shipLevels.find((entry) => entry.ship === "HENERPRISE")?.unlocked).toBe(false);
      const profile: PlayerProfile = { ...profileFor([]), shipLevels, missionOptions: buildMissionOptions(shipLevels, 0, 0) };
      const { solverFn, models } = recordingSolver();
      const result = await planForTarget(profile, "puzzle-cube-1", 1, 1, {
        objectiveMode: "virtueFuel",
        virtueTank: tankOptions({ shiftCap: 0, currentContents: { curiosity: 30 * T, kindness: 30 * T, resilience: 20 * T } }),
        lootData: lootFor([HENERPRISE_EPIC]),
        solverFn,
      });
      const tanks = result.virtueTanks!;
      expect(result.unmetItems).toEqual([]);
      expect(plannedLaunches(result, "HENERPRISE")).toBe(1);

      const prepUnits = tanks.units.filter((unit) => unit.isPrep);
      expect(prepUnits.length).toBeGreaterThan(0);
      expect(prepUnits.every((unit) => unit.ship === "VOYEGGER" && unit.missionRowKey === undefined)).toBe(true);
      const prepLaunches = prepUnits.reduce((sum, unit) => sum + unit.launches, 0);
      expect(prepLaunches).toBe(result.progression.prepLaunches.reduce((sum, row) => sum + row.launches, 0));
      // The tank rows carried the prep launches as fixed fuel.
      expect(models.some((model) => new RegExp(`vy_\\d+: .* = -${prepLaunches}\\n`).test(model))).toBe(true);
      // Prep launches go out before the Henerprise they unlock.
      const order = tanks.pack.launchOrder.map((entry) => entry.unitId);
      const lastPrep = Math.max(...prepUnits.map((unit) => order.lastIndexOf(unit.id)));
      const henerprise = tanks.units.find((unit) => unit.ship === "HENERPRISE")!;
      expect(lastPrep).toBeLessThan(order.indexOf(henerprise.id));

      expect(tanks.overCap).toBe(true);
      expect(tanks.neededShifts).toBeGreaterThan(0);
      expect(tanks.pack.totalShifts).toBe(tanks.neededShifts);
      expect(result.fuelCost).toBe(plannedFuel(result) + prepUnits.reduce((sum, unit) => sum + unit.launches * 15 * T, 0));
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "throws the usual coverage error when no shift count can meet the goals",
    async () => {
      // Puzzle Cube T3 also needs Ornate Gussets, which nothing here drops.
      const ships = [HENERPRISE_EPIC];
      const { solverFn } = recordingSolver();
      await expect(
        planForTarget(profileFor(ships), "puzzle-cube-3", 1, 1, {
          objectiveMode: "virtueFuel",
          virtueTank: tankOptions({ shiftCap: 0 }),
          lootData: lootFor(ships),
          solverFn,
        })
      ).rejects.toBeInstanceOf(MissionCoverageError);
      await expect(
        planForTarget(profileFor(ships), "puzzle-cube-1", 1, 1, {
          objectiveMode: "virtueFuel",
          virtueTank: tankOptions({ shiftCap: 7 }),
          lootData: { missions: [] } as unknown as LootJson,
          solverFn,
        })
      ).rejects.toBeInstanceOf(MissionCoverageError);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "notes a missing tank reading and plans from an empty tank",
    async () => {
      const { result } = await planTank([HENERPRISE_EPIC], 1, tankOptions({ shiftCap: 4, currentContents: undefined }));
      const tanks = result.virtueTanks!;
      expect(result.unmetItems).toEqual([]);
      expect(tanks.pack.totalShifts).toBe(4);
      expect(tanks.notes.some((note) => note.includes("empty tank"))).toBe(true);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "leaves the fuel-versus-time virtue objective alone without tank options",
    async () => {
      const { solverFn, models } = recordingSolver();
      const ships = [HENERPRISE_EPIC, CHICKFIANT_EPIC];
      const result = await planForTarget(profileFor(ships), "puzzle-cube-1", 6, 0.5, {
        objectiveMode: "virtueFuel",
        lootData: lootFor(ships),
        solverFn,
      });
      expect(result.virtueTanks).toBeUndefined();
      expect(result.priorityTime).toBe(0.5);
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((model) => /\bv[yklnqw]_/.test(model))).toBe(false);
      expect(result.notes.some((note) => note.includes("fuel versus mission time"))).toBe(true);
      expect(result.notes.some((note) => note.startsWith("Path of Virtue tank mode:"))).toBe(false);
      expect(result.fuelCost).toBe(plannedFuel(result));
      expect(result.missions.every((mission) => typeof mission.rowKey === "string")).toBe(true);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "offers a faster plan with a few more shifts when the minimum is slow",
    async () => {
      // An empty tank: the fewest shifts is one Integrity refill (2 shifts)
      // for slow Corvettes, 6 of them in two 200,000 s rounds. Refilling C,
      // R and K instead (4 shifts) flies 6 Henerprise EPICs in two 20,000 s
      // rounds, far ahead even after its extra shifts.
      const CORVETTE_EPIC: TestShip = {
        ship: "CORELLIHEN_CORVETTE",
        durationType: "EPIC",
        missionId: "corvette-extended",
        durationSeconds: 200_000,
      };
      const events: string[] = [];
      const { result } = await planTank([HENERPRISE_EPIC, CORVETTE_EPIC], 6, tankOptions({ shiftCap: 0, currentContents: {} }), {
        onProgress: (event) => {
          if (event.phase === "refinement") {
            events.push(event.message);
          }
        },
      });
      const tanks = result.virtueTanks!;
      expect(result.unmetItems).toEqual([]);
      expect(tanks.overCap).toBe(true);
      expect(tanks.neededShifts).toBe(2);
      expect(tanks.neededShiftsProven).toBe(true);
      expect(plannedLaunches(result, "CORELLIHEN_CORVETTE")).toBe(6);
      expect(result.expectedHours).toBeCloseTo(400_000 / 3600, 6);
      expect(tanks.fasterOption).toBeDefined();
      expect(tanks.fasterOption!.shifts).toBe(4);
      expect(tanks.fasterOption!.expectedHours).toBeCloseTo(40_000 / 3600, 6);
      expect(events).toContain("Checking whether up to 6 shifts is much faster…");
      expect(result.notes[0]).toBe("These goals need at least 2 shifts; the slider allows 0. Planned with 2 shifts.");
      expect(result.notes[1]).toBe("With 4 shifts the goals take about 11h 6m instead of 4d 15h 6m.");

      // Planning with the cap at the offered shifts gives that plan back.
      const { result: atOffer } = await planTank([HENERPRISE_EPIC, CORVETTE_EPIC], 6, tankOptions({ shiftCap: 4, currentContents: {} }));
      expect(atOffer.virtueTanks!.overCap).toBe(false);
      expect(atOffer.virtueTanks!.pack.totalShifts).toBe(4);
      expect(atOffer.expectedHours).toBeCloseTo(40_000 / 3600, 6);
    },
    SOLVER_TIMEOUT_MS
  );

  describe("faster option within the cap", () => {
    // A Chicken One burns no fuel and drops one cube per 12,000 s launch; a
    // Henerprise EPIC drops 30 but needs C, K and R. From an empty tank, a
    // cap of 0 leaves only Chicken Ones; one C, R and K refill (4 shifts, a
    // day each in the score) flies Henerprises instead.
    const CHICKEN_ONE_SHORT = {
      ship: "CHICKEN_ONE",
      durationType: "SHORT" as const,
      missionId: "chicken-one-short",
      durationSeconds: 12_000,
      cubes: 1,
    };
    const henerpriseEpic = (durationSeconds: number) => ({ ...HENERPRISE_EPIC, durationSeconds, cubes: 30 });
    const emptyTank = (shiftCap: number) => tankOptions({ shiftCap, currentContents: {} });
    const score = (result: PlannerResult) =>
      virtueTankPlanScoreSeconds({
        expectedHours: result.expectedHours,
        shifts: result.virtueTanks!.pack.totalShifts,
        launches: result.virtueTanks!.units.reduce((sum, unit) => sum + unit.launches, 0),
      });
    async function plan(
      ships: Array<TestShip & { cubes: number }>,
      quantity: number,
      tank: VirtueTankPlannerOptions
    ): Promise<{ result: PlannerResult; events: string[] }> {
      const events: string[] = [];
      const result = await planForTarget(profileFor(ships), "puzzle-cube-1", quantity, 1, {
        objectiveMode: "virtueFuel",
        virtueTank: tank,
        lootData: lootForCubes(ships),
        solverFn: solveWithHighs,
        onProgress: (event) => {
          if (event.phase === "refinement") {
            events.push(event.message);
          }
        },
      });
      return { result, events };
    }

    it(
      "offers a few more shifts when a plan within the cap is hundreds of slow launches",
      async () => {
        const ships = [CHICKEN_ONE_SHORT, henerpriseEpic(HENERPRISE_EPIC_SECONDS)];
        const { result, events } = await plan(ships, 150, emptyTank(0));
        const tanks = result.virtueTanks!;
        expect(result.unmetItems).toEqual([]);
        expect(tanks.overCap).toBe(false);
        expect(tanks.neededShifts).toBeUndefined();
        expect(tanks.pack.totalShifts).toBe(0);
        expect(plannedLaunches(result, "CHICKEN_ONE")).toBe(150);
        expect(result.expectedHours).toBeCloseTo((50 * CHICKEN_ONE_SHORT.durationSeconds) / 3600, 6);
        expect(events).toContain("Checking whether up to 4 shifts is much faster…");
        expect(tanks.fasterOption).toBeDefined();
        expect(tanks.fasterOption!.shifts).toBe(4);
        expect(tanks.fasterOption!.expectedHours).toBeCloseTo((2 * HENERPRISE_EPIC_SECONDS) / 3600, 6);
        expect(result.notes[0]).toBe("With 4 shifts the goals take about 11h 6m instead of 6d 22h 40m.");

        // Planning with the cap at the offered shifts gives that plan back,
        // and it clears both bars.
        const { result: atOffer } = await plan(ships, 150, emptyTank(4));
        expect(atOffer.virtueTanks!.overCap).toBe(false);
        expect(atOffer.virtueTanks!.fasterOption).toBeUndefined();
        expect(atOffer.virtueTanks!.pack.totalShifts).toBe(tanks.fasterOption!.shifts);
        expect(atOffer.expectedHours).toBeCloseTo(tanks.fasterOption!.expectedHours, 6);
        expect(plannedLaunches(atOffer, "HENERPRISE")).toBe(5);
        expect(virtueFasterOptionQualifies(score(result), score(atOffer), true)).toBe(true);
      },
      SOLVER_TIMEOUT_MS
    );

    it(
      "does not offer more shifts that are faster but not by a quarter",
      async () => {
        // Slower Henerprises (about 22h): the refill plan beats the Chicken
        // Ones by more than one shift's worth, but by less than a quarter.
        const ships = [CHICKEN_ONE_SHORT, henerpriseEpic(80_000)];
        const { result, events } = await plan(ships, 150, emptyTank(0));
        const tanks = result.virtueTanks!;
        expect(tanks.overCap).toBe(false);
        expect(tanks.pack.totalShifts).toBe(0);
        expect(plannedLaunches(result, "CHICKEN_ONE")).toBe(150);
        // The plan looked slow, so the pass ran, and found too little.
        expect(events).toContain("Checking whether up to 4 shifts is much faster…");
        expect(tanks.fasterOption).toBeUndefined();
        expect(result.notes.some((note) => /^With \d+ shifts the goals take/.test(note))).toBe(false);

        const { result: atFour } = await plan(ships, 150, emptyTank(4));
        const gain = score(result) - score(atFour);
        expect(atFour.virtueTanks!.pack.totalShifts).toBe(4);
        expect(gain).toBeGreaterThanOrEqual(VIRTUE_FASTER_OPTION_MIN_GAIN_SECONDS);
        expect(gain).toBeLessThan(score(result) * VIRTUE_FASTER_OPTION_WITHIN_CAP_MIN_GAIN_FRACTION);
      },
      SOLVER_TIMEOUT_MS
    );

    it(
      "does not look for more shifts on plans that do not look slow",
      async () => {
        const fast = henerpriseEpic(HENERPRISE_EPIC_SECONDS);
        // Too short to gain enough from any refill: 30 Chicken Ones take 10
        // rounds (33h 20m), under the floor a plan with shifts starts from.
        const short = await plan([CHICKEN_ONE_SHORT, fast], 30, emptyTank(0));
        // Fuel for everything: the tank flies the Henerprises with no refill.
        const fueled = await plan(
          [CHICKEN_ONE_SHORT, fast],
          150,
          tankOptions({ shiftCap: 0, currentContents: { curiosity: 150 * T, kindness: 150 * T, resilience: 120 * T } })
        );
        // A normal plan within a cap of 4 (the first test's).
        const normal = await plan(
          [
            { ...HENERPRISE_EPIC, cubes: 1 },
            { ...CHICKFIANT_EPIC, cubes: 1 },
          ],
          8,
          tankOptions({ shiftCap: 4 })
        );
        expect(plannedLaunches(short.result, "CHICKEN_ONE")).toBe(30);
        expect(plannedLaunches(fueled.result, "HENERPRISE")).toBe(5);
        for (const { result, events } of [short, fueled, normal]) {
          expect(result.unmetItems).toEqual([]);
          expect(result.virtueTanks!.overCap).toBe(false);
          expect(result.virtueTanks!.fasterOption).toBeUndefined();
          expect(events.some((event) => event.startsWith("Checking whether up to"))).toBe(false);
        }
      },
      SOLVER_TIMEOUT_MS
    );

    it("offers within the cap only on a gain of 24 h and a quarter of the score", () => {
      const h = 3600;
      const minGain = VIRTUE_FASTER_OPTION_MIN_GAIN_SECONDS;
      expect(minGain).toBe(24 * h);
      // A long plan: the quarter binds.
      expect(virtueFasterOptionQualifies(8 * minGain, 6 * minGain, true)).toBe(true);
      expect(virtueFasterOptionQualifies(8 * minGain, 6 * minGain + h, true)).toBe(false);
      expect(virtueFasterOptionQualifies(8 * minGain, 6 * minGain + h, false)).toBe(true);
      // A short plan: the 24 h floor binds.
      expect(virtueFasterOptionQualifies(2 * minGain, minGain, true)).toBe(true);
      expect(virtueFasterOptionQualifies(2 * minGain, minGain + h, true)).toBe(false);
      expect(virtueFasterOptionQualifies(2 * minGain, minGain + h, false)).toBe(false);
      expect(virtueFasterOptionQualifies(Number.NaN, 0, false)).toBe(false);
    });
  });

  it(
    "charges every launch its effort in the tank objective",
    async () => {
      // Two ships that burn no tank fuel: a launch's objective coefficient is
      // its slot time over three slots plus the launch effort, so a short
      // launch weighs more than its mission time alone says. The long one
      // drops three cubes to the short one's one, so neither beats the other
      // outright and both reach the solve.
      const ships: Array<TestShip & { cubes: number }> = [
        { ship: "CHICKEN_ONE", durationType: "SHORT", missionId: "chicken-one-short", durationSeconds: 600, cubes: 1 },
        { ship: "CHICKEN_HEAVY", durationType: "LONG", missionId: "chicken-heavy-long", durationSeconds: 6_000, cubes: 3 },
      ];
      const { result, models } = await planTank(ships, 4, tankOptions({ shiftCap: 0 }), { lootData: lootForCubes(ships) });
      expect(result.unmetItems).toEqual([]);
      const model = models.find((entry) => entry.includes("\nGeneral") && /\bm_1\b/.test(entry))!;
      const objective = model.slice(model.indexOf("obj:"), model.indexOf("Subject To"));
      const coefficient = (variable: string) => Number(new RegExp(`([\\d.e+-]+) ${variable}\\b`).exec(objective)![1]);
      const [short, long] = [coefficient("m_0"), coefficient("m_1")].sort((a, b) => a - b);
      expect(short / long).toBeCloseTo((600 / 3 + VIRTUE_LAUNCH_EFFORT_SECONDS) / (6_000 / 3 + VIRTUE_LAUNCH_EFFORT_SECONDS), 6);
      expect(result.notes.some((note) => note.includes("each launch as 3 min"))).toBe(true);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "scores a tank plan by its hours, shifts and launches",
    () => {
      expect(VIRTUE_LAUNCH_EFFORT_SECONDS).toBe(180);
      expect(VIRTUE_SHIFT_PENALTY_SECONDS).toBe(24 * 3600);
      expect(virtueTankPlanScoreSeconds({ expectedHours: 10, shifts: 2, launches: 20 })).toBe(
        10 * 3600 + 2 * VIRTUE_SHIFT_PENALTY_SECONDS + 20 * VIRTUE_LAUNCH_EFFORT_SECONDS
      );
      expect(virtueTankPlanScoreSeconds({ expectedHours: Number.NaN, shifts: -1, launches: 0 })).toBe(0);
    }
  );

  it(
    "narrows the candidate missions to the best per item without dropping an only source",
    async () => {
      // Twelve Henerprise targets drop Puzzle Cubes at different rates, each
      // with a trace of Gold Meteorite that shrinks as its cubes grow (so no
      // target beats another outright), and only a slow one drops the
      // meteorite in earnest. Without the yield index the solve keeps the
      // best few cube targets, the best few meteorite ones and so the
      // meteorite's real source.
      const cubeTargets = Array.from({ length: 12 }, (_, index) => index + 1);
      const lootData = {
        missions: [
          {
            afxShip: 0,
            afxDurationType: 0,
            missionId: HENERPRISE_EPIC.missionId,
            levels: [
              {
                level: 0,
                targets: [
                  ...cubeTargets.map((targetAfxId) => ({
                    totalDrops: 5000,
                    targetAfxId,
                    items: [
                      { afxId: 0, afxLevel: 1, itemId: "puzzle-cube-1", counts: [400 * targetAfxId, 0, 0, 0] },
                      { afxId: 0, afxLevel: 1, itemId: "gold-meteorite-1", counts: [13 - targetAfxId, 0, 0, 0] },
                    ],
                  })),
                  {
                    totalDrops: 5000,
                    targetAfxId: 99,
                    items: [{ afxId: 0, afxLevel: 1, itemId: "gold-meteorite-1", counts: [500, 0, 0, 0] }],
                  },
                ],
              },
            ],
          },
        ],
      } as LootJson;
      const { solverFn, models } = recordingSolver();
      const result = await planForTarget(profileFor([HENERPRISE_EPIC]), "puzzle-cube-1", 4, 1, {
        objectiveMode: "virtueFuel",
        virtueTank: tankOptions({ shiftCap: 4 }),
        targets: [
          { targetItemId: "puzzle-cube-1", quantity: 4 },
          { targetItemId: "gold-meteorite-1", quantity: 1 },
        ],
        lootData,
        solverFn,
      });
      expect(result.unmetItems).toEqual([]);
      // Solves start from the 8 kept actions (cube targets 9-12, then 99 and
      // the meteorite traces of targets 1-3); checks over all 13 find nothing
      // better.
      const actionCounts = models
        .filter((model) => model.includes("vy_"))
        .map((model) => (model.match(/\n  m_\d+ >= 0/g) || []).length);
      expect(actionCounts[0]).toBe(8);
      expect(actionCounts).toContain(13);
      expect(actionCounts.every((count) => count === 8 || count === 13)).toBe(true);
      expect(result.notes).toContain(
        "Tank mode kept 8 of 13 candidate mission actions: the top 4 mission/target pairs per required item by time, by fuel and by each egg's fuel."
      );
      const targets = new Set(result.missions.map((mission) => mission.targetAfxId));
      expect(targets.has(99)).toBe(true);
      expect([...targets].every((targetAfxId) => targetAfxId === 99 || targetAfxId >= 9)).toBe(true);

      // Outside tank mode nothing is pruned.
      const unpruned = await planForTarget(profileFor([HENERPRISE_EPIC]), "puzzle-cube-1", 4, 1, {
        objectiveMode: "virtueFuel",
        targets: [
          { targetItemId: "puzzle-cube-1", quantity: 4 },
          { targetItemId: "gold-meteorite-1", quantity: 1 },
        ],
        lootData,
        solverFn,
      });
      expect(unpruned.notes.some((note) => note.startsWith("Tank mode kept"))).toBe(false);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "wins back a target that drops a useful mix by checking a quick pruned solve against every action",
    async () => {
      // Five Henerprise targets drop more Puzzle Cubes and five more Gold
      // Meteorites than target 99, so pruning keeps neither of its drops'
      // rankings; but it drops both, and three launches of it (one round)
      // beat four of the specialists (two rounds). Each specialist drops a
      // trace of the other item, more the less of its own it drops, so none
      // beats another outright.
      const drops = (itemId: string, otherItemId: string, rates: number[], firstTarget: number) =>
        rates.map((rate, index) => ({
          totalDrops: 5000,
          targetAfxId: firstTarget + index,
          items: [
            { afxId: 0, afxLevel: 1, itemId, counts: [5000 * rate, 0, 0, 0] },
            { afxId: 0, afxLevel: 1, itemId: otherItemId, counts: [50 * (index + 1), 0, 0, 0] },
          ],
        }));
      const lootData = {
        missions: [
          {
            afxShip: 0,
            afxDurationType: 0,
            missionId: HENERPRISE_EPIC.missionId,
            levels: [
              {
                level: 0,
                targets: [
                  ...drops("puzzle-cube-1", "gold-meteorite-1", [1, 0.95, 0.9, 0.85, 0.8], 1),
                  ...drops("gold-meteorite-1", "puzzle-cube-1", [1, 0.95, 0.9, 0.85, 0.8], 11),
                  {
                    totalDrops: 5000,
                    targetAfxId: 99,
                    items: [
                      { afxId: 0, afxLevel: 1, itemId: "puzzle-cube-1", counts: [3500, 0, 0, 0] },
                      { afxId: 0, afxLevel: 1, itemId: "gold-meteorite-1", counts: [3500, 0, 0, 0] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      } as LootJson;
      const { solverFn, models } = recordingSolver();
      const result = await planForTarget(profileFor([HENERPRISE_EPIC]), "puzzle-cube-1", 2, 1, {
        objectiveMode: "virtueFuel",
        virtueTank: tankOptions({ shiftCap: 0, currentContents: { curiosity: 150 * T, kindness: 150 * T, resilience: 120 * T } }),
        targets: [
          { targetItemId: "puzzle-cube-1", quantity: 2 },
          { targetItemId: "gold-meteorite-1", quantity: 2 },
        ],
        lootData,
        solverFn,
      });
      expect(result.unmetItems).toEqual([]);
      const actionCounts = models
        .filter((model) => model.includes("vy_") && model.includes("\nGeneral"))
        .map((model) => (model.match(/\n  m_\d+ >= 0/g) || []).length);
      expect(actionCounts[0]).toBe(8);
      expect(actionCounts).toContain(11);
      expect(result.missions.map((mission) => [mission.targetAfxId, mission.launches])).toEqual([[99, 3]]);
      expect(result.expectedHours).toBeCloseTo(HENERPRISE_EPIC_SECONDS / 3600, 6);
      expect(result.notes.some((note) => /over every action found a better plan\./.test(note))).toBe(true);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "keeps a phased-leveling level whole when pruning keeps a later level of the chain",
    async () => {
      // The Millenium Chicken is 2 launches short of level 1. Level 0 offers
      // only target 50, a poor cube source every ranking drops; level 1
      // offers twelve better ones, trading cubes for Gold Meteorites (so none
      // beats another outright). Phased leveling fills level 0 before level
      // 1 can fly, so pruning has to keep target 50's level-0 action or no
      // kept action could ever be flown (short of a prep candidate that flies
      // those 2 launches as prep).
      const shipLevels = computeShipLevelsFromLaunchCounts({
        CHICKEN_ONE: { SHORT: 4 },
        CHICKEN_NINE: { SHORT: 6 },
        CHICKEN_HEAVY: { SHORT: 12 },
        BCR: { SHORT: 15 },
        MILLENIUM_CHICKEN: { SHORT: 8 },
      });
      expect(shipLevels.find((info) => info.ship === "MILLENIUM_CHICKEN")?.level).toBe(0);
      const profile: PlayerProfile = {
        ...profileFor([]),
        shipLevels,
        missionOptions: buildMissionOptions(shipLevels, 0, 0),
      };
      const cube = (targetAfxId: number, count: number, meteorites = 0) => ({
        totalDrops: 5000,
        targetAfxId,
        items: [
          { afxId: 0, afxLevel: 1, itemId: "puzzle-cube-1", counts: [count, 0, 0, 0] },
          ...(meteorites > 0 ? [{ afxId: 0, afxLevel: 1, itemId: "gold-meteorite-1", counts: [meteorites, 0, 0, 0] }] : []),
        ],
      });
      const lootData = {
        missions: [
          {
            afxShip: 0,
            afxDurationType: 0,
            missionId: "millenium-chicken-short",
            levels: [
              { level: 0, targets: [cube(50, 500)] },
              {
                level: 1,
                targets: Array.from({ length: 12 }, (_, index) => cube(index + 1, 2000 + 250 * index, 50 * (12 - index))),
              },
            ],
          },
        ],
      } as LootJson;
      const { solverFn } = recordingSolver();
      const result = await planForTarget(profile, "puzzle-cube-1", 60, 1, {
        objectiveMode: "virtueFuel",
        virtueTank: tankOptions({ shiftCap: 0 }),
        targets: [
          { targetItemId: "puzzle-cube-1", quantity: 60 },
          { targetItemId: "gold-meteorite-1", quantity: 1 },
        ],
        lootData,
        solverFn,
      });
      expect(result.unmetItems).toEqual([]);
      const launchesAt = (level: number) =>
        result.missions
          .filter((mission) => mission.ship === "MILLENIUM_CHICKEN" && mission.level === level)
          .reduce((sum, mission) => sum + mission.launches, 0);
      expect(result.progression.prepLaunches).toEqual([]);
      expect(result.missions.filter((mission) => mission.level === 0).map((mission) => mission.targetAfxId)).toEqual([50]);
      expect(launchesAt(0)).toBe(2);
      expect(launchesAt(1)).toBeGreaterThan(0);
      expect(result.notes.some((note) => note.startsWith("Tank mode kept"))).toBe(true);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "ignores tank options outside the virtue objective",
    async () => {
      const { solverFn, models } = recordingSolver();
      const ships = [HENERPRISE_EPIC, CHICKFIANT_EPIC];
      const result = await planForTarget(profileFor(ships), "puzzle-cube-1", 6, 0.5, {
        objectiveMode: "ge",
        virtueTank: tankOptions({ shiftCap: 0 }),
        lootData: lootFor(ships),
        solverFn,
      });
      expect(result.objectiveMode).toBe("ge");
      expect(result.virtueTanks).toBeUndefined();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((model) => /\bv[yklnqw]_/.test(model))).toBe(false);
      expect(result.unmetItems).toEqual([]);
    },
    SOLVER_TIMEOUT_MS
  );
});
