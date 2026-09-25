import recipesData from "../data/recipes.json";
import { itemIdIsArtifact, itemIdToCanonicalKey } from "./item-utils";

export type Recipe = {
  ingredients: Record<string, number>;
  xp: number;
  cost: number;
};

export type Recipes = Record<string, Recipe | null>;

export const recipes = recipesData as Recipes;

export function getRecipe(itemKey: string): Recipe | null {
  return recipes[itemKey] || null;
}

export function isCraftable(itemKey: string): boolean {
  return getRecipe(itemKey) !== null;
}

/**
 * Craftability for a UI item ID. Goes through the canonical key because a few
 * display IDs differ from their recipe key ("gusset-2" is ornate_gusset_2,
 * "vial-of-martian-dust-2" is vial_martian_dust_2).
 */
export function itemIdCanBeCrafted(itemId: string): boolean {
  return isCraftable(itemIdToCanonicalKey(itemId));
}

/**
 * Whether a Goals row for this item can aim for an all-time craft count rather
 * than copies: only craftable artifacts, since the goal exists to reach the
 * 400 crafts that max an artifact's shiny luck. Stones and ingredients (gold
 * meteorite, Tau Ceti geode, solar titanium) can't be shiny.
 */
export function itemIdTakesCraftCountGoal(itemId: string): boolean {
  return itemIdIsArtifact(itemId) && itemIdCanBeCrafted(itemId);
}

export function craftableItemKeys(): string[] {
  return Object.keys(recipes).filter((key) => recipes[key] !== null);
}
