import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HighsSolveResult } from "./highs";
import type { PlayerProfile } from "./profile";

vi.mock("./loot-data", () => ({
  loadLootData: vi.fn(),
}));
vi.mock("./highs", () => ({
  solveWithHighs: vi.fn(),
}));

import { loadLootData } from "./loot-data";
import { solveWithHighs } from "./highs";
import { MissionCoverageError, missionDurationLabel, planForTarget, summarizeCraftRows } from "./planner";
import { buildMissionOptions, computeShipLevelsFromLaunchCounts } from "./ship-data";

const mockedLoadLootData = vi.mocked(loadLootData);
const mockedSolveWithHighs = vi.mocked(solveWithHighs);

function baseProfile(): PlayerProfile {
  return {
    eid: "EI_TEST",
    inventory: {},
    craftCounts: {},
    craftingXp: 0,
    epicResearchFTLLevel: 0,
    epicResearchZerogLevel: 0,
    shipLevels: [],
    missionOptions: [],
  };
}

describe("planner helpers", () => {
  it("formats mission duration labels", () => {
    expect(missionDurationLabel(0)).toBe("0m");
    expect(missionDurationLabel(3660)).toBe("1h 1m");
    expect(missionDurationLabel(90060)).toBe("1d 1h 1m");
  });

  it("summarizes craft rows with display names", () => {
    const summary = summarizeCraftRows([
      { itemId: "soul-stone-2", count: 5 },
      { itemId: "tachyon-stone-2", count: 3 },
    ]);
    expect(summary[0]).toContain(": 5");
    expect(summary[0]?.toLowerCase()).toContain("soul");
  });
});

describe("planForTarget coverage handling", () => {
  beforeEach(() => {
    mockedLoadLootData.mockReset();
    mockedSolveWithHighs.mockReset();
  });

  it("throws MissionCoverageError when required items have no mission coverage", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [],
    });

    await expect(planForTarget(baseProfile(), "puzzle-cube-1", 1, 0.5)).rejects.toBeInstanceOf(MissionCoverageError);
  });

  it("resolves gusset-4 display ID to ornate_gusset_4 and finds mission coverage", async () => {
    // gusset-{n} is the display ID in artifact-display.json for the canonical key ornate_gusset_{n}.
    // The planner must normalize the incoming item ID so recipes and loot data match.
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 8,
                      afxLevel: 4,
                      itemId: "ornate-gusset-4",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    mockedSolveWithHighs.mockResolvedValue({
      Status: "Optimal",
      Columns: { m_0: { Primal: 1 } },
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    // "gusset-4" is the shortened display ID; must NOT throw MissionCoverageError.
    const result = await planForTarget(profile, "gusset-4", 1, 0.5);
    expect(result.missions).toHaveLength(1);
    expect(result.targetBreakdown.requested).toBe(1);
  });

  it("resolves vial-of-martian-dust-2 display ID to vial_martian_dust_2 and finds mission coverage", async () => {
    // vial-of-martian-dust-{n} is the display ID in artifact-display.json for key vial_martian_dust_{n}.
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 7,
                      afxLevel: 2,
                      itemId: "vial-martian-dust-2",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    mockedSolveWithHighs.mockResolvedValue({
      Status: "Optimal",
      Columns: { m_0: { Primal: 1 } },
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    // "vial-of-martian-dust-2" is the expanded display ID; must NOT throw MissionCoverageError.
    const result = await planForTarget(profile, "vial-of-martian-dust-2", 1, 0.5);
    expect(result.missions).toHaveLength(1);
    expect(result.targetBreakdown.requested).toBe(1);
  });

  it("uses HiGHS mission allocation when solver returns an optimal solution", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    mockedSolveWithHighs.mockResolvedValue({
      Status: "Optimal",
      Columns: {
        m_0: { Primal: 2 },
      },
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 2, 0.5);
    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].launches).toBe(2);
    expect(result.targetBreakdown.requested).toBe(2);
    expect(result.targetBreakdown.fromMissionsExpected).toBe(2);
    expect(result.targetBreakdown.fromCraft).toBe(0);
    expect(result.targetBreakdown.shortfall).toBe(0);
    expect(result.notes.some((note) => note.includes("unified HiGHS model"))).toBe(true);
  });

  it("can consume a selected artifact from inventory for expected stone yield", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [],
    });
    mockedSolveWithHighs.mockResolvedValue({
      Status: "Optimal",
      Columns: {
        x_0: { Primal: 1 },
        u_0: { Primal: 0 },
        u_1: { Primal: 0 },
      },
    });

    const profile = baseProfile();
    profile.inventory.light_of_eggendil_1 = 1;

    const result = await planForTarget(profile, "clarity-stone-1", 1, 0.5, {
      selectedConsumptionItemIds: ["light-of-eggendil-1"],
    });

    expect(result.consumptions).toHaveLength(1);
    expect(result.consumptions[0].itemId).toBe("light-of-eggendil-1");
    expect(result.consumptions[0].count).toBe(1);
    expect(result.consumptions[0].yields).toContainEqual({
      itemId: "clarity-stone-1",
      quantity: expect.any(Number),
    });
    expect(result.unmetItems).toEqual([]);
  });

  it("filters mission target rows with too few estimated launches or drops", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 10,
          afxDurationType: 1,
          missionId: "atreggies-standard",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 499,
                  targetAfxId: 1,
                  items: [{ afxId: 23, afxLevel: 1, itemId: "puzzle-cube-1", counts: [499, 0, 0, 0] }],
                },
                {
                  totalDrops: 600,
                  targetAfxId: 2,
                  items: [{ afxId: 23, afxLevel: 1, itemId: "puzzle-cube-1", counts: [600, 0, 0, 0] }],
                },
                {
                  totalDrops: 1000,
                  targetAfxId: 10000,
                  items: [{ afxId: 23, afxLevel: 1, itemId: "puzzle-cube-1", counts: [1000, 0, 0, 0] }],
                },
              ],
            },
          ],
        },
      ],
    });
    mockedSolveWithHighs.mockResolvedValue({
      Status: "Optimal",
      Columns: { m_0: { Primal: 1 } },
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "ATREGGIES",
        missionId: "atreggies-standard",
        durationType: "LONG",
        level: 0,
        durationSeconds: 259_200,
        capacity: 78,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 1, 0.5);
    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].targetAfxId).toBe(10000);
  });

  it("filters impossible targeted rows from ships that cannot target in game", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 3,
          afxDurationType: 0,
          missionId: "bcr-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 1,
                  items: [{ afxId: 23, afxLevel: 1, itemId: "puzzle-cube-1", counts: [5000, 0, 0, 0] }],
                },
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [{ afxId: 23, afxLevel: 1, itemId: "puzzle-cube-1", counts: [5000, 0, 0, 0] }],
                },
              ],
            },
          ],
        },
      ],
    });
    mockedSolveWithHighs.mockResolvedValue({
      Status: "Optimal",
      Columns: { m_0: { Primal: 1 } },
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "BCR",
        missionId: "bcr-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 1, 0.5);
    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].targetAfxId).toBe(10000);
    expect(result.availableCombos).toEqual([{ ship: "BCR", durationType: "SHORT", targetAfxId: 10000 }]);
  });

  it("respects allowedShipDurations by filtering mission options before solve", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          afxShip: 1,
          afxDurationType: 1,
          missionId: "test-long",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    mockedSolveWithHighs.mockResolvedValue({
      Status: "Optimal",
      Columns: {
        m_0: { Primal: 2 },
      },
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
      {
        ship: "CHICKEN_NINE",
        missionId: "test-long",
        durationType: "LONG",
        level: 0,
        durationSeconds: 3600,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 2, 0.5, {
      allowedShipDurations: [{ ship: "CHICKEN_NINE", durationType: "LONG" }],
    });

    expect(result.missions).toHaveLength(1);
    expect(result.missions[0]).toMatchObject({
      missionId: "test-long",
      ship: "CHICKEN_NINE",
      durationType: "LONG",
      launches: 2,
    });
    expect(
      result.availableCombos.every((combo) => combo.ship === "CHICKEN_NINE" && combo.durationType === "LONG")
    ).toBe(true);
  });

  it("reports expected mission time as 3-slot makespan rather than slot-time average", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-extended",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    mockedSolveWithHighs.mockResolvedValue({
      Status: "Optimal",
      Columns: {
        m_0: { Primal: 2 },
      },
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-extended",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 138_240,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 2, 0.5);
    expect(result.totalSlotSeconds).toBe(276_480);
    expect(result.expectedHours).toBeCloseTo(38.4, 6);
  });

  it("treats target quantity as additional beyond current inventory", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    let lpModel = "";
    mockedSolveWithHighs.mockImplementation(async (model): Promise<HighsSolveResult> => {
      lpModel = model;
      return {
        Status: "Optimal",
        Columns: {
          m_0: { Primal: 2 },
        },
      };
    });

    const profile = baseProfile();
    profile.inventory = {
      puzzle_cube_1: 50,
    };
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 2, 0.5);

    const demandLine = lpModel.split("\n").find((line) => line.trimStart().startsWith("b_0:")) || "";
    expect(demandLine).toContain(">= 2");
    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].launches).toBe(2);
    expect(result.targetBreakdown.requested).toBe(2);
    expect(result.targetBreakdown.fromInventory).toBe(0);
    expect(result.targetBreakdown.fromMissionsExpected).toBe(2);
  });

  it("keeps a tiny mission-time tie-break even at 0% time priority", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    let lpModel = "";
    mockedSolveWithHighs.mockImplementation(async (model): Promise<HighsSolveResult> => {
      lpModel = model;
      return {
        Status: "Optimal",
        Columns: {
          m_0: { Primal: 2 },
        },
      };
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    await planForTarget(profile, "puzzle-cube-1", 2, 0);
    const objectiveLine = lpModel.split("\n").find((line) => line.trimStart().startsWith("obj:")) || "";
    expect(objectiveLine).toContain("m_0");
  });

  it("adds required prep-launch constraints so prep drops can be credited", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "chicken-one-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          afxShip: 1,
          afxDurationType: 0,
          missionId: "chicken-nine-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
            {
              level: 1,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [10000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const lpModels: string[] = [];
    mockedSolveWithHighs.mockImplementation(async (model) => {
      lpModels.push(model);
      if (!model.includes("r_0:")) {
        return {
          Status: "Optimal",
          Columns: {
            m_0: { Primal: 1000 },
          },
        };
      }
      // A real solver must honor the required prep-launch rows, so credit each
      // required option's first mission variable with its forced launches on
      // top of a single farming launch on m_0.
      const primals: Record<string, number> = { m_0: 1 };
      for (const line of model.split("\n")) {
        const match = line.trim().match(/^r_\d+:\s*(m_\d+)[^=>]*(?:>=|=)\s*([0-9.]+)$/);
        if (!match) {
          continue;
        }
        primals[match[1]] = (primals[match[1]] || 0) + Number(match[2]);
      }
      return {
        Status: "Optimal",
        Columns: Object.fromEntries(
          Object.entries(primals).map(([variable, primal]) => [variable, { Primal: primal }])
        ),
      };
    });

    const profile = baseProfile();
    const shipLevels = computeShipLevelsFromLaunchCounts({
      CHICKEN_ONE: {
        SHORT: 4,
      },
      CHICKEN_NINE: {
        SHORT: 3,
      },
    });
    profile.shipLevels = shipLevels;
    profile.missionOptions = buildMissionOptions(shipLevels, 0, 0);

    const result = await planForTarget(profile, "puzzle-cube-1", 2, 1);
    expect(result.progression.prepLaunches.length).toBeGreaterThan(0);

    const hasRequiredPrepConstraint = lpModels.some((model) =>
      model
        .split("\n")
        .some((line) => line.trimStart().startsWith("r_") && line.includes(" = "))
    );
    expect(hasRequiredPrepConstraint).toBe(true);
  });

  it("includes prep launches when horizon progression unlocks better mission options", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "chicken-one-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          afxShip: 1,
          afxDurationType: 0,
          missionId: "chicken-nine-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    mockedSolveWithHighs.mockImplementation(async (model, _options): Promise<HighsSolveResult> => {
      if (model.includes("m_1")) {
        return {
          Status: "Optimal",
          Columns: {
            m_1: { Primal: 2 },
          },
        };
      }
      return {
        Status: "Optimal",
        Columns: {
          m_0: { Primal: 10 },
        },
      };
    });

    const profile = baseProfile();
    const shipLevels = computeShipLevelsFromLaunchCounts({
      CHICKEN_ONE: {
        SHORT: 3,
      },
    });
    profile.shipLevels = shipLevels;
    profile.missionOptions = buildMissionOptions(shipLevels, 0, 0);

    const result = await planForTarget(profile, "puzzle-cube-1", 4, 1);
    expect(result.progression.prepLaunches.length).toBeGreaterThan(0);
    expect(result.progression.prepLaunches.some((step) => step.reason.includes("Unlock CHICKEN_NINE"))).toBe(true);
    expect(result.missions.some((mission) => mission.ship === "CHICKEN_NINE")).toBe(true);
  });

  it("strips prep progression the final plan never launches or uses", async () => {
    // No level-1 loot exists, so leveling CHICKEN_NINE can never pay off: any
    // prep candidate that wins does so on solver noise alone.
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "chicken-one-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          afxShip: 1,
          afxDurationType: 0,
          missionId: "chicken-nine-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    mockedSolveWithHighs.mockImplementation(async (model) => {
      if (model.includes("r_0:")) {
        // Prep-carrying candidate models get a cheap solution (mimicking solver
        // noise in their favor) that honors the required prep-launch rows but
        // never touches any post-level option.
        const primals: Record<string, number> = { m_0: 1, m_1: 1 };
        for (const line of model.split("\n")) {
          const match = line.trim().match(/^r_\d+:\s*(m_\d+)[^=>]*(?:>=|=)\s*([0-9.]+)$/);
          if (!match) {
            continue;
          }
          primals[match[1]] = (primals[match[1]] || 0) + Number(match[2]);
        }
        return {
          Status: "Optimal",
          Columns: Object.fromEntries(
            Object.entries(primals).map(([variable, primal]) => [variable, { Primal: primal }])
          ),
        };
      }
      if (!model.includes("m_1")) {
        // Single-option monolithic incumbent re-solve: one launch suffices.
        return {
          Status: "Optimal",
          Columns: {
            m_0: { Primal: 1 },
          },
        };
      }
      // Full no-prep candidate models look expensive, so the prep candidate wins.
      return {
        Status: "Optimal",
        Columns: {
          m_0: { Primal: 1000 },
        },
      };
    });

    const profile = baseProfile();
    const shipLevels = computeShipLevelsFromLaunchCounts({
      CHICKEN_ONE: {
        SHORT: 5,
      },
      CHICKEN_NINE: {
        SHORT: 3,
      },
    });
    profile.shipLevels = shipLevels;
    profile.missionOptions = buildMissionOptions(shipLevels, 0, 0);

    const result = await planForTarget(profile, "puzzle-cube-1", 2, 1);
    expect(result.progression.prepLaunches).toHaveLength(0);
    expect(result.progression.prepHours).toBe(0);
    expect(
      result.notes.some((note) => note.includes("Removed orphaned ship-progression prep launches"))
    ).toBe(true);
  });

  it("builds integer piecewise craft discount variables for craftable targets in unified solve", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [],
    });

    let lpModel = "";
    mockedSolveWithHighs.mockImplementation(async (model) => {
      lpModel = model;
      return {
        Status: "Optimal",
        Columns: {
          c_0: { Primal: 1 },
        },
      };
    });

    const result = await planForTarget(baseProfile(), "soul-stone-2", 1, 0.5);
    expect(lpModel).toContain("General");
    expect(lpModel).toContain("cs_0");
    expect(lpModel).not.toContain("\nBinary\n");
    expect(result.crafts.length).toBeGreaterThan(0);
    expect(result.notes.some((note) => note.includes("exact craft discount scheduling"))).toBe(true);
  });

  it("can require target quantity to be satisfied only by crafts", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 23,
                      afxLevel: 2,
                      itemId: "puzzle-cube-2",
                      counts: [5000, 0, 0, 0],
                    },
                    {
                      afxId: 23,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [100000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    let lpModel = "";
    mockedSolveWithHighs.mockImplementation(async (model) => {
      lpModel = model;
      return {
        Status: "Optimal",
        Columns: {
          c_0: { Primal: 2 },
          m_0: { Primal: 3 },
        },
      };
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-2", 2, 0.5, { targetCraftedOnly: true });

    const targetDemandLine = lpModel.split("\n").find((line) => line.trimStart().startsWith("b_1:")) || "";
    expect(targetDemandLine).toContain("c_0");
    expect(targetDemandLine).not.toContain("m_0");
    expect(targetDemandLine).toContain(">= 2");
    expect(result.targetBreakdown.fromCraft).toBe(2);
    expect(result.targetBreakdown.fromMissionsExpected).toBe(0);
    expect(result.notes.some((note) => note.includes("Artifacts-only crafted goal mode enabled"))).toBe(true);
  });

  it("runs an integer re-solve in fast mode for non-GE priorities", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    mockedSolveWithHighs.mockImplementation(async (model) => {
      const isMilp = model.includes("\nGeneral\n");
      return {
        Status: "Optimal",
        Columns: {
          m_0: { Primal: isMilp ? 4 : 2 },
        },
      };
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 4, 0.5, { fastMode: true });

    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].launches).toBe(4);
    expect(result.notes.some((note) => note.includes("Fast mode integer re-solves the top LP-screened progression candidate."))).toBe(
      true
    );
  });

  it("scales a representative small-quantity plan in fast mode for larger requests", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const solvedModels: string[] = [];
    mockedSolveWithHighs.mockImplementation(async (model): Promise<HighsSolveResult> => {
      solvedModels.push(model);
      return {
        Status: "Optimal",
        Columns: {
          m_0: { Primal: 1 },
        },
      };
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 5, 0.5, { fastMode: true });

    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].launches).toBe(5);
    expect(result.targetBreakdown.requested).toBe(5);
    expect(result.targetBreakdown.fromMissionsExpected).toBe(5);
    expect(
      solvedModels.some((model) =>
        model
          .split("\n")
          .some((line) => line.trimStart().startsWith("b_0:") && line.includes(">= 1"))
      )
    ).toBe(true);
    expect(result.notes.some((note) => note.includes("large-quantity acceleration"))).toBe(true);
  });

  it("scales multi-target fast mode by target quantity GCD", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                    {
                      afxId: 7,
                      afxLevel: 2,
                      itemId: "vial-martian-dust-2",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const solvedModels: string[] = [];
    mockedSolveWithHighs.mockImplementation(async (model): Promise<HighsSolveResult> => {
      solvedModels.push(model);
      return {
        Status: "Optimal",
        Columns: {
          m_0: { Primal: 1 },
        },
      };
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 10, 0.5, {
      fastMode: true,
      targets: [
        { targetItemId: "puzzle-cube-1", quantity: 10 },
        { targetItemId: "vial-of-martian-dust-2", quantity: 10 },
      ],
    });

    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].launches).toBe(10);
    expect(result.targetBreakdowns.map((row) => row.requested)).toEqual([10, 10]);
    expect(
      solvedModels.some((model) => {
        const demandLines = model
          .split("\n")
          .filter((line) => line.trimStart().startsWith("b_") && line.includes(">= 1"));
        return demandLines.length >= 2;
      })
    ).toBe(true);
    expect(result.notes.some((note) => note.includes("multi-target acceleration"))).toBe(true);
  });

  it("repairs fast scaled blocks that used one-time ingredient inventory", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const solvedModels: string[] = [];
    mockedSolveWithHighs.mockImplementation(async (model): Promise<HighsSolveResult> => {
      solvedModels.push(model);
      if (model.includes("d_0:")) {
        return {
          Status: "Optimal",
          Columns: {
            m_0: { Primal: 12 },
          },
        };
      }
      return {
        Status: "Optimal",
        Columns: {
          c_0: { Primal: 1 },
        },
      };
    });

    const profile = baseProfile();
    profile.inventory = {
      puzzle_cube_1: 3,
    };
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-2", 5, 0.5, { fastMode: true });

    expect(result.crafts).toContainEqual({ itemId: "puzzle-cube-2", count: 5 });
    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].launches).toBe(12);
    expect(result.unmetItems).toHaveLength(0);
    expect(
      solvedModels.some((model) =>
        model
          .split("\n")
          .some((line) => line.trimStart().startsWith("b_0:") && line.includes(">= -3"))
      )
    ).toBe(true);
    expect(result.notes.some((note) => note.includes("repair launches"))).toBe(true);
  });

  it("lets normal mode adopt a better scaled small-block incumbent", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "slow-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [{ afxId: 1, afxLevel: 1, itemId: "puzzle-cube-1", counts: [5000, 0, 0, 0] }],
                },
              ],
            },
          ],
        },
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "fast-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [{ afxId: 1, afxLevel: 1, itemId: "puzzle-cube-1", counts: [5000, 0, 0, 0] }],
                },
              ],
            },
          ],
        },
      ],
    });

    mockedSolveWithHighs.mockImplementation(async (model): Promise<HighsSolveResult> => {
      const demandLine = model.split("\n").find((line) => line.trimStart().startsWith("b_0:")) || "";
      const isSmallBlock = demandLine.includes(">= 1");
      return {
        Status: "Optimal",
        Columns: isSmallBlock
          ? {
              m_1: { Primal: 1 },
            }
          : {
              m_0: { Primal: 5 },
            },
      };
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "slow-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 2400,
        capacity: 1,
      },
      {
        ship: "CHICKEN_ONE",
        missionId: "fast-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 5, 0.5);

    expect(result.missions).toHaveLength(1);
    expect(result.missions[0]).toMatchObject({ missionId: "fast-short", launches: 5 });
    expect(result.expectedHours).toBeCloseTo(2400 / 3600, 6);
    expect(result.notes.some((note) => note.includes("adopted a scaled small-block incumbent"))).toBe(true);
  });

  it("replays scaled fast-mode launches through projected ship levels and prunes excess launches", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 1,
          afxDurationType: 0,
          missionId: "chicken-nine-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 7000,
                  targetAfxId: 10000,
                  items: [{ afxId: 1, afxLevel: 1, itemId: "puzzle-cube-1", counts: [1000, 0, 0, 0] }],
                },
              ],
            },
            {
              level: 1,
              targets: [
                {
                  totalDrops: 4000,
                  targetAfxId: 10000,
                  items: [{ afxId: 1, afxLevel: 1, itemId: "puzzle-cube-1", counts: [1000, 0, 0, 0] }],
                },
              ],
            },
          ],
        },
      ],
    });

    mockedSolveWithHighs.mockResolvedValue({
      Status: "Optimal",
      Columns: {
        m_0: { Primal: 1 },
      },
    });

    const profile = baseProfile();
    const shipLevels = computeShipLevelsFromLaunchCounts({
      CHICKEN_ONE: { SHORT: 1000 },
      CHICKEN_NINE: { SHORT: 3 },
    });
    profile.shipLevels = shipLevels;
    profile.missionOptions = buildMissionOptions(shipLevels, 0, 0).filter(
      (option) => option.ship === "CHICKEN_NINE" && option.durationType === "SHORT"
    );

    const result = await planForTarget(profile, "puzzle-cube-1", 5, 0.5, { fastMode: true });

    const totalLaunches = result.missions.reduce((sum, mission) => sum + mission.launches, 0);
    expect(totalLaunches).toBe(3);
    expect(result.targetBreakdown.fromMissionsExpected).toBe(5);
    expect(result.notes.some((note) => note.includes("progression-aware scaling pruned 2 repeated launches"))).toBe(true);
  });

  it("records no-yield lower-star progression launches instead of future-star rows during fast replay", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 1,
          afxDurationType: 0,
          missionId: "chicken-nine-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [],
                },
              ],
            },
            {
              level: 1,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [{ afxId: 1, afxLevel: 1, itemId: "puzzle-cube-1", counts: [5000, 0, 0, 0] }],
                },
              ],
            },
          ],
        },
      ],
    });

    mockedSolveWithHighs.mockResolvedValue({
      Status: "Optimal",
      Columns: {
        m_0: { Primal: 1 },
      },
    });

    const profile = baseProfile();
    const shipLevels = computeShipLevelsFromLaunchCounts({
      CHICKEN_ONE: { SHORT: 1000 },
      CHICKEN_NINE: { SHORT: 3 },
    });
    profile.shipLevels = shipLevels;
    profile.missionOptions = buildMissionOptions(shipLevels, 0, 0).filter(
      (option) => option.ship === "CHICKEN_NINE" && option.durationType === "SHORT"
    );

    const result = await planForTarget(profile, "puzzle-cube-1", 5, 0.5, { fastMode: true });

    const projectedChickenNine = result.progression.projectedShipLevels.find((ship) => ship.ship === "CHICKEN_NINE");
    expect(projectedChickenNine).not.toBeUndefined();
    expect(result.missions.every((mission) => mission.level <= (projectedChickenNine?.level || 0))).toBe(true);
  });

  it("uses a second integer pass to break ties by time in 100% GE mode", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    let solveCalls = 0;
    mockedSolveWithHighs.mockImplementation(async () => {
      solveCalls += 1;
      return {
        Status: "Optimal",
        Columns: {
          m_0: { Primal: solveCalls === 1 ? 10 : 2 },
        },
      };
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 2, 0);

    expect(solveCalls).toBe(2);
    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].launches).toBe(2);
    expect(
      result.notes.some((note) =>
        note.includes("GE-priority uses lexicographic integer solves per candidate")
      )
    ).toBe(true);
  });

  it("uses GE polish to reduce craft cost without increasing expected mission time", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 2,
                      itemId: "prophecy-stone-2",
                      counts: [4000, 0, 0, 0],
                    },
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "prophecy-stone-1",
                      counts: [60000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    let polishOptions: Record<string, string | number | boolean> | undefined;
    mockedSolveWithHighs.mockImplementation(async (model, options): Promise<HighsSolveResult> => {
      const isGePolish = model.includes("ts_0:");
      if (isGePolish) {
        polishOptions = options;
      }
      return {
        Status: "Optimal",
        Columns: isGePolish
          ? {
              m_0: { Primal: 3 },
            }
          : {
              m_0: { Primal: 2 },
              c_0: { Primal: 1 },
            },
      };
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "prophecy-stone-2", 2, 0.5);

    expect(result.geCost).toBe(0);
    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].launches).toBe(3);
    expect(polishOptions?.time_limit).toBe(20);
    expect(result.notes.some((note) => note.includes("GE polish reduced craft cost"))).toBe(true);
    expect(result.notes.some((note) => note.includes("MILP GE-polish"))).toBe(true);
  });

  it("falls back to greedy mission allocation when HiGHS is non-optimal", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    mockedSolveWithHighs.mockResolvedValue({
      Status: "Infeasible",
      Columns: {},
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 2, 0.5);
    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].launches).toBe(2);
    expect(result.notes.some((note) => note.includes("greedy fallback"))).toBe(true);
  });

  it("uses injected solverFn instead of default HiGHS when provided", async () => {
    const loot = {
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "test-short",
          levels: [
            {
              level: 0,
              targets: [
                {
                  totalDrops: 5000,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [5000, 0, 0, 0] as [number, number, number, number],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    let injectedSolverCalled = false;
    const injectedSolver = async (model: string, _options?: Record<string, string | number | boolean>): Promise<HighsSolveResult> => {
      injectedSolverCalled = true;
      void model;
      return {
        Status: "Optimal",
        Columns: {
          m_0: { Primal: 3 },
        },
      };
    };

    // Do NOT set up the mocked defaults — if the injected solver is used,
    // the mocked loadLootData/solveWithHighs should never be called.
    mockedLoadLootData.mockRejectedValue(new Error("should not be called"));
    mockedSolveWithHighs.mockRejectedValue(new Error("should not be called"));

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "CHICKEN_ONE",
        missionId: "test-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 1200,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 3, 0.5, {
      solverFn: injectedSolver,
      lootData: loot,
    });
    expect(injectedSolverCalled).toBe(true);
    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].launches).toBe(3);
    expect(result.targetBreakdown.requested).toBe(3);
  });

  it("uses Path of Virtue fuel objective with a nonzero time floor", async () => {
    const models: string[] = [];
    mockedLoadLootData.mockResolvedValue({
      missions: [
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "bcr-short",
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
        },
        {
          afxShip: 0,
          afxDurationType: 0,
          missionId: "henliner-short",
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
        },
      ],
    });
    mockedSolveWithHighs.mockImplementation(async (model: string): Promise<HighsSolveResult> => {
      models.push(model);
      return {
        Status: "Optimal",
        Columns: { m_0: { Primal: 1 } },
      };
    });

    const profile = baseProfile();
    profile.missionOptions = [
      {
        ship: "BCR",
        missionId: "bcr-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 300_000,
        capacity: 1,
      },
      {
        ship: "ATREGGIES",
        missionId: "henliner-short",
        durationType: "SHORT",
        level: 0,
        durationSeconds: 300,
        capacity: 1,
      },
    ];

    const result = await planForTarget(profile, "puzzle-cube-1", 1, 0, {
      objectiveMode: "virtueFuel",
      disableFastQuantityAcceleration: true,
    });

    const objectiveModel = models.find((model) => model.includes(" m_0") && model.includes(" m_1"));
    expect(objectiveModel).toBeTruthy();
    const objectiveLine = objectiveModel!
      .split("\n")
      .find((line) => line.trim().startsWith("obj:"));
    expect(objectiveLine).toBeTruthy();

    const coeffFor = (variable: string): number => {
      const match = objectiveLine!.match(new RegExp(`([0-9.]+)\\s+${variable}\\b`));
      return match ? Number(match[1]) : Number.NaN;
    };
    const bcrCoeff = coeffFor("m_0");
    const henlinerCoeff = coeffFor("m_1");

    expect(result.objectiveMode).toBe("virtueFuel");
    expect(result.fuelCost).toBe(10_000_000);
    expect(bcrCoeff).toBeGreaterThan(100);
    expect(henlinerCoeff).toBeGreaterThan(bcrCoeff * 1000);
  });
});
