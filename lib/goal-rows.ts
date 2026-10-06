import { artifactDisplayMap, itemIdToCanonicalKey, itemKeyToDisplayName, itemKeyToIconUrl, itemKeyToId } from "./item-utils";
import { LOCAL_PREF_KEYS, readFirstStoredString } from "./local-preferences";
import { itemIdTakesCraftCountGoal, recipes } from "./recipes";
import {
  DEFAULT_SHINY_GOAL_PERCENT,
  defaultShinyRarity,
  itemIdTakesShinyGoal,
  MAX_SHINY_GOAL_PERCENT,
  MIN_SHINY_GOAL_PERCENT,
  SHINY_RARITIES,
  shinyRaritiesFor,
  type ShinyRarity,
} from "./shiny-odds";

/**
 * Goal rows ("Soul stone (T2) ×1", "Gusset (T3), craft count 400"): the row
 * model, item options and storage format shared by the artifact attainment
 * planner's Goals card and the XP planner's "Keep for your goals" box.
 */

export type TargetOption = {
  itemId: string;
  itemKey: string;
  label: string;
  familyKey: string;
  tierNumber: number;
  iconUrl: string | null;
  searchText: string;
};

export type PlannerTargetRow = {
  id: string;
  itemId: string;
  quantityInput: string;
  /** Read the quantity as an all-time craft-count goal rather than copies. */
  craftGoal: boolean;
  /** Read the quantity as a percent chance of at least one copy of this
   *  rarity or better (a shiny goal); craftGoal is then false. */
  shinyRarity?: ShinyRarity;
};

/** A goal row as stored and as sent to the planners. */
export type PlannerTargetInput = {
  targetItemId: string;
  quantity: number;
  craftGoal?: boolean;
  shinyRarity?: ShinyRarity;
};

export type GoalMode = "copies" | "crafts" | "shiny";

/** What a row's quantity means. */
export function goalRowMode(row: PlannerTargetRow): GoalMode {
  if (row.shinyRarity && itemIdTakesShinyGoal(row.itemId)) {
    return "shiny";
  }
  return row.craftGoal && itemIdTakesCraftCountGoal(row.itemId) ? "crafts" : "copies";
}

export function normalizedShinyGoalPercent(rawValue: string): number {
  return Math.max(MIN_SHINY_GOAL_PERCENT, Math.min(MAX_SHINY_GOAL_PERCENT, Math.round(Number(rawValue) || DEFAULT_SHINY_GOAL_PERCENT)));
}

/** The rarity a row keeps on a new item: the same one when the item has it, else the item's best. */
function shinyRarityFor(itemId: string, wanted: ShinyRarity | undefined): ShinyRarity | undefined {
  const itemKey = itemIdToCanonicalKey(itemId);
  if (wanted && shinyRaritiesFor(itemKey).includes(wanted)) {
    return wanted;
  }
  return defaultShinyRarity(itemKey) ?? undefined;
}

/** Craft count a new craft-count goal starts at: where an artifact's shiny
 *  (rarity) luck from crafting stops improving. Only artifacts take the goal
 *  (itemIdTakesCraftCountGoal). */
export const CRAFT_GOAL_DEFAULT_COUNT = 400;
/** Where an artifact's GE crafting discount stops improving. Mirrors
 *  MAX_CRAFT_COUNT_FOR_DISCOUNT in lib/planner.ts. Earlier builds seeded every
 *  craft-count goal here (artifacts, stones and ingredients alike), so it still
 *  counts as a seed. A saved artifact goal at 300 loads as 300: it is also the
 *  GE-discount target, so it may be the count the player wants. */
export const CRAFT_DISCOUNT_MAX_COUNT = 300;
export const MAX_TARGET_ROWS = 10;
/** Largest goal quantity, copies or crafts. */
export const MAX_TARGET_QUANTITY = 9999;

/** A craft-count goal still at a seeded default (or the older 300 seed) rather than a number the player typed. */
export function isCraftGoalSeed(quantity: number): boolean {
  return quantity === CRAFT_GOAL_DEFAULT_COUNT || quantity === CRAFT_DISCOUNT_MAX_COUNT;
}

export function targetFamilyKey(itemKey: string): string {
  const match = itemKey.match(/^(.*)_\d+$/);
  return match ? match[1] : itemKey;
}

export function targetTierNumber(itemKey: string, displayTierNumber?: number): number {
  if (displayTierNumber != null && Number.isFinite(displayTierNumber)) {
    return displayTierNumber;
  }
  const match = itemKey.match(/_(\d+)$/);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function normalizedTargetQuantity(rawValue: string): number {
  return Math.max(1, Math.min(MAX_TARGET_QUANTITY, Math.round(Number(rawValue) || 1)));
}

export function targetRowToPlannerTarget(row: PlannerTargetRow): PlannerTargetInput {
  if (goalRowMode(row) === "shiny") {
    return {
      targetItemId: row.itemId,
      quantity: normalizedShinyGoalPercent(row.quantityInput),
      shinyRarity: row.shinyRarity,
    };
  }
  const target: PlannerTargetInput = {
    targetItemId: row.itemId,
    quantity: normalizedTargetQuantity(row.quantityInput),
  };
  if (row.craftGoal && itemIdTakesCraftCountGoal(row.itemId)) {
    target.craftGoal = true;
  }
  return target;
}

export function parseStoredTargetRows(raw: string | null, targetOptions: TargetOption[]): PlannerTargetRow[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const availableTargets = new Set(targetOptions.map((option) => option.itemId));
    const rows: PlannerTargetRow[] = [];
    for (const value of parsed) {
      if (!value || typeof value !== "object" || rows.length >= MAX_TARGET_ROWS) {
        continue;
      }
      const record = value as {
        targetItemId?: unknown;
        itemId?: unknown;
        quantity?: unknown;
        quantityInput?: unknown;
        craftGoal?: unknown;
        shinyRarity?: unknown;
      };
      const itemId = typeof record.targetItemId === "string"
        ? record.targetItemId
        : typeof record.itemId === "string"
          ? record.itemId
          : "";
      if (!availableTargets.has(itemId)) {
        continue;
      }
      const shinyRarity =
        typeof record.shinyRarity === "string" &&
        (SHINY_RARITIES as readonly string[]).includes(record.shinyRarity) &&
        itemIdTakesShinyGoal(itemId) &&
        shinyRaritiesFor(itemIdToCanonicalKey(itemId)).includes(record.shinyRarity as ShinyRarity)
          ? (record.shinyRarity as ShinyRarity)
          : undefined;
      if (shinyRarity) {
        rows.push({
          id: `target-${rows.length + 1}`,
          itemId,
          quantityInput: String(normalizedShinyGoalPercent(String(record.quantity ?? record.quantityInput))),
          craftGoal: false,
          shinyRarity,
        });
        continue;
      }
      // A shiny goal on an item that can't take one loads as one copy.
      const storedQuantity =
        record.shinyRarity != null
          ? 1
          : Math.max(1, Math.min(MAX_TARGET_QUANTITY, Math.round(Number(record.quantity ?? record.quantityInput) || 1)));
      // Only artifacts take a craft-count goal. A saved goal on a stone or an
      // ingredient loads as copies, and a seeded count drops back to one copy
      // (as toggling the chip off does) rather than asking for hundreds.
      const craftGoal = record.craftGoal === true && itemIdTakesCraftCountGoal(itemId);
      const quantity =
        record.craftGoal === true && !craftGoal && isCraftGoalSeed(storedQuantity) ? 1 : storedQuantity;
      rows.push({
        id: `target-${rows.length + 1}`,
        itemId,
        quantityInput: String(quantity),
        craftGoal,
      });
    }
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

export function serializeTargetRows(rows: PlannerTargetRow[]): string {
  return JSON.stringify(rows.map(targetRowToPlannerTarget));
}

/** Every item with a recipe entry (craftable or not), sorted by family then tier. */
export function buildTargetOptions(): TargetOption[] {
  return Object.keys(recipes)
    .map((itemKey) => {
      const displayInfo = artifactDisplayMap[itemKey];
      const itemId = displayInfo?.id || itemKeyToId(itemKey);
      const tierNumber = targetTierNumber(itemKey, displayInfo?.tierNumber);
      const familyKey = targetFamilyKey(itemKey);
      const label =
        displayInfo && Number.isFinite(displayInfo.tierNumber)
          ? `${displayInfo.name} (T${displayInfo.tierNumber})`
          : itemKeyToDisplayName(itemKey);
      const iconUrl = itemKeyToIconUrl(itemKey);
      const searchText = [label, itemId, itemKey, familyKey].join(" ").toLowerCase();
      return { itemId, itemKey, label, familyKey, tierNumber, iconUrl, searchText } satisfies TargetOption;
    })
    .sort((a, b) => {
      const familyCompare = a.familyKey.localeCompare(b.familyKey);
      if (familyCompare !== 0) {
        return familyCompare;
      }
      if (a.tierNumber !== b.tierNumber) {
        return a.tierNumber - b.tierNumber;
      }
      return a.label.localeCompare(b.label);
    });
}

/** Options whose search text holds every whitespace-separated term of the filter. */
export function filterTargetOptions(options: TargetOption[], filter: string): TargetOption[] {
  const query = filter.trim().toLowerCase();
  if (!query) {
    return options;
  }
  const terms = query.split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) {
    return options;
  }
  return options.filter((option) => terms.every((term) => option.searchText.includes(term)));
}

export function newTargetRowId(): string {
  return `target-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Point a row at a new item. A seeded craft count drops back to one copy when the new item can't take a craft-count goal. */
export function selectTargetRowOption(rows: PlannerTargetRow[], rowId: string, option: TargetOption): PlannerTargetRow[] {
  const next = rows.map((row) => {
    if (row.id !== rowId) {
      return row;
    }
    if (goalRowMode(row) === "shiny") {
      // A shiny goal follows the new item to its nearest rarity, or becomes one copy.
      const shinyRarity = itemIdTakesShinyGoal(option.itemId) ? shinyRarityFor(option.itemId, row.shinyRarity) : undefined;
      return shinyRarity
        ? { ...row, itemId: option.itemId, shinyRarity }
        : { id: row.id, itemId: option.itemId, quantityInput: "1", craftGoal: false };
    }
    const craftGoal = row.craftGoal && itemIdTakesCraftCountGoal(option.itemId);
    // A seeded craft count drops back to one copy when the new item can't
    // take a craft-count goal (a stone, an ingredient or a tier-1 artifact),
    // as toggling the chip off does. A number the player typed stays.
    const quantityInput =
      row.craftGoal && !craftGoal && isCraftGoalSeed(normalizedTargetQuantity(row.quantityInput))
        ? "1"
        : row.quantityInput;
    return { ...row, itemId: option.itemId, craftGoal, quantityInput };
  });
  return next.length > 0 ? next : [{ id: rowId, itemId: option.itemId, quantityInput: "1", craftGoal: false }];
}

export function setTargetRowQuantityInput(rows: PlannerTargetRow[], rowId: string, rawValue: string): PlannerTargetRow[] {
  return rows.map((row) => (row.id === rowId ? { ...row, quantityInput: rawValue } : row));
}

export function normalizeTargetRowQuantity(rows: PlannerTargetRow[], rowId: string): PlannerTargetRow[] {
  return rows.map((row) => {
    if (row.id !== rowId) {
      return row;
    }
    if (goalRowMode(row) === "shiny") {
      return { ...row, quantityInput: String(normalizedShinyGoalPercent(row.quantityInput)) };
    }
    const parsed = Number(row.quantityInput);
    const quantity = Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_TARGET_QUANTITY, Math.round(parsed))) : 1;
    return { ...row, quantityInput: String(quantity) };
  });
}

/**
 * Switch what a row's quantity means. Copies, craft counts and percents live
 * on different scales, so a quantity still at the mode's default moves to the
 * new mode's default (one copy, CRAFT_GOAL_DEFAULT_COUNT crafts, 50%) and a
 * number the player typed carries over where it fits.
 */
export function setTargetRowGoalMode(rows: PlannerTargetRow[], rowId: string, mode: GoalMode): PlannerTargetRow[] {
  return rows.map((row) => {
    const current = goalRowMode(row);
    if (row.id !== rowId || current === mode) {
      return row;
    }
    if (mode === "shiny") {
      const shinyRarity = itemIdTakesShinyGoal(row.itemId) ? shinyRarityFor(row.itemId, row.shinyRarity) : undefined;
      return shinyRarity
        ? { ...row, craftGoal: false, shinyRarity, quantityInput: String(DEFAULT_SHINY_GOAL_PERCENT) }
        : row;
    }
    if (mode === "crafts" && !itemIdTakesCraftCountGoal(row.itemId)) {
      return row;
    }
    const base: PlannerTargetRow = { id: row.id, itemId: row.itemId, quantityInput: row.quantityInput, craftGoal: false };
    if (current === "shiny") {
      // A percent means nothing as copies or crafts.
      return mode === "crafts"
        ? { ...base, craftGoal: true, quantityInput: String(CRAFT_GOAL_DEFAULT_COUNT) }
        : { ...base, quantityInput: "1" };
    }
    return toggleTargetRowCraftGoal([row], rowId)[0];
  });
}

export function setTargetRowShinyRarity(rows: PlannerTargetRow[], rowId: string, rarity: ShinyRarity): PlannerTargetRow[] {
  return rows.map((row) =>
    row.id === rowId && goalRowMode(row) === "shiny" && shinyRaritiesFor(itemIdToCanonicalKey(row.itemId)).includes(rarity)
      ? { ...row, shinyRarity: rarity }
      : row
  );
}

export function toggleTargetRowCraftGoal(rows: PlannerTargetRow[], rowId: string): PlannerTargetRow[] {
  return rows.map((row) => {
    if (row.id !== rowId || !itemIdTakesCraftCountGoal(row.itemId)) {
      return row;
    }
    const nextCraftGoal = !row.craftGoal;
    const quantity = normalizedTargetQuantity(row.quantityInput);
    // Copies and craft counts live on very different scales, so a goal that
    // is still the stepper default gets seeded at CRAFT_GOAL_DEFAULT_COUNT,
    // and switching back drops that seed (or the older 300 one) rather than
    // asking for hundreds of copies.
    const quantityInput = nextCraftGoal
      ? quantity <= 1
        ? String(CRAFT_GOAL_DEFAULT_COUNT)
        : row.quantityInput
      : isCraftGoalSeed(quantity)
        ? "1"
        : row.quantityInput;
    return { ...row, craftGoal: nextCraftGoal, quantityInput };
  });
}

export function appendTargetRow(rows: PlannerTargetRow[], id: string, itemId: string): PlannerTargetRow[] {
  return [...rows, { id, itemId, quantityInput: "1", craftGoal: false }].slice(0, MAX_TARGET_ROWS);
}

/** Drop a row, keeping at least `minRows` (the attainment planner always has one goal). */
export function removeTargetRow(rows: PlannerTargetRow[], rowId: string, minRows: number): PlannerTargetRow[] {
  const next = rows.filter((row) => row.id !== rowId);
  return next.length >= minRows ? next : rows;
}

type StoredPlannerSourcePreferences = Partial<
  Record<"main" | "virtue", { targetRows?: unknown; targetCraftedOnly?: unknown } | undefined>
>;

function parseSourcePreferences(raw: string | null): StoredPlannerSourcePreferences {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StoredPlannerSourcePreferences) : {};
  } catch {
    return {};
  }
}

/**
 * The goal rows the attainment planner would load for an inventory source:
 * its per-source saved preferences, or (before it saved any for that source)
 * the shared legacy target list, as the planner itself falls back.
 */
export function plannerSavedTargetRows(
  stored: { sourcePreferences: string | null; targets: string | null },
  source: "main" | "virtue",
  targetOptions: TargetOption[]
): PlannerTargetRow[] {
  const scoped = parseSourcePreferences(stored.sourcePreferences)[source];
  if (scoped && typeof scoped === "object") {
    return scoped.targetRows ? parseStoredTargetRows(JSON.stringify(scoped.targetRows), targetOptions) || [] : [];
  }
  return parseStoredTargetRows(stored.targets, targetOptions) || [];
}

/** Read the attainment planner's saved goal rows for a source from localStorage. */
export function readPlannerSavedTargetRows(source: "main" | "virtue", targetOptions: TargetOption[]): PlannerTargetRow[] {
  return plannerSavedTargetRows(
    {
      sourcePreferences: readFirstStoredString([LOCAL_PREF_KEYS.plannerSourcePreferences]),
      targets: readFirstStoredString([LOCAL_PREF_KEYS.plannerTargets]),
    },
    source,
    targetOptions
  );
}

/**
 * Whether the attainment planner's "Artifacts: only crafted" box is on for a
 * source: its per-source saved preferences, or the shared legacy flag before
 * it saved any for that source.
 */
export function plannerSavedCraftedOnly(
  stored: { sourcePreferences: string | null; craftedOnly: string | null },
  source: "main" | "virtue"
): boolean {
  const scoped = parseSourcePreferences(stored.sourcePreferences)[source];
  if (scoped && typeof scoped === "object") {
    return scoped.targetCraftedOnly === true;
  }
  return stored.craftedOnly === "true";
}

/** Read the attainment planner's "only crafted" setting for a source from localStorage. */
export function readPlannerSavedCraftedOnly(source: "main" | "virtue"): boolean {
  return plannerSavedCraftedOnly(
    {
      sourcePreferences: readFirstStoredString([LOCAL_PREF_KEYS.plannerSourcePreferences]),
      craftedOnly: readFirstStoredString([LOCAL_PREF_KEYS.plannerTargetCraftedOnly]),
    },
    source
  );
}

/**
 * The inventory without expected mission drops (pre-plan sends, ships in the
 * air): what is in hand. Values snap to a millionth, so 142.4 - 31.4 floors
 * to 111 rather than 110.
 */
export function inHandInventory(
  inventory: Record<string, number>,
  expectedDrops: Array<Record<string, number> | null | undefined>
): Record<string, number> {
  const inHand: Record<string, number> = {};
  for (const [itemKey, quantity] of Object.entries(inventory)) {
    let left = Number(quantity) || 0;
    for (const drops of expectedDrops) {
      left -= Number(drops?.[itemKey]) || 0;
    }
    inHand[itemKey] = Math.max(0, Math.round(left * 1e6) / 1e6);
  }
  return inHand;
}

/**
 * Attainment-planner goals as XP-planner keep goals. A planner copies goal
 * "×N" means N more copies than you have in hand; a keep goal means having N
 * in total, so it becomes in hand + N. Pass `inventory` without expected
 * mission drops (inHandInventory): the drops are how the planner meant to get
 * those N, so counting them in "in hand" too would ask for them twice.
 *
 * With the planner's "only crafted" on, "×N" means N more crafted (neither
 * owned copies nor drops count), which is an XP-planner craft-count goal of
 * crafted so far + N, for every artifact that takes one; other items stay
 * copies goals. Craft-count goals already mean the same on both pages.
 */
export function plannerRowsToKeepRows(
  rows: PlannerTargetRow[],
  inventory: Record<string, number>,
  options: { craftCounts?: Record<string, number>; craftedOnly?: boolean } = {}
): PlannerTargetRow[] {
  const craftedSoFar = (itemId: string) =>
    Math.max(0, Math.round(Number(options.craftCounts?.[itemIdToCanonicalKey(itemId)]) || 0));
  return rows.map((row) => {
    const mode = goalRowMode(row);
    // Shiny and craft-count goals mean the same on both pages (a shiny goal's
    // crafts are worked out from the profile at each calculate).
    if (mode === "shiny" || mode === "crafts") {
      return row;
    }
    if (options.craftedOnly && itemIdTakesCraftCountGoal(row.itemId)) {
      const crafted = craftedSoFar(row.itemId);
      const total = Math.min(MAX_TARGET_QUANTITY, normalizedTargetQuantity(row.quantityInput) + crafted);
      return { ...row, craftGoal: true, quantityInput: String(total) };
    }
    const owned = Math.max(0, Math.floor(Number(inventory[itemIdToCanonicalKey(row.itemId)]) || 0));
    const total = Math.min(MAX_TARGET_QUANTITY, normalizedTargetQuantity(row.quantityInput) + owned);
    return { ...row, craftGoal: false, quantityInput: String(total) };
  });
}
