import { describe, expect, it } from "vitest";

import { getCraftingLevelTotalXpForLevel } from "./crafting-levels";
import type { LootJson } from "./loot-data";
import {
  craftChanceExactly,
  craftChanceOrBetter,
  craftingRarityMult,
  craftsForShinyChance,
  expectedShinyDrops,
  itemIdTakesShinyGoal,
  resolveShinyGoalTargets,
  shinyOddsForPlan,
  shinyRaritiesFor,
} from "./shiny-odds";
import { getNominalMissionCapacity } from "./ship-data";

const MAX_LEVEL_XP = getCraftingLevelTotalXpForLevel(30);

describe("shiny rarities", () => {
  it("lists the rarities a tier comes in", () => {
    expect(shinyRaritiesFor("interstellar_compass_4")).toEqual(["rare", "epic", "legendary"]);
    expect(shinyRaritiesFor("tungsten_ankh_3")).toEqual(["rare", "legendary"]);
    expect(shinyRaritiesFor("soul_stone_2")).toEqual([]);
  });

  it("takes shiny goals only on craftable artifacts with shiny rarities", () => {
    expect(itemIdTakesShinyGoal("interstellar-compass-4")).toBe(true);
    expect(itemIdTakesShinyGoal("interstellar-compass-1")).toBe(false);
    expect(itemIdTakesShinyGoal("soul-stone-2")).toBe(false);
  });
});

describe("craftChanceOrBetter", () => {
  it("follows the game's formula", () => {
    // T4 compass legendary: common 0.45 / legendary 0.00045 = 1000.
    expect(craftChanceOrBetter("interstellar_compass_4", "legendary", 1, 0)).toBeCloseTo(0.001, 6);
    expect(craftChanceOrBetter("interstellar_compass_4", "legendary", 1, 400)).toBeCloseTo(0.001 ** 0.7, 6);
    expect(craftChanceOrBetter("interstellar_compass_4", "legendary", 10, 0)).toBeCloseTo(0.01, 6);
    // Rate never drops under 10, so no rarity beats 10% a craft.
    expect(craftChanceOrBetter("interstellar_compass_4", "rare", 10, 400)).toBeCloseTo(0.1, 6);
    expect(craftingRarityMult(1)).toBe(1);
    expect(craftingRarityMult(30)).toBe(10);
  });

  it("leaves exactly-rare nothing once epic also reaches the cap", () => {
    expect(craftChanceOrBetter("interstellar_compass_4", "epic", 10, 400)).toBeCloseTo(0.1, 6);
    expect(craftChanceExactly("interstellar_compass_4", "rare", 10, 400)).toBeCloseTo(0, 6);
    expect(craftChanceExactly("interstellar_compass_4", "rare", 1, 0)).toBeGreaterThan(0);
  });
});

describe("craftsForShinyChance", () => {
  it("finds the fewest crafts at a steady chance", () => {
    // Max level and 400+ crafts: every craft has the same chance.
    const chance = 0.01 ** 0.7;
    const expected = Math.ceil(Math.log(0.5) / Math.log(1 - chance));
    const result = craftsForShinyChance({
      itemKey: "interstellar_compass_4",
      rarity: "legendary",
      targetChance: 0.5,
      craftedBefore: 400,
      craftingXp: MAX_LEVEL_XP,
    });
    expect(result.crafts).toBe(expected);
    expect(result.reached).toBe(true);
    expect(result.chance).toBeGreaterThanOrEqual(0.5);
  });

  it("counts the craft count rising during the crafts", () => {
    // From 0 crafts, μ grows with every craft, so later crafts are likelier.
    const result = craftsForShinyChance({
      itemKey: "interstellar_compass_4",
      rarity: "legendary",
      targetChance: 0.3,
      craftedBefore: 0,
      craftingXp: MAX_LEVEL_XP,
    });
    expect(result.lastChance).toBeGreaterThan(result.firstChance);
    expect(result.chance).toBeGreaterThanOrEqual(0.3);
  });
});

describe("resolveShinyGoalTargets", () => {
  it("turns shiny goals into craft-count goals and passes the rest through", () => {
    const { targets, shinyGoals } = resolveShinyGoalTargets(
      [
        { targetItemId: "soul-stone-2", quantity: 3 },
        { targetItemId: "interstellar-compass-4", quantity: 50, shinyRarity: "legendary" as const },
      ],
      { craftCounts: { interstellar_compass_4: 400 }, craftingXp: MAX_LEVEL_XP }
    );
    const crafts = Math.ceil(Math.log(0.5) / Math.log(1 - 0.01 ** 0.7));
    expect(targets).toEqual([
      { targetItemId: "soul-stone-2", quantity: 3 },
      { targetItemId: "interstellar-compass-4", quantity: 400 + crafts, craftGoal: true },
    ]);
    expect(shinyGoals).toEqual([
      {
        itemId: "interstellar-compass-4",
        rarity: "legendary",
        targetChance: 0.5,
        craftedBefore: 400,
        crafts,
        reached: true,
      },
    ]);
  });
});

function lootWith(counts: [number, number, number, number]): LootJson {
  const capacity = getNominalMissionCapacity("HENERPRISE", "EPIC", 0) || 1;
  return {
    missions: [
      {
        afxShip: 0,
        afxDurationType: 0,
        missionId: "henerprise-extended",
        levels: [
          {
            level: 0,
            targets: [
              {
                targetAfxId: 10000,
                totalDrops: capacity * 1000,
                items: [{ afxId: 0, afxLevel: 3, itemId: "interstellar-compass-4", counts }],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("expectedShinyDrops", () => {
  const mission = {
    missionId: "henerprise-extended",
    ship: "HENERPRISE",
    durationType: "EPIC",
    level: 0,
    targetAfxId: 10000,
    launches: 10,
  };

  it("counts drops of the rarity or better per launch", () => {
    // 1,000 launches' worth of drops held 30 epic and 20 legendary compasses.
    const drops = expectedShinyDrops({
      itemKey: "interstellar_compass_4",
      rarity: "epic",
      missions: [mission],
      loot: lootWith([500, 40, 30, 20]),
      zerogLevel: 0,
    });
    expect(drops.total).toBeCloseTo((50 / 1000) * 10, 6);
  });

  it("ignores legendary counts too small to trust", () => {
    const drops = expectedShinyDrops({
      itemKey: "interstellar_compass_4",
      rarity: "legendary",
      missions: [mission],
      loot: lootWith([500, 40, 30, 4]),
      zerogLevel: 0,
    });
    expect(drops.total).toBe(0);
  });
});

describe("shinyOddsForPlan", () => {
  it("combines planned crafts with expected drops", () => {
    const odds = shinyOddsForPlan({
      itemKey: "interstellar_compass_4",
      craftedBefore: 400,
      craftingXp: MAX_LEVEL_XP,
      plannedCrafts: { interstellar_compass_4: 10 },
      missions: [],
      loot: null,
      zerogLevel: 0,
    });
    expect(odds.map((entry) => entry.rarity)).toEqual(["rare", "epic", "legendary"]);
    const legendary = odds.find((entry) => entry.rarity === "legendary")!;
    expect(legendary.chance).toBeCloseTo(1 - (1 - 0.01 ** 0.7) ** 10, 6);
    expect(legendary.crafts.crafts).toBe(10);
    // Rare and epic are both capped here, so an exactly-rare craft can't happen.
    expect(odds.find((entry) => entry.rarity === "rare")!.lastExactChance).toBeCloseTo(0, 6);
  });
});
