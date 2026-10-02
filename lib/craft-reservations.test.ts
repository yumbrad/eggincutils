import { describe, expect, it } from "vitest";

import { goalReservationCovered, planLeavesReserved, reserveInventoryForGoals } from "./craft-reservations";
import { recipes } from "./recipes";

describe("reserveInventoryForGoals", () => {
  it("keeps owned copies for a copies goal that inventory fully covers", () => {
    const result = reserveInventoryForGoals(
      { book_of_basan_4: 3, book_of_basan_3: 20 },
      {},
      [{ itemId: "book-of-basan-4", quantity: 2 }]
    );

    expect(result.goals[0].keeps).toEqual({ book_of_basan_4: 2 });
    expect(result.goals[0].short).toEqual({});
    expect(goalReservationCovered(result.goals[0])).toBe(true);
    expect(result.available).toEqual({ book_of_basan_4: 1, book_of_basan_3: 20 });
    expect(result.totalReserved).toBe(2);
  });

  it("recurses a shortfall through stone tiers down to fragments", () => {
    const result = reserveInventoryForGoals(
      { soul_stone_2: 10, soul_stone_1: 60 },
      {},
      [{ itemId: "soul-stone-3", quantity: 1 }]
    );

    // Soul stone T3 = 15× T2; T2 = 20× fragments. 5 missing T2 need 100 fragments.
    expect(result.goals[0].keeps).toEqual({ soul_stone_2: 10, soul_stone_1: 60 });
    expect(result.goals[0].short).toEqual({ soul_stone_1: 40 });
    expect(goalReservationCovered(result.goals[0])).toBe(false);
    expect(result.available).toEqual({ soul_stone_2: 0, soul_stone_1: 0 });
  });

  it("keeps everything owned along a partly covered tree, own copies first at every tier", () => {
    const inventory = {
      ornate_gusset_3: 5,
      ornate_gusset_2: 10,
      ornate_gusset_1: 100,
      mercurys_lens_2: 2,
      gold_meteorite_3: 1,
      gold_meteorite_2: 30,
    };
    const result = reserveInventoryForGoals(inventory, {}, [{ itemId: "gusset-4", quantity: 1 }]);
    const goal = result.goals[0];

    // Gusset T4 = 8× T3 + 3× gold T3. 3 missing T3 = 18× T2 + 6× lens T2;
    // 8 missing T2 = 40× T1; 4 missing lens T2 = 24× lens T1 (none owned);
    // 2 missing gold T3 = 22× gold T2.
    expect(goal.keeps).toEqual({
      ornate_gusset_3: 5,
      ornate_gusset_2: 10,
      ornate_gusset_1: 40,
      mercurys_lens_2: 2,
      gold_meteorite_3: 1,
      gold_meteorite_2: 22,
    });
    expect(Object.keys(goal.keeps)).toEqual([
      "ornate_gusset_3",
      "ornate_gusset_2",
      "ornate_gusset_1",
      "mercurys_lens_2",
      "gold_meteorite_3",
      "gold_meteorite_2",
    ]);
    expect(goal.short).toEqual({ mercurys_lens_1: 24 });
    expect(result.available.ornate_gusset_1).toBe(60);
    expect(result.available.gold_meteorite_2).toBe(8);
  });

  it("reads a craft-count goal from craft history and ignores owned copies of the artifact", () => {
    const result = reserveInventoryForGoals(
      { ornate_gusset_3: 50, ornate_gusset_2: 100, mercurys_lens_2: 30 },
      { ornate_gusset_3: 390 },
      [{ itemId: "gusset-3", quantity: 400, craftGoal: true }]
    );
    const goal = result.goals[0];

    // 10 crafts to go, each 6× gusset T2 + 2× lens T2.
    expect(goal.craftGoal).toBe(true);
    expect(goal.craftsToGo).toBe(10);
    expect(goal.keeps).toEqual({ ornate_gusset_2: 60, mercurys_lens_2: 20 });
    expect(goal.short).toEqual({});
    expect(result.available.ornate_gusset_3).toBe(50);
  });

  it("keeps nothing for a craft-count goal that is already met", () => {
    const result = reserveInventoryForGoals(
      { ornate_gusset_2: 100, mercurys_lens_2: 30 },
      { ornate_gusset_3: 412 },
      [{ itemId: "gusset-3", quantity: 400, craftGoal: true }]
    );

    expect(result.goals[0].craftsToGo).toBe(0);
    expect(result.goals[0].keeps).toEqual({});
    expect(goalReservationCovered(result.goals[0])).toBe(true);
    expect(result.totalReserved).toBe(0);
    expect(result.available).toEqual({ ornate_gusset_2: 100, mercurys_lens_2: 30 });
  });

  it("does not stack two craft-count rows for the same artifact", () => {
    const result = reserveInventoryForGoals(
      { ornate_gusset_2: 1000, mercurys_lens_2: 1000 },
      { ornate_gusset_3: 100 },
      [
        { itemId: "gusset-3", quantity: 400, craftGoal: true },
        { itemId: "gusset-3", quantity: 300, craftGoal: true },
        { itemId: "gusset-3", quantity: 410, craftGoal: true },
      ]
    );

    expect(result.goals.map((goal) => goal.craftsToGo)).toEqual([300, 0, 10]);
    expect(result.reserved).toEqual({ ornate_gusset_2: 1000, mercurys_lens_2: 620 });
    expect(result.goals[0].short).toEqual({ ornate_gusset_1: 4000 });
  });

  it("draws goals from one shared pool in row order", () => {
    const result = reserveInventoryForGoals(
      { soul_stone_2: 2, soul_stone_1: 30 },
      {},
      [
        { itemId: "soul-stone-2", quantity: 3 },
        { itemId: "soul-stone-2", quantity: 2 },
      ]
    );

    expect(result.goals[0].keeps).toEqual({ soul_stone_2: 2, soul_stone_1: 20 });
    expect(result.goals[0].short).toEqual({});
    expect(result.goals[1].keeps).toEqual({ soul_stone_1: 10 });
    expect(result.goals[1].short).toEqual({ soul_stone_1: 30 });
    expect(result.reserved).toEqual({ soul_stone_2: 2, soul_stone_1: 30 });
    expect(result.available).toEqual({ soul_stone_2: 0, soul_stone_1: 0 });
  });

  it("reports an uncraftable shortfall after keeping what is owned", () => {
    const result = reserveInventoryForGoals({ book_of_basan_1: 4 }, {}, [{ itemId: "book-of-basan-1", quantity: 10 }]);

    expect(result.goals[0].keeps).toEqual({ book_of_basan_1: 4 });
    expect(result.goals[0].short).toEqual({ book_of_basan_1: 6 });
  });

  it("resolves display ids that differ from recipe keys", () => {
    const result = reserveInventoryForGoals(
      { ornate_gusset_2: 5, vial_martian_dust_2: 30, solar_titanium_2: 10 },
      { vial_martian_dust_3: 2 },
      [
        { itemId: "gusset-2", quantity: 3 },
        { itemId: "vial-of-martian-dust-3", quantity: 5, craftGoal: true },
      ]
    );

    expect(result.goals[0].itemKey).toBe("ornate_gusset_2");
    expect(result.goals[0].keeps).toEqual({ ornate_gusset_2: 3 });
    expect(result.goals[1].itemKey).toBe("vial_martian_dust_3");
    expect(result.goals[1].craftsToGo).toBe(3);
    // 3 crafts × (7× vial T2 + 2× solar titanium T2).
    expect(result.goals[1].keeps).toEqual({ vial_martian_dust_2: 21, solar_titanium_2: 6 });
  });

  it("keeps whole copies only and leaves fractional pre-plan drops available", () => {
    const result = reserveInventoryForGoals(
      { gold_meteorite_2: 3.6, gold_meteorite_1: 50 },
      {},
      [{ itemId: "gold-meteorite-2", quantity: 5 }]
    );

    expect(result.goals[0].keeps).toEqual({ gold_meteorite_2: 3, gold_meteorite_1: 18 });
    expect(result.available.gold_meteorite_2).toBeCloseTo(0.6);
    expect(result.available.gold_meteorite_1).toBe(32);
  });

  it("reads a craft-count flag on an uncraftable item as copies and skips unknown items", () => {
    const result = reserveInventoryForGoals(
      { book_of_basan_1: 9 },
      {},
      [
        { itemId: "book-of-basan-1", quantity: 2, craftGoal: true },
        { itemId: "", quantity: 3 },
        { itemId: "not-an-item-9", quantity: 3 },
      ]
    );

    expect(result.goals[0].craftGoal).toBe(false);
    expect(result.goals[0].keeps).toEqual({ book_of_basan_1: 2 });
    expect(result.goals[1]).toMatchObject({ itemKey: "", keeps: {}, short: {} });
    expect(result.goals[2]).toMatchObject({ itemKey: "", keeps: {}, short: {} });
    expect(result.totalReserved).toBe(2);
  });

  it("never keeps more than the inventory holds", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const keys = Object.keys(recipes);
    for (let round = 0; round < 200; round += 1) {
      const inventory: Record<string, number> = {};
      for (const key of keys) {
        if (random() < 0.6) {
          inventory[key] = Math.floor(random() * 120) + (random() < 0.2 ? random() : 0);
        }
      }
      const craftCounts: Record<string, number> = {};
      for (const key of keys) {
        if (random() < 0.5) {
          craftCounts[key] = Math.floor(random() * 500);
        }
      }
      const goals = Array.from({ length: 1 + Math.floor(random() * 6) }, () => ({
        itemId: keys[Math.floor(random() * keys.length)],
        quantity: 1 + Math.floor(random() * (random() < 0.3 ? 400 : 12)),
        craftGoal: random() < 0.4,
      }));

      const result = reserveInventoryForGoals(inventory, craftCounts, goals);

      const keptByGoals: Record<string, number> = {};
      for (const goal of result.goals) {
        for (const [key, count] of Object.entries(goal.keeps)) {
          expect(count).toBeGreaterThan(0);
          keptByGoals[key] = (keptByGoals[key] || 0) + count;
        }
      }
      expect(keptByGoals).toEqual(result.reserved);
      for (const [key, count] of Object.entries(result.reserved)) {
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeLessThanOrEqual(Math.floor(inventory[key] || 0));
      }
      for (const [key, quantity] of Object.entries(inventory)) {
        expect(result.available[key]).toBeGreaterThanOrEqual(0);
        expect(result.available[key]).toBeCloseTo(quantity - (result.reserved[key] || 0));
      }
    }
  });
});

describe("planLeavesReserved", () => {
  it("checks a plan's net use of each kept item", () => {
    const inventory = { ornate_gusset_2: 20, mercurys_lens_2: 4, ornate_gusset_3: 1 };
    // 2 gusset T3 crafts use 12 gusset T2 and 4 lens T2.
    expect(planLeavesReserved({ ornate_gusset_3: 2 }, inventory, { ornate_gusset_2: 8 })).toBe(true);
    expect(planLeavesReserved({ ornate_gusset_3: 2 }, inventory, { ornate_gusset_2: 9 })).toBe(false);
    expect(planLeavesReserved({ ornate_gusset_3: 2 }, inventory, { mercurys_lens_2: 1 })).toBe(false);
    // Crafted copies count toward what is kept of the crafted item.
    expect(planLeavesReserved({ ornate_gusset_3: 2 }, inventory, { ornate_gusset_3: 3 })).toBe(true);
    expect(planLeavesReserved({}, inventory, {})).toBe(true);
  });
});
