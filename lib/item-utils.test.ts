import { describe, expect, it } from "vitest";

import { afxIdToDisplayName, afxIdToItemKey, afxIdToTargetFamilyName, itemIdToCanonicalKey } from "./item-utils";

describe("itemIdToCanonicalKey", () => {
  it("returns the canonical key for normal item IDs", () => {
    expect(itemIdToCanonicalKey("puzzle-cube-1")).toBe("puzzle_cube_1");
    expect(itemIdToCanonicalKey("puzzle-cube-4")).toBe("puzzle_cube_4");
    expect(itemIdToCanonicalKey("soul-stone-3")).toBe("soul_stone_3");
  });

  it("resolves shortened gusset IDs to ornate_gusset keys", () => {
    // artifact-display.json uses id="gusset-{n}" for key="ornate_gusset_{n}"
    expect(itemIdToCanonicalKey("gusset-1")).toBe("ornate_gusset_1");
    expect(itemIdToCanonicalKey("gusset-2")).toBe("ornate_gusset_2");
    expect(itemIdToCanonicalKey("gusset-3")).toBe("ornate_gusset_3");
    expect(itemIdToCanonicalKey("gusset-4")).toBe("ornate_gusset_4");
  });

  it("resolves expanded vial-of-martian-dust IDs to vial_martian_dust keys", () => {
    // artifact-display.json uses id="vial-of-martian-dust-{n}" for key="vial_martian_dust_{n}"
    expect(itemIdToCanonicalKey("vial-of-martian-dust-1")).toBe("vial_martian_dust_1");
    expect(itemIdToCanonicalKey("vial-of-martian-dust-2")).toBe("vial_martian_dust_2");
    expect(itemIdToCanonicalKey("vial-of-martian-dust-3")).toBe("vial_martian_dust_3");
    expect(itemIdToCanonicalKey("vial-of-martian-dust-4")).toBe("vial_martian_dust_4");
  });

  it("is idempotent for already-canonical item IDs", () => {
    expect(itemIdToCanonicalKey("ornate-gusset-4")).toBe("ornate_gusset_4");
    expect(itemIdToCanonicalKey("vial-martian-dust-2")).toBe("vial_martian_dust_2");
  });
});

describe("target family mapping", () => {
  it("uses current target family IDs (not legacy tier IDs)", () => {
    expect(afxIdToTargetFamilyName(40)).toBe("Clarity stone");
    expect(afxIdToDisplayName(40)).toBe("Clarity stone");
    expect(afxIdToItemKey(40)).toBe("clarity_stone_1");

    expect(afxIdToTargetFamilyName(10)).toBe("Book of Basan");
    expect(afxIdToDisplayName(10)).toBe("Book of Basan");
    expect(afxIdToItemKey(10)).toBe("book_of_basan_1");
  });

  it("handles untargeted missions", () => {
    expect(afxIdToTargetFamilyName(10000)).toBe("Untargeted");
    expect(afxIdToDisplayName(10000)).toBe("Untargeted");
    expect(afxIdToItemKey(10000)).toBeNull();
  });

  it("maps stone fragment target family IDs", () => {
    expect(afxIdToTargetFamilyName(52)).toBe("Clarity stone fragment");
    expect(afxIdToDisplayName(52)).toBe("Clarity stone fragment");
    expect(afxIdToItemKey(52)).toBe("clarity_stone_1");
  });
});
