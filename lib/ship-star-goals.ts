import { durationLaunchPoints, shipDisplayName, shipLevelPointThresholds, type DurationType } from "./ship-data";
import type { TargetOption } from "./goal-rows";

/**
 * "Max stars" goals: a ship reaching its top star level by the end of the
 * plan. The planner treats a ship's launch points as an item every launch
 * of that ship drops (STAR_POINT_UNITS per point, so short, standard and
 * extended launches drop 5, 7 and 9), and the goal as a demand for the
 * points still missing. Client-safe.
 */

const ITEM_ID_PREFIX = "ship-stars-";
const ITEM_KEY_PREFIX = "ship_stars_";

/** Units per launch point: launch points come in fifths (1, 1.4, 1.8). */
export const STAR_POINT_UNITS = 5;

export function shipStarsItemId(ship: string): string {
  return `${ITEM_ID_PREFIX}${ship.toLowerCase().replace(/_/g, "-")}`;
}

export function shipStarsItemKey(ship: string): string {
  return `${ITEM_KEY_PREFIX}${ship.toLowerCase()}`;
}

/** The ship a stars goal's item id or key names, or null for any other item. */
export function shipFromStarsItem(itemIdOrKey: string): string | null {
  const lower = itemIdOrKey.toLowerCase();
  const rest = lower.startsWith(ITEM_ID_PREFIX)
    ? lower.slice(ITEM_ID_PREFIX.length).replace(/-/g, "_")
    : lower.startsWith(ITEM_KEY_PREFIX)
      ? lower.slice(ITEM_KEY_PREFIX.length)
      : null;
  if (!rest) {
    return null;
  }
  const ship = rest.toUpperCase();
  return shipLevelPointThresholds(ship) ? ship : null;
}

export function isShipStarsItem(itemIdOrKey: string): boolean {
  return shipFromStarsItem(itemIdOrKey) !== null;
}

export function shipStarsGoalLabel(ship: string): string {
  return `Max stars · ${shipDisplayName(ship)}`;
}

/** Point units one launch of this duration drops toward its ship's stars goal. */
export function starPointUnits(durationType: DurationType): number {
  return Math.round(durationLaunchPoints(durationType) * STAR_POINT_UNITS);
}

/** Point units a ship still needs for its top star level: 0 once it has them. */
export function starPointUnitsToMax(ship: string, launchPoints: number): number {
  const thresholds = shipLevelPointThresholds(ship);
  if (!thresholds) {
    return 0;
  }
  const missing = thresholds[thresholds.length - 1] - launchPoints;
  return missing > 1e-9 ? Math.ceil(missing * STAR_POINT_UNITS - 1e-6) : 0;
}

/**
 * A "Max stars" goal for each unlocked ship short of its top stars, after the
 * artifact options. Maxed and locked ships aren't offered.
 */
export function shipStarsTargetOptions(
  ships: ReadonlyArray<{ ship: string; unlocked: boolean; level: number; maxLevel: number }>
): TargetOption[] {
  return ships
    .filter((ship) => ship.unlocked && ship.level < ship.maxLevel && shipLevelPointThresholds(ship.ship))
    .map((ship) => {
      const label = shipStarsGoalLabel(ship.ship);
      return {
        itemId: shipStarsItemId(ship.ship),
        itemKey: shipStarsItemKey(ship.ship),
        label,
        familyKey: "zz-ship-stars",
        tierNumber: 0,
        iconUrl: null,
        searchText: `${label} ${ship.ship} stars star asc max level ship`.toLowerCase(),
      } satisfies TargetOption;
    });
}
