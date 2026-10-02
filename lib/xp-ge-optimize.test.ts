import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { reserveInventoryForGoals, type CraftReservationGoal } from "./craft-reservations";
import { getHighsModule } from "./highs";
import { recipes } from "./recipes";
import {
  buildMaxXpExecutionPlan,
  optimizeCrafts,
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
