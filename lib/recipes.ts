import recipesData from "../data/recipes.json";

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

export function craftableItemKeys(): string[] {
  return Object.keys(recipes).filter((key) => recipes[key] !== null);
}
