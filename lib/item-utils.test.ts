import { describe, expect, it } from "vitest";

import {
  afxIdToDisplayName,
  afxIdToItemKey,
  afxIdToTargetFamilyName,
  itemIdIsArtifact,
  itemIdToCanonicalKey,
  itemIdToFamilyType,
} from "./item-utils";

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

describe("itemIdIsArtifact", () => {
  it("is true for artifacts, including display IDs that differ from their key", () => {
    for (const tier of [1, 2, 3, 4]) {
      expect(itemIdIsArtifact(`gusset-${tier}`)).toBe(true);
      expect(itemIdIsArtifact(`ornate-gusset-${tier}`)).toBe(true);
      expect(itemIdIsArtifact(`vial-of-martian-dust-${tier}`)).toBe(true);
      expect(itemIdIsArtifact(`vial-martian-dust-${tier}`)).toBe(true);
      expect(itemIdIsArtifact(`puzzle-cube-${tier}`)).toBe(true);
    }
    expect(itemIdIsArtifact("tachyon-deflector-3")).toBe(true);
    expect(itemIdIsArtifact("book-of-basan-4")).toBe(true);
    expect(itemIdToFamilyType("gusset-3")).toBe("Artifact");
  });

  it("is false for stones and stone fragments", () => {
    for (const tier of [1, 2, 3]) {
      expect(itemIdIsArtifact(`tachyon-stone-${tier}`)).toBe(false);
      expect(itemIdIsArtifact(`soul-stone-${tier}`)).toBe(false);
      expect(itemIdIsArtifact(`clarity-stone-${tier}`)).toBe(false);
    }
    // Tier 1 of a stone is its fragment.
    expect(itemIdToFamilyType("tachyon-stone-1")).toBe("Stone");
    expect(itemIdToFamilyType("dilithium-stone-1")).toBe("Stone");
  });

  it("is false for ingredients", () => {
    for (const tier of [1, 2, 3]) {
      expect(itemIdIsArtifact(`gold-meteorite-${tier}`)).toBe(false);
      expect(itemIdIsArtifact(`tau-ceti-geode-${tier}`)).toBe(false);
      expect(itemIdIsArtifact(`solar-titanium-${tier}`)).toBe(false);
    }
    expect(itemIdToFamilyType("gold-meteorite-2")).toBe("Ingredient");
  });

  it("is false for unknown items", () => {
    expect(itemIdIsArtifact("no-such-item-2")).toBe(false);
    expect(itemIdToFamilyType("no-such-item-2")).toBeNull();
  });
});
