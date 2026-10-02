import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { reserveInventoryForGoals, type CraftReservationGoal } from "./craft-reservations";
import { getHighsModule } from "./highs";
import { recipes } from "./recipes";
import {
  buildMaxXpExecutionPlan,
  optimizeCrafts,
  simulateGeEfficiencyPlan,
  type Highs,
  type MaxXpExecutionPlanNode,
  type Solution,
  type SolutionCraftRow,
} from "./xp-ge-optimize";

function solutionRow(count: number): SolutionCraftRow {
  return {
    count,
    xp: 0,
    cost: 0,
    xpPerGe: 0,
    xpPerCraft: 0,
    costDetails: {
      baseCost: 0,
      discountedCost: 0,
      totalDirectCost: 0,
      craftCount: 0,
      discountPercent: 0,
      recursiveCost: 0,
      ingredients: [],
      saleApplied: false,
    },
    modeComparison: {
      direct: { count, xp: 0, cost: 0, xpPerGe: 0 },
      auto: null,
    },
  };
}

function collectNodes(nodes: MaxXpExecutionPlanNode[]): MaxXpExecutionPlanNode[] {
  const collected: MaxXpExecutionPlanNode[] = [];
  const visit = (node: MaxXpExecutionPlanNode) => {
    collected.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return collected;
}

describe("buildMaxXpExecutionPlan", () => {
  it("promotes planned crafts that would be suppressed by existing ingredient inventory", () => {
    const plan = buildMaxXpExecutionPlan(
      {
        crafts: {
          tachyon_deflector_4: solutionRow(1),
          tachyon_deflector_3: solutionRow(12),
        },
        totalXp: 0,
        totalCost: 0,
      },
      {
        tachyon_deflector_3: 5,
        tachyon_deflector_2: 120,
        quantum_metronome_4: 12,
        ship_in_a_bottle_4: 4,
      },
      {},
      ["tachyon_deflector_4", "tachyon_deflector_3"]
    );

    expect(plan.steps.map((step) => `${step.mode}:${step.artifact}:${step.count}`)).toEqual([
      "click:tachyon_deflector_4:1",
      "click:tachyon_deflector_3:5",
    ]);
    expect(plan.steps[0].children.map((step) => `${step.mode}:${step.artifact}:${step.count}`)).toEqual([
      "auto:tachyon_deflector_3:7",
    ]);
    expect(collectNodes(plan.steps).every((node) => (node.mode === "click") === plan.steps.includes(node))).toBe(true);
    expect(plan.finalCraftCounts.tachyon_deflector_4).toBe(1);
    expect(plan.finalCraftCounts.tachyon_deflector_3).toBe(12);
    expect(plan.remainingInventory.tachyon_deflector_3).toBe(5);
    expect(plan.usage.tachyon_deflector_3.manualCrafts).toBe(5);
    expect(plan.usage.tachyon_deflector_3.autoCrafts).toBe(7);
    expect(plan.usage.tachyon_deflector_3.inventoryConsumed).toBe(5);
    expect(plan.usage.tachyon_deflector_3.consumedBy.tachyon_deflector_4).toBe(12);
  });

  it("keeps promoted and originally top-level crafts in one main row", () => {
    const plan = buildMaxXpExecutionPlan(
      {
        crafts: {
          tachyon_deflector_4: solutionRow(1),
          tachyon_deflector_3: solutionRow(65),
        },
        totalXp: 0,
        totalCost: 0,
      },
      {
        tachyon_deflector_3: 5,
        tachyon_deflector_2: 650,
        quantum_metronome_4: 65,
        ship_in_a_bottle_4: 4,
      },
      {},
      ["tachyon_deflector_4", "tachyon_deflector_3"]
    );

    expect(plan.steps.map((step) => `${step.mode}:${step.artifact}:${step.count}`)).toEqual([
      "click:tachyon_deflector_4:1",
      "click:tachyon_deflector_3:58",
    ]);
    expect(plan.steps[0].children.map((step) => `${step.mode}:${step.artifact}:${step.count}`)).toEqual([
      "auto:tachyon_deflector_3:7",
    ]);
    expect(plan.usage.tachyon_deflector_3.manualCrafts).toBe(58);
    expect(plan.usage.tachyon_deflector_3.autoCrafts).toBe(7);
  });
});

describe("optimizeCrafts craft limits", () => {
  it("adds all-craft cap constraints directly to solver variables", () => {
    let capturedProblem = "";
    const highs: Highs = {
      solve(problem) {
        capturedProblem = problem;
        return { Columns: {} };
      },
    };

    optimizeCrafts(highs, { tachyon_deflector_3: 49 }, {}, false, { tachyon_deflector_3: 0 });

    expect(capturedProblem).toContain("craft_limit_tachyon_deflector_3: tachyon_deflector_3 <= 0");
    expect(capturedProblem).not.toContain("Binary");
  });
});

async function realHighs(): Promise<Highs> {
  const highsModule = await getHighsModule();
  return {
    solve: (problem, options) => highsModule.solve(problem, options) as ReturnType<Highs["solve"]>,
  };
}

/** Inventory left after every craft in the solution, consumption net of what the plan crafts. */
function inventoryAfterPlan(solution: Solution, inventory: Record<string, number>): Record<string, number> {
  const after = { ...inventory };
  for (const [artifact, craft] of Object.entries(solution.crafts)) {
    const count = Math.round(craft.count);
    if (count <= 0) {
      continue;
    }
    after[artifact] = (after[artifact] || 0) + count;
    for (const [ingredient, quantity] of Object.entries(recipes[artifact]!.ingredients)) {
      after[ingredient] = (after[ingredient] || 0) - quantity * count;
    }
  }
  return after;
}

function expectPlanKeepsReserved(
  highs: Highs,
  inventory: Record<string, number>,
  craftCounts: Record<string, number>,
  goals: CraftReservationGoal[]
): void {
  const reservations = reserveInventoryForGoals(inventory, craftCounts, goals);
  expect(reservations.totalReserved).toBeGreaterThan(0);

  const baseline = optimizeCrafts(highs, inventory, craftCounts);
  const baselineAfter = inventoryAfterPlan(baseline, inventory);
  // Without the goals the plan eats into what they keep, so the check below means something.
  expect(
    Object.entries(reservations.reserved).some(([item, kept]) => (baselineAfter[item] || 0) < kept)
  ).toBe(true);

  const solution = optimizeCrafts(highs, reservations.available, craftCounts);
  const after = inventoryAfterPlan(solution, inventory);
  for (const [item, kept] of Object.entries(reservations.reserved)) {
    expect((after[item] || 0) + 1e-6, item).toBeGreaterThanOrEqual(kept);
  }
  expect(solution.totalXp).toBeLessThanOrEqual(baseline.totalXp);
  expect(solution.totalXp).toBeGreaterThan(0);

  // The click order is built from the full inventory (the game uses owned copies
  // first) and must still leave every kept item in place.
  const plan = buildMaxXpExecutionPlan(solution, inventory, craftCounts);
  for (const [item, kept] of Object.entries(reservations.reserved)) {
    expect(plan.remainingInventory[item] || 0, item).toBeGreaterThanOrEqual(kept);
  }
}

describe("optimizeCrafts on inventory with goal items held back (blocked goals)", () => {
  it("never consumes items kept for goals", async () => {
    const highs = await realHighs();
    expectPlanKeepsReserved(
      highs,
      {
        ornate_gusset_1: 300,
        ornate_gusset_2: 40,
        ornate_gusset_3: 6,
        mercurys_lens_1: 200,
        mercurys_lens_2: 20,
        gold_meteorite_1: 500,
        gold_meteorite_2: 60,
        gold_meteorite_3: 2,
      },
      { ornate_gusset_3: 390 },
      [
        { itemId: "gusset-4", quantity: 1 },
        { itemId: "gusset-3", quantity: 400, craftGoal: true },
      ]
    );
  }, 30_000);

  it("never consumes kept items on a real profile snapshot", async () => {
    const snapshotPath = path.join(process.cwd(), "benchmarks/mission-craft-planner/profile-snapshot-benchmark.json");
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
      profile: { inventory: Record<string, number>; craftCounts: Record<string, number> };
    };
    const highs = await realHighs();
    expectPlanKeepsReserved(highs, snapshot.profile.inventory, snapshot.profile.craftCounts, [
      { itemId: "book-of-basan-4", quantity: 1 },
      { itemId: "gusset-3", quantity: 400, craftGoal: true },
      { itemId: "soul-stone-3", quantity: 20 },
    ]);
  }, 60_000);
});

describe("auto-craft XP", () => {
  // Ship in a bottle T3 with no T2s on hand: auto mode crafts the T2s first,
  // and each of those is a real craft with its own GE cost and XP.
  const t3 = "ship_in_a_bottle_3";
  const t2 = "ship_in_a_bottle_2";
  const recipeT3 = recipes[t3]!;
  const recipeT2 = recipes[t2]!;
  const t2PerT3 = recipeT3.ingredients[t2];
  const inventory: Record<string, number> = { [t2]: 0 };
  for (const [ingredient, quantity] of Object.entries(recipeT3.ingredients)) {
    if (ingredient !== t2) {
      inventory[ingredient] = quantity;
    }
  }
  for (const [ingredient, quantity] of Object.entries(recipeT2.ingredients)) {
    inventory[ingredient] = (inventory[ingredient] || 0) + quantity * t2PerT3;
  }

  it("counts the XP of the ingredients auto mode crafts, not just the top-level craft", () => {
    const result = simulateGeEfficiencyPlan(inventory, {}, [{ artifact: t3, mode: "auto", referenceXpPerGe: 1 }], 0);
    const row = result.rows[0];
    expect(t2PerT3).toBeGreaterThan(0);
    expect(row.craftedCount).toBe(1);
    expect(result.finalCraftCounts[t2]).toBe(t2PerT3);
    expect(row.xp).toBe(recipeT3.xp + t2PerT3 * recipeT2.xp);
    expect(result.totalXp).toBe(row.xp);
  });

  it("matches the XP of every craft it makes on a real profile", () => {
    const snapshotPath = path.join(process.cwd(), "benchmarks", "mission-craft-planner", "profile-snapshot-benchmark.json");
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    const startInventory: Record<string, number> = snapshot.profile.inventory;
    const startCounts: Record<string, number> = snapshot.profile.craftCounts;
    let checked = 0;
    for (const artifact of Object.keys(recipes)) {
      if (!recipes[artifact]) {
        continue;
      }
      const result = simulateGeEfficiencyPlan(startInventory, startCounts, [{ artifact, mode: "auto", referenceXpPerGe: 1 }], 0);
      let everyCraftXp = 0;
      for (const [itemKey, finalCount] of Object.entries(result.finalCraftCounts)) {
        const crafted = finalCount - (startCounts[itemKey] || 0);
        if (crafted > 0 && recipes[itemKey]) {
          everyCraftXp += crafted * recipes[itemKey]!.xp;
        }
      }
      expect(result.rows[0]?.xp ?? 0).toBe(everyCraftXp);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(50);
  });
});
