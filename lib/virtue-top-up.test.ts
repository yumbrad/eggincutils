import { describe, expect, it } from "vitest";

import { solveWithHighs } from "./highs";
import type { LootJson } from "./loot-data";
import { buildVirtueTopUpCandidates } from "./planner";
import type { PlayerProfile } from "./profile";
import type { MissionOption } from "./ship-data";
import { getVirtueFuelConfig, TRILLION, type VirtueFuelKey } from "./virtue-fuel";
import { VIRTUE_LAUNCH_EFFORT_SECONDS } from "./virtue-tank-plan";
import { VIRTUE_REFILL_ROUTE_ORDER, type VirtueFuelVector, type VirtueTankPlan } from "./virtue-tanks";
import {
  planVirtueLastTankTopUp,
  VIRTUE_TOP_UP_LAMBDA_FRACTION,
  VIRTUE_TOP_UP_MAX_LAUNCHES,
  virtueLastTankRoom,
  virtueLastTankRoomText,
  virtueTopUpT1Equivalent,
  virtueTopUpValue,
  virtueTopUpYieldOf,
  type VirtueTopUpCandidate,
  type VirtueTopUpYield,
} from "./virtue-top-up";

const T = TRILLION;
const TANK = 500 * T;
const SOLVER_TIMEOUT_MS = 60_000;

/**
 * A two-tank plan whose last tank is a refuel loop over `route` that fills each
 * route egg to exactly what `used` burns (on the 1% grid), with `carried`
 * off-route eggs left in the tank.
 */
function packWithLastTank(route: VirtueFuelKey[], used: VirtueFuelVector, carried: VirtueFuelVector = {}): VirtueTankPlan {
  const pct = TANK / 100;
  const limitPct: Partial<Record<VirtueFuelKey, number>> = {};
  const fillTo: VirtueFuelVector = {};
  const add: VirtueFuelVector = {};
  const startContents: VirtueFuelVector = { ...carried };
  for (const egg of route) {
    limitPct[egg] = Math.ceil((used[egg] ?? 0) / pct);
    fillTo[egg] = used[egg] ?? 0;
    add[egg] = limitPct[egg]! * pct;
    startContents[egg] = limitPct[egg]! * pct;
  }
  const leftover: VirtueFuelVector = {};
  for (const egg of VIRTUE_REFILL_ROUTE_ORDER) {
    const left = (startContents[egg] ?? 0) - (used[egg] ?? 0);
    if (left > 0) {
      leftover[egg] = left;
    }
  }
  return {
    startMode: "current",
    capacity: TANK,
    tanks: [
      {
        index: 0,
        label: "Initial Tank",
        refill: null,
        startContents: {},
        used: {},
        leftover: {},
        launches: [],
        capacity: TANK,
      },
      {
        index: 1,
        label: "Tank 2",
        refill: {
          route: [...route, "humility"],
          shifts: route.length + 1,
          add,
          fillTo,
          limitPct,
          drain: {},
          drainHumility: false,
        },
        startContents,
        used,
        leftover,
        launches: [{ unitId: "u1", launches: 2 }],
        capacity: TANK,
      },
    ],
    totalShifts: route.length + 1,
    refillLoops: 1,
    totalFuel: used,
    feasible: true,
    exact: true,
    launchOrder: [{ unitId: "u1", tankIndex: 1, launches: 2 }],
    schedule: { makespanSeconds: 1, lanes: [[], [], []] },
    unplaced: [],
    notes: [],
    diagnostics: [],
  };
}

function yieldOf(partial: Partial<VirtueTopUpYield>): VirtueTopUpYield {
  return { goldMeteorite: 0, tauCetiGeode: 0, solarTitanium: 0, ...partial };
}

/** Mission hours by ship and duration (roughly the game's with some FTL research). */
const HOURS: Record<string, number> = {
  "HENERPRISE|SHORT": 9.6,
  "HENERPRISE|LONG": 19.2,
  "HENERPRISE|EPIC": 38.4,
  "VOYEGGER|SHORT": 4.8,
  "VOYEGGER|EPIC": 28.8,
  "CHICKFIANT|EPIC": 19.2,
};

function candidate(ship: string, durationType: string, expected: Partial<VirtueTopUpYield>, targetAfxId: number | null = 18): VirtueTopUpCandidate {
  return {
    ship,
    durationType,
    level: 8,
    durationSeconds: HOURS[`${ship}|${durationType}`] * 3600,
    targetAfxId,
    fuelPerLaunch: getVirtueFuelConfig(ship, durationType),
    expected: yieldOf(expected),
  };
}

/** Maxed Henerprise; Extended is the most time-efficient, Short and Standard pass the time charge by a little. */
const MAXED_HENERPRISE = [
  candidate("HENERPRISE", "SHORT", { tauCetiGeode: 12 }),
  candidate("HENERPRISE", "LONG", { tauCetiGeode: 20 }),
  candidate("HENERPRISE", "EPIC", { tauCetiGeode: 60 }),
];

/** Independent check: the plan's burn plus the top-up's fits the tank the way the game fills it. */
function checkFits(pack: VirtueTankPlan, topUp: NonNullable<Awaited<ReturnType<typeof planVirtueLastTankTopUp>>>) {
  const tank = pack.tanks[pack.tanks.length - 1];
  const pct = pack.capacity / 100;
  const route = VIRTUE_REFILL_ROUTE_ORDER.filter((egg) => tank.refill!.route.includes(egg));
  const extra: Record<VirtueFuelKey, number> = { curiosity: 0, integrity: 0, kindness: 0, resilience: 0 };
  for (const launch of topUp.launches) {
    const fuel = getVirtueFuelConfig(launch.ship, launch.durationType);
    for (const egg of VIRTUE_REFILL_ROUTE_ORDER) {
      extra[egg] += (fuel[egg] ?? 0) * launch.launches;
      if ((fuel[egg] ?? 0) > 0) {
        expect(route).toContain(egg);
      }
    }
  }
  let total = 0;
  for (const egg of VIRTUE_REFILL_ROUTE_ORDER) {
    if (!route.includes(egg)) {
      total += tank.startContents[egg] ?? 0;
    }
  }
  route.forEach((egg, index) => {
    const limit = topUp.limitPct[egg]!;
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit).toBeGreaterThanOrEqual(tank.refill!.limitPct[egg] ?? 0);
    expect(limit).toBeLessThanOrEqual(100);
    const level = topUp.fillTo[egg]!;
    const need = (tank.used[egg] ?? 0) + extra[egg];
    expect(level).toBeGreaterThanOrEqual(need - 1);
    if (index < route.length - 1) {
      // Every refilled egg but the last lands exactly on its limit step.
      expect(level).toBe(limit * pct);
    } else {
      expect(level).toBeLessThanOrEqual(limit * pct);
    }
    total += level;
  });
  expect(total).toBeLessThanOrEqual(pack.capacity);
  return extra;
}

describe("virtue top-up value", () => {
  it("counts T1 equivalents through the recipe chain", () => {
    expect(virtueTopUpT1Equivalent("gold_meteorite_1")).toBe(1);
    expect(virtueTopUpT1Equivalent("gold_meteorite_2")).toBe(9);
    expect(virtueTopUpT1Equivalent("gold_meteorite_3")).toBe(99);
    expect(virtueTopUpT1Equivalent("tau_ceti_geode_3")).toBe(168);
    expect(virtueTopUpT1Equivalent("solar_titanium_3")).toBe(120);
    expect(virtueTopUpT1Equivalent("puzzle_cube_1")).toBe(0);
  });

  it("weighs the three families equally", () => {
    const expected = virtueTopUpYieldOf({ gold_meteorite_1: 1, tau_ceti_geode_1: 1, solar_titanium_1: 1, puzzle_cube_1: 5 });
    expect(expected).toEqual({ goldMeteorite: 1, tauCetiGeode: 1, solarTitanium: 1 });
    expect(virtueTopUpValue(yieldOf({ goldMeteorite: 10 }))).toBe(virtueTopUpValue(yieldOf({ solarTitanium: 10 })));
    expect(virtueTopUpValue(yieldOf({ tauCetiGeode: 10 }))).toBe(virtueTopUpValue(yieldOf({ goldMeteorite: 10 })));
  });
});

describe("virtueLastTankRoom", () => {
  it("calls out a mostly empty last tank", () => {
    // 2 Henerprise Standard: R 20T, K 30T, C 40T; only Resilience refilled.
    const pack = packWithLastTank(["resilience"], { curiosity: 40 * T, kindness: 30 * T, resilience: 20 * T }, {
      curiosity: 40 * T,
      kindness: 30 * T,
    });
    const room = virtueLastTankRoom(pack);
    expect(room?.room).toBe(410 * T);
    expect(virtueLastTankRoomText(room!)).toBe("Tank 2 only needs 20T of Resilience for 2 launches, leaving 410T of room.");
  });

  it("stays quiet on a nearly full last tank or a plan without refuel loops", () => {
    const full = packWithLastTank(["curiosity", "kindness"], { curiosity: 250 * T, kindness: 200 * T });
    expect(virtueLastTankRoom(full)).toBeNull();
    const single = packWithLastTank(["curiosity"], { curiosity: 10 * T });
    single.tanks = single.tanks.slice(0, 1);
    expect(virtueLastTankRoom(single)).toBeNull();
  });
});

describe("planVirtueLastTankTopUp", () => {
  it(
    "fills a C/R/K route with maxed Henerprise Extended launches, on the grid and within the tank",
    async () => {
      const pack = packWithLastTank(["curiosity", "resilience", "kindness"], {
        curiosity: 40 * T,
        kindness: 30 * T,
        resilience: 20 * T,
      });
      const topUp = await planVirtueLastTankTopUp({ pack, candidates: MAXED_HENERPRISE, solverFn: solveWithHighs });
      expect(topUp).not.toBeNull();
      expect(topUp!.tankIndex).toBe(1);
      expect(topUp!.roomBefore).toBe(410 * T);
      // 90T used + 5 x 70T = 440T; a sixth Extended would need 510T.
      const epic = topUp!.launches.find((launch) => launch.durationType === "EPIC");
      expect(epic?.launches).toBe(5);
      expect(topUp!.launches[0]).toMatchObject({ ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 18 });
      checkFits(pack, topUp!);

      // Brute force over every mix: the solve finds the best value net of the time charge.
      const costOf = (hours: number) => (hours * 3600) / 3 + VIRTUE_LAUNCH_EFFORT_SECONDS;
      const lambda = VIRTUE_TOP_UP_LAMBDA_FRACTION * Math.max(12 / costOf(9.6), 20 / costOf(19.2), 60 / costOf(38.4));
      const net = (value: number, hours: number) => Math.max(0, value - lambda * costOf(hours));
      let best = 0;
      let bestGross = 0;
      for (let epicCount = 0; epicCount <= 6; epicCount += 1) {
        for (let long = 0; long <= 10; long += 1) {
          for (let short = 0; short <= 20; short += 1) {
            const c = 40 + 25 * epicCount + 20 * long + 15 * short;
            const r = 20 + 20 * epicCount + 10 * long;
            const k = 30 + 25 * epicCount + 15 * long + 10 * short;
            // C and R land on 5T steps, K fills the rest.
            const footprint = Math.ceil(c / 5) * 5 + Math.ceil(r / 5) * 5 + k;
            if (footprint <= 500 && epicCount + long + short <= VIRTUE_TOP_UP_MAX_LAUNCHES) {
              const value = net(60, 38.4) * epicCount + net(20, 19.2) * long + net(12, 9.6) * short;
              if (value > best) {
                best = value;
                bestGross = 60 * epicCount + (net(20, 19.2) > 0 ? 20 * long : 0) + (net(12, 9.6) > 0 ? 12 * short : 0);
              }
            }
          }
        }
      }
      expect(topUp!.netValue).toBeCloseTo(best, 6);
      expect(topUp!.totalValue).toBeCloseTo(bestGross, 6);
      expect(topUp!.expected.tauCetiGeode).toBeCloseTo(bestGross, 6);
      const slot = topUp!.launches.reduce((sum, launch) => sum + launch.launches * HOURS[`${launch.ship}|${launch.durationType}`] * 3600, 0);
      expect(topUp!.slotSeconds).toBe(slot);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "never overflows the tank once the limits round up",
    async () => {
      // Off-grid burn and an off-grid carried egg: every limit rounds up.
      const pack = packWithLastTank(["curiosity", "kindness"], { curiosity: 33.3 * T, kindness: 21.7 * T }, {
        integrity: 123.4 * T,
      });
      const candidates = [
        candidate("CHICKFIANT", "EPIC", { goldMeteorite: 7 }, 17),
        candidate("VOYEGGER", "EPIC", { solarTitanium: 25 }, 43),
        candidate("VOYEGGER", "SHORT", { solarTitanium: 7 }, null),
      ];
      const topUp = await planVirtueLastTankTopUp({ pack, candidates, solverFn: solveWithHighs });
      expect(topUp).not.toBeNull();
      checkFits(pack, topUp!);
      const greedy = await planVirtueLastTankTopUp({ pack, candidates });
      expect(greedy).not.toBeNull();
      checkFits(pack, greedy!);
      // The solve maximizes value net of the time charge, so it never does worse than greedy on that.
      expect(topUp!.netValue).toBeGreaterThanOrEqual(greedy!.netValue - 1e-9);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "only suggests ships that burn eggs on the route",
    async () => {
      const pack = packWithLastTank(["curiosity", "kindness"], { curiosity: 40 * T, kindness: 30 * T });
      const topUp = await planVirtueLastTankTopUp({
        pack,
        candidates: [...MAXED_HENERPRISE, candidate("VOYEGGER", "EPIC", { goldMeteorite: 60 }, 17)],
        solverFn: solveWithHighs,
      });
      // Henerprise Standard and Extended burn Resilience, which the route skips.
      expect(topUp!.launches.every((launch) => launch.ship === "VOYEGGER" || launch.durationType === "SHORT")).toBe(true);
      checkFits(pack, topUp!);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "charges launches their time, keeping slow ships out however little fuel they burn",
    async () => {
      const pack = packWithLastTank(["curiosity", "kindness"], { curiosity: 40 * T, kindness: 30 * T });
      // Defihent Extended brings more per egg (10 per 6T vs 30 per 25T), but a third as much per hour.
      const candidates = [
        candidate("HENERPRISE", "SHORT", { goldMeteorite: 30 }, 17),
        candidate("CHICKFIANT", "EPIC", { goldMeteorite: 10 }, 17),
      ];
      const topUp = await planVirtueLastTankTopUp({ pack, candidates, solverFn: solveWithHighs });
      expect(topUp!.launches.map((launch) => launch.ship)).toEqual(["HENERPRISE"]);
      checkFits(pack, topUp!);
      // With almost no time charge the Defihents flood in.
      const cheap = await planVirtueLastTankTopUp({ pack, candidates, solverFn: solveWithHighs, lambdaFraction: 0.05 });
      expect(cheap!.launches.some((launch) => launch.ship === "CHICKFIANT")).toBe(true);
      expect(cheap!.launches.reduce((sum, launch) => sum + launch.launches, 0)).toBeGreaterThan(30);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "lets slow fuel-thrifty ships fill the room by default when they bring clearly more per egg",
    async () => {
      const pack = packWithLastTank(["curiosity", "kindness"], { curiosity: 40 * T, kindness: 30 * T });
      // Defihent Extended: half Henerprise Short's value per hour, but 5 per egg-T against 1.2.
      const thrifty = [
        candidate("HENERPRISE", "SHORT", { goldMeteorite: 30 }, 17),
        candidate("CHICKFIANT", "EPIC", { goldMeteorite: 30 }, 17),
      ];
      const topUp = await planVirtueLastTankTopUp({ pack, candidates: thrifty, solverFn: solveWithHighs });
      const defihents = topUp!.launches.find((launch) => launch.ship === "CHICKFIANT")?.launches ?? 0;
      expect(defihents).toBeGreaterThan(30);
      checkFits(pack, topUp!);
      // A heavier charge keeps only the fast ship.
      const strict = await planVirtueLastTankTopUp({ pack, candidates: thrifty, solverFn: solveWithHighs, lambdaFraction: 0.5 });
      expect(strict!.launches.map((launch) => launch.ship)).toEqual(["HENERPRISE"]);

      // When the thrifty ship is only about as good per egg, the fewer, faster launches win.
      const close = await planVirtueLastTankTopUp({
        pack,
        candidates: [candidate("HENERPRISE", "SHORT", { goldMeteorite: 30 }, 17), candidate("CHICKFIANT", "EPIC", { goldMeteorite: 20 }, 17)],
        solverFn: solveWithHighs,
      });
      expect(close!.launches.find((launch) => launch.ship === "HENERPRISE")?.launches ?? 0).toBeGreaterThan(
        close!.launches.find((launch) => launch.ship === "CHICKFIANT")?.launches ?? 0
      );
      checkFits(pack, close!);
    },
    SOLVER_TIMEOUT_MS
  );

  it(
    "offers nothing when only slow ships fit the route",
    async () => {
      const pack = packWithLastTank(["curiosity", "kindness"], { curiosity: 40 * T, kindness: 30 * T });
      // The player's best mission (Henerprise Extended) burns Resilience, which the route skips.
      const topUp = await planVirtueLastTankTopUp({
        pack,
        // Defihent Extended at a sixth of Henerprise Extended's value per hour: under even the light default charge.
        candidates: [candidate("HENERPRISE", "EPIC", { goldMeteorite: 60 }, 17), candidate("CHICKFIANT", "EPIC", { goldMeteorite: 5 }, 17)],
        solverFn: solveWithHighs,
      });
      expect(topUp).toBeNull();
    },
    SOLVER_TIMEOUT_MS
  );

  it("suggests nothing for a single-egg route no ship can burn alone", async () => {
    const pack = packWithLastTank(["resilience"], { curiosity: 40 * T, kindness: 30 * T, resilience: 20 * T }, {
      curiosity: 40 * T,
      kindness: 30 * T,
    });
    expect(virtueLastTankRoom(pack)).not.toBeNull();
    const topUp = await planVirtueLastTankTopUp({ pack, candidates: MAXED_HENERPRISE, solverFn: solveWithHighs });
    expect(topUp).toBeNull();
  });
});

describe("buildVirtueTopUpCandidates", () => {
  const MISSIONS: Record<string, { missionId: string; capacity: number }> = {
    "HENERPRISE|EPIC": { missionId: "henerprise-extended", capacity: 100 },
    "VOYEGGER|EPIC": { missionId: "voyegger-extended", capacity: 40 },
  };

  function loot(): LootJson {
    return {
      missions: Object.values(MISSIONS).map(({ missionId }) => ({
        afxShip: 0,
        afxDurationType: 0,
        missionId,
        levels: [
          {
            level: 0,
            targets: [
              {
                totalDrops: 5000,
                targetAfxId: 18,
                items: [
                  { afxId: 0, afxLevel: 1, itemId: "tau-ceti-geode-2", counts: [2500, 0, 0, 0] },
                  { afxId: 0, afxLevel: 1, itemId: "puzzle-cube-1", counts: [2500, 0, 0, 0] },
                ],
              },
              {
                totalDrops: 5000,
                targetAfxId: 1,
                items: [{ afxId: 0, afxLevel: 1, itemId: "gold-meteorite-3", counts: [5000, 0, 0, 0] }],
              },
            ],
          },
        ],
      })),
    } as LootJson;
  }

  function profile(shapes: string[]): PlayerProfile {
    const missionOptions: MissionOption[] = shapes.map((shape) => {
      const [ship, durationType] = shape.split("|");
      return {
        ship,
        durationType: durationType as MissionOption["durationType"],
        missionId: MISSIONS[shape].missionId,
        level: 0,
        durationSeconds: 100_000,
        capacity: MISSIONS[shape].capacity,
      };
    });
    return {
      eid: "EI_TEST",
      inventory: {},
      craftCounts: {},
      craftingXp: 0,
      epicResearchFTLLevel: 0,
      epicResearchZerogLevel: 0,
      shipLevels: [],
      missionOptions,
    };
  }

  it("prices each mission's ingredient drops and skips other targets", async () => {
    const candidates = await buildVirtueTopUpCandidates({
      profile: profile(["HENERPRISE|EPIC", "VOYEGGER|EPIC"]),
      lootData: loot(),
    });
    // Only the geode target: target 1 (tachyon stone) is not a top-up target.
    expect(candidates.map((entry) => `${entry.ship}|${entry.targetAfxId}`).sort()).toEqual([
      "HENERPRISE|18",
      "VOYEGGER|18",
    ]);
    const henerprise = candidates.find((entry) => entry.ship === "HENERPRISE")!;
    // Half of 100 drops are T2 geodes (12 T1 each); the puzzle cubes count for nothing.
    expect(henerprise.expected.tauCetiGeode).toBeCloseTo(50 * 12, 6);
    expect(henerprise.fuelPerLaunch).toEqual(getVirtueFuelConfig("HENERPRISE", "EPIC"));
  });

  it(
    "falls back to another ship when Henerprise is locked",
    async () => {
      const pack = packWithLastTank(["curiosity", "resilience", "kindness"], {
        curiosity: 40 * T,
        kindness: 30 * T,
        resilience: 20 * T,
      });
      const withHenerprise = await planVirtueLastTankTopUp({
        pack,
        candidates: await buildVirtueTopUpCandidates({ profile: profile(["HENERPRISE|EPIC", "VOYEGGER|EPIC"]), lootData: loot() }),
        solverFn: solveWithHighs,
      });
      expect(withHenerprise!.launches[0]).toMatchObject({ ship: "HENERPRISE", durationType: "EPIC", launches: 5 });
      const locked = await planVirtueLastTankTopUp({
        pack,
        candidates: await buildVirtueTopUpCandidates({ profile: profile(["VOYEGGER|EPIC"]), lootData: loot() }),
        solverFn: solveWithHighs,
      });
      expect(locked!.launches.map((launch) => launch.ship)).toEqual(["VOYEGGER"]);
      checkFits(pack, locked!);
      // Voyegger Extended burns 40T (K 15T, C 25T): 10 fit beside the plan's 90T (490T).
      expect(locked!.launches[0].launches).toBe(10);
      expect(locked!.totalValue).toBeLessThan(withHenerprise!.totalValue);
    },
    SOLVER_TIMEOUT_MS
  );

  it("leaves out ships the plan may not use", async () => {
    const candidates = await buildVirtueTopUpCandidates({
      profile: profile(["HENERPRISE|EPIC", "VOYEGGER|EPIC"]),
      lootData: loot(),
      allowedShipDurations: [{ ship: "VOYEGGER", durationType: "EPIC" }],
    });
    expect(candidates.map((entry) => entry.ship)).toEqual(["VOYEGGER"]);
  });
});
