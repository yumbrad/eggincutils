import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerProfile } from "./profile";

vi.mock("./loot-data", () => ({
  loadLootData: vi.fn(),
}));

import { loadLootData } from "./loot-data";
import { MissionCoverageError, missionDurationLabel, planForTarget, summarizeCraftRows } from "./planner";

const mockedLoadLootData = vi.mocked(loadLootData);

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
  });

  it("throws MissionCoverageError when required items have no mission coverage", async () => {
    mockedLoadLootData.mockResolvedValue({
      missions: [],
    });

    await expect(planForTarget(baseProfile(), "puzzle-cube-1", 1, 0.5)).rejects.toBeInstanceOf(MissionCoverageError);
  });
});
