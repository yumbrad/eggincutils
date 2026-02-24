import { describe, expect, it } from "vitest";

import { formatSpecName, parseCraftCounts, parseInventory, parseMissions } from "./profile";

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
