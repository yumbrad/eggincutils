import { describe, expect, it } from "vitest";

import type { PlayerProfile } from "./profile";
import { applyReplanUpdates } from "./replan";
import { buildMissionOptions, computeShipLevelsFromLaunchCounts } from "./ship-data";

function baseProfile(): PlayerProfile {
  const shipLevels = computeShipLevelsFromLaunchCounts({
    CHICKEN_ONE: {
      SHORT: 3,
    },
  });
  return {
    eid: "EI_TEST",
    inventory: {
      puzzle_cube_1: 1,
    },
    craftCounts: {},
    epicResearchFTLLevel: 0,
    epicResearchZerogLevel: 0,
    shipLevels,
    missionOptions: buildMissionOptions(shipLevels, 0, 0),
  };
}

describe("applyReplanUpdates", () => {
  it("adds observed returns into inventory", () => {
    const profile = baseProfile();
    const updated = applyReplanUpdates(profile, {
      observedReturns: [
        { itemId: "puzzle-cube-1", quantity: 4 },
        { itemId: "soul-stone-2", quantity: 2 },
      ],
    });

    expect(updated.inventory.puzzle_cube_1).toBe(5);
    expect(updated.inventory.soul_stone_2).toBe(2);
  });

  it("applies mission launches and rebuilds ship levels/options", () => {
    const profile = baseProfile();
    const chickenNineBefore = profile.shipLevels.find((entry) => entry.ship === "CHICKEN_NINE");
    expect(chickenNineBefore?.unlocked).toBe(false);

    const updated = applyReplanUpdates(profile, {
      missionLaunches: [
        {
          ship: "CHICKEN_ONE",
          durationType: "SHORT",
          launches: 1,
        },
      ],
    });

    const chickenOneAfter = updated.shipLevels.find((entry) => entry.ship === "CHICKEN_ONE");
    const chickenNineAfter = updated.shipLevels.find((entry) => entry.ship === "CHICKEN_NINE");
    expect(chickenOneAfter?.launches).toBe(4);
    expect(chickenNineAfter?.unlocked).toBe(true);
    expect(updated.missionOptions.some((option) => option.ship === "CHICKEN_NINE")).toBe(true);
  });
});
