import { describe, expect, it } from "vitest";

import {
  appendTargetRow,
  buildTargetOptions,
  CRAFT_GOAL_DEFAULT_COUNT,
  filterTargetOptions,
  MAX_TARGET_ROWS,
  normalizeTargetRowQuantity,
  parseStoredTargetRows,
  inHandInventory,
  plannerRowsToKeepRows,
  plannerSavedCraftedOnly,
  plannerSavedTargetRows,
  removeTargetRow,
  goalRowMode,
  selectTargetRowOption,
  serializeTargetRows,
  setTargetRowGoalMode,
  setTargetRowShinyRarity,
  targetRowToPlannerTarget,
  toggleTargetRowCraftGoal,
  type PlannerTargetRow,
} from "./goal-rows";
import { getCraftingLevelTotalXpForLevel } from "./crafting-levels";

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

describe("plannerRowsToKeepRows", () => {
  it("turns planner copies goals (N more) into keep goals of owned + N", () => {
    const inventory = { book_of_basan_4: 2, ornate_gusset_2: 7.6, soul_stone_3: 0 };
    expect(
      plannerRowsToKeepRows(
        [
          row("a", "book-of-basan-4", "1"),
          // Display id "gusset-2" is ornate_gusset_2; only whole copies count.
          row("b", "gusset-2", "3"),
          row("c", "soul-stone-3", "2"),
          row("d", "tachyon-deflector-4", "5"),
        ],
        inventory
      )
    ).toEqual([
      row("a", "book-of-basan-4", "3"),
      row("b", "gusset-2", "10"),
      row("c", "soul-stone-3", "2"),
      row("d", "tachyon-deflector-4", "5"),
    ]);
  });

  it("keeps craft-count goals as they are and caps totals at the stepper maximum", () => {
    const inventory = { ornate_gusset_3: 50, gold_meteorite_1: 9990 };
    expect(
      plannerRowsToKeepRows([row("a", "gusset-3", "400", true), row("b", "gold-meteorite-1", "25")], inventory)
    ).toEqual([row("a", "gusset-3", "400", true), row("b", "gold-meteorite-1", "9999")]);
  });
});

describe("inHandInventory", () => {
  it("takes expected drops back out, so imported goals don't count them twice", () => {
    // 111 in hand, 26.4 expected from pre-plan sends, 5 from ships in the air.
    const inventory = { interstellar_compass_4: 142.4, book_of_basan_4: 3 };
    const inHand = inHandInventory(inventory, [{ interstellar_compass_4: 26.4 }, { interstellar_compass_4: 5 }, null]);
    expect(inHand).toEqual({ interstellar_compass_4: 111, book_of_basan_4: 3 });
    expect(plannerRowsToKeepRows([row("a", "interstellar-compass-4", "35")], inHand)).toEqual([
      row("a", "interstellar-compass-4", "146"),
    ]);
  });
});

describe("plannerSavedCraftedOnly", () => {
  it("reads the per-source setting, falling back to the legacy flag", () => {
    const sourcePreferences = JSON.stringify({ main: { targetCraftedOnly: true }, virtue: { targetRows: [] } });
    expect(plannerSavedCraftedOnly({ sourcePreferences, craftedOnly: null }, "main")).toBe(true);
    // A source with saved preferences but no flag is off, whatever the legacy flag says.
    expect(plannerSavedCraftedOnly({ sourcePreferences, craftedOnly: "true" }, "virtue")).toBe(false);
    expect(plannerSavedCraftedOnly({ sourcePreferences: null, craftedOnly: "true" }, "virtue")).toBe(true);
    expect(plannerSavedCraftedOnly({ sourcePreferences: "garbage", craftedOnly: null }, "main")).toBe(false);
  });
});

describe("plannerRowsToKeepRows with only crafted on", () => {
  it("turns artifact copies goals into craft counts of crafted so far + N", () => {
    const inventory = { interstellar_compass_4: 116, soul_stone_2: 4 };
    const craftCounts = { interstellar_compass_4: 298 };
    expect(
      plannerRowsToKeepRows(
        [
          row("a", "interstellar-compass-4", "35"),
          // Stones take no craft-count goal, so they stay copies (in hand + N).
          row("b", "soul-stone-2", "3"),
          // Craft-count goals carry over unchanged.
          row("c", "gusset-3", "400", true),
          row("d", "book-of-basan-4", "2"),
        ],
        inventory,
        { craftCounts, craftedOnly: true }
      )
    ).toEqual([
      row("a", "interstellar-compass-4", "333", true),
      row("b", "soul-stone-2", "7"),
      row("c", "gusset-3", "400", true),
      row("d", "book-of-basan-4", "2", true),
    ]);
  });
});

describe("shiny goal rows", () => {
  const shinyRow = (id: string, itemId: string, percent: string, rarity: "rare" | "epic" | "legendary"): PlannerTargetRow => ({
    id,
    itemId,
    quantityInput: percent,
    craftGoal: false,
    shinyRarity: rarity,
  });

  it("switches modes with each mode's default and the item's best rarity", () => {
    const shiny = setTargetRowGoalMode([row("a", "interstellar-compass-4", "7")], "a", "shiny")[0];
    expect(shiny).toEqual(shinyRow("a", "interstellar-compass-4", "50", "legendary"));
    expect(goalRowMode(shiny)).toBe("shiny");
    expect(setTargetRowGoalMode([shiny], "a", "copies")[0]).toEqual(row("a", "interstellar-compass-4", "1"));
    expect(setTargetRowGoalMode([shiny], "a", "crafts")[0]).toEqual(
      row("a", "interstellar-compass-4", String(CRAFT_GOAL_DEFAULT_COUNT), true)
    );
    // Stones can't be shiny.
    expect(setTargetRowGoalMode([row("a", "soul-stone-2")], "a", "shiny")[0]).toEqual(row("a", "soul-stone-2"));
  });

  it("only picks rarities the item comes in", () => {
    const ankh = shinyRow("a", "tungsten-ankh-3", "50", "legendary");
    expect(setTargetRowShinyRarity([ankh], "a", "epic")[0].shinyRarity).toBe("legendary");
    expect(setTargetRowShinyRarity([ankh], "a", "rare")[0].shinyRarity).toBe("rare");
  });

  it("follows a new item to its nearest rarity, or becomes one copy", () => {
    const epicCompass = [shinyRow("a", "interstellar-compass-4", "40", "epic")];
    expect(selectTargetRowOption(epicCompass, "a", option("tungsten-ankh-3"))[0]).toEqual(
      shinyRow("a", "tungsten-ankh-3", "40", "legendary")
    );
    expect(selectTargetRowOption(epicCompass, "a", option("soul-stone-2"))[0]).toEqual(row("a", "soul-stone-2"));
  });

  it("stores the percent and rarity, and clamps the percent on load", () => {
    const rows = [shinyRow("a", "interstellar-compass-4", "50", "epic")];
    expect(targetRowToPlannerTarget(rows[0])).toEqual({
      targetItemId: "interstellar-compass-4",
      quantity: 50,
      shinyRarity: "epic",
    });
    expect(parseStoredTargetRows(serializeTargetRows(rows), options)).toEqual([
      shinyRow("target-1", "interstellar-compass-4", "50", "epic"),
    ]);
    const raw = JSON.stringify([
      { targetItemId: "interstellar-compass-4", quantity: 400, shinyRarity: "legendary" },
      { targetItemId: "soul-stone-2", quantity: 50, shinyRarity: "legendary" },
    ]);
    expect(parseStoredTargetRows(raw, options)).toEqual([
      shinyRow("target-1", "interstellar-compass-4", "99", "legendary"),
      row("target-2", "soul-stone-2", "1"),
    ]);
    expect(normalizeTargetRowQuantity([shinyRow("a", "interstellar-compass-4", "0", "rare")], "a")[0].quantityInput).toBe(
      "50"
    );
  });

  it("imports into the XP planner as the craft count that gives the chance", () => {
    const steady = 0.01 ** 0.7;
    const crafts = Math.ceil(Math.log(0.5) / Math.log(1 - steady));
    expect(
      plannerRowsToKeepRows([shinyRow("a", "interstellar-compass-4", "50", "legendary")], {}, {
        craftCounts: { interstellar_compass_4: 400 },
        craftingXp: getCraftingLevelTotalXpForLevel(30),
      })
    ).toEqual([row("a", "interstellar-compass-4", String(400 + crafts), true)]);
  });
});
