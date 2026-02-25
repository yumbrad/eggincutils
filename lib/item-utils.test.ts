import { describe, expect, it } from "vitest";

import { afxIdToDisplayName, afxIdToItemKey, afxIdToTargetFamilyName } from "./item-utils";

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
});
