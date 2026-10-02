import {
  reserveInventoryForGoals,
  type CraftReservationGoal,
  type CraftReservations,
} from "./craft-reservations";
import {
  optimizeCrafts,
  type CraftLimits,
  type CraftRequirements,
  type GeEfficiencyPlanResult,
  type GoalCraftSimulation,
  type GoalCraftStep,
  type Highs,
  type Inventory,
  type Solution,
} from "./xp-ge-optimize";

/**
 * Goals inside the XP plan. The part of each goal inventory can finish is a
 * requirement of the plan (a copies goal ends with its copies, a craft-count
 * goal makes its crafts), so the plan crafts it and counts its XP. What the
 * unfinishable remainder holds back is taken out of the inventory the plan
 * sees. A goal whose requirement can't be met (a max-craft limit in the way)
 * falls back to holding everything it takes instead.
 */

export type GoalPlanConstraints = {
  /** The inventory the plan optimizes over: held items taken out. */
  inventory: Inventory;
  requirements: CraftRequirements;
  /** Items held back: unfinishable remainders, plus everything a blocked goal takes. */
  held: Inventory;
  /** Goal crafts in row order, for plans that craft goals first. */
  steps: GoalCraftStep[];
};

export type GoalPlanSolve = {
  solution: Solution;
  /** Null without goals that take anything. */
  reservations: CraftReservations | null;
  /** Goals (row indexes) whose requirement couldn't be met and that hold their items instead. */
  blocked: number[];
  constraints: GoalPlanConstraints | null;
};

/**
 * Requirements for goals in the plan; blocked goals hold everything they take
 * instead. `undecided` goals (while probing which goals fit) ask nothing and
 * hold only their remainder.
 */
export function goalPlanConstraints(
  inventory: Inventory,
  reservations: CraftReservations,
  blocked: ReadonlySet<number> = new Set(),
  undecided: ReadonlySet<number> = new Set()
): GoalPlanConstraints {
  const held: Inventory = { ...reservations.held };
  const keepCopies: Record<string, number> = {};
  const minCrafts: Record<string, number> = {};
  const steps: GoalCraftStep[] = [];
  reservations.goals.forEach((goal, index) => {
    if (!goal.itemKey || goal.finishable <= 0 || undecided.has(index)) {
      return;
    }
    if (blocked.has(index)) {
      for (const [itemKey, count] of Object.entries(goal.finishTake)) {
        held[itemKey] = (held[itemKey] || 0) + count;
      }
      return;
    }
    const target = goal.craftGoal ? minCrafts : keepCopies;
    target[goal.itemKey] = (target[goal.itemKey] || 0) + goal.finishable;
    steps.push({ artifact: goal.itemKey, amount: goal.finishable, craftGoal: goal.craftGoal });
  });
  const planInventory: Inventory = {};
  for (const [itemKey, quantity] of Object.entries(inventory)) {
    planInventory[itemKey] = Math.max(0, (Number(quantity) || 0) - (held[itemKey] || 0));
  }
  return { inventory: planInventory, requirements: { keepCopies, minCrafts }, held, steps };
}

/** Identifies what goals ask of the plan, to skip re-solving edits that change nothing. */
export function goalPlanKey(reservations: CraftReservations | null): string {
  if (!reservations) {
    return "";
  }
  return JSON.stringify({
    held: reservations.held,
    goals: reservations.goals.map((goal) => [goal.itemKey, goal.craftGoal, goal.finishable, goal.finishTake]),
  });
}

/**
 * Maximize XP with the goals' finishable parts required. If the requirements
 * can't all be met (only max-craft limits can cause that), goals are added one
 * at a time in row order and any that can't be met hold their items instead.
 */
export function optimizeCraftsForGoals(
  highs: Highs,
  inventory: Inventory,
  craftCounts: Record<string, number>,
  saleEnabled: boolean,
  craftLimits: CraftLimits,
  goals: CraftReservationGoal[]
): GoalPlanSolve {
  const reservations = goals.length > 0 ? reserveInventoryForGoals(inventory, craftCounts, goals) : null;
  if (!reservations || reservations.totalReserved === 0) {
    return {
      solution: optimizeCrafts(highs, inventory, craftCounts, saleEnabled, craftLimits),
      reservations: null,
      blocked: [],
      constraints: null,
    };
  }
  const solveWith = (blocked: ReadonlySet<number>, undecided: ReadonlySet<number> = new Set()) => {
    const constraints = goalPlanConstraints(inventory, reservations, blocked, undecided);
    return {
      constraints,
      solution: optimizeCrafts(highs, constraints.inventory, craftCounts, saleEnabled, craftLimits, constraints.requirements),
    };
  };

  const first = solveWith(new Set());
  if (!first.solution.infeasible) {
    return { solution: first.solution, reservations, blocked: [], constraints: first.constraints };
  }

  const requiring = reservations.goals
    .map((goal, index) => (goal.itemKey && goal.finishable > 0 ? index : -1))
    .filter((index) => index >= 0);
  const blocked = new Set<number>();
  requiring.forEach((index, position) => {
    const undecided = new Set(requiring.slice(position + 1));
    if (solveWith(blocked, undecided).solution.infeasible) {
      blocked.add(index);
    }
  });
  let final = solveWith(blocked);
  if (final.solution.infeasible) {
    // Holding everything for every goal never needs a craft, so it always solves.
    requiring.forEach((index) => blocked.add(index));
    final = solveWith(blocked);
  }
  return {
    solution: final.solution,
    reservations,
    blocked: [...blocked].sort((left, right) => left - right),
    constraints: final.constraints,
  };
}

export type GoalsFirstGeTotals = {
  totalXp: number;
  totalCost: number;
  /** Left after goal crafts and the efficiency walk, with goal copies and held items still counted. */
  remainingInventory: Inventory;
};

/**
 * The Max GE Efficiency Plan's totals when goal crafts come first: the goal
 * crafts' XP and GE, plus the walk over what they left. Copies set aside for
 * goals and items held for their remainders are still in inventory at the end.
 */
export function goalsFirstGeTotals(
  goalCrafts: GoalCraftSimulation,
  efficiencyPlan: GeEfficiencyPlanResult,
  held: Inventory
): GoalsFirstGeTotals {
  const remainingInventory: Inventory = { ...efficiencyPlan.finalInventory };
  for (const extra of [goalCrafts.setAside, held]) {
    for (const [itemKey, count] of Object.entries(extra)) {
      remainingInventory[itemKey] = (remainingInventory[itemKey] || 0) + count;
    }
  }
  return {
    totalXp: goalCrafts.xp + efficiencyPlan.totalXp,
    totalCost: goalCrafts.cost + efficiencyPlan.totalCost,
    remainingInventory,
  };
}
