import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { planMeetsGoals, reserveInventoryForGoals, type CraftReservationGoal } from "./craft-reservations";
import { getHighsModule } from "./highs";
import { recipes, type Recipes } from "./recipes";
import {
  buildMaxXpExecutionPlan,
  optimizeCrafts,
  simulateGeEfficiencyPlan,
  simulateGoalCrafts,
  type Highs,
  type Solution,
} from "./xp-ge-optimize";
import { goalPlanConstraints, goalsFirstGeTotals, optimizeCraftsForGoals } from "./xp-goal-plan";

async function realHighs(): Promise<Highs> {
  const highsModule = await getHighsModule();
  return { solve: (problem, options) => highsModule.solve(problem, options) as ReturnType<Highs["solve"]> };
}

function captureProblem(run: (highs: Highs) => void): string {
  let problem = "";
  run({
    solve(text) {
      problem = text;
      return { Columns: {} };
    },
  });
  return problem;
}

/** The LP optimizeCrafts wrote before goals existed, kept to pin the no-goal model. */
function preGoalProblem(inventory: Record<string, number>, craftLimits: Record<string, number> = {}): string {
  const recipeMap = recipes as Recipes;
  const artifacts = Object.keys(recipeMap).sort();
  const lines = ["Maximize"];
  lines.push(`  obj: ${artifacts.filter((a) => recipeMap[a]).map((a) => `${recipeMap[a]!.xp} ${a}`).join(" + ")}`);
  lines.push("Subject To");
  for (const artifact of artifacts) {
    const used = Object.keys(recipeMap)
      .filter((parent) => recipeMap[parent] && artifact in recipeMap[parent]!.ingredients)
      .map((parent) => `${recipeMap[parent]!.ingredients[artifact]} ${parent}`);
    if (used.length === 0) {
      continue;
    }
    const available = inventory[artifact] || 0;
    lines.push(
      recipeMap[artifact]
        ? `  c_${artifact}: ${used.join(" + ")} - ${artifact} <= ${available}`
        : `  c_${artifact}: ${used.join(" + ")} <= ${available}`
    );
  }
  for (const [artifact, limit] of Object.entries(craftLimits)) {
    if (recipeMap[artifact] && Number.isFinite(limit) && limit >= 0) {
      lines.push(`  craft_limit_${artifact}: ${artifact} <= ${Math.max(0, Math.round(limit))}`);
    }
  }
  lines.push("Bounds", ...artifacts.map((a) => `  ${a} >= 0`), "General", `  ${artifacts.join(" ")}`, "End");
  return lines.join("\n");
}

function plannedCounts(solution: Solution): Record<string, number> {
  return Object.fromEntries(Object.entries(solution.crafts).map(([artifact, craft]) => [artifact, Math.round(craft.count)]));
}

/** Inventory after every craft in the plan, net of what its crafts consume. */
function inventoryAfter(solution: Solution, inventory: Record<string, number>): Record<string, number> {
  const after = { ...inventory };
  for (const [artifact, count] of Object.entries(plannedCounts(solution))) {
    after[artifact] = (after[artifact] || 0) + count;
    for (const [ingredient, quantity] of Object.entries(recipes[artifact]!.ingredients)) {
      after[ingredient] = (after[ingredient] || 0) - quantity * count;
    }
  }
  return after;
}

/** Every goal requirement and held item, checked on the plan and on the simulated click order. */
function expectPlanMeetsGoals(
  inventory: Record<string, number>,
  craftCounts: Record<string, number>,
  result: ReturnType<typeof optimizeCraftsForGoals>
): void {
  expect(result.solution.infeasible).toBeUndefined();
  const constraints = result.constraints!;
  const mustRemain: Record<string, number> = { ...constraints.held };
  for (const [itemKey, copies] of Object.entries(constraints.requirements.keepCopies || {})) {
    mustRemain[itemKey] = (mustRemain[itemKey] || 0) + copies;
  }
  const minCrafts = constraints.requirements.minCrafts || {};
  expect(planMeetsGoals(plannedCounts(result.solution), inventory, mustRemain, minCrafts)).toBe(true);

  // The click order starts from the whole inventory (the game uses owned copies first).
  const order = buildMaxXpExecutionPlan(result.solution, inventory, craftCounts);
  for (const [itemKey, count] of Object.entries(mustRemain)) {
    expect(order.remainingInventory[itemKey] || 0, itemKey).toBeGreaterThanOrEqual(count);
  }
  for (const [artifact, least] of Object.entries(minCrafts)) {
    expect((order.finalCraftCounts[artifact] || 0) - (craftCounts[artifact] || 0), artifact).toBeGreaterThanOrEqual(least);
  }
}

describe("goal requirements in the LP", () => {
  const inventory = { soul_stone_3: 2, soul_stone_2: 30, book_of_basan_4: 1, ornate_gusset_2: 40 };

  it("keeps the no-goal LP exactly as before", () => {
    for (const [stock, limits] of [
      [inventory, {}],
      [{ gold_meteorite_2: 3.6, soul_stone_1: 40 }, { tachyon_deflector_3: 0, ornate_gusset_4: 3 }],
      [{}, {}],
    ] as const) {
      const before = preGoalProblem(stock, limits);
      expect(captureProblem((highs) => optimizeCrafts(highs, stock, {}, false, limits))).toBe(before);
      expect(captureProblem((highs) => optimizeCrafts(highs, stock, {}, false, limits, {}))).toBe(before);
      expect(
        captureProblem((highs) =>
          optimizeCrafts(highs, stock, {}, false, limits, { keepCopies: { soul_stone_3: 0 }, minCrafts: { soul_stone_3: 0 } })
        )
      ).toBe(before);
    }
  });

  it("writes copies goals into balance rows and craft-count goals as lower bounds", () => {
    const problem = captureProblem((highs) =>
      optimizeCrafts(highs, inventory, {}, false, {}, {
        keepCopies: { soul_stone_3: 5, book_of_basan_4: 3, gold_meteorite_1: 2 },
        minCrafts: { ornate_gusset_3: 7 },
      })
    );
    const lines = problem.split("\n").map((line) => line.trim());

    expect(lines).toContain("c_soul_stone_3: 20 soul_stone_4 - soul_stone_3 <= -3");
    // Nothing consumes the book, so kept copies come from crafting it.
    expect(lines).toContain("c_book_of_basan_4: book_of_basan_4 >= 2");
    expect(lines).toContain("c_gold_meteorite_1: 9 gold_meteorite_2 <= -2");
    expect(lines).toContain("ornate_gusset_3 >= 7");
    expect(lines).toContain("c_soul_stone_2: 15 soul_stone_3 - soul_stone_2 <= 30");
    expect(lines.filter((line) => line.startsWith("c_"))).toHaveLength(
      preGoalProblem(inventory).split("\n").filter((line) => line.trim().startsWith("c_")).length + 1
    );
  });

  it("reports an infeasible solve instead of planning nothing silently", async () => {
    const highs = await realHighs();
    const solution = optimizeCrafts(highs, { ornate_gusset_2: 60, mercurys_lens_2: 20 }, {}, false, { ornate_gusset_3: 2 }, {
      minCrafts: { ornate_gusset_3: 5 },
    });

    expect(solution.infeasible).toBe(true);
    expect(solution.totalXp).toBe(0);
    expect(solution.crafts).toEqual({});
  });
});

describe("optimizeCraftsForGoals", () => {
  it("holds a craft-later goal's materials without crafting it", async () => {
    const highs = await realHighs();
    const inventory = { soul_stone_1: 300 };
    const goal: CraftReservationGoal = { itemId: "soul-stone-2", quantity: 2, craftLater: true };
    const result = optimizeCraftsForGoals(highs, inventory, {}, false, {}, [goal]);
    const held = reserveInventoryForGoals(inventory, {}, [{ itemId: "soul-stone-2", quantity: 2 }]);

    // No requirement to craft it: its fragments are held back, and the plan works with the rest.
    expect(result.constraints!.requirements.keepCopies).toEqual({});
    expect(result.constraints!.steps).toEqual([]);
    expect(result.constraints!.held).toEqual(held.goals[0].keeps);
    expect(result.solution.totalXp).toBe(optimizeCrafts(highs, held.available).totalXp);
    // It holds by choice, so it isn't reported as blocked by limits.
    expect(result.blocked).toEqual([]);
  });

  it("crafts a finishable copies goal in the plan and counts its XP", async () => {
    const highs = await realHighs();
    const inventory = { soul_stone_1: 300 };
    // Without goals all 15 T2 go into one T3.
    const free = optimizeCrafts(highs, inventory);
    expect(free.crafts.soul_stone_3.count).toBe(1);

    const result = optimizeCraftsForGoals(highs, inventory, {}, false, {}, [{ itemId: "soul-stone-2", quantity: 2 }]);

    expect(result.constraints!.requirements.keepCopies).toEqual({ soul_stone_2: 2 });
    expect(result.solution.crafts.soul_stone_2.count).toBe(15);
    expect(result.solution.crafts.soul_stone_3?.count || 0).toBe(0);
    expect(inventoryAfter(result.solution, inventory).soul_stone_2).toBeGreaterThanOrEqual(2);
    expect(result.solution.totalXp).toBe(15 * recipes.soul_stone_2!.xp);
    // Holding the goal's fragments instead (the old model) leaves 13 T2 crafts.
    const held = reserveInventoryForGoals(inventory, {}, [{ itemId: "soul-stone-2", quantity: 2 }]);
    expect(optimizeCrafts(highs, held.available).totalXp).toBe(13 * recipes.soul_stone_2!.xp);
    expectPlanMeetsGoals(inventory, {}, result);
  });

  it("makes at least a craft-count goal's finishable crafts", async () => {
    const highs = await realHighs();
    const inventory = { ornate_gusset_2: 100, mercurys_lens_2: 30, ornate_gusset_3: 4, gold_meteorite_3: 6 };
    const craftCounts = { ornate_gusset_3: 390 };
    const result = optimizeCraftsForGoals(highs, inventory, craftCounts, false, {}, [
      { itemId: "gusset-3", quantity: 400, craftGoal: true },
    ]);

    expect(result.reservations!.goals[0]).toMatchObject({ needed: 10, finishable: 10 });
    expect(result.constraints!.requirements.minCrafts).toEqual({ ornate_gusset_3: 10 });
    expect(result.solution.crafts.ornate_gusset_3.count).toBeGreaterThanOrEqual(10);
    expectPlanMeetsGoals(inventory, craftCounts, result);
  });

  it("crafts the finishable part and holds the unfinishable remainder's tree", async () => {
    const highs = await realHighs();
    // Have 3 soul stone T3: 20 T2 + 100 fragments (5 more T2) finish one (15 T2).
    // The other two hold the 5 T2 and 100 fragments left.
    const inventory = { soul_stone_2: 20, soul_stone_1: 100 };
    const result = optimizeCraftsForGoals(highs, inventory, {}, false, {}, [{ itemId: "soul-stone-3", quantity: 3 }]);
    const goal = result.reservations!.goals[0];

    expect(goal).toMatchObject({ needed: 3, finishable: 1, ownedCopies: 0 });
    expect(goal.finishTake).toEqual({ soul_stone_2: 15 });
    expect(goal.held).toEqual({ soul_stone_2: 5, soul_stone_1: 100 });
    expect(result.constraints!.inventory).toEqual({ soul_stone_2: 15, soul_stone_1: 0 });
    expect(result.solution.crafts.soul_stone_3.count).toBe(1);
    const after = inventoryAfter(result.solution, inventory);
    expect(after.soul_stone_3).toBe(1);
    expect(after.soul_stone_2).toBe(5);
    expect(after.soul_stone_1).toBe(100);
    expectPlanMeetsGoals(inventory, {}, result);
  });

  it("meets several goals sharing one pool together", async () => {
    const highs = await realHighs();
    const inventory = {
      soul_stone_1: 400,
      soul_stone_2: 6,
      ornate_gusset_3: 9,
      ornate_gusset_2: 30,
      mercurys_lens_2: 12,
      gold_meteorite_3: 4,
      gold_meteorite_2: 30,
    };
    const goals: CraftReservationGoal[] = [
      { itemId: "soul-stone-3", quantity: 1 },
      // 220 fragments are left after the T3: 11 of 20.
      { itemId: "soul-stone-2", quantity: 20 },
      { itemId: "gusset-4", quantity: 1 },
      { itemId: "gusset-3", quantity: 400, craftGoal: true },
    ];
    const craftCounts = { ornate_gusset_3: 397 };
    const result = optimizeCraftsForGoals(highs, inventory, craftCounts, false, {}, goals);

    expect(result.blocked).toEqual([]);
    expect(result.reservations!.goals.map((goal) => goal.finishable)).toEqual([1, 11, 1, 3]);
    expect(result.constraints!.requirements).toEqual({
      keepCopies: { soul_stone_3: 1, soul_stone_2: 11, ornate_gusset_4: 1 },
      minCrafts: { ornate_gusset_3: 3 },
    });
    expectPlanMeetsGoals(inventory, craftCounts, result);
  });

  it("keeps random goal sets on real inventory feasible, met, and in the click order", async () => {
    const highs = await realHighs();
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "benchmarks/mission-craft-planner/profile-snapshot-benchmark.json"), "utf8")
    ) as { profile: { inventory: Record<string, number>; craftCounts: Record<string, number> } };
    const { inventory, craftCounts } = snapshot.profile;
    const craftable = Object.keys(recipes).filter((key) => recipes[key]);
    let seed = 99;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 6; round += 1) {
      const goals = Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
        const itemId = craftable[Math.floor(random() * craftable.length)];
        const craftGoal = random() < 0.35;
        return {
          itemId,
          quantity: craftGoal ? (craftCounts[itemId] || 0) + 1 + Math.floor(random() * 30) : 1 + Math.floor(random() * 25),
          craftGoal,
        };
      });
      const result = optimizeCraftsForGoals(highs, inventory, craftCounts, false, {}, goals);

      expect(result.blocked, JSON.stringify(goals)).toEqual([]);
      if (result.constraints) {
        expectPlanMeetsGoals(inventory, craftCounts, result);
      }
    }
  }, 120_000);

  it("falls back to holding a goal's items when a craft limit blocks it", async () => {
    const highs = await realHighs();
    const inventory = { soul_stone_1: 200, ornate_gusset_2: 60, mercurys_lens_2: 20 };
    const goals: CraftReservationGoal[] = [
      { itemId: "gusset-3", quantity: 5 },
      { itemId: "soul-stone-2", quantity: 3 },
    ];
    const result = optimizeCraftsForGoals(highs, inventory, {}, false, { ornate_gusset_3: 0 }, goals);

    expect(result.blocked).toEqual([0]);
    expect(result.solution.infeasible).toBeUndefined();
    expect(result.solution.crafts.ornate_gusset_3?.count || 0).toBe(0);
    // The blocked goal holds what it would have used; the other stays in the plan.
    expect(result.constraints!.held).toMatchObject({ ornate_gusset_2: 30, mercurys_lens_2: 10 });
    expect(result.constraints!.requirements.keepCopies).toEqual({ soul_stone_2: 3 });
    expect(inventoryAfter(result.solution, inventory).soul_stone_2).toBeGreaterThanOrEqual(3);
    expect(inventoryAfter(result.solution, inventory).ornate_gusset_2).toBeGreaterThanOrEqual(30);
  });

  it("solves exactly as before when goals take nothing", async () => {
    const problems: string[] = [];
    const highs: Highs = {
      solve(problem) {
        problems.push(problem);
        return { Columns: {} };
      },
    };
    const inventory = { soul_stone_2: 3 };
    const result = optimizeCraftsForGoals(highs, inventory, { ornate_gusset_3: 450 }, false, {}, [
      { itemId: "gusset-3", quantity: 400, craftGoal: true },
    ]);

    expect(result.reservations).toBeNull();
    expect(problems).toEqual([preGoalProblem(inventory)]);
  });
});

describe("goal crafts first in the Max GE Efficiency Plan", () => {
  it("crafts goals before the efficiency walk and counts their XP, GE and kept copies", () => {
    const inventory = { soul_stone_1: 300, ornate_gusset_2: 12, mercurys_lens_2: 4 };
    const goals: CraftReservationGoal[] = [
      { itemId: "soul-stone-2", quantity: 2 },
      { itemId: "gusset-3", quantity: 400, craftGoal: true },
    ];
    const craftCounts = { ornate_gusset_3: 398 };
    const reservations = reserveInventoryForGoals(inventory, craftCounts, goals);
    const constraints = goalPlanConstraints(inventory, reservations);
    const goalCrafts = simulateGoalCrafts(constraints.inventory, craftCounts, constraints.steps);

    expect(goalCrafts.setAside).toEqual({ soul_stone_2: 2 });
    expect(goalCrafts.crafts).toEqual({ soul_stone_2: 2, ornate_gusset_3: 2 });
    expect(goalCrafts.xp).toBe(2 * recipes.soul_stone_2!.xp + 2 * recipes.ornate_gusset_3!.xp);
    expect(goalCrafts.cost).toBeGreaterThan(0);
    // The craft-count goal's copies stay available; the copies goal's are set aside.
    expect(goalCrafts.inventory).toMatchObject({ soul_stone_1: 260, soul_stone_2: 0, ornate_gusset_3: 2 });

    const walk = simulateGeEfficiencyPlan(
      goalCrafts.inventory,
      goalCrafts.craftCounts,
      [{ artifact: "soul_stone_2", mode: "direct", referenceXpPerGe: 1 }],
      0
    );
    expect(walk.rows[0].craftedCount).toBe(13);
    const totals = goalsFirstGeTotals(goalCrafts, walk, constraints.held);
    expect(totals.totalXp).toBe(goalCrafts.xp + walk.totalXp);
    expect(totals.totalCost).toBe(goalCrafts.cost + walk.totalCost);
    expect(totals.remainingInventory.soul_stone_2).toBe(15);
    expect(totals.remainingInventory.ornate_gusset_3).toBe(2);
  });

  it("keeps owned copies for a copies goal and crafts only the rest", () => {
    const goalCrafts = simulateGoalCrafts({ soul_stone_2: 1, soul_stone_1: 45 }, {}, [
      { artifact: "soul_stone_2", amount: 3, craftGoal: false },
    ]);

    expect(goalCrafts.setAside).toEqual({ soul_stone_2: 3 });
    expect(goalCrafts.crafts).toEqual({ soul_stone_2: 2 });
    expect(goalCrafts.inventory).toMatchObject({ soul_stone_2: 0, soul_stone_1: 5 });
  });
});
