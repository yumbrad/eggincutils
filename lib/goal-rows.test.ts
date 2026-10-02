import { describe, expect, it } from "vitest";

import {
  appendTargetRow,
  buildTargetOptions,
  CRAFT_GOAL_DEFAULT_COUNT,
  filterTargetOptions,
  MAX_TARGET_ROWS,
  normalizeTargetRowQuantity,
  parseStoredTargetRows,
  plannerSavedTargetRows,
  removeTargetRow,
  selectTargetRowOption,
  serializeTargetRows,
  toggleTargetRowCraftGoal,
  type PlannerTargetRow,
} from "./goal-rows";

const options = buildTargetOptions();
const option = (itemId: string) => {
  const found = options.find((candidate) => candidate.itemId === itemId);
  if (!found) {
    throw new Error(`no option ${itemId}`);
  }
  return found;
};
const row = (id: string, itemId: string, quantityInput = "1", craftGoal = false): PlannerTargetRow => ({
  id,
  itemId,
  quantityInput,
  craftGoal,
});

describe("buildTargetOptions", () => {
  it("lists every recipe item with display ids, sorted by family then tier", () => {
    const gussets = options.filter((candidate) => candidate.familyKey === "ornate_gusset");
    expect(gussets.map((candidate) => candidate.itemId)).toEqual(["gusset-1", "gusset-2", "gusset-3", "gusset-4"]);
    expect(option("vial-of-martian-dust-2").itemKey).toBe("vial_martian_dust_2");
    expect(option("book-of-basan-4").label).toBe("Gilded book of Basan (T4)");
  });

  it("filters on every search term", () => {
    expect(filterTargetOptions(options, "gilded basan").map((candidate) => candidate.itemId)).toEqual(["book-of-basan-4"]);
    expect(filterTargetOptions(options, "   ")).toBe(options);
  });
});

describe("stored goal rows", () => {
  it("round-trips rows and keeps the craft-count flag only for craftable artifacts", () => {
    const rows = [row("a", "book-of-basan-4", "2"), row("b", "gusset-3", "400", true)];
    const parsed = parseStoredTargetRows(serializeTargetRows(rows), options);
    expect(parsed).toEqual([row("target-1", "book-of-basan-4", "2"), row("target-2", "gusset-3", "400", true)]);
  });

  it("drops bad entries and unknown items, clamps quantities and caps the row count", () => {
    const raw = JSON.stringify([
      null,
      "soul-stone-2",
      { targetItemId: "not-an-item", quantity: 3 },
      { targetItemId: "soul-stone-2", quantity: 120000 },
      { itemId: "gusset-2", quantityInput: "abc" },
      // A seeded craft count on a stone loads as one copy.
      { targetItemId: "soul-stone-3", quantity: 400, craftGoal: true },
      ...Array.from({ length: 20 }, () => ({ targetItemId: "gold-meteorite-1", quantity: 1 })),
    ]);
    const parsed = parseStoredTargetRows(raw, options) || [];
    expect(parsed.slice(0, 3)).toEqual([
      row("target-1", "soul-stone-2", "9999"),
      row("target-2", "gusset-2", "1"),
      row("target-3", "soul-stone-3", "1"),
    ]);
    expect(parsed).toHaveLength(MAX_TARGET_ROWS);
    expect(parseStoredTargetRows("{not json", options)).toBeNull();
    expect(parseStoredTargetRows(JSON.stringify({ rows: [] }), options)).toBeNull();
    expect(parseStoredTargetRows("[]", options)).toBeNull();
  });
});

describe("row updates", () => {
  it("seeds a craft count when the chip turns on and drops the seed when it turns off", () => {
    const on = toggleTargetRowCraftGoal([row("a", "gusset-3")], "a");
    expect(on[0]).toEqual(row("a", "gusset-3", String(CRAFT_GOAL_DEFAULT_COUNT), true));
    expect(toggleTargetRowCraftGoal(on, "a")[0]).toEqual(row("a", "gusset-3", "1"));
    // A typed count stays when switching back; stones never take the chip.
    expect(toggleTargetRowCraftGoal([row("a", "gusset-3", "250", true)], "a")[0].quantityInput).toBe("250");
    expect(toggleTargetRowCraftGoal([row("a", "soul-stone-3")], "a")[0].craftGoal).toBe(false);
  });

  it("drops a seeded craft count when a row moves to an item that can't take one", () => {
    const next = selectTargetRowOption([row("a", "gusset-3", "400", true), row("b", "gusset-2")], "a", option("soul-stone-2"));
    expect(next).toEqual([row("a", "soul-stone-2"), row("b", "gusset-2")]);
  });

  it("normalizes, appends and removes rows", () => {
    expect(normalizeTargetRowQuantity([row("a", "gusset-3", "0012.6")], "a")[0].quantityInput).toBe("13");
    const full = Array.from({ length: MAX_TARGET_ROWS }, (_, index) => row(`r${index}`, "gusset-3"));
    expect(appendTargetRow(full, "extra", "gusset-2")).toHaveLength(MAX_TARGET_ROWS);
    expect(appendTargetRow([], "new", "")).toEqual([row("new", "")]);
    expect(removeTargetRow([row("a", "gusset-3")], "a", 1)).toEqual([row("a", "gusset-3")]);
    expect(removeTargetRow([row("a", "gusset-3")], "a", 0)).toEqual([]);
  });
});

describe("plannerSavedTargetRows", () => {
  const sourcePreferences = JSON.stringify({
    main: { targetRows: [{ targetItemId: "gusset-3", quantity: 400, craftGoal: true }, { targetItemId: "soul-stone-2", quantity: 3 }] },
    virtue: { targetRows: [{ targetItemId: "tachyon-deflector-3", quantity: 5 }] },
  });

  it("reads the rows the attainment planner saved for a source", () => {
    expect(plannerSavedTargetRows({ sourcePreferences, targets: null }, "main", options)).toEqual([
      row("target-1", "gusset-3", "400", true),
      row("target-2", "soul-stone-2", "3"),
    ]);
    expect(plannerSavedTargetRows({ sourcePreferences, targets: null }, "virtue", options)).toEqual([
      row("target-1", "tachyon-deflector-3", "5"),
    ]);
  });

  it("falls back to the shared target list before the planner saved per-source rows", () => {
    const targets = JSON.stringify([{ targetItemId: "book-of-basan-4", quantity: 1 }]);
    expect(plannerSavedTargetRows({ sourcePreferences: null, targets }, "main", options)).toEqual([
      row("target-1", "book-of-basan-4", "1"),
    ]);
    expect(
      plannerSavedTargetRows({ sourcePreferences: JSON.stringify({ virtue: {} }), targets }, "main", options)
    ).toEqual([row("target-1", "book-of-basan-4", "1")]);
    // Saved preferences for the source without usable rows import nothing.
    expect(plannerSavedTargetRows({ sourcePreferences: JSON.stringify({ main: {} }), targets }, "main", options)).toEqual([]);
    expect(plannerSavedTargetRows({ sourcePreferences: "garbage", targets: null }, "main", options)).toEqual([]);
  });
});
