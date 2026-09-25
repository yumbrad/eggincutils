import { describe, expect, it } from "vitest";

import { playerProfileSchema } from "./api-schemas";
import { createDemoProfile } from "./demo-profile";
import {
  countShinyIngredients,
  craftCountsForSource,
  formatSpecName,
  inventoryItemsForSource,
  parseCraftCounts,
  parseInventory,
  parseMissions,
  parseVirtueTank,
} from "./profile";

describe("formatSpecName", () => {
  it("normalizes stone fragments, stones, and regular artifacts", () => {
    expect(formatSpecName({ name: "SOUL_STONE_FRAGMENT", level: "LESSER" })).toBe("soul_stone_2");
    expect(formatSpecName({ name: "TACHYON_STONE", level: "INFERIOR" })).toBe("tachyon_stone_2");
    expect(formatSpecName({ name: "LIGHT_OF_EGGENDIL", level: 2 })).toBe("light_of_eggendil_3");
  });

  it("returns null for invalid/unknown specs", () => {
    expect(formatSpecName({ name: "UNKNOWN", level: "NORMAL" })).toBeNull();
    expect(formatSpecName({ name: "SHELL_STONE", level: "NOT_A_LEVEL" as unknown as string })).toBeNull();
    expect(formatSpecName({})).toBeNull();
  });
});

describe("parseInventory", () => {
  it("optionally includes slotted stones and uses fallback quantity for empty stacks", () => {
    const items = [
      {
        artifact: {
          spec: { name: "SOUL_STONE", level: "INFERIOR" },
          stones: [{ name: "TACHYON_STONE", level: "LESSER" }],
        },
        quantity: 2,
      },
      {
        artifact: {
          spec: { name: "LIGHT_OF_EGGENDIL", level: "GREATER" },
          stones: [{ name: "TERRA_STONE_FRAGMENT", level: "NORMAL" }],
        },
        quantity: 0,
      },
    ];

    const withSlotted = parseInventory(items, true);
    const withoutSlotted = parseInventory(items, false);

    expect(withSlotted.soul_stone_2).toBe(2);
    expect(withSlotted.tachyon_stone_3).toBe(2);
    expect(withSlotted.terra_stone_3).toBe(1);
    expect(withSlotted.light_of_eggendil_4).toBeUndefined();

    expect(withoutSlotted.soul_stone_2).toBe(2);
    expect(withoutSlotted.tachyon_stone_3).toBeUndefined();
    expect(withoutSlotted.terra_stone_3).toBeUndefined();
  });

  it("can exclude shiny artifacts from craftable inventory counts", () => {
    const items = [
      {
        artifact: {
          spec: { name: "SOUL_STONE", level: "INFERIOR", rarity: "RARE" },
          stones: [{ name: "TACHYON_STONE", level: "LESSER" }],
        },
        quantity: 2,
      },
      {
        artifact: {
          spec: { name: "LIGHT_OF_EGGENDIL", level: "GREATER", rarity: "LEGENDARY" },
          stones: [{ name: "TERRA_STONE_FRAGMENT", level: "NORMAL" }],
        },
        quantity: 1,
      },
      {
        artifact: {
          spec: { name: "PUZZLE_CUBE", level: "NORMAL", rarity: "COMMON" },
          stones: [],
        },
        quantity: 3,
      },
    ];

    const inventory = parseInventory(items, true, false);

    expect(inventory.soul_stone_2).toBeUndefined();
    expect(inventory.light_of_eggendil_4).toBeUndefined();
    expect(inventory.puzzle_cube_3).toBe(3);
    expect(inventory.tachyon_stone_3).toBe(2);
    expect(inventory.terra_stone_3).toBe(1);
  });

  it("can include only selected shiny tiers", () => {
    const items = [
      {
        artifact: {
          spec: { name: "SOUL_STONE", level: "INFERIOR", rarity: "RARE" },
        },
        quantity: 2,
      },
      {
        artifact: {
          spec: { name: "LIGHT_OF_EGGENDIL", level: "GREATER", rarity: "EPIC" },
        },
        quantity: 1,
      },
      {
        artifact: {
          spec: { name: "PUZZLE_CUBE", level: "NORMAL", rarity: "LEGENDARY" },
        },
        quantity: 3,
      },
    ];

    const inventory = parseInventory(items, true, {
      rare: true,
      epic: false,
      legendary: false,
    });

    expect(inventory.soul_stone_2).toBe(2);
    expect(inventory.light_of_eggendil_4).toBeUndefined();
    expect(inventory.puzzle_cube_3).toBeUndefined();
  });

  it("excludes slotted shiny artifacts when slotted sources are disabled", () => {
    const items = [
      {
        artifact: {
          spec: { name: "SOUL_STONE", level: "INFERIOR", rarity: "RARE" },
          stones: [{ name: "TACHYON_STONE", level: "LESSER" }],
        },
        quantity: 2,
      },
      {
        artifact: {
          spec: { name: "PUZZLE_CUBE", level: "NORMAL", rarity: "RARE" },
          stones: [],
        },
        quantity: 3,
      },
    ];

    const inventory = parseInventory(items, false, {
      rare: true,
      epic: false,
      legendary: false,
    });

    expect(inventory.soul_stone_2).toBeUndefined();
    expect(inventory.tachyon_stone_3).toBeUndefined();
    expect(inventory.puzzle_cube_3).toBe(3);
  });
});

describe("parseCraftCounts and parseMissions", () => {
  it("parses craft counts and filters incomplete mission records", () => {
    const craftCounts = parseCraftCounts([
      { spec: { name: "GUSSET", level: "LESSER" }, count: 9 },
      { spec: { name: "UNKNOWN", level: "NORMAL" }, count: 4 },
    ]);

    const missions = parseMissions([
      { ship: "CHICKEN_ONE", durationType: "SHORT", status: "RETURNED" },
      { ship: "CHICKEN_ONE", durationType: "SHORT" },
      { ship: "CHICKEN_ONE", status: "RETURNED" },
    ]);

    expect(craftCounts).toEqual({ gusset_2: 9 });
    expect(missions).toEqual([{ ship: "CHICKEN_ONE", durationType: "SHORT", status: "RETURNED" }]);
  });
});

describe("inventoryItemsForSource", () => {
  it("selects the requested inventory pool", () => {
    const mainItems = [{ quantity: 1 }];
    const virtueItems = [{ quantity: 2 }];

    expect(
      inventoryItemsForSource(
        {
          inventoryItems: mainItems,
          virtueAfxDb: {
            inventoryItems: virtueItems,
          },
        },
        "main"
      )
    ).toBe(mainItems);
    expect(
      inventoryItemsForSource(
        {
          inventoryItems: mainItems,
          virtueAfxDb: {
            inventoryItems: virtueItems,
          },
        },
        "virtue"
      )
    ).toBe(virtueItems);
    expect(inventoryItemsForSource(undefined, "virtue")).toEqual([]);
  });
});

describe("countShinyIngredients", () => {
  it("counts only shiny artifacts that pass the rarity and slotted rules", () => {
    const items = [
      { artifact: { spec: { name: "SOUL_STONE", level: "INFERIOR" }, stones: [] }, quantity: 5 },
      { artifact: { spec: { name: "LIGHT_OF_EGGENDIL", level: "GREATER", rarity: "RARE" }, stones: [] }, quantity: 2 },
      {
        artifact: {
          spec: { name: "LIGHT_OF_EGGENDIL", level: "GREATER", rarity: "RARE" },
          stones: [{ name: "TACHYON_STONE", level: "LESSER" }],
        },
        quantity: 1,
      },
      { artifact: { spec: { name: "LIGHT_OF_EGGENDIL", level: "GREATER", rarity: "EPIC" }, stones: [] }, quantity: 3 },
    ];

    expect(countShinyIngredients(items, true, false)).toBe(0);
    expect(countShinyIngredients(items, true, { rare: true, epic: false, legendary: false })).toBe(3);
    expect(countShinyIngredients(items, false, { rare: true, epic: false, legendary: false })).toBe(2);
    expect(countShinyIngredients(items, true, true)).toBe(6);
  });
});

describe("craftCountsForSource", () => {
  const mainStatus = [
    { spec: { name: "PUZZLE_CUBE", level: "NORMAL" }, count: 40 },
    { spec: { name: "LUNAR_TOTEM", level: "INFERIOR" }, count: 7 },
  ];

  it("reads only the main counts in main mode", () => {
    const artifactsDb = {
      artifactStatus: mainStatus,
      virtueAfxDb: { artifactStatus: [{ spec: { name: "PUZZLE_CUBE", level: "NORMAL" }, count: 3 }] },
    };

    expect(craftCountsForSource(artifactsDb, "main")).toEqual({ puzzle_cube_3: 40, lunar_totem_1: 7 });
    expect(craftCountsForSource(undefined, "main")).toEqual({});
  });

  it("adds the virtue DB's counts on top of the main counts in virtue mode", () => {
    const artifactsDb = {
      artifactStatus: mainStatus,
      virtueAfxDb: {
        artifactStatus: [
          { spec: { name: "PUZZLE_CUBE", level: "NORMAL" }, count: 3 },
          { spec: { name: "DEMETERS_NECKLACE", level: "INFERIOR" }, count: 2 },
        ],
      },
    };

    expect(craftCountsForSource(artifactsDb, "virtue")).toEqual({
      puzzle_cube_3: 43,
      lunar_totem_1: 7,
      demeters_necklace_1: 2,
    });
  });

  it("keeps the main counts when the virtue DB's are all zero or missing, as in real backups", () => {
    const zeroed = mainStatus.map((item) => ({ ...item, count: 0 }));

    expect(craftCountsForSource({ artifactStatus: mainStatus, virtueAfxDb: { artifactStatus: zeroed } }, "virtue")).toEqual({
      puzzle_cube_3: 40,
      lunar_totem_1: 7,
    });
    expect(craftCountsForSource({ artifactStatus: mainStatus }, "virtue")).toEqual({ puzzle_cube_3: 40, lunar_totem_1: 7 });
    expect(craftCountsForSource(undefined, "virtue")).toEqual({});
  });
});

describe("parseVirtueTank", () => {
  // Shaped like a `defaults: true` decode: `virtue.afx.tankLevel` is present
  // but always 0, main-farm eggs fill the low tank indices, and the virtue
  // eggs carry the float noise real backups have.
  function tankFuels(): number[] {
    const values = Array.from({ length: 25 }, (_, index) => (index + 1) * 1e9);
    values[20] = 108679621351103.19;
    values[21] = 41969910000001.086;
    values[22] = 59999500000000.6;
    values[23] = 0;
    values[24] = 190000000000001.9;
    return values;
  }

  function tankLimits(): number[] {
    const values = new Array(25).fill(1);
    values[20] = 0.5;
    values[21] = 0.12000000000000001;
    values[22] = 0.12;
    values[23] = 1;
    values[24] = 0.38;
    return values;
  }

  // As in real backups, the virtue egg sits on the home farm (`farms[0]`), and
  // `currentFarm` points at a contract farm the player was looking at.
  function backup() {
    return {
      approxTime: 1788898324,
      artifacts: { tankLevel: 7, tankFuels: new Array(25).fill(0) },
      virtue: {
        shiftCount: 21,
        afx: { tankLevel: 0, tankFuels: tankFuels(), tankLimits: tankLimits(), tankFillingEnabled: true },
      },
      game: { soulEggsD: 1.05e21, currentFarm: 1 },
      farms: [
        { eggType: "HUMILITY", farmType: "HOME" },
        { eggType: "CUSTOM_EGG", farmType: "CONTRACT" },
        { eggType: "IMMORTALITY", farmType: "CONTRACT" },
      ],
    };
  }

  it("reads the virtue eggs and sizes the tank from artifacts.tankLevel", () => {
    const tank = parseVirtueTank(backup());

    expect(tank).toBeDefined();
    expect(tank?.tankLevel).toBe(7);
    expect(tank?.capacity).toBe(500e12);
    expect(tank?.fuels.curiosity).toBeCloseTo(108.68e12, -10);
    expect(tank?.fuels.integrity).toBeCloseTo(41.97e12, -10);
    expect(tank?.fuels.humility).toBeCloseTo(60e12, -10);
    expect(tank?.fuels.resilience).toBe(0);
    expect(tank?.fuels.kindness).toBeCloseTo(190e12, -1);
    expect(tank?.limits).toEqual({ curiosity: 0.5, integrity: 0.12, humility: 0.12, resilience: 1, kindness: 0.38 });
    expect(tank?.fillingEnabled).toBe(true);
    expect(tank?.shiftCount).toBe(21);
    expect(tank?.soulEggs).toBe(1.05e21);
    expect(tank?.currentEgg).toBe("humility");
    expect(tank?.backupTimeSeconds).toBe(1788898324);
  });

  it("is undefined when the backup has no virtue data", () => {
    const { virtue: _virtue, ...withoutVirtue } = backup();

    expect(parseVirtueTank(withoutVirtue)).toBeUndefined();
    expect(parseVirtueTank({ ...withoutVirtue, virtue: null })).toBeUndefined();
    expect(parseVirtueTank(undefined)).toBeUndefined();
  });

  it("zeroes missing fuel, uncaps missing limits, and tolerates a missing tank level", () => {
    const tank = parseVirtueTank({
      virtue: { shiftCount: 0, afx: { tankFuels: [], tankLimits: [], tankFillingEnabled: false } },
    });
    const bare = parseVirtueTank({ virtue: { afx: null }, artifacts: null, game: null, farms: null });
    const zero = { curiosity: 0, integrity: 0, humility: 0, resilience: 0, kindness: 0 };
    const uncapped = { curiosity: 1, integrity: 1, humility: 1, resilience: 1, kindness: 1 };

    for (const snapshot of [tank, bare]) {
      expect(snapshot?.tankLevel).toBe(0);
      expect(snapshot?.capacity).toBe(2e9);
      expect(snapshot?.fuels).toEqual(zero);
      expect(snapshot?.limits).toEqual(uncapped);
      expect(snapshot?.fillingEnabled).toBe(false);
      expect(snapshot?.shiftCount).toBe(0);
      expect(snapshot?.soulEggs).toBe(0);
      expect(snapshot?.currentEgg).toBeNull();
      expect(snapshot?.backupTimeSeconds).toBeNull();
    }
  });

  it("reads the virtue egg off the home farm, whichever farm is on screen", () => {
    const contracts = [{ eggType: "CUSTOM_EGG" }, { eggType: "IMMORTALITY" }];
    const onHome = (eggType: string | number) =>
      parseVirtueTank({ ...backup(), farms: [{ eggType }, ...contracts] })?.currentEgg;

    expect(onHome("CURIOSITY")).toBe("curiosity");
    expect(onHome("INTEGRITY")).toBe("integrity");
    expect(onHome("HUMILITY")).toBe("humility");
    expect(onHome("RESILIENCE")).toBe("resilience");
    expect(onHome("KINDNESS")).toBe("kindness");
    expect(onHome(52)).toBe("humility");
    // Back on the main game: the home farm runs a main egg and no farm has a virtue egg.
    expect(onHome("DILITHIUM")).toBeNull();
    expect(parseVirtueTank({ ...backup(), farms: [] })?.currentEgg).toBeNull();
  });

  it("survives profile validation", () => {
    const tank = parseVirtueTank(backup());
    const demo = createDemoProfile("main");
    const parsed = playerProfileSchema.parse({ ...demo, virtueTank: tank, shinyIngredientCount: 2 });

    expect(parsed.virtueTank).toEqual(tank);
    expect(parsed.shinyIngredientCount).toBe(2);
    expect(parsed.inFlightMissions).toEqual(demo.inFlightMissions);
  });
});

describe("createDemoProfile virtue tank", () => {
  it("gives only the virtue demo a tank, parked on Humility", () => {
    const virtueDemo = createDemoProfile("virtue");

    expect(createDemoProfile("main").virtueTank).toBeUndefined();
    expect(virtueDemo.virtueTank?.capacity).toBe(500e12);
    expect(virtueDemo.virtueTank?.currentEgg).toBe("humility");
    expect(playerProfileSchema.parse(virtueDemo).virtueTank).toEqual(virtueDemo.virtueTank);
  });
});
