"use client";

import Link from "next/link";
import Image from "next/image";
import React, { JSX, useEffect, useMemo, useRef, useState } from "react";

import targetFamilies from "../../data/target-families.json";
import { getArtifactDisplayData, getArtifactDisplayLabel } from "../../lib/artifact-display";
import {
  getCraftingLevelProgress,
  getCraftingLevelThresholds,
  getCraftingLevelTotalXpForLevel,
} from "../../lib/crafting-levels";
import {
  goalReservationCovered,
  planMeetsGoals,
  reserveInventoryForGoals,
  type CraftGoalReservation,
  type CraftReservationGoal,
  type CraftReservations,
} from "../../lib/craft-reservations";
import {
  buildTargetOptions,
  MAX_TARGET_QUANTITY,
  MAX_TARGET_ROWS,
  newTargetRowId,
  normalizedTargetQuantity,
  parseStoredTargetRows,
  inHandInventory,
  plannerRowsToKeepRows,
  readPlannerSavedCraftedOnly,
  readPlannerSavedTargetRows,
  serializeTargetRows,
  targetRowToPlannerTarget,
  type PlannerTargetRow,
} from "../../lib/goal-rows";
import { afxIdToTargetFamilyName, itemIdToCanonicalKey } from "../../lib/item-utils";
import { recipes } from "../../lib/recipes";
import {
  LOCAL_PREF_KEYS,
  readFirstStoredString,
  readStoredBoolean,
  writeStoredBoolean,
  writeStoredString,
} from "../../lib/local-preferences";
import {
  MAX_PRE_PLAN_LAUNCHES_PER_ROW,
  MAX_PRE_PLAN_SEND_ROWS,
  PRE_PLAN_UNTARGETED_TARGET_AFX_ID,
  readSavedPlannerPlan,
  type SavedPlannerPlan,
} from "../../lib/preplan-import";
import useHighsClient from "../../lib/use-highs-client";
import {
  buildMaxXpExecutionPlan,
  CraftLimits,
  Highs,
  MaxXpExecutionPlanNode,
  MaxXpUsageSummary,
  Solution,
  optimizeCrafts,
  simulateGeEfficiencyPlan,
  simulateGoalCrafts,
  withStandaloneComparisons,
  type SequentialMode,
} from "../../lib/xp-ge-optimize";
import {
  goalPlanKey,
  goalsFirstGeTotals,
  optimizeCraftsForGoals,
  type GoalPlanSolve,
} from "../../lib/xp-goal-plan";
import { XP_GE_CRAFT_COPY } from "../../lib/xp-ge-craft-copy";
import { craftRunOdds, resolveShinyGoalTargets, SHINY_RARITY_LABELS, type ShinyRarity } from "../../lib/shiny-odds";
import GoalRowsEditor from "../goal-rows-editor";
import ProfileCustomizer, { useProfileOverrides } from "../profile-customizer";
import { profileOverrideCount, type ProfileOverrides, type ProfileSummary } from "../../lib/profile-overrides";
import { shipDisplayName as titleCaseShip } from "../../lib/ship-data";
import styles from "./page.module.css";

type SortKey = "xpPerGe" | "xp" | "tierXpPerGe" | "familyTier" | "name";
type InventorySource = "main" | "virtue";
type MaxXpPlanView = "tree" | "flat";
type CraftingXpZoomMode = "level" | "full";
type MaxXpFlatSortKey = "artifact" | "tier" | "manualCrafts" | "autoCrafts" | "xp" | "cost" | "netRemaining" | "usedBy";
type SortDirection = "asc" | "desc";
type PrePlanDurationType = "SHORT" | "LONG" | "EPIC";
type PrePlanSendRow = {
  id: string;
  ship: string;
  durationType: PrePlanDurationType;
  targetAfxId: number;
  launches: number;
};
type PrePlanSendRowResult = {
  startLevel: number;
  endLevel: number;
  maxLevel: number;
  appliedLaunches: number;
  skippedLaunches: number;
  noLootLaunches: number;
};
type ShipStars = { ship: string; unlocked: boolean; level: number; maxLevel: number };
type InFlightResult = {
  /** Ships in the air for this inventory source, counted or not. */
  missionCount: number;
  included: boolean;
  addedInventory: Record<string, number>;
  rows: Array<{ ship: string; durationType: PrePlanDurationType; level: number; targetAfxId: number; launches: number }>;
};
type InventoryResponse = {
  inventory?: Record<string, number>;
  craftCounts?: Record<string, number>;
  craftingXp?: number;
  shinyIngredientCount?: number;
  /** The backup's own values, before any customized profile. */
  realProfile?: ProfileSummary;
  shipLevels?: ShipStars[];
  inFlight?: InFlightResult;
  prePlanSends?: {
    addedInventory?: Record<string, number>;
    appliedLaunches?: number;
    skippedLaunches?: number;
    noLootLaunches?: number;
    /** Per requested send, in order. */
    rows?: Array<PrePlanSendRowResult | null>;
  };
  error?: string;
  details?: string;
};

type ShinyIngredientFlags = {
  rare: boolean;
  epic: boolean;
  legendary: boolean;
};

type ModeComparisonRow = {
  key: string;
  artifact: string;
  mode: SequentialMode;
  modeLabel: string;
  count: number;
  xp: number;
  cost: number;
  xpPerGe: number;
};

type ExecutionPlanRow = {
  key: string;
  artifact: string;
  mode: "click" | "auto";
  count: number;
  xp: number;
  cost: number;
  depth: number;
  prefix: string;
  usage?: MaxXpUsageSummary;
};

type FlatPlanRow = {
  artifact: string;
  familyKey: string;
  tier: number;
  manualCrafts: number;
  autoCrafts: number;
  xp: number;
  cost: number;
  netRemaining: number;
  usedBy: string;
  usage: MaxXpUsageSummary;
};

type ConsumedIngredientRow = {
  artifact: string;
  familyKey: string;
  tier: number;
  inventoryConsumed: number;
  netRemaining: number;
  usedBy: string;
  usage: MaxXpUsageSummary;
};

type EfficiencyStatusKind = "full" | "partial" | "blocked" | "belowThreshold";

type EfficiencyStatus = {
  kind: EfficiencyStatusKind;
  realizedCount: number;
  label: string;
  title: string;
};

type InventoryMatrixFamily = {
  key: string;
  label: string;
};

type InventoryMatrixRow = {
  label: string;
  counts: number[];
};

type SolveInputs = {
  inventory: Record<string, number>;
  craftCounts: Record<string, number>;
  sale: boolean;
  limits: CraftLimits;
  /** What goals ask of the plan (goalPlanKey). */
  goalKey: string;
};

/** The plan without goals, to price what the goals cost. */
type PlanBaseline = Omit<SolveInputs, "goalKey"> & {
  totalXp: number;
  crafts: Record<string, number>;
};

/** How the shown solution handled goals. */
type SolvedGoalPlan = Omit<GoalPlanSolve, "solution"> & { goalKey: string };

type OptimizePayload = {
  solution: Solution;
  goalPlan: SolvedGoalPlan;
  inventory: Record<string, number>;
  craftCounts: Record<string, number>;
  craftingXp: number;
  shinyIngredientCount: number;
  shipLevels: ShipStars[];
  realProfile: ProfileSummary | null;
  inFlight: InFlightResult | null;
  prePlanSends?: InventoryResponse["prePlanSends"];
};

const SHARED_EID_KEYS = [LOCAL_PREF_KEYS.sharedEid, LOCAL_PREF_KEYS.legacyEid] as const;
const SHARED_INCLUDE_SLOTTED_KEYS = [LOCAL_PREF_KEYS.sharedIncludeSlotted, LOCAL_PREF_KEYS.legacyIncludeSlotted] as const;
const SHARED_CRAFTING_SALE_KEYS = [LOCAL_PREF_KEYS.sharedCraftingSale] as const;
// Goal edits reach the solver after a short pause: a solve can block the page for up to a second.
const GOAL_APPLY_DELAY_MS = 600;
const GOAL_TARGET_OPTIONS = buildTargetOptions();
const GOAL_COPIES_TITLE = "Have this many copies when the plan is done. Copies you own count first; the plan crafts the rest it can.";
const GOAL_CRAFT_COUNT_TITLE =
  "Reach this many all-time crafts; the plan makes the crafts it can. 400 maxes shiny luck; 300 maxes the GE discount. Copies you own don't count.";
const PRE_PLAN_UNTARGETED_ONLY_SHIPS = new Set(["CHICKEN_ONE", "CHICKEN_NINE", "CHICKEN_HEAVY", "BCR"]);
const PRE_PLAN_SHIPS = [
  "ATREGGIES",
  "HENERPRISE",
  "VOYEGGER",
  "CHICKFIANT",
  "GALEGGTICA",
  "CORELLIHEN_CORVETTE",
  "MILLENIUM_CHICKEN",
  "BCR",
  "CHICKEN_HEAVY",
  "CHICKEN_NINE",
  "CHICKEN_ONE",
];
const PRE_PLAN_DURATIONS: Array<{ value: PrePlanDurationType; label: string }> = [
  { value: "SHORT", label: "Short" },
  { value: "LONG", label: "Standard" },
  { value: "EPIC", label: "Extended" },
];
const PRE_PLAN_TARGET_OPTIONS = [
  { afxId: PRE_PLAN_UNTARGETED_TARGET_AFX_ID, label: "Untargeted" },
  ...Object.values(
    targetFamilies as Record<string, { afxId: number; name: string; representativeItemId: string | null }>
  )
    .filter((entry) => Number.isFinite(entry.afxId) && entry.representativeItemId)
    .map((entry) => ({ afxId: entry.afxId, label: entry.name }))
    .sort((a, b) => a.label.localeCompare(b.label)),
];
const INVENTORY_MATRIX_FAMILIES: InventoryMatrixFamily[] = [
  { key: "tachyon_deflector", label: "Deflector" },
  { key: "dilithium_monocle", label: "Monocle" },
  { key: "quantum_metronome", label: "Metronome" },
  { key: "carved_rainstick", label: "Rainstick" },
  { key: "beak_of_midas", label: "Beak" },
  { key: "ornate_gusset", label: "Gusset" },
  { key: "neodymium_medallion", label: "Medallion" },
  { key: "lunar_totem", label: "Totem" },
  { key: "mercurys_lens", label: "Lens" },
  { key: "interstellar_compass", label: "Compass" },
  { key: "puzzle_cube", label: "Cube" },
  { key: "aurelian_brooch", label: "Brooch" },
  { key: "the_chalice", label: "Chalice" },
  { key: "titanium_actuator", label: "Actuator" },
  { key: "demeters_necklace", label: "Necklace" },
  { key: "tungsten_ankh", label: "Ankh" },
  { key: "vial_martian_dust", label: "Vial" },
  { key: "book_of_basan", label: "Book" },
  { key: "ship_in_a_bottle", label: "Ship" },
  { key: "phoenix_feather", label: "Feather" },
  { key: "light_of_eggendil", label: "LoE" },
  { key: "clarity_stone", label: "Clarity stone" },
  { key: "dilithium_stone", label: "Dilithium stone" },
  { key: "life_stone", label: "Life stone" },
  { key: "lunar_stone", label: "Lunar stone" },
  { key: "prophecy_stone", label: "Prophecy stone" },
  { key: "quantum_stone", label: "Quantum stone" },
  { key: "shell_stone", label: "Shell stone" },
  { key: "soul_stone", label: "Soul stone" },
  { key: "tachyon_stone", label: "Tachyon stone" },
  { key: "terra_stone", label: "Terra stone" },
  { key: "gold_meteorite", label: "Gold" },
  { key: "solar_titanium", label: "Titanium" },
  { key: "tau_ceti_geode", label: "Geode" },
];

function goalRowToReservationGoal(row: PlannerTargetRow): CraftReservationGoal {
  const target = targetRowToPlannerTarget(row);
  const later = target.craftLater ? { craftLater: true } : {};
  return target.shinyRarity
    ? { itemId: target.targetItemId, quantity: target.quantity, shinyRarity: target.shinyRarity, ...later }
    : { itemId: target.targetItemId, quantity: target.quantity, craftGoal: target.craftGoal, ...later };
}

/**
 * Shiny goals as the craft counts that give their chance from crafting alone,
 * counted from this profile's craft counts and crafting XP: the chance runs
 * from now, so each calculate aims for it afresh. Other goals pass through,
 * one for one, so results still line up with the rows.
 */
function resolveShinyGoals(
  goals: CraftReservationGoal[],
  craftCounts: Record<string, number>,
  craftingXp: number
): CraftReservationGoal[] {
  if (!goals.some((goal) => goal.shinyRarity)) {
    return goals;
  }
  const { targets } = resolveShinyGoalTargets(
    goals.map((goal) => ({
      targetItemId: goal.itemId,
      quantity: goal.quantity,
      craftGoal: goal.craftGoal,
      shinyRarity: goal.shinyRarity,
    })),
    { craftCounts, craftingXp }
  );
  return targets.map((target, index) => ({
    itemId: target.targetItemId,
    quantity: target.quantity,
    craftGoal: target.craftGoal,
    ...(goals[index].craftLater ? { craftLater: true } : {}),
  }));
}

/** Goal rows with an item picked, as reservation goals. */
function goalRowsToReservationGoals(rows: PlannerTargetRow[]): CraftReservationGoal[] {
  return rows.filter((row) => row.itemId).map(goalRowToReservationGoal);
}

function parseGoalsKey(key: string): CraftReservationGoal[] {
  try {
    const parsed = JSON.parse(key) as unknown;
    return Array.isArray(parsed) ? (parsed as CraftReservationGoal[]) : [];
  } catch {
    return [];
  }
}

/** What goals take from this inventory, or null when they take nothing (the plan ignores them). */
function reservationsFor(
  inventory: Record<string, number>,
  craftCounts: Record<string, number>,
  craftingXp: number,
  goals: CraftReservationGoal[]
): CraftReservations | null {
  if (goals.length === 0) {
    return null;
  }
  const reservations = reserveInventoryForGoals(inventory, craftCounts, resolveShinyGoals(goals, craftCounts, craftingXp));
  return reservations.totalReserved > 0 ? reservations : null;
}

function solveForGoals(
  highs: Highs,
  inventory: Record<string, number>,
  craftCounts: Record<string, number>,
  craftingXp: number,
  saleEnabled: boolean,
  craftLimits: CraftLimits,
  goals: CraftReservationGoal[]
): { solution: Solution; goalPlan: SolvedGoalPlan } {
  const { solution, ...goalPlan } = optimizeCraftsForGoals(
    highs,
    inventory,
    craftCounts,
    saleEnabled,
    craftLimits,
    resolveShinyGoals(goals, craftCounts, craftingXp)
  );
  return { solution, goalPlan: { ...goalPlan, goalKey: goalPlanKey(goalPlan.reservations) } };
}

function addCountMaps(base: Record<string, number>, extra: Record<string, number>): Record<string, number> {
  const sum = { ...base };
  for (const [itemKey, count] of Object.entries(extra)) {
    sum[itemKey] = (sum[itemKey] || 0) + count;
  }
  return sum;
}

function plannedCraftCounts(solution: Solution): Record<string, number> {
  return Object.fromEntries(Object.entries(solution.crafts).map(([artifact, craft]) => [artifact, craft.count]));
}

const GOAL_LIST_LIMIT = 4;

function formatGoalItemList(counts: Record<string, number>, limit = GOAL_LIST_LIMIT): string {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  const shown = entries
    .slice(0, limit)
    .map(([itemKey, count]) => `${count.toLocaleString()}× ${getArtifactDisplayLabel(itemKey)}`);
  return entries.length > limit ? `${shown.join(", ")}, +${entries.length - limit} more` : shown.join(", ");
}

/** How much of a goal inventory can't finish yet, or null when it is covered. */
function goalShortfallText(goal: CraftGoalReservation): string | null {
  if (goalReservationCovered(goal)) {
    return null;
  }
  const needed = goal.needed.toLocaleString();
  const finishable = goal.finishable.toLocaleString();
  if (goal.craftGoal) {
    return goal.finishable > 0
      ? `Can craft ${finishable} of the ${needed} still to go from inventory`
      : `Can't craft any of the ${needed} still to go from inventory yet`;
  }
  return goal.finishable > 0
    ? `Can finish ${finishable} of ${needed} from inventory`
    : `Can't finish ${needed}× ${getArtifactDisplayLabel(goal.itemKey)} from inventory yet`;
}

/** What the plan does for a goal: crafts in the plan, owned copies it keeps. */
function goalPlanText(goal: CraftGoalReservation): string | null {
  const label = getArtifactDisplayLabel(goal.itemKey);
  const crafts = goal.craftGoal ? goal.finishable : goal.finishable - goal.ownedCopies;
  if (crafts > 0) {
    const owned = goal.ownedCopies > 0 ? `, keeps ${goal.ownedCopies.toLocaleString()} you own` : "";
    return `Crafts ${crafts.toLocaleString()}× ${label} in this plan${owned}`;
  }
  return goal.ownedCopies > 0 ? `Keeps ${goal.ownedCopies.toLocaleString()}× ${label} you own` : null;
}

/**
 * A copies goal is a total to end up with, not copies on top of what you own
 * (the attainment planner's "×N" means N more), so spell out how the total splits.
 */
function goalCopiesBreakdownText(goal: CraftGoalReservation, owned: number, ownedExpected: number): string | null {
  if (goal.craftGoal || owned <= 0 || goal.quantity <= 0) {
    return null;
  }
  const fromSends = ownedExpected > 0 ? ` (incl. ${ownedExpected.toLocaleString()} expected mission drops)` : "";
  if (owned >= goal.quantity) {
    const more = owned + goal.quantity;
    const hint =
      more <= MAX_TARGET_QUANTITY
        ? ` Enter ${more.toLocaleString()} to end up with ${goal.quantity.toLocaleString()} more.`
        : "";
    return `You own ${owned.toLocaleString()}${fromSends}, so this is covered.${hint}`;
  }
  return `${goal.quantity.toLocaleString()} total = ${owned.toLocaleString()} owned${fromSends} + ${(
    goal.quantity - owned
  ).toLocaleString()} more`;
}

function GoalReservationLine({
  goal,
  blocked,
  owned,
  ownedExpected,
}: {
  goal: CraftGoalReservation | undefined;
  /** Max-craft limits stop the plan crafting it, so it holds everything it takes. */
  blocked: boolean;
  /** Whole copies of the goal's artifact in the plan's inventory. */
  owned: number;
  /** How many of those are expected drops (ships in the air, pre-plan sends). */
  ownedExpected: number;
}): JSX.Element | null {
  if (!goal || !goal.itemKey) {
    return null;
  }
  // A "craft later" goal holds everything it would use, as a blocked one does.
  const holdsAll = blocked || goal.craftLater;
  const holds = holdsAll ? goal.keeps : goal.held;
  const holdsList = formatGoalItemList(holds);
  const holdsTitle = formatGoalItemList(holds, Number.MAX_SAFE_INTEGER);
  const planText = holdsAll ? null : goalPlanText(goal);
  const shortfall = goalShortfallText(goal);
  const breakdown = goalCopiesBreakdownText(goal, owned, ownedExpected);
  return (
    <div className={styles.goalReservation}>
      {shortfall ? (
        <span
          className={styles.goalShort}
          title={`Missing from inventory: ${formatGoalItemList(goal.short, Number.MAX_SAFE_INTEGER)}`}
        >
          {shortfall}
        </span>
      ) : (
        <span className={styles.goalCovered}>Covered</span>
      )}
      {breakdown && <span className={styles.goalKeeps}>{breakdown}</span>}
      {blocked && !goal.craftLater && <span className={styles.goalShort}>Max-craft limits block it, so it holds its items</span>}
      {goal.craftLater && <span className={styles.goalKeeps}>Not crafted in this plan</span>}
      {planText && <span className={styles.goalKeeps}>{planText}</span>}
      {holdsList && (
        <span className={styles.goalKeeps} title={`Holds ${holdsTitle}`}>
          Holds {holdsList}
          {goal.craftLater ? " for later" : ""}
        </span>
      )}
    </div>
  );
}

async function getOptimalCrafts(
  highs: Highs,
  eid: string,
  includeSlotted: boolean,
  includeFragments: boolean,
  includeShiny: ShinyIngredientFlags,
  saleEnabled: boolean,
  inventorySource: InventorySource,
  craftLimits: CraftLimits,
  prePlanSends: PrePlanSendRow[],
  includeInFlight: boolean,
  goals: CraftReservationGoal[],
  profileOverrides: ProfileOverrides
): Promise<OptimizePayload> {
  const body = {
    eid,
    includeSlotted: includeSlotted ? "true" : "false",
    includeInventoryFragments: includeFragments ? "true" : "false",
    includeInventoryRare: includeShiny.rare ? "true" : "false",
    includeInventoryEpic: includeShiny.epic ? "true" : "false",
    includeInventoryLegendary: includeShiny.legendary ? "true" : "false",
    inventorySource,
    includeInFlight: includeInFlight ? "true" : "false",
    ...(profileOverrideCount(profileOverrides) > 0 ? { profileOverrides } : {}),
    // Unfiltered, so the per-row results line up with the rows on screen.
    prePlanSends: prePlanSends.map((send) => ({
      ship: send.ship,
      durationType: send.durationType,
      targetAfxId: send.targetAfxId,
      launches: send.launches,
    })),
  };
  const response = await fetch("/api/inventory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: InventoryResponse | null = null;
  try {
    data = (await response.json()) as InventoryResponse;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = data?.details || data?.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  if (!data?.inventory) {
    throw new Error("No inventory data returned from the server.");
  }
  const inventory = data.inventory;
  const craftCounts = data.craftCounts || {};
  const craftingXp = Math.max(0, Math.floor(data.craftingXp || 0));
  // Goals are crafted in the plan as far as inventory allows; their unfinishable remainders are held back.
  return {
    ...solveForGoals(highs, inventory, craftCounts, craftingXp, saleEnabled, craftLimits, goals),
    inventory,
    craftCounts,
    craftingXp,
    shinyIngredientCount: Math.max(0, Math.floor(data.shinyIngredientCount || 0)),
    shipLevels: data.shipLevels || [],
    realProfile: data.realProfile || null,
    inFlight: data.inFlight || null,
    prePlanSends: data.prePlanSends,
  };
}

function durationTypeLabel(durationType: PrePlanDurationType): string {
  return PRE_PLAN_DURATIONS.find((entry) => entry.value === durationType)?.label || durationType;
}

function prePlanSendLabel(send: PrePlanSendRow): string {
  return `${send.launches.toLocaleString()}x ${titleCaseShip(send.ship)} ${durationTypeLabel(send.durationType)} / ${afxIdToTargetFamilyName(send.targetAfxId)}`;
}

/** Where a send row leaves its ship, and the launches that didn't play out as asked. */
function prePlanRowOutcome(result: PrePlanSendRowResult): { stars: string | null; warnings: string[] } {
  let stars: string | null = null;
  if (result.appliedLaunches > 0) {
    const max = result.maxLevel > 0 && result.endLevel >= result.maxLevel ? " (max)" : "";
    stars =
      result.startLevel === result.endLevel
        ? `${result.endLevel}⭐${max}`
        : `${result.startLevel}⭐ → ${result.endLevel}⭐${max}`;
  }
  const warnings: string[] = [];
  if (result.skippedLaunches > 0) {
    warnings.push(`${result.skippedLaunches.toLocaleString()} skipped: ship not unlocked yet`);
  }
  if (result.noLootLaunches > 0) {
    warnings.push(`${result.noLootLaunches.toLocaleString()} add stars but no items (too little loot data)`);
  }
  return { stars, warnings };
}

function sameSend(left: Omit<PrePlanSendRow, "id">, right: Omit<PrePlanSendRow, "id">): boolean {
  return (
    left.ship === right.ship &&
    left.durationType === right.durationType &&
    left.targetAfxId === right.targetAfxId &&
    left.launches === right.launches
  );
}

/** Whether `run` already sits in `sends` as consecutive rows. */
function containsSendRun(sends: PrePlanSendRow[], run: Array<Omit<PrePlanSendRow, "id">>): boolean {
  if (run.length === 0 || run.length > sends.length) {
    return false;
  }
  for (let start = 0; start + run.length <= sends.length; start += 1) {
    if (run.every((send, offset) => sameSend(sends[start + offset], send))) {
      return true;
    }
  }
  return false;
}

function prePlanSendsSignature(sends: PrePlanSendRow[]): string {
  return JSON.stringify(
    sends.map((send) => ({
      ship: send.ship,
      durationType: send.durationType,
      targetAfxId: send.targetAfxId,
      launches: send.launches,
    }))
  );
}

function positiveAdditions(addedInventory: Record<string, number> | undefined): Array<[string, number]> {
  return Object.entries(addedInventory || {})
    .filter(([, quantity]) => quantity > 0)
    .sort((a, b) => b[1] - a[1] || getArtifactDisplayLabel(a[0]).localeCompare(getArtifactDisplayLabel(b[0])));
}

/** Expected drops the plan inventory includes, by where they come from. */
function formatExpectedAdditionsTooltip(sections: Array<{ title: string; added: Record<string, number> | undefined }>): string {
  const lines: string[] = [];
  for (const section of sections) {
    const rows = positiveAdditions(section.added);
    if (rows.length === 0) {
      continue;
    }
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(
      section.title,
      ...rows.map(([itemKey, quantity]) => `${getArtifactDisplayLabel(itemKey)}: ${quantity.toFixed(quantity >= 10 ? 1 : 3)}`)
    );
  }
  return lines.join("\n");
}

function parseStoredPrePlanSends(raw: string | null): PrePlanSendRow[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((value, index): PrePlanSendRow | null => {
        if (!value || typeof value !== "object") {
          return null;
        }
        const record = value as Partial<PrePlanSendRow>;
        const durationType = record.durationType;
        if (
          typeof record.ship !== "string" ||
          !PRE_PLAN_SHIPS.includes(record.ship) ||
          (durationType !== "SHORT" && durationType !== "LONG" && durationType !== "EPIC")
        ) {
          return null;
        }
        const launches = Math.max(1, Math.min(MAX_PRE_PLAN_LAUNCHES_PER_ROW, Math.round(Number(record.launches) || 1)));
        const targetAfxId = PRE_PLAN_UNTARGETED_ONLY_SHIPS.has(record.ship)
          ? PRE_PLAN_UNTARGETED_TARGET_AFX_ID
          : Math.round(Number(record.targetAfxId) || PRE_PLAN_UNTARGETED_TARGET_AFX_ID);
        return {
          id: typeof record.id === "string" && record.id ? record.id : `saved-${index}-${record.ship}-${durationType}-${targetAfxId}`,
          ship: record.ship,
          durationType,
          targetAfxId,
          launches,
        };
      })
      .filter((row): row is PrePlanSendRow => row !== null)
      .slice(0, MAX_PRE_PLAN_SEND_ROWS);
  } catch {
    return [];
  }
}

function getModeRowKey(artifact: string, mode: SequentialMode): string {
  return `${artifact}:${mode}`;
}

function getSortedArtifacts(solution: Solution, sortKey: SortKey): string[] {
  const keys = Object.keys(solution.crafts);

  const compareByName = (a: string, b: string): number => getArtifactDisplayLabel(a).localeCompare(getArtifactDisplayLabel(b));
  const familyKey = (artifact: string): string => artifact.replace(/_\d+$/, "");
  const getTierNumber = (artifact: string): number => {
    const display = getArtifactDisplayData(artifact);
    if (display && Number.isFinite(display.tierNumber)) {
      return display.tierNumber;
    }
    const match = artifact.match(/_(\d+)$/);
    if (!match) {
      return Number.MAX_SAFE_INTEGER;
    }
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  };
  const compareByFamilyTier = (a: string, b: string): number => {
    const familyCompare = familyKey(a).localeCompare(familyKey(b));
    if (familyCompare !== 0) {
      return familyCompare;
    }
    const tierCompare = getTierNumber(a) - getTierNumber(b);
    if (tierCompare !== 0) {
      return tierCompare;
    }
    return compareByName(a, b);
  };

  switch (sortKey) {
    case "name":
      return keys.sort(compareByName);
    case "xp":
      return keys.sort((a, b) => solution.crafts[b].xp - solution.crafts[a].xp || compareByName(a, b));
    case "xpPerGe":
      return keys.sort((a, b) => solution.crafts[b].xpPerGe - solution.crafts[a].xpPerGe || compareByName(a, b));
    case "tierXpPerGe":
      return keys.sort(
        (a, b) =>
          getTierNumber(b) - getTierNumber(a) ||
          solution.crafts[b].xpPerGe - solution.crafts[a].xpPerGe ||
          compareByName(a, b)
      );
    case "familyTier":
      return keys.sort(compareByFamilyTier);
    default:
      return keys.sort();
  }
}

function getModeComparisonRows(solution: Solution, sortKey: SortKey): ModeComparisonRow[] {
  const rows: ModeComparisonRow[] = [];
  for (const artifact of getSortedArtifacts(solution, sortKey)) {
    const craft = solution.crafts[artifact];
    rows.push({
      key: getModeRowKey(artifact, "direct"),
      artifact,
      mode: "direct",
      modeLabel: "direct craft",
      count: craft.modeComparison.direct.count,
      xp: craft.modeComparison.direct.xp,
      cost: craft.modeComparison.direct.cost,
      xpPerGe: craft.modeComparison.direct.xpPerGe,
    });
    if (craft.modeComparison.auto) {
      const autoExtraCount = Math.max(0, craft.modeComparison.auto.count - craft.modeComparison.direct.count);
      if (autoExtraCount > 0) {
        // Auto mode's XP includes the ingredients it auto-crafts, as its cost does.
        const autoExtraXp = Math.max(0, craft.modeComparison.auto.xp - craft.modeComparison.direct.xp);
        const autoExtraCost = Math.max(0, craft.modeComparison.auto.cost - craft.modeComparison.direct.cost);
        rows.push({
          key: getModeRowKey(artifact, "auto"),
          artifact,
          mode: "auto",
          modeLabel: "auto-craftable beyond direct",
          count: autoExtraCount,
          xp: autoExtraXp,
          cost: autoExtraCost,
          xpPerGe: autoExtraCost > 0 ? autoExtraXp / autoExtraCost : 0,
        });
      }
    }
  }

  switch (sortKey) {
    case "xp":
      return rows.sort(
        (a, b) =>
          b.xp - a.xp ||
          getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)) ||
          a.modeLabel.localeCompare(b.modeLabel)
      );
    case "xpPerGe":
      return rows.sort(
        (a, b) =>
          b.xpPerGe - a.xpPerGe ||
          getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)) ||
          a.modeLabel.localeCompare(b.modeLabel)
      );
    case "tierXpPerGe":
      return rows.sort((a, b) => {
        const tierA = getArtifactDisplayData(a.artifact)?.tierNumber ?? Number(a.artifact.match(/_(\d+)$/)?.[1] || Number.MAX_SAFE_INTEGER);
        const tierB = getArtifactDisplayData(b.artifact)?.tierNumber ?? Number(b.artifact.match(/_(\d+)$/)?.[1] || Number.MAX_SAFE_INTEGER);
        if (tierA !== tierB) {
          return tierB - tierA;
        }
        return (
          b.xpPerGe - a.xpPerGe ||
          getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)) ||
          a.modeLabel.localeCompare(b.modeLabel)
        );
      });
    case "name":
    default:
      return rows.sort(
        (a, b) =>
          getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)) ||
          a.modeLabel.localeCompare(b.modeLabel)
      );
    case "familyTier":
      return rows.sort((a, b) => {
        const familyA = a.artifact.replace(/_\d+$/, "");
        const familyB = b.artifact.replace(/_\d+$/, "");
        const familyCompare = familyA.localeCompare(familyB);
        if (familyCompare !== 0) {
          return familyCompare;
        }

        const tierA = getArtifactDisplayData(a.artifact)?.tierNumber ?? Number(a.artifact.match(/_(\d+)$/)?.[1] || Number.MAX_SAFE_INTEGER);
        const tierB = getArtifactDisplayData(b.artifact)?.tierNumber ?? Number(b.artifact.match(/_(\d+)$/)?.[1] || Number.MAX_SAFE_INTEGER);
        if (tierA !== tierB) {
          return tierA - tierB;
        }

        return (
          getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)) ||
          a.modeLabel.localeCompare(b.modeLabel)
        );
      });
  }
}

function getExecutionPlanRows(
  nodes: MaxXpExecutionPlanNode[],
  usageByArtifact: Record<string, MaxXpUsageSummary> = {}
): ExecutionPlanRow[] {
  const rows: ExecutionPlanRow[] = [];

  const walk = (
    node: MaxXpExecutionPlanNode,
    key: string,
    depth: number,
    ancestorHasNext: boolean[],
    isRoot: boolean,
    isLast: boolean
  ): void => {
    const prefix = isRoot
      ? ""
      : `${ancestorHasNext.map((hasNext) => (hasNext ? "|  " : "   ")).join("")}|_ `;
    rows.push({
      key,
      artifact: node.artifact,
      mode: node.mode,
      count: node.count,
      xp: node.xp,
      cost: node.cost,
      depth,
      prefix,
      usage: usageByArtifact[node.artifact],
    });

    node.children.forEach((child, index) => {
      walk(child, `${key}.${index}`, depth + 1, [...ancestorHasNext, !isLast], false, index === node.children.length - 1);
    });
  };

  nodes.forEach((node, index) => {
    walk(node, `execution-${index}`, 0, [], true, index === nodes.length - 1);
  });

  return rows;
}

function normalizeCraftLimitInputs(inputs: Record<string, string>): CraftLimits {
  const limits: CraftLimits = {};
  for (const [artifact, rawValue] of Object.entries(inputs)) {
    const trimmed = rawValue.trim();
    if (trimmed === "") {
      continue;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      continue;
    }
    limits[artifact] = Math.max(0, Math.round(parsed));
  }
  return limits;
}

function craftLimitsToInputs(limits: CraftLimits): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const [artifact, limit] of Object.entries(limits)) {
    if (Number.isFinite(limit) && limit >= 0) {
      inputs[artifact] = String(Math.max(0, Math.round(limit)));
    }
  }
  return inputs;
}

function craftLimitsEqual(left: CraftLimits, right: CraftLimits): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? null) !== (right[key] ?? null)) {
      return false;
    }
  }
  return true;
}

function parseStoredCraftLimits(raw: string | null): CraftLimits {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const limits: CraftLimits = {};
    for (const [artifact, value] of Object.entries(parsed)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric >= 0) {
        limits[artifact] = Math.max(0, Math.round(numeric));
      }
    }
    return limits;
  } catch {
    return {};
  }
}

function formatUsedBy(usage: MaxXpUsageSummary | undefined): string {
  const entries = getUsedByEntries(usage);
  if (entries.length === 0) {
    return "";
  }
  return entries
    .map(([artifact, quantity]) => `${getArtifactDisplayLabel(artifact)} x${quantity.toLocaleString()}`)
    .join(", ");
}

function formatConsumes(usage: MaxXpUsageSummary | undefined): string {
  if (!usage) {
    return "";
  }
  const recipe = recipes[usage.artifact];
  const totalCrafts = Math.max(0, Math.round(usage.manualCrafts + usage.autoCrafts));
  if (!recipe || totalCrafts <= 0) {
    return "";
  }
  return Object.entries(recipe.ingredients)
    .filter(([, quantity]) => quantity > 0)
    .sort((a, b) => getArtifactDisplayLabel(a[0]).localeCompare(getArtifactDisplayLabel(b[0])))
    .map(([artifact, quantity]) => `${getArtifactDisplayLabel(artifact)} x${(quantity * totalCrafts).toLocaleString()}`)
    .join(", ");
}

function getUsedByEntries(usage: MaxXpUsageSummary | undefined): Array<[string, number]> {
  if (!usage) {
    return [];
  }
  return Object.entries(usage.consumedBy)
    .filter(([, quantity]) => quantity > 0)
    .sort((a, b) => b[1] - a[1] || getArtifactDisplayLabel(a[0]).localeCompare(getArtifactDisplayLabel(b[0])));
}

function UsedByIcons({ usage }: { usage: MaxXpUsageSummary | undefined }): JSX.Element {
  const entries = getUsedByEntries(usage);
  const tooltip = formatUsedBy(usage);
  if (entries.length === 0) {
    return <span className={styles.usedByEmpty}>-</span>;
  }
  return (
    <span className={styles.usedByIcons} title={tooltip}>
      {entries.slice(0, 8).map(([artifact, quantity]) => {
        const displayData = getArtifactDisplayData(artifact);
        const label = `${getArtifactDisplayLabel(artifact)} x${quantity.toLocaleString()}`;
        return (
          <span key={artifact} className={styles.usedByIcon} title={tooltip} aria-label={label}>
            {displayData ? (
              <img src={displayData.smallIconUrl} alt="" className={styles.usedByIconImage} loading="lazy" />
            ) : (
              <span className={styles.usedByFallback} aria-hidden="true">?</span>
            )}
          </span>
        );
      })}
      {entries.length > 8 && <span className={styles.usedByMore}>+{entries.length - 8}</span>}
    </span>
  );
}

function getUsageTooltip(usage: MaxXpUsageSummary | undefined): string {
  if (!usage) {
    return "";
  }
  const lines = [
    `Starting inventory: ${usage.startingInventory.toLocaleString()}`,
    `Inventory consumed: ${usage.inventoryConsumed.toLocaleString()}`,
  ];
  const usedBy = formatUsedBy(usage);
  if (usedBy) {
    lines.push(`Used by: ${usedBy}`);
  }
  const consumes = formatConsumes(usage);
  if (consumes) {
    lines.push(`Consumes: ${consumes}`);
  }
  return lines.join("\n");
}

function formatCraftingLevelLine(xp: number): string {
  const progress = getCraftingLevelProgress(xp);
  return `Level ${progress.level} · ${progress.xp.toLocaleString()} XP`;
}

function getCraftingLevelTooltip(xp: number): string {
  const progress = getCraftingLevelProgress(xp);
  if (progress.nextLevelXp == null || progress.xpForLevel == null) {
    return `Level ${progress.level}\nMax crafting level reached.`;
  }
  const remaining = Math.max(0, progress.nextLevelXp - progress.xp);
  return [
    `Level ${progress.level}`,
    `${progress.xpIntoLevel.toLocaleString()} / ${progress.xpForLevel.toLocaleString()} XP in current level`,
    `${remaining.toLocaleString()} XP to level ${progress.level + 1}`,
  ].join("\n");
}

function formatCompactXp(value: number): string {
  const safeValue = Math.max(0, Math.floor(value));
  if (safeValue >= 1_000_000_000) {
    return `${trimFixed(safeValue / 1_000_000_000)}B`;
  }
  if (safeValue >= 1_000_000) {
    return `${trimFixed(safeValue / 1_000_000)}M`;
  }
  if (safeValue >= 1_000) {
    return `${trimFixed(safeValue / 1_000)}K`;
  }
  return safeValue.toLocaleString();
}

function trimFixed(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.?0+$/, "");
}

function CraftingXpSummaryBox({
  currentXp,
  planXp,
  zoomMode,
  onZoomModeChange,
}: {
  currentXp: number | null;
  planXp: number;
  zoomMode: CraftingXpZoomMode;
  onZoomModeChange: (mode: CraftingXpZoomMode) => void;
}): JSX.Element | null {
  if (currentXp == null) {
    return null;
  }
  const safeCurrentXp = Math.max(0, Math.floor(currentXp));
  const safePlanXp = Math.max(0, Math.floor(planXp));
  const postPlanXp = safeCurrentXp + safePlanXp;
  const postProgress = getCraftingLevelProgress(postPlanXp);
  const fullUpperThreshold = getCraftingLevelTotalXpForLevel(postProgress.maxLevel);
  const isFullZoom = zoomMode === "full";
  const lowerThreshold = isFullZoom ? 0 : getCraftingLevelTotalXpForLevel(postProgress.level);
  const upperThreshold = isFullZoom
    ? fullUpperThreshold
    : postProgress.nextLevelXp ?? getCraftingLevelTotalXpForLevel(postProgress.level);
  const progressRange = Math.max(1, upperThreshold - lowerThreshold);
  const progressRatio = Math.max(0, Math.min(1, (postPlanXp - lowerThreshold) / progressRange));
  const leftLevel = isFullZoom ? 1 : postProgress.level;
  const rightLevel = isFullZoom
    ? postProgress.maxLevel
    : postProgress.nextLevelXp == null
      ? postProgress.level
      : postProgress.level + 1;
  const tickMarks = isFullZoom
    ? getCraftingLevelThresholds()
        .filter((threshold) => threshold.level > 1 && threshold.level < postProgress.maxLevel)
        .map((threshold) => ({
          ...threshold,
          pct: Math.max(0, Math.min(100, (threshold.xp / Math.max(1, fullUpperThreshold)) * 100)),
        }))
    : [];
  return (
    <div className={styles.craftingXpBox} title={getCraftingLevelTooltip(postPlanXp)}>
      <div className={styles.craftingXpLine}>
        <span>Current</span>
        <strong title={getCraftingLevelTooltip(safeCurrentXp)}>{formatCraftingLevelLine(safeCurrentXp)}</strong>
      </div>
      <div className={styles.craftingXpLine}>
        <span>Post plan</span>
        <strong>{formatCraftingLevelLine(postPlanXp)}</strong>
      </div>
      <div className={styles.craftingXpProgress} aria-label={`Post-plan progress to level ${postProgress.level + 1}`}>
        <div className={styles.craftingXpTrack}>
          <span className={styles.craftingXpFill} style={{ width: `${progressRatio * 100}%` }} />
          {tickMarks.map((tick) => (
            <span
              key={tick.level}
              className={styles.craftingXpTick}
              style={{ left: `${tick.pct}%` }}
              title={`${formatCompactXp(tick.xp)} · Lvl ${tick.level}`}
            />
          ))}
        </div>
        <div className={styles.craftingXpThresholds}>
          <span>{formatCompactXp(lowerThreshold)} · Lvl {leftLevel}</span>
          <span className={styles.craftingXpZoomControls} aria-label="Crafting XP scale">
            <button
              type="button"
              className={styles.craftingXpZoomButton}
              disabled={isFullZoom}
              title="Zoom out to Level 1 through Level 30"
              onClick={() => onZoomModeChange("full")}
            >
              -
            </button>
            <button
              type="button"
              className={styles.craftingXpZoomButton}
              disabled={!isFullZoom}
              title="Zoom in to the current post-plan level"
              onClick={() => onZoomModeChange("level")}
            >
              +
            </button>
          </span>
          <span>{formatCompactXp(upperThreshold)} · Lvl {rightLevel}</span>
        </div>
      </div>
    </div>
  );
}

function getRecipeTooltip(artifact: string): string {
  const recipe = recipes[artifact];
  if (!recipe) {
    return "";
  }
  const ingredients = Object.entries(recipe.ingredients)
    .sort((a, b) => getArtifactDisplayLabel(a[0]).localeCompare(getArtifactDisplayLabel(b[0])))
    .map(([ingredient, quantity]) => `${quantity.toLocaleString()}x ${getArtifactDisplayLabel(ingredient)}`);
  return [
    "Recipe:",
    ...ingredients,
    `XP: ${recipe.xp.toLocaleString()}`,
    `Base GE cost: ${recipe.cost.toLocaleString()}`,
  ].join("\n");
}

function getArtifactTierNumber(artifact: string): number {
  const displayData = getArtifactDisplayData(artifact);
  if (displayData?.tierNumber != null) {
    return displayData.tierNumber;
  }
  const match = artifact.match(/_(\d+)$/);
  if (!match) {
    return 0;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getArtifactFamilyKey(artifact: string): string {
  return artifact.replace(/_\d+$/, "");
}

function compareFlatRowsByKey(left: FlatPlanRow, right: FlatPlanRow, key: MaxXpFlatSortKey): number {
  switch (key) {
    case "artifact":
      return (
        left.familyKey.localeCompare(right.familyKey) ||
        left.tier - right.tier ||
        getArtifactDisplayLabel(left.artifact).localeCompare(getArtifactDisplayLabel(right.artifact))
      );
    case "tier":
      return left.tier - right.tier || compareFlatRowsByKey(left, right, "artifact");
    case "manualCrafts":
      return left.manualCrafts - right.manualCrafts || left.autoCrafts - right.autoCrafts || compareFlatRowsByKey(left, right, "artifact");
    case "autoCrafts":
      return left.autoCrafts - right.autoCrafts || left.manualCrafts - right.manualCrafts || compareFlatRowsByKey(left, right, "artifact");
    case "xp":
      return left.xp - right.xp || compareFlatRowsByKey(left, right, "manualCrafts");
    case "cost":
      return left.cost - right.cost || compareFlatRowsByKey(left, right, "manualCrafts");
    case "netRemaining":
      return left.netRemaining - right.netRemaining || compareFlatRowsByKey(left, right, "artifact");
    case "usedBy":
      return left.usedBy.localeCompare(right.usedBy) || compareFlatRowsByKey(left, right, "artifact");
    default:
      return compareFlatRowsByKey(left, right, "manualCrafts");
  }
}

function getSortedFlatPlanRows(
  rows: FlatPlanRow[],
  sortKey: MaxXpFlatSortKey,
  sortDirection: SortDirection
): FlatPlanRow[] {
  const sorted = [...rows].sort((left, right) => compareFlatRowsByKey(left, right, sortKey));
  return sortDirection === "desc" ? sorted.reverse() : sorted;
}

function getDefaultFlatSortDirection(sortKey: MaxXpFlatSortKey): SortDirection {
  return sortKey === "artifact" || sortKey === "usedBy" ? "asc" : "desc";
}

function compareConsumedIngredientRowsByKey(
  left: ConsumedIngredientRow,
  right: ConsumedIngredientRow,
  key: MaxXpFlatSortKey
): number {
  switch (key) {
    case "artifact":
      return (
        left.familyKey.localeCompare(right.familyKey) ||
        left.tier - right.tier ||
        getArtifactDisplayLabel(left.artifact).localeCompare(getArtifactDisplayLabel(right.artifact))
      );
    case "tier":
      return left.tier - right.tier || compareConsumedIngredientRowsByKey(left, right, "artifact");
    case "manualCrafts":
      return left.inventoryConsumed - right.inventoryConsumed || compareConsumedIngredientRowsByKey(left, right, "artifact");
    case "netRemaining":
      return left.netRemaining - right.netRemaining || compareConsumedIngredientRowsByKey(left, right, "artifact");
    case "usedBy":
      return left.usedBy.localeCompare(right.usedBy) || compareConsumedIngredientRowsByKey(left, right, "artifact");
    case "autoCrafts":
    case "xp":
    case "cost":
    default:
      return compareConsumedIngredientRowsByKey(left, right, "artifact");
  }
}

function getSortedConsumedIngredientRows(
  rows: ConsumedIngredientRow[],
  sortKey: MaxXpFlatSortKey,
  sortDirection: SortDirection
): ConsumedIngredientRow[] {
  const effectiveSortKey =
    sortKey === "autoCrafts" || sortKey === "xp" || sortKey === "cost" ? "artifact" : sortKey;
  const effectiveDirection = effectiveSortKey === sortKey ? sortDirection : getDefaultFlatSortDirection(effectiveSortKey);
  const sorted = [...rows].sort((left, right) => compareConsumedIngredientRowsByKey(left, right, effectiveSortKey));
  return effectiveDirection === "desc" ? sorted.reverse() : sorted;
}

function getFlatPlanRows(
  usageByArtifact: Record<string, MaxXpUsageSummary>,
  executionRows: ExecutionPlanRow[]
): FlatPlanRow[] {
  const totals = new Map<string, { xp: number; cost: number }>();
  for (const row of executionRows) {
    const existing = totals.get(row.artifact) || { xp: 0, cost: 0 };
    existing.xp += row.xp;
    existing.cost += row.cost;
    totals.set(row.artifact, existing);
  }
  return Object.values(usageByArtifact)
    .filter((usage) => Boolean((usage.manualCrafts > 0 || usage.autoCrafts > 0) && recipes[usage.artifact]))
    .sort((a, b) => b.manualCrafts - a.manualCrafts || b.autoCrafts - a.autoCrafts || getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)))
    .map((usage) => ({
      artifact: usage.artifact,
      familyKey: getArtifactFamilyKey(usage.artifact),
      tier: getArtifactTierNumber(usage.artifact),
      manualCrafts: usage.manualCrafts,
      autoCrafts: usage.autoCrafts,
      xp: totals.get(usage.artifact)?.xp || 0,
      cost: totals.get(usage.artifact)?.cost || 0,
      netRemaining: usage.remaining,
      usedBy: formatUsedBy(usage),
      usage,
    }));
}

function getConsumedIngredientRows(usageByArtifact: Record<string, MaxXpUsageSummary>): ConsumedIngredientRow[] {
  return Object.values(usageByArtifact)
    .filter((usage) => {
      const isCraftRow = usage.manualCrafts > 0 || usage.autoCrafts > 0;
      return !isCraftRow && (usage.inventoryConsumed > 0 || Object.keys(usage.consumedBy).length > 0);
    })
    .sort((a, b) => getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)))
    .map((usage) => ({
      artifact: usage.artifact,
      familyKey: getArtifactFamilyKey(usage.artifact),
      tier: getArtifactTierNumber(usage.artifact),
      inventoryConsumed: usage.inventoryConsumed,
      netRemaining: usage.remaining,
      usedBy: formatUsedBy(usage),
      usage,
    }));
}

function getGeEfficiencyStatusMap(
  planRows: ModeComparisonRow[],
  geEfficiencyPlan: ReturnType<typeof simulateGeEfficiencyPlan> | null,
  minXpPerGe: number
): Record<string, EfficiencyStatus> {
  if (!geEfficiencyPlan) {
    return {};
  }

  const statusByRowKey = {} as Record<string, EfficiencyStatus>;
  const realizedCountsByRowKey = new Map<string, number>();
  for (const row of geEfficiencyPlan.rows) {
    realizedCountsByRowKey.set(getModeRowKey(row.artifact, row.mode), row.craftedCount);
  }

  for (const row of planRows) {
    if (row.xpPerGe + Number.EPSILON < minXpPerGe) {
      statusByRowKey[row.key] = {
        kind: "belowThreshold",
        realizedCount: 0,
        label: "Below threshold",
        title: "Below the current minimum XP/GE threshold, so this row is not considered in the Max GE Efficiency Plan.",
      };
      continue;
    }

    const realizedCount = realizedCountsByRowKey.get(row.key) ?? 0;
    if (realizedCount >= row.count) {
      statusByRowKey[row.key] = {
        kind: "full",
        realizedCount,
        label: "Fully included",
        title: `Fully included in the Max GE Efficiency Plan (${realizedCount.toLocaleString()} of ${row.count.toLocaleString()} crafts).`,
      };
      continue;
    }

    if (realizedCount > 0) {
      statusByRowKey[row.key] = {
        kind: "partial",
        realizedCount,
        label: "Partially included",
        title: `Partially included in the Max GE Efficiency Plan (${realizedCount.toLocaleString()} of ${row.count.toLocaleString()} crafts).`,
      };
      continue;
    }

    statusByRowKey[row.key] = {
      kind: "blocked",
      realizedCount: 0,
      label: "Blocked",
      title: "No longer craftable by the time this row is reached in the Max GE Efficiency Plan because earlier rows consumed what it needs.",
    };
  }

  return statusByRowKey;
}

function getModeRowCountLabel(row: ModeComparisonRow, status: EfficiencyStatus | undefined): string {
  if (!status || status.kind === "full" || status.kind === "belowThreshold") {
    return row.count.toLocaleString();
  }
  return `${row.count.toLocaleString()} -> ${status.realizedCount.toLocaleString()}`;
}

function getInventoryMatrixRows(inventory: Record<string, number> | null | undefined): InventoryMatrixRow[] {
  if (!inventory) {
    return [];
  }

  const rows: InventoryMatrixRow[] = [];
  for (const family of INVENTORY_MATRIX_FAMILIES) {
    const counts = [1, 2, 3, 4].map((tier) => Math.max(0, Math.round(inventory[`${family.key}_${tier}`] || 0)));
    if (counts.every((count) => count === 0)) {
      continue;
    }
    rows.push({
      label: family.label,
      counts,
    });
  }
  return rows;
}

type ShinyRunOdds = Array<{ rarity: ShinyRarity; chance: number; detail: string; ifByHand?: boolean }>;

const SHINY_SHORT_LABELS: Record<ShinyRarity, string> = { rare: "R+", epic: "E+", legendary: "L" };

function formatRunPercent(chance: number): string {
  const percent = chance * 100;
  if (percent <= 0) {
    return "0%";
  }
  if (percent < 0.5) {
    return "<1%";
  }
  return percent >= 99.5 ? ">99%" : `${Math.round(percent)}%`;
}

/** Compact shiny odds after an artifact name: "R+ 41% · L 3%", details in the tooltip. */
function ShinyOddsInline({
  odds,
  artifact,
  intro = "Chance these manual crafts give",
}: {
  odds: ShinyRunOdds | undefined;
  artifact: string;
  intro?: string;
}): JSX.Element | null {
  if (!odds || odds.length === 0) {
    return null;
  }
  const byHand = odds.some((entry) => entry.ifByHand);
  const title = [
    byHand
      ? `Auto-crafts can't be shiny. Crafted by hand instead (before the row above), these would give at least one shiny ${getArtifactDisplayLabel(artifact)}:`
      : `${intro} at least one shiny ${getArtifactDisplayLabel(artifact)} (auto-crafted ingredients can't be shiny):`,
    ...odds.map((entry) => `${SHINY_RARITY_LABELS[entry.rarity]}: ${formatRunPercent(entry.chance)} (${entry.detail})`),
  ].join("\n");
  return (
    <span className={styles.shinyOddsInline} data-by-hand={byHand ? "1" : "0"} title={title}>
      {odds.map((entry) => (
        <span key={entry.rarity} data-rarity={entry.rarity}>
          {SHINY_SHORT_LABELS[entry.rarity]} {formatRunPercent(entry.chance)}
        </span>
      ))}
    </span>
  );
}

function ArtifactCell({
  artifact,
  modeLabel,
  hideTier = false,
}: {
  artifact: string;
  modeLabel?: string;
  hideTier?: boolean;
}): JSX.Element {
  const displayData = getArtifactDisplayData(artifact);
  const recipeTooltip = getRecipeTooltip(artifact);
  if (!displayData) {
    return <span title={recipeTooltip || undefined}>{artifact}</span>;
  }
  return (
    <span className={styles.artifactCell}>
      <span className={styles.artifactIconWrap}>
        <img src={displayData.smallIconUrl} alt={displayData.name} className={styles.artifactIconThumb} loading="lazy" />
        <span className={styles.artifactIconPreview}>
          <img src={displayData.largeIconUrl} alt={displayData.name} className={styles.artifactIconLarge} loading="lazy" />
        </span>
      </span>
      <span className={styles.artifactText} title={recipeTooltip || undefined}>
        <span>{hideTier ? displayData.name : `${displayData.name} (T${displayData.tierNumber})`}</span>
        {modeLabel && <span className={styles.artifactMode}>({modeLabel})</span>}
      </span>
    </span>
  );
}

function StatusDot({ status }: { status: EfficiencyStatus }): JSX.Element {
  const className =
    status.kind === "full"
      ? styles.statusFull
      : status.kind === "partial"
        ? styles.statusPartial
        : status.kind === "blocked"
          ? styles.statusBlocked
          : styles.statusBelowThreshold;
  return <span className={`${styles.statusDot} ${className}`} title={status.title} aria-label={status.label} />;
}

function RemainingInventoryDisclosure({
  label,
  planLabel,
  inventory,
}: {
  label: string;
  planLabel: string;
  inventory: Record<string, number> | null | undefined;
}): JSX.Element {
  const rows = getInventoryMatrixRows(inventory);
  return (
    <details className={`${styles.inventoryDisclosure} inventory-disclosure`}>
      <summary className={styles.inventoryDisclosureSummary}>{label}</summary>
      <div className={`${styles.inventoryDisclosurePanel} inventoryDisclosurePanel`}>
        <div className={styles.inventoryDisclosureTitle}>{planLabel}</div>
        {rows.length > 0 ? (
          <div className={styles.inventoryTableWrap}>
            <table className={styles.inventoryTable}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className={styles.num}>T1</th>
                  <th className={styles.num}>T2</th>
                  <th className={styles.num}>T3</th>
                  <th className={styles.num}>T4</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    {row.counts.map((count, index) => (
                      <td key={`${row.label}-${index}`} className={styles.num}>
                        {count > 0 ? count.toLocaleString() : "-"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.summaryMeta}>Nothing left in tracked inventory.</div>
        )}
      </div>
    </details>
  );
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function getXpTooltip(xpPerCraft: number, count: number, totalXp: number): string {
  const lines = [`XP per craft: ${xpPerCraft.toLocaleString()}`, `Crafts: ${count.toLocaleString()}`];
  const ingredientXp = totalXp - xpPerCraft * count;
  if (ingredientXp > 0) {
    lines.push(`Plus ${ingredientXp.toLocaleString()} XP from the ingredients they auto-craft`);
  }
  return lines.join("\n");
}

function getCostTooltip(artifact: string, craft: Solution["crafts"][string]): string {
  const costDetails = craft.costDetails;
  const plannedCrafts = Math.max(0, Math.round(craft.count));
  const craftLabel = plannedCrafts === 1 ? "craft" : "crafts";
  const lines = [
    `Artifact: ${getArtifactDisplayLabel(artifact)}`,
    `Crafts: ${craft.count.toLocaleString()}`,
    `Base GE cost: ${costDetails.baseCost.toLocaleString()}`,
    `Craft history: ${costDetails.craftCount.toLocaleString()}`,
    `Current discount: ${formatPercent(costDetails.discountPercent)}`,
    `Next craft cost: ${costDetails.discountedCost.toLocaleString()} GE`,
    `Direct GE cost in table (${plannedCrafts.toLocaleString()} ${craftLabel}): ${costDetails.totalDirectCost.toLocaleString()} GE`,
    `Standalone direct craftability: ${craft.modeComparison.direct.count.toLocaleString()} crafts (${craft.modeComparison.direct.cost.toLocaleString()} GE total)`,
  ];
  if (costDetails.saleApplied) {
    lines.push("30% crafting sale applied to all GE costs shown here.");
  }
  if (craft.modeComparison.auto) {
    lines.push(
      `Standalone auto-craft craftability: ${craft.modeComparison.auto.count.toLocaleString()} crafts (${craft.modeComparison.auto.cost.toLocaleString()} GE total)`
    );
  }
  if (costDetails.ingredients.length > 0) {
    lines.push("Ingredient direct costs for one parent craft (sequential discounts):");
    for (const ingredient of costDetails.ingredients) {
      lines.push(
        `- ${ingredient.name} x${ingredient.quantity}: starts at ${ingredient.discountedCost.toLocaleString()} GE (${formatPercent(
          ingredient.discountPercent
        )} discount, ${ingredient.craftCount.toLocaleString()} crafts) -> total ${ingredient.totalCost.toLocaleString()} GE`
      );
    }
  }
  if (costDetails.recursiveCost > 0) {
    lines.push(
      `Recursive cost per craft from scratch (with sequential ingredient discounts): ${costDetails.recursiveCost.toLocaleString()} GE`
    );
  }
  return lines.join("\n");
}

export default function XpGeCraftPage(): JSX.Element {
  const highs = useHighsClient();
  const [eid, setEID] = useState<string>("");
  const [profileOverrides, setProfileOverrides] = useProfileOverrides(eid);
  // The backup's own values from the last calculate, and the overrides it used.
  const [realProfileSummary, setRealProfileSummary] = useState<{ eid: string; summary: ProfileSummary } | null>(null);
  const [calculatedOverridesKey, setCalculatedOverridesKey] = useState<string | null>(null);
  const [includeSlotted, setIncludeSlotted] = useState<boolean>(true);
  const [includeFragments, setIncludeFragments] = useState<boolean>(true);
  const [includeRare, setIncludeRare] = useState<boolean>(false);
  const [includeEpic, setIncludeEpic] = useState<boolean>(false);
  const [includeLegendary, setIncludeLegendary] = useState<boolean>(false);
  const [craftingSale, setCraftingSale] = useState<boolean>(false);
  const [inventorySource, setInventorySource] = useState<InventorySource>("main");
  // The source the loaded plan inventory came from (the dropdown may have moved on since).
  const [planInventorySource, setPlanInventorySource] = useState<InventorySource>("main");
  const [solution, setSolution] = useState<Solution | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("xpPerGe");
  const [minEfficiencyXpPerGe, setMinEfficiencyXpPerGe] = useState<number>(0);
  const [maxXpPlanView, setMaxXpPlanView] = useState<MaxXpPlanView>("tree");
  const [maxXpFlatSortKey, setMaxXpFlatSortKey] = useState<MaxXpFlatSortKey>("manualCrafts");
  const [maxXpFlatSortDirection, setMaxXpFlatSortDirection] = useState<SortDirection>("desc");
  const [craftingXpZoomMode, setCraftingXpZoomMode] = useState<CraftingXpZoomMode>("level");
  // Off: the craft order shows no shiny odds (they'd crowd every row).
  const [showShinyOdds, setShowShinyOdds] = useState<boolean>(false);
  const [standaloneOpen, setStandaloneOpen] = useState<boolean>(true);
  const [appliedCraftLimits, setAppliedCraftLimits] = useState<CraftLimits>({});
  const [draftCraftLimitInputs, setDraftCraftLimitInputs] = useState<Record<string, string>>({});
  const [prePlanSends, setPrePlanSends] = useState<PrePlanSendRow[]>([]);
  const [draftPrePlanShip, setDraftPrePlanShip] = useState<string>("ATREGGIES");
  const [draftPrePlanDuration, setDraftPrePlanDuration] = useState<PrePlanDurationType>("EPIC");
  const [draftPrePlanTargetAfxId, setDraftPrePlanTargetAfxId] = useState<number>(PRE_PLAN_UNTARGETED_TARGET_AFX_ID);
  const [draftPrePlanLaunches, setDraftPrePlanLaunches] = useState<string>("1");
  const [prePlanOpen, setPrePlanOpen] = useState<boolean>(false);
  const [lastPrePlanResult, setLastPrePlanResult] = useState<InventoryResponse["prePlanSends"] | null>(null);
  const [lastSolvedPrePlanSignature, setLastSolvedPrePlanSignature] = useState<string | null>(null);
  // Count expected loot from ships in the air (off: plan with what's in hand).
  const [includeInFlight, setIncludeInFlight] = useState<boolean>(false);
  const [lastInFlight, setLastInFlight] = useState<InFlightResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [prefsLoaded, setPrefsLoaded] = useState<boolean>(false);
  const [planSourceInventory, setPlanSourceInventory] = useState<Record<string, number> | null>(null);
  const [planSourceCraftCounts, setPlanSourceCraftCounts] = useState<Record<string, number>>({});
  const [planSourceCraftingXp, setPlanSourceCraftingXp] = useState<number | null>(null);
  const [planShinyIngredientCount, setPlanShinyIngredientCount] = useState<number>(0);
  const [goalRows, setGoalRows] = useState<PlannerTargetRow[]>([]);
  const [goalsOpen, setGoalsOpen] = useState<boolean>(false);
  const [appliedGoalsKey, setAppliedGoalsKey] = useState<string>("[]");
  // How the shown solution handled goals (it lags the goals while a solve is pending).
  const [solvedGoalPlan, setSolvedGoalPlan] = useState<SolvedGoalPlan | null>(null);
  const [planBaseline, setPlanBaseline] = useState<PlanBaseline | null>(null);
  const [savedPlannerGoalCount, setSavedPlannerGoalCount] = useState<number>(0);
  const [goalImportNote, setGoalImportNote] = useState<string | null>(null);
  // Stars before any pre-plan sends, from the last calculate.
  const [shipStars, setShipStars] = useState<ShipStars[] | null>(null);
  const [savedPlannerPlan, setSavedPlannerPlan] = useState<SavedPlannerPlan | null>(null);
  const [sendImportNote, setSendImportNote] = useState<string | null>(null);
  const lastSolveRef = useRef<SolveInputs | null>(null);

  useEffect(() => {
    const savedEid = readFirstStoredString(SHARED_EID_KEYS);
    if (savedEid) {
      setEID(savedEid);
    }
    const savedIncludeSlotted = readStoredBoolean(SHARED_INCLUDE_SLOTTED_KEYS);
    if (savedIncludeSlotted != null) {
      setIncludeSlotted(savedIncludeSlotted);
    }
    const savedIncludeFragments = readStoredBoolean([LOCAL_PREF_KEYS.craftIncludeInventoryFragments]);
    if (savedIncludeFragments != null) {
      setIncludeFragments(savedIncludeFragments);
    }
    const savedIncludeRare = readStoredBoolean([LOCAL_PREF_KEYS.craftIncludeInventoryRare]);
    if (savedIncludeRare != null) {
      setIncludeRare(savedIncludeRare);
    }
    const savedIncludeEpic = readStoredBoolean([LOCAL_PREF_KEYS.craftIncludeInventoryEpic]);
    if (savedIncludeEpic != null) {
      setIncludeEpic(savedIncludeEpic);
    }
    const savedIncludeLegendary = readStoredBoolean([LOCAL_PREF_KEYS.craftIncludeInventoryLegendary]);
    if (savedIncludeLegendary != null) {
      setIncludeLegendary(savedIncludeLegendary);
    }
    const savedCraftingSale = readStoredBoolean(SHARED_CRAFTING_SALE_KEYS);
    if (savedCraftingSale != null) {
      setCraftingSale(savedCraftingSale);
    }
    const savedInventorySource = readFirstStoredString([LOCAL_PREF_KEYS.craftInventorySource]);
    if (savedInventorySource === "main" || savedInventorySource === "virtue") {
      setInventorySource(savedInventorySource);
    }
    setShowShinyOdds(readStoredBoolean([LOCAL_PREF_KEYS.craftShowShinyOdds]) ?? false);
    const savedPlanView = readFirstStoredString([LOCAL_PREF_KEYS.craftMaxXpPlanView]);
    if (savedPlanView === "tree" || savedPlanView === "flat") {
      setMaxXpPlanView(savedPlanView);
    }
    const savedStandaloneOpen = readStoredBoolean([LOCAL_PREF_KEYS.craftStandaloneOpen]);
    if (savedStandaloneOpen != null) {
      setStandaloneOpen(savedStandaloneOpen);
    }
    const savedCraftLimits = parseStoredCraftLimits(readFirstStoredString([LOCAL_PREF_KEYS.craftAllLimits]));
    setAppliedCraftLimits(savedCraftLimits);
    setDraftCraftLimitInputs(craftLimitsToInputs(savedCraftLimits));
    setPrePlanSends(parseStoredPrePlanSends(readFirstStoredString([LOCAL_PREF_KEYS.craftPrePlanSends])));
    setIncludeInFlight(readStoredBoolean([LOCAL_PREF_KEYS.craftIncludeInFlight]) ?? false);
    const savedGoalRows = parseStoredTargetRows(readFirstStoredString([LOCAL_PREF_KEYS.craftGoalRows]), GOAL_TARGET_OPTIONS) || [];
    setGoalRows(savedGoalRows);
    setAppliedGoalsKey(JSON.stringify(goalRowsToReservationGoals(savedGoalRows)));
    setPrefsLoaded(true);
  }, []);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredString(SHARED_EID_KEYS, eid.trim());
  }, [eid, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredBoolean(SHARED_INCLUDE_SLOTTED_KEYS, includeSlotted);
  }, [includeSlotted, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredBoolean([LOCAL_PREF_KEYS.craftIncludeInventoryFragments], includeFragments);
  }, [includeFragments, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredBoolean([LOCAL_PREF_KEYS.craftIncludeInventoryRare], includeRare);
    writeStoredBoolean([LOCAL_PREF_KEYS.craftIncludeInventoryEpic], includeEpic);
    writeStoredBoolean([LOCAL_PREF_KEYS.craftIncludeInventoryLegendary], includeLegendary);
  }, [includeRare, includeEpic, includeLegendary, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredBoolean(SHARED_CRAFTING_SALE_KEYS, craftingSale);
  }, [craftingSale, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredString([LOCAL_PREF_KEYS.craftInventorySource], inventorySource);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [inventorySource, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredString([LOCAL_PREF_KEYS.craftMaxXpPlanView], maxXpPlanView);
    writeStoredBoolean([LOCAL_PREF_KEYS.craftShowShinyOdds], showShinyOdds);
  }, [maxXpPlanView, showShinyOdds, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredBoolean([LOCAL_PREF_KEYS.craftStandaloneOpen], standaloneOpen);
  }, [standaloneOpen, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredString([LOCAL_PREF_KEYS.craftAllLimits], JSON.stringify(appliedCraftLimits));
  }, [appliedCraftLimits, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredString([LOCAL_PREF_KEYS.craftPrePlanSends], JSON.stringify(prePlanSends));
  }, [prePlanSends, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredBoolean([LOCAL_PREF_KEYS.craftIncludeInFlight], includeInFlight);
  }, [includeInFlight, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredString([LOCAL_PREF_KEYS.craftGoalRows], serializeTargetRows(goalRows.filter((row) => row.itemId)));
  }, [goalRows, prefsLoaded]);

  const goalsKey = useMemo(() => JSON.stringify(goalRowsToReservationGoals(goalRows)), [goalRows]);

  useEffect(() => {
    if (goalsKey === appliedGoalsKey) {
      return;
    }
    const timer = window.setTimeout(() => setAppliedGoalsKey(goalsKey), GOAL_APPLY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [goalsKey, appliedGoalsKey]);

  const appliedGoals = useMemo(() => parseGoalsKey(appliedGoalsKey), [appliedGoalsKey]);
  // What goals ask of the plan, from exactly the inventory it optimizes over.
  const planReservations = useMemo(
    () =>
      planSourceInventory
        ? reservationsFor(planSourceInventory, planSourceCraftCounts, planSourceCraftingXp ?? 0, appliedGoals)
        : null,
    [planSourceInventory, planSourceCraftCounts, planSourceCraftingXp, appliedGoals]
  );
  const planGoalKey = useMemo(() => goalPlanKey(planReservations), [planReservations]);
  // Per-row keeps and status for the goal rows as they are now (no solve needed).
  const goalRowReservations = useMemo(
    () =>
      planSourceInventory && goalRows.length > 0
        ? reserveInventoryForGoals(
            planSourceInventory,
            planSourceCraftCounts,
            resolveShinyGoals(goalRows.map(goalRowToReservationGoal), planSourceCraftCounts, planSourceCraftingXp ?? 0)
          )
        : null,
    [goalRows, planSourceInventory, planSourceCraftCounts, planSourceCraftingXp]
  );

  useEffect(() => {
    if (!highs || !planSourceInventory) {
      return;
    }
    // Skip inputs already solved: by Calculate, or a goal edit that asks the same of the plan.
    const last = lastSolveRef.current;
    if (
      last &&
      last.inventory === planSourceInventory &&
      last.craftCounts === planSourceCraftCounts &&
      last.sale === craftingSale &&
      last.limits === appliedCraftLimits &&
      last.goalKey === planGoalKey
    ) {
      return;
    }
    lastSolveRef.current = {
      inventory: planSourceInventory,
      craftCounts: planSourceCraftCounts,
      sale: craftingSale,
      limits: appliedCraftLimits,
      goalKey: planGoalKey,
    };
    const solved = solveForGoals(
      highs,
      planSourceInventory,
      planSourceCraftCounts,
      planSourceCraftingXp ?? 0,
      craftingSale,
      appliedCraftLimits,
      appliedGoals
    );
    setSolution(solved.solution);
    setSolvedGoalPlan(solved.goalPlan);
  }, [highs, planSourceCraftCounts, planSourceCraftingXp, planSourceInventory, craftingSale, appliedCraftLimits, planGoalKey, appliedGoals]);

  const keepsForGoals = planReservations != null;
  const baselineCurrent =
    planBaseline &&
    planBaseline.inventory === planSourceInventory &&
    planBaseline.craftCounts === planSourceCraftCounts &&
    planBaseline.sale === craftingSale &&
    planBaseline.limits === appliedCraftLimits
      ? planBaseline
      : null;

  useEffect(() => {
    if (!highs || !planSourceInventory || !keepsForGoals || baselineCurrent) {
      return;
    }
    const baseline = optimizeCrafts(highs, planSourceInventory, planSourceCraftCounts, craftingSale, appliedCraftLimits);
    setPlanBaseline({
      inventory: planSourceInventory,
      craftCounts: planSourceCraftCounts,
      sale: craftingSale,
      limits: appliedCraftLimits,
      totalXp: baseline.totalXp,
      crafts: plannedCraftCounts(baseline),
    });
  }, [highs, planSourceInventory, planSourceCraftCounts, craftingSale, appliedCraftLimits, keepsForGoals, baselineCurrent]);

  // Import reads the planner goals for the inventory the goals reserve from.
  const goalImportSource = planSourceInventory ? planInventorySource : inventorySource;

  useEffect(() => {
    if (!prePlanOpen) {
      return;
    }
    // Sends apply on the next calculate, so they follow the inventory dropdown.
    setSavedPlannerPlan(readSavedPlannerPlan(inventorySource));
    setSendImportNote(null);
  }, [prePlanOpen, inventorySource]);
  useEffect(() => {
    if (!goalsOpen) {
      return;
    }
    setSavedPlannerGoalCount(readPlannerSavedTargetRows(goalImportSource, GOAL_TARGET_OPTIONS).length);
  }, [goalsOpen, goalImportSource]);

  async function runOptimize(): Promise<void> {
    if (!highs) {
      setError("Solver is still loading. Please try again in a moment.");
      return;
    }

    setError(null);
    setSolution(null);
    setSolvedGoalPlan(null);
    setPlanSourceInventory(null);
    setPlanSourceCraftCounts({});
    setPlanSourceCraftingXp(null);
    setPlanShinyIngredientCount(0);
    setLastPrePlanResult(null);
    setLastInFlight(null);
    setIsLoading(true);
    try {
      const nextLimits = normalizeCraftLimitInputs(draftCraftLimitInputs);
      setAppliedCraftLimits(nextLimits);
      setDraftCraftLimitInputs(craftLimitsToInputs(nextLimits));
      // Calculate uses the goal rows as they are now, without waiting out the edit pause.
      const nextGoals = goalRowsToReservationGoals(goalRows);
      setAppliedGoalsKey(JSON.stringify(nextGoals));
      const result = await getOptimalCrafts(
        highs,
        eid,
        includeSlotted,
        includeFragments,
        { rare: includeRare, epic: includeEpic, legendary: includeLegendary },
        craftingSale,
        inventorySource,
        nextLimits,
        prePlanSends,
        includeInFlight,
        nextGoals,
        profileOverrides
      );
      lastSolveRef.current = {
        inventory: result.inventory,
        craftCounts: result.craftCounts,
        sale: craftingSale,
        limits: nextLimits,
        goalKey: result.goalPlan.goalKey,
      };
      setSolution(result.solution);
      setSolvedGoalPlan(result.goalPlan);
      setPlanSourceInventory(result.inventory);
      setPlanInventorySource(inventorySource);
      setPlanShinyIngredientCount(result.shinyIngredientCount);
      setPlanSourceCraftCounts(result.craftCounts);
      setPlanSourceCraftingXp(result.craftingXp);
      setLastPrePlanResult(result.prePlanSends || null);
      setLastSolvedPrePlanSignature(prePlanSendsSignature(prePlanSends));
      setLastInFlight(result.inFlight);
      setRealProfileSummary(result.realProfile ? { eid: eid.trim(), summary: result.realProfile } : null);
      setCalculatedOverridesKey(JSON.stringify(profileOverrides));
      setShipStars(result.shipLevels.length > 0 ? result.shipLevels : null);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unable to load inventory.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  // Goals the shown solution plans for, and what the Max GE Efficiency Plan
  // walks after crafting them first.
  const goalConstraints = solution ? solvedGoalPlan?.constraints ?? null : null;
  const goalCrafts = useMemo(
    () =>
      goalConstraints
        ? simulateGoalCrafts(goalConstraints.inventory, planSourceCraftCounts, goalConstraints.steps, craftingSale)
        : null,
    [goalConstraints, planSourceCraftCounts, craftingSale]
  );
  // Standalone options read what is left once goals are crafted (the GE walk's inventory).
  const standaloneSolution = useMemo(
    () =>
      solution && goalCrafts
        ? withStandaloneComparisons(solution, goalCrafts.inventory, goalCrafts.craftCounts, craftingSale)
        : solution,
    [solution, goalCrafts, craftingSale]
  );
  const sortedArtifacts = solution ? getSortedArtifacts(solution, sortKey) : [];
  const sortedModeRows = standaloneSolution ? getModeComparisonRows(standaloneSolution, sortKey) : [];
  const visibleModeRows = sortedModeRows.filter((row) => row.count > 0);
  // Each standalone row is an alternative, so its odds start from where the
  // goal crafts leave the craft counts; the "beyond direct" row starts after
  // that artifact's direct crafts, which come first.
  const standaloneOddsKey = showShinyOdds
    ? JSON.stringify([visibleModeRows.map((row) => [row.key, row.artifact, row.mode, row.count]), planSourceCraftingXp])
    : "";
  const standaloneCraftCounts = goalCrafts?.craftCounts ?? planSourceCraftCounts;
  const standaloneShinyOdds = useMemo(() => {
    const byRow = new Map<string, ShinyRunOdds>();
    if (!standaloneOddsKey) {
      return byRow;
    }
    const directCounts = new Map(
      visibleModeRows.filter((row) => row.mode === "direct").map((row) => [row.artifact, row.count])
    );
    for (const row of visibleModeRows) {
      const after = row.mode === "auto" ? directCounts.get(row.artifact) || 0 : 0;
      const craftedBefore = Math.max(0, Math.round(standaloneCraftCounts[row.artifact] || 0)) + after;
      const run = craftRunOdds({ itemKey: row.artifact, craftedBefore, craftingXp: planSourceCraftingXp ?? 0, crafts: row.count });
      if (run.length === 0) {
        continue;
      }
      byRow.set(
        row.key,
        run.map((entry) => ({
          rarity: entry.rarity,
          chance: 1 - entry.miss,
          detail: `${row.count.toLocaleString()} crafts from ${craftedBefore.toLocaleString()} crafted${
            after > 0 ? " (after the direct crafts)" : ""
          }, ${
            entry.firstChance === entry.lastChance
              ? `${(entry.firstChance * 100).toFixed(2)}% each`
              : `${(entry.firstChance * 100).toFixed(2)}% → ${(entry.lastChance * 100).toFixed(2)}% each`
          }`,
        }))
      );
    }
    return byRow;
    // The key holds the rows and XP; craft counts change only with a new calculate or goal crafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standaloneOddsKey, standaloneCraftCounts]);
  const xpPerGeModeRows = standaloneSolution ? getModeComparisonRows(standaloneSolution, "xpPerGe") : [];
  const efficiencySliderMax = xpPerGeModeRows.length > 0 ? Math.max(0, xpPerGeModeRows[0].xpPerGe) : 0;
  const efficiencySliderStep = efficiencySliderMax > 100 ? 1 : efficiencySliderMax > 10 ? 0.1 : 0.01;

  useEffect(() => {
    setMinEfficiencyXpPerGe((previous) => Math.min(previous, efficiencySliderMax));
  }, [efficiencySliderMax]);

  const draftCraftLimits = normalizeCraftLimitInputs(draftCraftLimitInputs);
  const hasPendingCraftLimits = !craftLimitsEqual(draftCraftLimits, appliedCraftLimits);
  const visibleCraftLimits = solution ? draftCraftLimits : appliedCraftLimits;
  const selectedDraftShipIsUntargetedOnly = PRE_PLAN_UNTARGETED_ONLY_SHIPS.has(draftPrePlanShip);
  const draftPrePlanShipDuration = `${draftPrePlanShip}|${draftPrePlanDuration}`;
  const currentPrePlanSignature = prePlanSendsSignature(prePlanSends);
  const prePlanAssumptionsStale = Boolean(
    solution &&
      ((lastSolvedPrePlanSignature != null && currentPrePlanSignature !== lastSolvedPrePlanSignature) ||
        (lastInFlight != null && lastInFlight.included !== includeInFlight))
  );
  const inFlightCount = lastInFlight?.missionCount ?? null;
  // Row results only describe the rows they were calculated for.
  const prePlanRowResults =
    lastPrePlanResult && lastSolvedPrePlanSignature === currentPrePlanSignature ? lastPrePlanResult.rows || null : null;
  const inventorySourceLabel = inventorySource === "virtue" ? "Virtue" : "main";
  const prePlanTotalLaunches = prePlanSends.reduce((sum, send) => sum + send.launches, 0);
  const savedPlannerPlanLaunches = savedPlannerPlan
    ? savedPlannerPlan.sends.reduce((sum, send) => sum + send.launches, 0)
    : 0;
  // Expected mission drops the plan inventory includes (both come from the same calculate).
  const planExpectedDrops = [lastPrePlanResult?.addedInventory, lastInFlight?.included ? lastInFlight.addedInventory : null];
  // Ships in the air the last calculate found; listed while the box is ticked.
  const inAirRows = includeInFlight ? lastInFlight?.rows ?? [] : [];
  const inFlightAdded = lastInFlight?.included ? lastInFlight.addedInventory : undefined;
  const prePlanAddedItemCount = new Set([
    ...positiveAdditions(lastPrePlanResult?.addedInventory).map(([itemKey]) => itemKey),
    ...positiveAdditions(inFlightAdded).map(([itemKey]) => itemKey),
  ]).size;
  const prePlanAdditionsTooltip = formatExpectedAdditionsTooltip([
    { title: "Expected from ships in the air:", added: inFlightAdded },
    { title: "Expected from pre-plan sends:", added: lastPrePlanResult?.addedInventory },
  ]);

  const shipDurationOptions = useMemo(
    () =>
      PRE_PLAN_SHIPS.flatMap((ship) => {
        const stars = shipStars?.find((entry) => entry.ship === ship);
        const starsLabel = !stars ? "" : stars.unlocked ? ` ${stars.level}/${stars.maxLevel}⭐` : " (locked)";
        return PRE_PLAN_DURATIONS.map((duration) => ({
          value: `${ship}|${duration.value}`,
          ship,
          durationType: duration.value,
          label: `${titleCaseShip(ship)}${starsLabel} · ${duration.label}`,
        }));
      }),
    [shipStars]
  );

  function applyCraftLimitDrafts(): void {
    const nextLimits = normalizeCraftLimitInputs(draftCraftLimitInputs);
    setAppliedCraftLimits(nextLimits);
    setDraftCraftLimitInputs(craftLimitsToInputs(nextLimits));
  }

  function resetCraftLimitDrafts(): void {
    setDraftCraftLimitInputs(craftLimitsToInputs(appliedCraftLimits));
  }

  function setDraftCraftLimit(artifact: string, rawValue: string): void {
    const sanitized = rawValue.replace(/[^\d]/g, "");
    setDraftCraftLimitInputs((previous) => {
      const next = { ...previous };
      if (sanitized === "") {
        delete next[artifact];
      } else {
        next[artifact] = sanitized;
      }
      return next;
    });
  }

  function clearDraftCraftLimit(artifact: string): void {
    setDraftCraftLimitInputs((previous) => {
      const next = { ...previous };
      delete next[artifact];
      return next;
    });
  }

  function addPrePlanSend(): void {
    const launches = Math.max(1, Math.min(MAX_PRE_PLAN_LAUNCHES_PER_ROW, Math.round(Number(draftPrePlanLaunches) || 1)));
    const targetAfxId = selectedDraftShipIsUntargetedOnly
      ? PRE_PLAN_UNTARGETED_TARGET_AFX_ID
      : draftPrePlanTargetAfxId;
    setPrePlanSends((previous) => [
      ...previous,
      {
        id: `${Date.now()}-${draftPrePlanShip}-${draftPrePlanDuration}-${targetAfxId}-${launches}`,
        ship: draftPrePlanShip,
        durationType: draftPrePlanDuration,
        targetAfxId,
        launches,
      },
    ].slice(0, MAX_PRE_PLAN_SEND_ROWS));
    setDraftPrePlanLaunches("1");
  }

  function removePrePlanSend(id: string): void {
    setPrePlanSends((previous) => previous.filter((send) => send.id !== id));
  }

  function clearPrePlanSends(): void {
    setPrePlanSends([]);
    setSendImportNote(null);
  }

  function importPlannerSends(): void {
    const plan = readSavedPlannerPlan(inventorySource);
    setSavedPlannerPlan(plan);
    if (!plan || plan.sends.length === 0) {
      setSendImportNote(null);
      return;
    }
    if (containsSendRun(prePlanSends, plan.sends)) {
      setSendImportNote("Already here");
      return;
    }
    const stamp = Date.now();
    const room = Math.max(0, MAX_PRE_PLAN_SEND_ROWS - prePlanSends.length);
    const added = plan.sends.slice(0, room);
    setPrePlanSends([
      ...prePlanSends,
      ...added.map((send, index) => ({ ...send, id: `aap-${stamp}-${index}-${send.ship}-${send.durationType}` })),
    ]);
    const addedLaunches = added.reduce((sum, send) => sum + send.launches, 0);
    const leftOutLaunches =
      plan.droppedLaunches + plan.sends.slice(room).reduce((sum, send) => sum + send.launches, 0);
    const notes = [
      `Imported ${added.length.toLocaleString()} ${added.length === 1 ? "row" : "rows"} (${addedLaunches.toLocaleString()} launches)`,
    ];
    if (leftOutLaunches > 0) {
      notes.push(`${leftOutLaunches.toLocaleString()} launches left out (${MAX_PRE_PLAN_SEND_ROWS} rows max)`);
    }
    if (plan.inAirLaunches > 0) {
      // The planner counted these ships' loot, so the XP plan should too; their stars are already in.
      setIncludeInFlight(true);
      notes.push(`${plan.inAirLaunches.toLocaleString()} ships in the air counted as expected loot, not sends`);
    }
    if (plan.eid && eid.trim() && plan.eid !== eid.trim()) {
      notes.push("the AAP plan is for a different EID");
    }
    setSendImportNote(notes.join(" · "));
  }

  /** Whole copies a goal's artifact has in the plan inventory, and how many are expected mission drops. */
  function goalOwnedCopies(itemId: string): { owned: number; ownedExpected: number } {
    const itemKey = itemIdToCanonicalKey(itemId);
    const quantity = Number(planSourceInventory?.[itemKey]) || 0;
    const inHand = inHandInventory({ [itemKey]: quantity }, planExpectedDrops)[itemKey] || 0;
    const owned = Math.max(0, Math.floor(quantity));
    return { owned, ownedExpected: Math.max(0, owned - Math.floor(inHand)) };
  }

  function clearGoals(): void {
    updateGoalRows(() => []);
  }

  function updateDraftPrePlanShipDuration(value: string): void {
    const [ship, durationTypeRaw] = value.split("|");
    const durationType = durationTypeRaw as PrePlanDurationType;
    if (!PRE_PLAN_SHIPS.includes(ship) || !["SHORT", "LONG", "EPIC"].includes(durationType)) {
      return;
    }
    setDraftPrePlanShip(ship);
    setDraftPrePlanDuration(durationType);
    if (PRE_PLAN_UNTARGETED_ONLY_SHIPS.has(ship)) {
      setDraftPrePlanTargetAfxId(PRE_PLAN_UNTARGETED_TARGET_AFX_ID);
    }
  }

  function renderMaxCraftInput(artifact: string): JSX.Element {
    const draftValue = draftCraftLimitInputs[artifact] || "";
    const appliedValue = appliedCraftLimits[artifact];
    const isPending = (draftValue === "" ? null : Number(draftValue)) !== (appliedValue ?? null);
    return (
      <input
        className={`${styles.limitInput} ${isPending ? styles.limitInputPending : ""}`}
        type="text"
        inputMode="numeric"
        value={draftValue}
        placeholder="∞"
        aria-label={`Max crafts for ${getArtifactDisplayLabel(artifact)}`}
        title="Blank means unlimited. 0 prevents this artifact from being crafted manually or as an auto-crafted ingredient."
        onChange={(event) => setDraftCraftLimit(artifact, event.target.value)}
      />
    );
  }

  function setFlatSort(sortKey: MaxXpFlatSortKey): void {
    if (sortKey === maxXpFlatSortKey) {
      setMaxXpFlatSortDirection((previous) => (previous === "desc" ? "asc" : "desc"));
      return;
    }
    setMaxXpFlatSortKey(sortKey);
    setMaxXpFlatSortDirection(getDefaultFlatSortDirection(sortKey));
  }

  function renderFlatSortHeader(
    label: React.ReactNode,
    sortKey: MaxXpFlatSortKey,
    className?: string,
    title?: string
  ): JSX.Element {
    const active = maxXpFlatSortKey === sortKey;
    const directionLabel = maxXpFlatSortDirection === "desc" ? "▼" : "▲";
    const titleLabel = title || (typeof label === "string" ? `Sort by ${label}` : "Sort column");
    return (
      <th className={className}>
        <button
          type="button"
          className={`${styles.tableSortButton} ${active ? styles.tableSortButtonActive : ""}`}
          onClick={() => setFlatSort(sortKey)}
          title={titleLabel}
        >
          {label}
          {active && <span className={styles.tableSortArrow} aria-hidden="true">{directionLabel}</span>}
        </button>
      </th>
    );
  }

  function renderStackedHeader(top: string, bottom: string): JSX.Element {
    return (
      <span className={styles.stackedHeaderLabel}>
        <span>{top}</span>
        <span>{bottom}</span>
      </span>
    );
  }

  // The efficiency walk starts after the goal crafts, on what they and held remainders leave.
  const geEfficiencyPlan =
    solution && planSourceInventory
      ? simulateGeEfficiencyPlan(
          goalCrafts?.inventory ?? planSourceInventory,
          goalCrafts?.craftCounts ?? planSourceCraftCounts,
          xpPerGeModeRows.map((row) => ({
            artifact: row.artifact,
            mode: row.mode,
            referenceXpPerGe: row.xpPerGe,
          })),
          minEfficiencyXpPerGe,
          craftingSale
        )
      : null;
  const geEfficiencyTotals =
    geEfficiencyPlan && goalCrafts && goalConstraints
      ? goalsFirstGeTotals(goalCrafts, geEfficiencyPlan, goalConstraints.held)
      : geEfficiencyPlan
        ? {
            totalXp: geEfficiencyPlan.totalXp,
            totalCost: geEfficiencyPlan.totalCost,
            remainingInventory: geEfficiencyPlan.finalInventory,
          }
        : null;
  const geEfficiencyHasGoalCrafts = Boolean(goalCrafts && Object.keys(goalCrafts.crafts).length > 0);
  const geEfficiencyOverallXpPerGe =
    geEfficiencyTotals && geEfficiencyTotals.totalCost > 0 ? geEfficiencyTotals.totalXp / geEfficiencyTotals.totalCost : 0;
  const geEfficiencyStatusByRowKey = getGeEfficiencyStatusMap(xpPerGeModeRows, geEfficiencyPlan, minEfficiencyXpPerGe);
  let maxXpExecutionPlan = null as ReturnType<typeof buildMaxXpExecutionPlan> | null;
  let maxXpExecutionPlanError = null as string | null;
  if (solution && planSourceInventory) {
    try {
      // The click order starts from the whole inventory, goal copies and held
      // items included: the game uses owned copies before auto-crafting, so the
      // order re-crafts any it uses and the plan's balance rows leave them all
      // there at the end. Goal crafts are in the solution like any other.
      maxXpExecutionPlan = buildMaxXpExecutionPlan(
        solution,
        planSourceInventory,
        planSourceCraftCounts,
        sortedArtifacts,
        craftingSale
      );
    } catch (caughtError) {
      maxXpExecutionPlanError =
        caughtError instanceof Error ? caughtError.message : "Unable to derive the Max-XP click order from this plan.";
    }
  }
  const maxXpExecutionRows = maxXpExecutionPlan ? getExecutionPlanRows(maxXpExecutionPlan.steps, maxXpExecutionPlan.usage) : [];
  const maxXpFlatRows = maxXpExecutionPlan
    ? getSortedFlatPlanRows(
        getFlatPlanRows(maxXpExecutionPlan.usage, maxXpExecutionRows),
        maxXpFlatSortKey,
        maxXpFlatSortDirection
      )
    : [];
  // Walking the order: each manual row's odds start from the craft count and
  // crafting XP the rows above it reach. Flat rows combine an artifact's runs.
  const shinyOddsKey = showShinyOdds
    ? JSON.stringify([maxXpExecutionRows.map((row) => [row.artifact, row.mode, row.count, row.xp]), planSourceCraftingXp])
    : "";
  const shinyOdds = useMemo(() => {
    const byRow = new Map<string, ShinyRunOdds>();
    const byArtifact = new Map<string, ShinyRunOdds>();
    if (!shinyOddsKey) {
      return { byRow, byArtifact };
    }
    const crafted: Record<string, number> = { ...planSourceCraftCounts };
    let xp = planSourceCraftingXp ?? 0;
    const misses = new Map<string, Map<ShinyRarity, number>>();
    const runCounts = new Map<string, number>();
    for (const row of maxXpExecutionRows) {
      const craftedBefore = Math.max(0, Math.round(crafted[row.artifact] || 0));
      if (row.count > 0) {
        const run = craftRunOdds({ itemKey: row.artifact, craftedBefore, craftingXp: xp, crafts: row.count });
        if (run.length > 0) {
          const each = (entry: (typeof run)[number]) =>
            entry.firstChance === entry.lastChance
              ? `${(entry.firstChance * 100).toFixed(2)}% each`
              : `${(entry.firstChance * 100).toFixed(2)}% → ${(entry.lastChance * 100).toFixed(2)}% each`;
          byRow.set(
            row.key,
            run.map((entry) => ({
              rarity: entry.rarity,
              chance: 1 - entry.miss,
              detail: `${row.count.toLocaleString()} crafts, ${each(entry)}`,
              // Auto-crafts can't be shiny; these odds are for crafting the row by hand instead.
              ifByHand: row.mode === "auto",
            }))
          );
        }
        // The flat view describes the plan as written: only its manual crafts roll.
        if (run.length > 0 && row.mode === "click") {
          const artifactMisses = misses.get(row.artifact) || new Map<ShinyRarity, number>();
          for (const entry of run) {
            artifactMisses.set(entry.rarity, (artifactMisses.get(entry.rarity) ?? 1) * entry.miss);
          }
          misses.set(row.artifact, artifactMisses);
          runCounts.set(row.artifact, (runCounts.get(row.artifact) || 0) + row.count);
        }
      }
      crafted[row.artifact] = craftedBefore + row.count;
      xp += row.xp;
    }
    for (const [artifact, artifactMisses] of misses) {
      const crafts = runCounts.get(artifact) || 0;
      byArtifact.set(
        artifact,
        Array.from(artifactMisses.entries()).map(([rarity, miss]) => ({
          rarity,
          chance: 1 - miss,
          detail: `${crafts.toLocaleString()} manual crafts in all`,
        }))
      );
    }
    return { byRow, byArtifact };
    // The key holds every input the walk reads (rows, counts, XP); craft counts change only with a new calculate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shinyOddsKey, planSourceCraftCounts]);
  const maxXpConsumedIngredientRows = maxXpExecutionPlan
    ? getSortedConsumedIngredientRows(
        getConsumedIngredientRows(maxXpExecutionPlan.usage),
        maxXpFlatSortKey,
        maxXpFlatSortDirection
      )
    : [];

  const goalCount = goalRows.filter((row) => row.itemId).length;
  const shortGoalCount =
    goalRowReservations?.goals.filter((goal) => goal.itemKey && Object.keys(goal.short).length > 0).length ?? 0;
  const goalsSummary =
    goalCount === 0
      ? "None"
      : [
          `${goalCount} goal${goalCount === 1 ? "" : "s"}`,
          goalRowReservations
            ? `uses ${goalRowReservations.totalReserved.toLocaleString()} item${goalRowReservations.totalReserved === 1 ? "" : "s"}`
            : null,
          shortGoalCount > 0 ? `${shortGoalCount} short` : null,
        ]
          .filter(Boolean)
          .join(" · ");
  // What the goals cost: max XP without them minus max XP with them, unless
  // the plan without goals already meets them (then any difference is solver noise).
  const goalPlanCurrent = Boolean(solvedGoalPlan && solvedGoalPlan.goalKey === planGoalKey);
  const keepCostXp =
    solution && goalConstraints && goalPlanCurrent && baselineCurrent && planSourceInventory
      ? planMeetsGoals(
          baselineCurrent.crafts,
          planSourceInventory,
          addCountMaps(goalConstraints.held, goalConstraints.requirements.keepCopies || {}),
          goalConstraints.requirements.minCrafts
        )
        ? 0
        : Math.max(0, Math.round(baselineCurrent.totalXp - solution.totalXp))
      : 0;
  // Goals (by position among rows with an item) that max-craft limits keep out of the plan.
  const blockedGoalIndexes = new Set(goalPlanCurrent && goalsKey === appliedGoalsKey ? solvedGoalPlan?.blocked ?? [] : []);
  const keepCostShare = keepCostXp > 0 && baselineCurrent && baselineCurrent.totalXp > 0 ? keepCostXp / baselineCurrent.totalXp : 0;

  function updateGoalRows(update: (rows: PlannerTargetRow[]) => PlannerTargetRow[]): void {
    setGoalRows(update);
    setGoalImportNote(null);
  }

  function importPlannerGoals(): void {
    if (!planSourceInventory) {
      return;
    }
    const plannerRows = readPlannerSavedTargetRows(goalImportSource, GOAL_TARGET_OPTIONS);
    setSavedPlannerGoalCount(plannerRows.length);
    if (plannerRows.length === 0) {
      setGoalImportNote(null);
      return;
    }
    // Planner copies goals mean "N more" than you have in hand; here a goal means having N in total.
    // With its "only crafted" on they mean N more crafts, which become craft-count goals.
    const craftedOnly = readPlannerSavedCraftedOnly(goalImportSource);
    const saved = plannerRowsToKeepRows(
      plannerRows,
      inHandInventory(planSourceInventory, planExpectedDrops),
      { craftCounts: planSourceCraftCounts, craftedOnly }
    );
    // Craft counts the "only crafted" setting made.
    const convertedRows = new Set(saved.filter((row, index) => row.craftGoal && !plannerRows[index].craftGoal));
    const sameGoal = (left: PlannerTargetRow, right: PlannerTargetRow) =>
      left.itemId === right.itemId &&
      left.craftGoal === right.craftGoal &&
      normalizedTargetQuantity(left.quantityInput) === normalizedTargetQuantity(right.quantityInput);
    const current = goalRows.filter((row) => row.itemId);
    const added = saved.filter((row) => !current.some((existing) => sameGoal(existing, row)));
    const room = Math.max(0, MAX_TARGET_ROWS - current.length);
    const imported = added.slice(0, room);
    setGoalRows([...current, ...imported.map((row) => ({ ...row, id: newTargetRowId() }))]);
    const converted = imported.filter((row) => convertedRows.has(row)).length;
    const convertedNote = converted > 0 ? ` · ${converted} as craft counts (AAP "only crafted" is on)` : "";
    setGoalImportNote(
      added.length === 0
        ? "Already here"
        : added.length > room
          ? `Imported ${room} (${MAX_TARGET_ROWS} max)${convertedNote}`
          : `Imported ${added.length}${convertedNote}`
    );
  }

  return (
    <main className="page">
      <div className="panel brand-panel">
        <div className="brand-header" data-compact="1">
          <Link href="/" className="brand-mark-shell brand-mark-link" aria-label="Back to menu">
            <Image src="/media/hamster_egg_poly.png" alt="" width={1024} height={1536} className="brand-mark" priority />
          </Link>
          <div className="brand-copy">
            <h1 className="brand-title">{XP_GE_CRAFT_COPY.title}</h1>
            <p className="muted brand-subtitle">{XP_GE_CRAFT_COPY.subtitle}</p>
            <details className="info-disclosure">
              <summary className="subtle-info-link">More info</summary>
              <p className="muted">{XP_GE_CRAFT_COPY.longDescription}</p>
            </details>
          </div>
          <Link href="/" className="brand-home-link" aria-label="Back to main menu" title="Back to main menu">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M3.5 10.5 12 3.5l8.5 7v9a1 1 0 0 1-1 1h-5.5v-6h-4v6H4.5a1 1 0 0 1-1-1z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>

        <div className={styles.inputSection}>
          <div className={styles.inputPrimaryRow}>
            <div className={styles.inputField}>
              <label htmlFor="eidInput">EID</label>
              <input
                id="eidInput"
                type="text"
                value={eid}
                onChange={(event) => setEID(event.target.value)}
                onPaste={(event) => {
                  event.preventDefault();
                  setEID(event.clipboardData.getData("text"));
                }}
                placeholder="EI123... (blank for a demo)"
              />
              <ProfileCustomizer
                eid={eid}
                overrides={profileOverrides}
                onChange={setProfileOverrides}
                summary={realProfileSummary?.eid === eid.trim() ? realProfileSummary.summary : null}
                pendingNote={
                  solution && calculatedOverridesKey != null && calculatedOverridesKey !== JSON.stringify(profileOverrides)
                    ? "recalculate to apply"
                    : null
                }
              />
            </div>
            <fieldset className={styles.ingredientSourceGroup}>
              <legend>Include as ingredients</legend>
              <label className={styles.inputCheckbox} title="Count rare shiny artifacts as ingredients (demote them in game first)">
                <input type="checkbox" checked={includeRare} onChange={(event) => setIncludeRare(event.target.checked)} />
                Rare
              </label>
              <label className={styles.inputCheckbox} title="Count epic shiny artifacts as ingredients (demote them in game first)">
                <input type="checkbox" checked={includeEpic} onChange={(event) => setIncludeEpic(event.target.checked)} />
                Epic
              </label>
              <label
                className={styles.inputCheckbox}
                title="Count legendary shiny artifacts as ingredients (demote them in game first)"
              >
                <input
                  type="checkbox"
                  checked={includeLegendary}
                  onChange={(event) => setIncludeLegendary(event.target.checked)}
                />
                Legendary
              </label>
              <label
                className={styles.inputCheckbox}
                title="Harvest stones slotted in artifacts. When off, shiny artifacts that hold stones are also kept out of the ingredient pool."
              >
                <input
                  type="checkbox"
                  checked={includeSlotted}
                  onChange={(event) => setIncludeSlotted(event.target.checked)}
                />
                Slotted
              </label>
              <label className={styles.inputCheckbox}>
                <input
                  type="checkbox"
                  checked={includeFragments}
                  onChange={(event) => setIncludeFragments(event.target.checked)}
                />
                Stone fragments
              </label>
            </fieldset>
            <label className={`${styles.inputCheckbox} ${styles.saleCheckbox}`}>
              <input
                type="checkbox"
                checked={craftingSale}
                onChange={(event) => setCraftingSale(event.target.checked)}
              />
              30% off crafting sale
            </label>
            <div className={styles.inputField}>
              <label htmlFor="craft-inventory-source">Inventory source</label>
              <select
                id="craft-inventory-source"
                value={inventorySource}
                onChange={(event) => setInventorySource(event.target.value as InventorySource)}
              >
                <option value="main">Main farm</option>
                <option value="virtue">Path of Virtue</option>
              </select>
            </div>
            <button onClick={runOptimize} disabled={isLoading}>
              {isLoading ? "Calculating..." : "Calculate"}
            </button>
          </div>

          <details
            className={styles.prePlanDrawer}
            open={prePlanOpen}
            onToggle={(event) => setPrePlanOpen(event.currentTarget.open)}
          >
            <summary className={styles.prePlanSummary}>
              <span className={styles.prePlanTitleRow}>
                <span className={styles.prePlanCaret} aria-hidden="true">▶</span>
                <span>Optional pre-plan ship sends</span>
              </span>
              <span className={styles.prePlanSummaryMeta}>
                {prePlanTotalLaunches > 0 ? `${prePlanTotalLaunches.toLocaleString()} assumed sends` : "No assumed sends"}
                {includeInFlight &&
                  (inFlightCount != null && !prePlanAssumptionsStale
                    ? ` · ${inFlightCount.toLocaleString()} ${inFlightCount === 1 ? "ship" : "ships"} in the air counted`
                    : " · counting ships in the air")}
                {prePlanAssumptionsStale ? (
                  <span className={styles.prePlanStaleText}>
                    {" · "}
                    assumptions changed; plans stale, re-calculate to update
                  </span>
                ) : lastPrePlanResult && (
                  <>
                    {" · "}
                    {Math.max(0, lastPrePlanResult.appliedLaunches || 0).toLocaleString()} applied
                    {lastPrePlanResult.skippedLaunches ? `, ${lastPrePlanResult.skippedLaunches.toLocaleString()} skipped` : ""}
                    {lastPrePlanResult.noLootLaunches
                      ? `, ${lastPrePlanResult.noLootLaunches.toLocaleString()} without loot data`
                      : ""}
                    {prePlanAddedItemCount > 0 && (
                      <>
                        {" · "}
                        <span className={styles.prePlanTooltipText} title={prePlanAdditionsTooltip}>
                          expected additions across {prePlanAddedItemCount.toLocaleString()} item types
                        </span>
                      </>
                    )}
                  </>
                )}
              </span>
            </summary>
            <div className={styles.prePlanDrawerBody}>
              <div className={styles.prePlanComposer}>
                <div className={styles.prePlanInlineField}>
                  <label htmlFor="pre-plan-ship-duration">Ship</label>
                  <select
                    id="pre-plan-ship-duration"
                    value={draftPrePlanShipDuration}
                    onChange={(event) => updateDraftPrePlanShipDuration(event.target.value)}
                  >
                    {shipDurationOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.prePlanInlineField}>
                  <label htmlFor="pre-plan-target">Target</label>
                  <select
                    id="pre-plan-target"
                    value={selectedDraftShipIsUntargetedOnly ? PRE_PLAN_UNTARGETED_TARGET_AFX_ID : draftPrePlanTargetAfxId}
                    onChange={(event) => setDraftPrePlanTargetAfxId(Number(event.target.value))}
                    disabled={selectedDraftShipIsUntargetedOnly}
                    title={selectedDraftShipIsUntargetedOnly ? "This ship only supports untargeted sends." : undefined}
                  >
                    {PRE_PLAN_TARGET_OPTIONS.map((option) => (
                      <option key={option.afxId} value={option.afxId}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={`${styles.prePlanInlineField} ${styles.prePlanQuantityField}`}>
                  <label htmlFor="pre-plan-launches">Sends</label>
                  <input
                    id="pre-plan-launches"
                    type="text"
                    inputMode="numeric"
                    value={draftPrePlanLaunches}
                    onChange={(event) => setDraftPrePlanLaunches(event.target.value.replace(/[^\d]/g, ""))}
                    onBlur={() =>
                      setDraftPrePlanLaunches(
                        String(Math.max(1, Math.min(MAX_PRE_PLAN_LAUNCHES_PER_ROW, Math.round(Number(draftPrePlanLaunches) || 1))))
                      )
                    }
                  />
                </div>
                <button
                  type="button"
                  className={styles.prePlanAddButton}
                  onClick={addPrePlanSend}
                  disabled={prePlanSends.length >= MAX_PRE_PLAN_SEND_ROWS}
                  title={prePlanSends.length >= MAX_PRE_PLAN_SEND_ROWS ? `${MAX_PRE_PLAN_SEND_ROWS} rows max` : undefined}
                >
                  Add
                </button>
              </div>
              <label
                className={styles.inputCheckbox}
                title="Add the expected loot from ships already in the air to the inventory the plan crafts from, as the Artifact Attainment Planner does. Off plans with only what's in hand."
              >
                <input
                  type="checkbox"
                  checked={includeInFlight}
                  onChange={(event) => setIncludeInFlight(event.target.checked)}
                />
                Count ships in the air (expected loot)
                {inFlightCount != null && (
                  <span className={styles.prePlanMeta}>
                    {inFlightCount === 0
                      ? "none in the air"
                      : `${inFlightCount.toLocaleString()} in the air`}
                  </span>
                )}
              </label>
              <div className={styles.prePlanMeta}>
                Ships start at your current stars and level up as the sends run, top row first.
                {prePlanSends.length > 0 && !prePlanRowResults && " Calculate to see each row's stars."}
              </div>
              <div className={styles.goalsActions}>
                <button
                  type="button"
                  className={styles.goalsImportButton}
                  onClick={importPlannerSends}
                  disabled={!savedPlannerPlan || savedPlannerPlan.sends.length === 0}
                  title={`Add the launches from your last Artifact Attainment Planner plan for the ${inventorySourceLabel} inventory, prep launches first. Launches already in the air are left out.`}
                >
                  Import my AAP plan sends
                </button>
                <button
                  type="button"
                  className={styles.goalsImportButton}
                  onClick={clearPrePlanSends}
                  disabled={prePlanSends.length === 0}
                >
                  Clear sends
                </button>
                {sendImportNote ? (
                  <span className={styles.prePlanMeta}>{sendImportNote}</span>
                ) : !savedPlannerPlan || savedPlannerPlan.sends.length === 0 ? (
                  <span className={styles.prePlanMeta}>No AAP plan saved for the {inventorySourceLabel} inventory yet</span>
                ) : (
                  <span className={styles.prePlanMeta}>
                    {inventorySourceLabel} AAP plan
                    {savedPlannerPlan.savedAt ? ` from ${new Date(savedPlannerPlan.savedAt).toLocaleString()}` : ""}:{" "}
                    {savedPlannerPlanLaunches.toLocaleString()} launches
                  </span>
                )}
              </div>
              {(prePlanSends.length > 0 || inAirRows.length > 0) && (
                <ol className={styles.prePlanList} aria-label="Pre-plan sends">
                  {inAirRows.map((row, index) => (
                    <li
                      key={`air-${index}-${row.ship}-${row.durationType}-${row.targetAfxId}`}
                      className={`${styles.prePlanRow} ${styles.prePlanRowInAir}`}
                      title="Already launched: its loot counts while the box is ticked, and its stars are already yours."
                    >
                      <span className={styles.prePlanRowLabel}>{prePlanSendLabel({ ...row, id: "" })}</span>
                      <span className={styles.prePlanRowAirTag}>in the air</span>
                    </li>
                  ))}
                  {prePlanSends.map((send, index) => {
                    const result = prePlanRowResults?.[index] ?? null;
                    const outcome = result ? prePlanRowOutcome(result) : null;
                    return (
                      <li key={send.id} className={styles.prePlanRow}>
                        <span className={styles.prePlanRowLabel}>{prePlanSendLabel(send)}</span>
                        {outcome?.stars && <span className={styles.prePlanRowStars}>{outcome.stars}</span>}
                        {outcome?.warnings.map((warning) => (
                          <span key={warning} className={styles.prePlanRowWarn}>
                            {warning}
                          </span>
                        ))}
                        <button
                          type="button"
                          onClick={() => removePrePlanSend(send.id)}
                          aria-label={`Remove ${prePlanSendLabel(send)}`}
                        >
                          x
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </details>

          <details
            className={`${styles.prePlanDrawer} ${styles.goalsDrawer}`}
            open={goalsOpen}
            onToggle={(event) => setGoalsOpen(event.currentTarget.open)}
          >
            <summary className={styles.prePlanSummary}>
              <span className={styles.prePlanTitleRow}>
                <span className={styles.prePlanCaret} aria-hidden="true">▶</span>
                <span>Keep for your goals</span>
              </span>
              <span className={styles.prePlanSummaryMeta}>
                {goalsSummary}
                {keepCostXp > 0 && <> · costs {keepCostXp.toLocaleString()} XP</>}
              </span>
            </summary>
            <div className={`${styles.prePlanDrawerBody} ${styles.goalsBody}`}>
              <div className={styles.prePlanMeta}>The XP plan crafts what it can of these goals and won&apos;t spend what they need.</div>
              <GoalRowsEditor
                rows={goalRows}
                onRowsChange={updateGoalRows}
                options={GOAL_TARGET_OPTIONS}
                craftCounts={planSourceInventory ? planSourceCraftCounts : null}
                craftingXp={planSourceInventory ? planSourceCraftingXp : null}
                allowShinyGoals
                allowCraftLater
                minRows={0}
                newRowItemId=""
                copyLastRowItem={false}
                emptyRowLabel="Choose an artifact"
                addLabel="Add goal"
                copiesTitle={GOAL_COPIES_TITLE}
                craftCountTitle={GOAL_CRAFT_COUNT_TITLE}
                craftCountPendingText="craft count loads when you calculate"
                idPrefix="goalItem"
                renderRowFooter={(row, rowIndex) =>
                  row.itemId ? (
                    <GoalReservationLine
                      goal={goalRowReservations?.goals[rowIndex]}
                      blocked={blockedGoalIndexes.has(goalRows.slice(0, rowIndex).filter((other) => other.itemId).length)}
                      {...goalOwnedCopies(row.itemId)}
                    />
                  ) : null
                }
              />
              <div className={styles.goalsActions}>
                <button
                  type="button"
                  className={styles.goalsImportButton}
                  onClick={importPlannerGoals}
                  disabled={savedPlannerGoalCount === 0 || !planSourceInventory}
                  title={'Copy the goals saved in the Artifact Attainment Planner. Its copies goals mean N more, so they arrive as what you have in hand + N; expected drops from sends and ships in the air count toward them, not on top. With its "Artifacts: only crafted" on, artifact goals mean N more crafts instead, so they arrive as craft counts: crafted so far + N. Shiny goals stay shiny goals.'}
                >
                  Import my AAP goals
                </button>
                <button type="button" className={styles.goalsImportButton} onClick={clearGoals} disabled={goalRows.length === 0}>
                  Clear goals
                </button>
                {savedPlannerGoalCount === 0 ? (
                  <span className={styles.prePlanMeta}>No AAP goals saved yet</span>
                ) : (
                  goalImportNote && <span className={styles.prePlanMeta}>{goalImportNote}</span>
                )}
              </div>
              {!planSourceInventory && (goalCount > 0 || savedPlannerGoalCount > 0) && (
                <div className={styles.prePlanMeta}>Calculate to load your inventory first.</div>
              )}
              {keepCostXp > 0 && (
                <div className={styles.goalsCost}>
                  Your goals cost {keepCostXp.toLocaleString()} XP (
                  {keepCostShare < 0.01 ? "<1%" : `${Math.round(keepCostShare * 100)}%`}).
                </div>
              )}
            </div>
          </details>
        </div>

        {error && (
          <div className={styles.errorBox}>
            {error} <Link href="/xp-ge-craft/diagnostics">Open diagnostics</Link>.
          </div>
        )}

        {solution && planShinyIngredientCount > 0 && (
          <div className={styles.shinyNotice}>
            <span className={styles.inlineWarningLabel}>Note:</span> this plan counts{" "}
            {planShinyIngredientCount.toLocaleString()} rare/epic/legendary artifact
            {planShinyIngredientCount === 1 ? "" : "s"} as ingredients. Demote them in game before crafting, or the game&apos;s
            craftable counts will be lower than shown here.
          </div>
        )}

        {solution && (
          <>
            <div className={styles.summary}>
              <div className={styles.summaryGroup}>
                <div
                  className={styles.summaryGroupLabel}
                  title="Global LP integer plan that maximizes total XP from your current inventory under full ingredient-consumption constraints. Total GE cost sums all craft rows in that LP plan, including intermediate rows."
                >
                  Max XP Plan
                </div>
                <div className={styles.summaryGroupCards}>
                  <div className={styles.summaryCard}>
                    <div className={styles.summaryLabel}>Total XP</div>
                    <div className={styles.summaryValue}>{solution.totalXp.toLocaleString()}</div>
                  </div>
                  <div className={styles.summaryCard}>
                    <div className={styles.summaryLabel}>Total GE Cost</div>
                    <div className={styles.summaryValue}>{solution.totalCost.toLocaleString()}</div>
                  </div>
                </div>
                <div className={styles.summaryMetaRow}>
                  <span className={styles.summaryMeta}>Follow the second table below.</span>
                  <RemainingInventoryDisclosure
                    label="Remaining inventory"
                    planLabel="Remaining inventory after Max XP Plan"
                    inventory={maxXpExecutionPlan?.remainingInventory}
                  />
                </div>
              </div>

              <div className={styles.summaryGroup}>
                <div
                  className={styles.summaryGroupLabel}
                  title="Sequential accumulator: walk the XP/GE-ranked standalone rows top-down and craft each row as much as still possible from remaining inventory, stopping at the first row below your minimum XP/GE threshold."
                >
                  Max GE Efficiency Plan
                </div>
                <div className={styles.efficiencyControl}>
                  <div className={styles.efficiencyControlHeader}>
                    <label htmlFor="minEfficiencyXpPerGe">
                      Min XP / GE: <strong>{minEfficiencyXpPerGe.toFixed(2)}</strong>
                    </label>
                    <span>Overall XP/GE: {geEfficiencyOverallXpPerGe.toFixed(2)}</span>
                  </div>
                  <input
                    id="minEfficiencyXpPerGe"
                    type="range"
                    min={0}
                    max={efficiencySliderMax}
                    step={efficiencySliderStep}
                    value={Math.min(minEfficiencyXpPerGe, efficiencySliderMax)}
                    onChange={(event) => setMinEfficiencyXpPerGe(Number(event.target.value))}
                    disabled={xpPerGeModeRows.length === 0}
                  />
                </div>
                <div className={styles.summaryGroupCards}>
                  <div className={styles.summaryCard}>
                    <div className={styles.summaryLabel}>Accumulated XP</div>
                    <div className={styles.summaryValue}>{Math.round(geEfficiencyTotals?.totalXp || 0).toLocaleString()}</div>
                  </div>
                  <div className={styles.summaryCard}>
                    <div className={styles.summaryLabel}>Accumulated GE Cost</div>
                    <div className={styles.summaryValue}>{Math.round(geEfficiencyTotals?.totalCost || 0).toLocaleString()}</div>
                  </div>
                </div>
                <div className={styles.summaryMetaRow}>
                  <span className={styles.summaryMeta}>
                    {geEfficiencyHasGoalCrafts ? "Craft your goals first, then follow" : "Follow"} the first table below, sorted by
                    XP / GE.
                  </span>
                  <RemainingInventoryDisclosure
                    label="Remaining inventory"
                    planLabel="Remaining inventory after Max GE Efficiency Plan"
                    inventory={geEfficiencyTotals?.remainingInventory}
                  />
                </div>
              </div>
            </div>

            <details
              className={styles.standaloneDrawer}
              open={standaloneOpen}
              onToggle={(event) => setStandaloneOpen(event.currentTarget.open)}
            >
              <summary className={styles.standaloneSummary}>
                <div className={styles.standaloneHeaderMain}>
                  <span className={styles.standaloneTitleRow}>
                    <span className={styles.standaloneCaret} aria-hidden="true">▶</span>
                    <span className={styles.standaloneHeaderTitle}>Standalone Craft Options</span>
                  </span>
                  <div className={styles.standaloneSortControls} onClick={(event) => event.stopPropagation()}>
                    <div className={`${styles.sortSection} ${styles.standaloneSortSection}`}>
                      <span>Sort rows by:</span>
                      <button
                        className={`${styles.sortButton} ${sortKey === "xpPerGe" ? styles.activeButton : ""}`}
                        onClick={() => setSortKey("xpPerGe")}
                      >
                        XP / GE
                      </button>
                      <button
                        className={`${styles.sortButton} ${sortKey === "xp" ? styles.activeButton : ""}`}
                        onClick={() => setSortKey("xp")}
                      >
                        Total XP
                      </button>
                      <button
                        className={`${styles.sortButton} ${sortKey === "tierXpPerGe" ? styles.activeButton : ""}`}
                        onClick={() => setSortKey("tierXpPerGe")}
                      >
                        Tier
                      </button>
                      <button
                        className={`${styles.sortButton} ${sortKey === "familyTier" ? styles.activeButton : ""}`}
                        onClick={() => setSortKey("familyTier")}
                      >
                        Family
                      </button>
                      <button
                        className={`${styles.sortButton} ${sortKey === "name" ? styles.activeButton : ""}`}
                        onClick={() => setSortKey("name")}
                      >
                        Name
                      </button>
                      <label
                        className={styles.shinyOddsToggle}
                        title="Show each row's chance of at least one shiny copy, by rarity. Same setting as the craft order's."
                      >
                        <input type="checkbox" checked={showShinyOdds} onChange={(event) => setShowShinyOdds(event.target.checked)} />
                        Shiny odds
                      </label>
                    </div>
                  </div>
                </div>
                <div className={styles.standaloneTopBox} onClick={(event) => event.stopPropagation()}>
                  <CraftingXpSummaryBox
                    currentXp={planSourceCraftingXp}
                    planXp={Math.round(geEfficiencyTotals?.totalXp || 0)}
                    zoomMode={craftingXpZoomMode}
                    onZoomModeChange={setCraftingXpZoomMode}
                  />
                </div>
              </summary>

              <div className={styles.tableSection}>
                <div className={styles.tableHeaderRow}>
                  <div className={styles.tableHeaderCopy}>
                    <div className={styles.statusLegend}>
                      <span className={styles.statusLegendItem}>
                        <StatusDot status={{ kind: "full", realizedCount: 0, label: "Fully included", title: "Fully included in the Max GE Efficiency Plan." }} /> Full
                      </span>
                      <span className={styles.statusLegendItem}>
                        <StatusDot status={{ kind: "partial", realizedCount: 0, label: "Partially included", title: "Partially included in the Max GE Efficiency Plan." }} /> Part
                      </span>
                      <span className={styles.statusLegendItem}>
                        <StatusDot status={{ kind: "blocked", realizedCount: 0, label: "Blocked", title: "No longer craftable by the time the plan reaches this row." }} /> Blocked
                      </span>
                      <span className={styles.statusLegendItem}>
                        <StatusDot status={{ kind: "belowThreshold", realizedCount: 0, label: "Below threshold", title: "Below the current minimum XP/GE threshold." }} /> Below threshold
                      </span>
                    </div>
                  </div>
                </div>
                <table className={styles.resultsTable}>
                  <thead>
                    <tr>
                      <th>Artifact</th>
                      <th className={styles.num} title="Standalone craftable count from your current inventory. Yellow and red rows show standalone -> realized count in the current Max GE Efficiency Plan.">Count</th>
                      <th className={styles.num}>Total XP</th>
                      <th className={styles.num}>GE Cost</th>
                      <th className={styles.num}>XP / GE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleModeRows.map((row) => {
                      const status = geEfficiencyStatusByRowKey[row.key];
                      return (
                        <tr key={row.key}>
                          <td>
                            <span className={styles.statusArtifactCell}>
                              {status && <StatusDot status={status} />}
                              <ArtifactCell artifact={row.artifact} modeLabel={row.modeLabel} />
                              <ShinyOddsInline
                                odds={standaloneShinyOdds.get(row.key)}
                                artifact={row.artifact}
                                intro="Chance crafting just these gives"
                              />
                            </span>
                          </td>
                          <td className={styles.num}>{getModeRowCountLabel(row, status)}</td>
                          <td className={styles.num}>
                            <span className={styles.valueTooltip} title={getXpTooltip(standaloneSolution!.crafts[row.artifact].xpPerCraft, row.count, row.xp)}>
                              {row.xp.toLocaleString()}
                            </span>
                          </td>
                          <td className={styles.num}>
                            <span className={styles.valueTooltip} title={getCostTooltip(row.artifact, standaloneSolution!.crafts[row.artifact])}>
                              {row.cost.toLocaleString()}
                            </span>
                          </td>
                          <td className={styles.num}>{row.xpPerGe.toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>

            <div className={`${styles.tableSection} ${styles.maxXpOrderPanel}`}>
              {maxXpExecutionPlan ? (
                <>
                  <div className={styles.tableHeaderRow}>
                    <div className={styles.tableHeaderCopy}>
                      <div className={styles.sectionHeaderRow}>
                        <h3>Max-XP Craft Order</h3>
                      </div>
                      <div className={styles.viewControl} aria-label="Max XP craft order view">
                        <span>View:</span>
                          <button
                            className={`${styles.sortButton} ${maxXpPlanView === "tree" ? styles.activeButton : ""}`}
                            onClick={() => setMaxXpPlanView("tree")}
                          >
                            Tree
                          </button>
                          <button
                            className={`${styles.sortButton} ${maxXpPlanView === "flat" ? styles.activeButton : ""}`}
                            onClick={() => setMaxXpPlanView("flat")}
                          >
                            Flat
                          </button>
                          <label
                            className={styles.shinyOddsToggle}
                            title="Show each row's chance of at least one shiny copy, by rarity. Auto-crafts can't be shiny, so indented rows (in grey italics) show what crafting them by hand instead would give."
                          >
                            <input type="checkbox" checked={showShinyOdds} onChange={(event) => setShowShinyOdds(event.target.checked)} />
                            Shiny odds
                          </label>
                      </div>
                      <div className={styles.summaryMeta}>
                        {maxXpPlanView === "tree" ? (
                          <>
                            Craft the unindented rows in order. Indented rows show only the artifacts the game should actually auto-craft
                            underneath those manual crafts after consuming available inventory first.{" "}
                            <span className={styles.inlineWarningLabel}>Warning:</span> auto-crafted artifacts cannot be shiny, so you may
                            want to manually craft high-value targets instead of following this order blindly.
                          </>
                        ) : (
                          <>
                            Flat view shows the same Max XP plan as one row per crafted artifact, for sorting by any column.
                          </>
                        )}
                      </div>
                      {Object.keys(visibleCraftLimits).length > 0 && (
                        <div className={styles.limitChips}>
                          {Object.entries(visibleCraftLimits).map(([artifact, limit]) => (
                            <button key={artifact} className={styles.limitChip} onClick={() => clearDraftCraftLimit(artifact)}>
                              {getArtifactDisplayLabel(artifact)}: {limit === 0 ? "excluded" : `max ${limit.toLocaleString()}`} x
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <CraftingXpSummaryBox
                      currentXp={planSourceCraftingXp}
                      planXp={solution.totalXp}
                      zoomMode={craftingXpZoomMode}
                      onZoomModeChange={setCraftingXpZoomMode}
                    />
                  </div>
                  {maxXpPlanView === "tree" ? (
                    <table className={styles.resultsTable}>
                      <thead>
                        <tr>
                          <th>Craft</th>
                          <th className={styles.num}>Count</th>
                          <th className={styles.num}>{renderStackedHeader("Max", "crafts")}</th>
                          <th className={styles.num}>XP</th>
                          <th className={styles.num} title="Direct craft spend for the rows shown here. Summing the whole tree matches the Max XP Plan total above.">Direct GE Cost</th>
                          <th className={styles.num}>{renderStackedHeader("Net", "remaining")}</th>
                          <th>Used by</th>
                        </tr>
                      </thead>
                      <tbody>
                        {maxXpExecutionRows.map((row) => (
                          <tr key={row.key} data-depth={row.depth} className={row.mode === "click" ? styles.executionRootRow : ""}>
                            <td>
                              <span className={styles.executionArtifactCell}>
                                {row.prefix && <span className={styles.executionPrefix}>{row.prefix}</span>}
                                <ArtifactCell artifact={row.artifact} />
                                <ShinyOddsInline odds={shinyOdds.byRow.get(row.key)} artifact={row.artifact} />
                              </span>
                            </td>
                            <td className={styles.num}>
                              <span className={styles.valueTooltip} title={getUsageTooltip(row.usage)}>{row.count.toLocaleString()}</span>
                            </td>
                            <td className={styles.num}>{renderMaxCraftInput(row.artifact)}</td>
                            <td className={styles.num}>{row.xp.toLocaleString()}</td>
                            <td className={styles.num}>{row.cost.toLocaleString()}</td>
                            <td className={styles.num}>{row.usage?.remaining.toLocaleString() ?? "-"}</td>
                            <td className={styles.usedByCell}><UsedByIcons usage={row.usage} /></td>
                          </tr>
                        ))}
                        {maxXpConsumedIngredientRows.length > 0 && (
                          <tr className={styles.ingredientSectionRow}>
                            <td colSpan={7}>Ingredients consumed from inventory by this plan</td>
                          </tr>
                        )}
                        {maxXpConsumedIngredientRows.map((row) => (
                          <tr key={`consumed-${row.artifact}`} className={styles.baseIngredientRow}>
                            <td><ArtifactCell artifact={row.artifact} /></td>
                            <td className={styles.num}><span className={styles.valueTooltip} title={getUsageTooltip(row.usage)}>{row.inventoryConsumed.toLocaleString()}</span></td>
                            <td className={styles.num}>-</td>
                            <td className={styles.num}>-</td>
                            <td className={styles.num}>-</td>
                            <td className={styles.num}>{row.netRemaining.toLocaleString()}</td>
                            <td className={styles.usedByCell}><UsedByIcons usage={row.usage} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <table className={styles.resultsTable}>
                      <thead>
                        <tr>
                          {renderFlatSortHeader("Artifact", "artifact")}
                          {renderFlatSortHeader("Tier", "tier", styles.num, "Sort by tier")}
                          {renderFlatSortHeader(renderStackedHeader("Manual", "crafts"), "manualCrafts", styles.num, "Sort by manual crafts")}
                          {renderFlatSortHeader(renderStackedHeader("Auto", "crafts"), "autoCrafts", styles.num, "Sort by auto crafts")}
                          <th className={styles.num}>{renderStackedHeader("Max", "crafts")}</th>
                          {renderFlatSortHeader("XP", "xp", styles.num)}
                          {renderFlatSortHeader("GE Cost", "cost", styles.num)}
                          {renderFlatSortHeader(renderStackedHeader("Net", "remaining"), "netRemaining", styles.num, "Sort by net remaining")}
                          {renderFlatSortHeader("Used by", "usedBy")}
                        </tr>
                      </thead>
                      <tbody>
                        {maxXpFlatRows.map((row) => (
                          <tr key={`flat-${row.artifact}`}>
                            <td>
                              <ArtifactCell artifact={row.artifact} hideTier />
                              <ShinyOddsInline odds={shinyOdds.byArtifact.get(row.artifact)} artifact={row.artifact} />
                            </td>
                            <td className={styles.num}>T{row.tier}</td>
                            <td className={styles.num}><span className={styles.valueTooltip} title={getUsageTooltip(row.usage)}>{row.manualCrafts.toLocaleString()}</span></td>
                            <td className={styles.num}><span className={styles.valueTooltip} title={getUsageTooltip(row.usage)}>{row.autoCrafts.toLocaleString()}</span></td>
                            <td className={styles.num}>{renderMaxCraftInput(row.artifact)}</td>
                            <td className={styles.num}>{row.xp.toLocaleString()}</td>
                            <td className={styles.num}>{row.cost.toLocaleString()}</td>
                            <td className={styles.num}>{row.netRemaining.toLocaleString()}</td>
                            <td className={styles.usedByCell}><UsedByIcons usage={row.usage} /></td>
                          </tr>
                        ))}
                        {maxXpConsumedIngredientRows.length > 0 && (
                          <tr className={styles.ingredientSectionRow}>
                            <td colSpan={9}>Ingredients consumed from inventory by this plan</td>
                          </tr>
                        )}
                        {maxXpConsumedIngredientRows.map((row) => (
                          <tr key={`flat-consumed-${row.artifact}`} className={styles.baseIngredientRow}>
                            <td><ArtifactCell artifact={row.artifact} hideTier /></td>
                            <td className={styles.num}>T{row.tier}</td>
                            <td className={styles.num}><span className={styles.valueTooltip} title={getUsageTooltip(row.usage)}>{row.inventoryConsumed.toLocaleString()}</span></td>
                            <td className={styles.num}>-</td>
                            <td className={styles.num}>-</td>
                            <td className={styles.num}>-</td>
                            <td className={styles.num}>-</td>
                            <td className={styles.num}>{row.netRemaining.toLocaleString()}</td>
                            <td className={styles.usedByCell}><UsedByIcons usage={row.usage} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className={styles.summaryMeta}>
                    {maxXpExecutionPlan.totalTopLevelCrafts.toLocaleString()} total manual crafts across{" "}
                    {maxXpExecutionPlan.totalTopLevelRows.toLocaleString()} top-level entries.
                  </div>
                </>
              ) : (
                <div className={styles.summaryMeta}>{maxXpExecutionPlanError || "No Max-XP click order available."}</div>
              )}
            </div>
          </>
        )}

        {hasPendingCraftLimits && (
          <div className={styles.pendingLimitBar}>
            <span>Craft limits changed</span>
            <button onClick={applyCraftLimitDrafts}>Apply &amp; recalculate</button>
            <button className={styles.secondaryButton} onClick={resetCraftLimitDrafts}>Reset changes</button>
          </div>
        )}

        {!solution && (
          <p className={styles.footnote}>
            Enter your Egg Inc. ID and calculate to see optimized craft counts, expected XP, and discounted GE cost based on your
            current inventory and craft history, or leave it blank to try a small demo inventory.
          </p>
        )}

        <div className={styles.pageLinks}>
          <Link href="/xp-ge-craft/diagnostics" className="subtle-link">
            Diagnostics
          </Link>
          <Link href="/" className="subtle-link">
            Back to menu
          </Link>
        </div>
      </div>
    </main>
  );
}
