import { describe, expect, it } from "vitest";

import { itemIdCanBeCrafted, itemIdTakesCraftCountGoal } from "./recipes";

describe("itemIdCanBeCrafted", () => {
  it("finds recipes for display IDs that differ from their recipe key", () => {
    for (const tier of [2, 3, 4]) {
      expect(itemIdCanBeCrafted(`gusset-${tier}`)).toBe(true);
      expect(itemIdCanBeCrafted(`vial-of-martian-dust-${tier}`)).toBe(true);
    }
  });

  it("keeps tier 1 uncraftable", () => {
    expect(itemIdCanBeCrafted("gusset-1")).toBe(false);
    expect(itemIdCanBeCrafted("vial-of-martian-dust-1")).toBe(false);
    expect(itemIdCanBeCrafted("puzzle-cube-1")).toBe(false);
  });

  it("handles ordinary and canonical IDs", () => {
    expect(itemIdCanBeCrafted("puzzle-cube-3")).toBe(true);
    expect(itemIdCanBeCrafted("ornate-gusset-4")).toBe(true);
    expect(itemIdCanBeCrafted("no-such-item-2")).toBe(false);
  });
});

describe("itemIdTakesCraftCountGoal", () => {
  it("takes a craft-count goal for craftable artifacts", () => {
    for (const tier of [2, 3, 4]) {
      expect(itemIdTakesCraftCountGoal(`gusset-${tier}`)).toBe(true);
      expect(itemIdTakesCraftCountGoal(`vial-of-martian-dust-${tier}`)).toBe(true);
      expect(itemIdTakesCraftCountGoal(`puzzle-cube-${tier}`)).toBe(true);
    }
  });

  it("does not for tier-1 artifacts, which can't be crafted", () => {
    expect(itemIdTakesCraftCountGoal("gusset-1")).toBe(false);
    expect(itemIdTakesCraftCountGoal("vial-of-martian-dust-1")).toBe(false);
    expect(itemIdTakesCraftCountGoal("puzzle-cube-1")).toBe(false);
  });

  it("does not for stones or ingredients, even craftable ones", () => {
    for (const tier of [2, 3]) {
      expect(itemIdCanBeCrafted(`tachyon-stone-${tier}`)).toBe(true);
      expect(itemIdTakesCraftCountGoal(`tachyon-stone-${tier}`)).toBe(false);
      expect(itemIdTakesCraftCountGoal(`soul-stone-${tier}`)).toBe(false);
      expect(itemIdCanBeCrafted(`gold-meteorite-${tier}`)).toBe(true);
      expect(itemIdTakesCraftCountGoal(`gold-meteorite-${tier}`)).toBe(false);
      expect(itemIdTakesCraftCountGoal(`tau-ceti-geode-${tier}`)).toBe(false);
      expect(itemIdTakesCraftCountGoal(`solar-titanium-${tier}`)).toBe(false);
    }
    expect(itemIdTakesCraftCountGoal("tachyon-stone-1")).toBe(false);
  });
});
