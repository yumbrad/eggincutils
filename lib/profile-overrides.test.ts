import { describe, expect, it } from "vitest";

import { getCraftingLevelTotalXpForLevel } from "./crafting-levels";
import {
  applyProfileOverrides,
  normalizeProfileOverrides,
  profileOverrideCount,
  profileOverridesKey,
} from "./profile-overrides";
import {
  buildMissionOptions,
  computeShipLevelsFromLaunchCounts,
  shipLevelsToLaunchCounts,
  withShipStars,
} from "./ship-data";

const level = (levels: Array<{ ship: string; level: number; unlocked: boolean }>, ship: string) =>
  levels.find((entry) => entry.ship === ship)!;

describe("withShipStars", () => {
  it("sets a ship's stars and unlocks it, staying consistent with its launch counts", () => {
    const base = computeShipLevelsFromLaunchCounts({});
    const { shipLevels, effective } = withShipStars(base, { CHICKEN_HEAVY: 2 });
    expect(level(shipLevels, "CHICKEN_HEAVY")).toMatchObject({ unlocked: true, level: 2 });
    expect(effective).toEqual({ CHICKEN_HEAVY: 2 });
    // Replaying the launch counts (as pre-plan sends do) keeps the stars.
    const replayed = computeShipLevelsFromLaunchCounts(shipLevelsToLaunchCounts(shipLevels));
    expect(level(replayed, "CHICKEN_HEAVY")).toMatchObject({ unlocked: true, level: 2 });
  });

  it("keeps the launches that unlock the next ship, so 0 stars can stay above 0", () => {
    // Chicken Nine needs 6 launches to unlock the Heavy, and 6 points is 1 star.
    const base = computeShipLevelsFromLaunchCounts({
      CHICKEN_ONE: { SHORT: 10 },
      CHICKEN_NINE: { SHORT: 20 },
      CHICKEN_HEAVY: { SHORT: 2 },
    });
    const { shipLevels, effective } = withShipStars(base, { CHICKEN_NINE: 0 });
    expect(effective.CHICKEN_NINE).toBe(1);
    expect(level(shipLevels, "CHICKEN_HEAVY").unlocked).toBe(true);
  });

  it("leaves other ships alone", () => {
    const base = computeShipLevelsFromLaunchCounts({ CHICKEN_ONE: { SHORT: 10 } });
    const { shipLevels } = withShipStars(base, {});
    expect(shipLevels).toBe(base);
  });
});

describe("profile overrides", () => {
  const profile = () => {
    const shipLevels = computeShipLevelsFromLaunchCounts({});
    return {
      craftingXp: 0,
      epicResearchFTLLevel: 0,
      epicResearchZerogLevel: 0,
      shipLevels,
      missionOptions: buildMissionOptions(shipLevels, 0, 0),
      inFlightMissions: [{}, {}],
    };
  };

  it("applies research, crafting level, stars and the in-air toggle", () => {
    const applied = applyProfileOverrides(profile(), {
      epicResearchFTLLevel: 40,
      epicResearchZerogLevel: 5,
      craftingLevel: 20,
      shipStars: { CHICKEN_HEAVY: 1 },
      ignoreInFlight: true,
    });
    expect(applied.epicResearchFTLLevel).toBe(40);
    expect(applied.epicResearchZerogLevel).toBe(5);
    expect(applied.craftingXp).toBe(getCraftingLevelTotalXpForLevel(20));
    expect(level(applied.shipLevels, "CHICKEN_HEAVY").level).toBe(1);
    expect(applied.missionOptions.some((option) => option.ship === "CHICKEN_HEAVY")).toBe(true);
    expect(applied.inFlightMissions).toEqual([]);
  });

  it("returns the same profile with nothing set", () => {
    const base = profile();
    expect(applyProfileOverrides(base, {})).toBe(base);
  });

  it("normalizes stored values and counts them", () => {
    const overrides = normalizeProfileOverrides({
      epicResearchFTLLevel: 99,
      epicResearchZerogLevel: "",
      craftingLevel: 0,
      shipStars: { CHICKEN_HEAVY: 9, NOT_A_SHIP: 2 },
      ignoreInFlight: "yes",
    });
    expect(overrides).toEqual({ epicResearchFTLLevel: 60, craftingLevel: 1, shipStars: { CHICKEN_HEAVY: 3 } });
    expect(profileOverrideCount(overrides)).toBe(3);
    expect(profileOverridesKey("  ")).toBe("DEMO");
  });
});
