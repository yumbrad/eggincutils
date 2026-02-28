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
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [1, 0, 0, 0],
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
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [1, 0, 0, 0],
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
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [1, 0, 0, 0],
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
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [1, 0, 0, 0],
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
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [1, 0, 0, 0],
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
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [1, 0, 0, 0],
                    },
                  ],
                },
              ],
            },
            {
              level: 1,
              targets: [
                {
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [2, 0, 0, 0],
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
      if (model.includes("r_0:")) {
        return {
          Status: "Optimal",
          Columns: {
            m_0: { Primal: 1 },
          },
        };
      }
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
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [1, 0, 0, 0],
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
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [1, 0, 0, 0],
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

    const result = await planForTarget(profile, "puzzle-cube-1", 10, 1);
    expect(result.progression.prepLaunches.length).toBeGreaterThan(0);
    expect(result.progression.prepLaunches.some((step) => step.reason.includes("Unlock CHICKEN_NINE"))).toBe(true);
    expect(result.missions.some((mission) => mission.ship === "CHICKEN_NINE")).toBe(true);
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
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [1, 0, 0, 0],
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
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [1, 0, 0, 0],
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
                  totalDrops: 1,
                  targetAfxId: 10000,
                  items: [
                    {
                      afxId: 1,
                      afxLevel: 1,
                      itemId: "puzzle-cube-1",
                      counts: [1, 0, 0, 0] as [number, number, number, number],
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
});
