import { describe, expect, it } from "vitest";

import { projectInFlightMissions } from "./in-flight";
import type { LootJson } from "./loot-data";
import { parseInFlightMissions, type InFlightMission } from "./profile";

const RARITIES = { rare: false, epic: false, legendary: false };

// One Henerprise extended level-7 mission, targeting Quantum Metronome (afxId 24).
function lootData(): LootJson {
  return {
    missions: [
      {
        afxShip: 9,
        afxDurationType: 2,
        missionId: "henerprise-extended",
        levels: [
          {
            level: 7,
            targets: [
              {
                targetAfxId: 24,
                totalDrops: 100_000,
                items: [{ afxId: 24, afxLevel: 1, itemId: "quantum-metronome-1", counts: [50_000, 0, 0, 0] }],
              },
              {
                targetAfxId: 10000,
                totalDrops: 100_000,
                items: [{ afxId: 0, afxLevel: 1, itemId: "lunar-totem-1", counts: [20_000, 0, 0, 0] }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function mission(overrides: Partial<InFlightMission> = {}): InFlightMission {
  return {
    ship: "HENERPRISE",
    durationType: "EPIC",
    status: "EXPLORING",
    level: 7,
    capacity: 24,
    targetAfxId: 24,
    secondsRemaining: 3600,
    ...overrides,
  };
}

describe("projectInFlightMissions", () => {
  it("projects drops the player is owed and groups identical missions into one row", async () => {
    const result = await projectInFlightMissions(
      [
        mission({ secondsRemaining: 3600 }),
        mission({ secondsRemaining: 7200 }),
        mission({ secondsRemaining: 1800 }),
      ],
      { lootData: lootData(), includeRarities: RARITIES, includeStoneFragments: true }
    );

    expect(result.missionCount).toBe(3);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].launches).toBe(3);
    // 50% drop rate * capacity 24 * 3 launches.
    expect(result.yields.quantum_metronome_1).toBeCloseTo(36, 6);
    expect(result.rows[0].expectedYields[0]).toEqual({ itemId: "quantum-metronome-1", quantity: 36 });
    // The row waits on its slowest mission, but each launch keeps its own wait
    // so scheduling knows when each slot actually frees up.
    expect(result.rows[0].secondsRemaining).toBe(7200);
    expect(result.rows[0].launchSecondsRemaining).toEqual([7200, 3600, 1800]);
    expect(result.secondsRemaining).toBe(7200);
  });

  it("treats a mission sent without a target as untargeted rather than afxId 0", async () => {
    const result = await projectInFlightMissions([mission({ targetAfxId: null })], {
      lootData: lootData(),
      includeRarities: RARITIES,
      includeStoneFragments: true,
    });

    expect(result.rows[0].targetAfxId).toBe(10000);
    expect(result.yields.lunar_totem_1).toBeCloseTo(4.8, 6);
    expect(result.yields.quantum_metronome_1).toBeUndefined();
  });

  it("still counts the slot time when the target has no usable drop sample", async () => {
    const sparse = lootData();
    sparse.missions[0].levels[0].targets[0].totalDrops = 10;
    sparse.missions[0].levels[0].targets[0].items[0].counts = [5, 0, 0, 0];

    const result = await projectInFlightMissions([mission()], {
      lootData: sparse,
      includeRarities: RARITIES,
      includeStoneFragments: true,
    });

    expect(result.yields).toEqual({});
    expect(result.rows).toHaveLength(1);
    expect(result.secondsRemaining).toBe(3600);
  });

  it("returns an empty projection when nothing is outstanding", async () => {
    const result = await projectInFlightMissions([], {
      lootData: lootData(),
      includeRarities: RARITIES,
      includeStoneFragments: true,
    });

    expect(result).toEqual({ yields: {}, rows: [], secondsRemaining: 0, missionCount: 0 });
  });
});

describe("parseInFlightMissions", () => {
  const afxIds = { QUANTUM_METRONOME: 24, LUNAR_TOTEM: 0 };

  it("keeps launched-but-uncollected missions and drops the rest", () => {
    const parsed = parseInFlightMissions(
      [
        { ship: "HENERPRISE", durationType: "EPIC", status: "EXPLORING" },
        { ship: "HENERPRISE", durationType: "EPIC", status: "RETURNED" },
        { ship: "HENERPRISE", durationType: "EPIC", status: "ANALYZING" },
        { ship: "HENERPRISE", durationType: "EPIC", status: "FUELING" },
        { ship: "HENERPRISE", durationType: "EPIC", status: "ARCHIVED" },
      ],
      afxIds
    );

    expect(parsed.map((entry) => entry.status)).toEqual(["EXPLORING", "RETURNED", "ANALYZING"]);
  });

  it("keeps only the requested farm's missions, since both share one list", () => {
    const items = [
      { ship: "HENERPRISE", durationType: "EPIC", status: "EXPLORING", capacity: 1 },
      { ship: "HENERPRISE", durationType: "EPIC", status: "EXPLORING", type: "STANDARD", capacity: 2 },
      { ship: "HENERPRISE", durationType: "EPIC", status: "EXPLORING", type: "VIRTUE", capacity: 3 },
    ];

    // An absent type is the proto's zero value, so it belongs to the main farm.
    expect(parseInFlightMissions(items, afxIds, "main").map((entry) => entry.capacity)).toEqual([1, 2]);
    expect(parseInFlightMissions(items, afxIds, "virtue").map((entry) => entry.capacity)).toEqual([3]);
    expect(parseInFlightMissions(items, afxIds).map((entry) => entry.capacity)).toEqual([1, 2]);
  });

  describe("remaining time", () => {
    const NOW = 1_700_000_000;
    const base = { ship: "HENERPRISE", durationType: "EPIC", status: "EXPLORING" as const };

    function remaining(item: Record<string, unknown>, backupApproxTimeSeconds = 0): number {
      return parseInFlightMissions([{ ...base, ...item }], afxIds, "main", {
        nowSeconds: NOW,
        backupApproxTimeSeconds,
      })[0].secondsRemaining;
    }

    it("measures from the launch timestamp, not the stale client snapshot", () => {
      // Launched 3h ago on a 4h mission, but the client last synced when it had
      // 4h to go. The honest answer is 1h, not the snapshot's 4h.
      expect(
        remaining({
          startTimeDerived: NOW - 3 * 3600,
          durationSeconds: 4 * 3600,
          secondsRemaining: 4 * 3600,
        })
      ).toBe(3600);
    });

    it("reports a mission whose return time has passed as landed", () => {
      expect(
        remaining({ startTimeDerived: NOW - 10 * 3600, durationSeconds: 4 * 3600, secondsRemaining: 4 * 3600 })
      ).toBe(0);
    });

    it("ages the snapshot by the backup's own timestamp when no launch time exists", () => {
      // Snapshot said 4h left, but the backup itself is 3h old.
      expect(remaining({ secondsRemaining: 4 * 3600 }, NOW - 3 * 3600)).toBe(3600);
      // Never ages past zero.
      expect(remaining({ secondsRemaining: 4 * 3600 }, NOW - 30 * 3600)).toBe(0);
    });

    it("uses the snapshot as-is when there is nothing to date it against", () => {
      expect(remaining({ secondsRemaining: 4 * 3600 })).toBe(4 * 3600);
    });
  });

  it("reads a set target and leaves an absent one null", () => {
    const parsed = parseInFlightMissions(
      [
        {
          ship: "HENERPRISE",
          durationType: "EPIC",
          status: "EXPLORING",
          targetArtifact: "QUANTUM_METRONOME",
          level: 7,
          capacity: 24,
          secondsRemaining: 1234.6,
        },
        { ship: "HENERPRISE", durationType: "EPIC", status: "EXPLORING" },
      ],
      afxIds
    );

    expect(parsed[0]).toEqual({
      ship: "HENERPRISE",
      durationType: "EPIC",
      status: "EXPLORING",
      level: 7,
      capacity: 24,
      targetAfxId: 24,
      secondsRemaining: 1235,
    });
    expect(parsed[1].targetAfxId).toBeNull();
  });
});
