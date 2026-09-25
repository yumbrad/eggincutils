import type { DurationType } from "./ship-data";

export type VirtueFuelKey = "curiosity" | "integrity" | "kindness" | "resilience";

export type VirtueFuelConfig = Partial<Record<VirtueFuelKey, number>>;

export const MILLION = 1_000_000;
export const BILLION = 1_000_000_000;
export const TRILLION = 1_000_000_000_000;

export const VIRTUE_FUEL_DISPLAY: Array<{ key: VirtueFuelKey; label: string; imageSrc: string }> = [
  { key: "curiosity", label: "Curiosity", imageSrc: "/media/Egg_curiosity.webp" },
  { key: "integrity", label: "Integrity", imageSrc: "/media/Egg_integrity.webp" },
  { key: "kindness", label: "Kindness", imageSrc: "/media/Egg_kindness.webp" },
  { key: "resilience", label: "Resilience", imageSrc: "/media/Egg_resilience.webp" },
];

export const VIRTUE_FUEL_BY_SHIP_DURATION: Record<string, Partial<Record<DurationType, VirtueFuelConfig>>> = {
  BCR: {
    SHORT: { integrity: 10 * MILLION },
    LONG: { integrity: 20 * MILLION },
    EPIC: { integrity: 30 * MILLION },
  },
  MILLENIUM_CHICKEN: {
    SHORT: { integrity: 10 * BILLION },
    LONG: { integrity: 20 * BILLION },
    EPIC: { integrity: 50 * BILLION },
  },
  CORELLIHEN_CORVETTE: {
    SHORT: { integrity: 5 * BILLION },
    LONG: { integrity: 8 * BILLION },
    EPIC: { integrity: 10 * BILLION },
  },
  GALEGGTICA: {
    SHORT: { integrity: 200 * BILLION, curiosity: 200 * BILLION },
    LONG: { integrity: 400 * BILLION, curiosity: 400 * BILLION },
    EPIC: { integrity: 600 * BILLION, curiosity: 600 * BILLION },
  },
  CHICKFIANT: {
    SHORT: { kindness: 1 * TRILLION, curiosity: 1 * TRILLION },
    LONG: { kindness: 2 * TRILLION, curiosity: 2 * TRILLION },
    EPIC: { kindness: 3 * TRILLION, curiosity: 3 * TRILLION },
  },
  VOYEGGER: {
    SHORT: { kindness: 5 * TRILLION, curiosity: 10 * TRILLION },
    LONG: { kindness: 10 * TRILLION, curiosity: 20 * TRILLION },
    EPIC: { kindness: 15 * TRILLION, curiosity: 25 * TRILLION },
  },
  HENERPRISE: {
    SHORT: { kindness: 10 * TRILLION, curiosity: 15 * TRILLION },
    LONG: { resilience: 10 * TRILLION, kindness: 15 * TRILLION, curiosity: 20 * TRILLION },
    EPIC: { resilience: 20 * TRILLION, kindness: 25 * TRILLION, curiosity: 25 * TRILLION },
  },
  ATREGGIES: {
    SHORT: { kindness: 20 * TRILLION, curiosity: 25 * TRILLION },
    LONG: { resilience: 20 * TRILLION, kindness: 30 * TRILLION, curiosity: 40 * TRILLION },
    EPIC: { resilience: 40 * TRILLION, kindness: 75 * TRILLION, curiosity: 50 * TRILLION },
  },
};

export function getVirtueFuelConfig(ship: string, durationType: string): VirtueFuelConfig {
  return VIRTUE_FUEL_BY_SHIP_DURATION[ship]?.[durationType as DurationType] || {};
}

export function getVirtueFuelPerLaunch(ship: string, durationType: string): number {
  const config = getVirtueFuelConfig(ship, durationType);
  return VIRTUE_FUEL_DISPLAY.reduce((sum, fuel) => sum + Math.max(0, config[fuel.key] || 0), 0);
}

/**
 * Eggs a tank-limit slider holds at `limitPct` whole percent. The game snaps
 * limits to 1% of capacity and shows them as egg amounts (5T steps on a 500T
 * tank), so instructions name this amount, never the percent.
 */
export function virtueTankLimitAmount(limitPct: number, capacity: number): number {
  const pct = Number.isFinite(limitPct) ? Math.max(0, Math.min(100, Math.round(limitPct))) : 0;
  return (pct * Math.max(0, capacity)) / 100;
}

/**
 * A tank-limit slider setting as the game shows it: "175T", or "0". Neighbouring steps always
 * read differently: "1.02B" and "1.04B" on the 2B tank (20M steps), where "1B" would name both.
 */
export function formatVirtueTankLimit(limitPct: number, capacity: number): string {
  const amount = virtueTankLimitAmount(limitPct, capacity);
  return amount > 0 ? formatVirtueTankAmount(amount, capacity) : "0";
}

/**
 * Fuel in a tank of `capacity`, precise to its 1% limit steps: formatVirtueFuelQuantity plus the
 * decimals a step needs. Drain targets, which land on a step, read the same as that step's limit.
 */
export function formatVirtueTankAmount(value: number, capacity: number): string {
  return formatVirtueFuelQuantity(value, Math.max(0, capacity) / 100);
}

/**
 * Decimals it takes for amounts `resolution` apart (in display units) to read differently:
 * 2 for the 2B tank's 0.02B steps, 1 for the 10T tank's 0.1T ones, 0 from a whole unit up.
 */
export function fractionDigitsForResolution(resolution: number): number {
  if (!(resolution > 0) || resolution >= 1) {
    return 0;
  }
  return Math.min(3, Math.ceil(-Math.log10(resolution) - 1e-9));
}

/**
 * "175T", "3.4T", "980M": one decimal below 10, none above. `resolution` (in eggs) adds the
 * decimals that tell amounts that far apart from each other (see fractionDigitsForResolution).
 */
export function formatVirtueFuelQuantity(value: number, resolution = 0): string {
  const absValue = Math.abs(value);
  const units: Array<{ value: number; suffix: string }> = [
    { value: 1_000_000_000_000_000_000, suffix: "Q" },
    { value: 1_000_000_000_000_000, suffix: "q" },
    { value: TRILLION, suffix: "T" },
    { value: BILLION, suffix: "B" },
    { value: MILLION, suffix: "M" },
  ];
  for (const unit of units) {
    if (absValue >= unit.value) {
      const scaled = value / unit.value;
      const maximumFractionDigits = Math.max(
        Math.abs(scaled) < 10 && Math.abs(scaled % 1) > 1e-9 ? 1 : 0,
        fractionDigitsForResolution(resolution / unit.value)
      );
      return `${scaled.toLocaleString(undefined, { maximumFractionDigits })}${unit.suffix}`;
    }
  }
  return Math.round(value).toLocaleString();
}

// ---------------------------------------------------------------------------
// Fuel tank and shifting. Client-safe: profile.ts pulls in node-only modules,
// so the tank constants the planner page needs live here instead.
// ---------------------------------------------------------------------------

/**
 * Humility is burned too, but missions only launch from the Humility farm, so
 * it is treated as live-fueled there and never counted against the tank. Kept
 * out of VIRTUE_FUEL_DISPLAY on purpose: everything iterating that list is
 * fuel math that must not see Humility.
 */
export const VIRTUE_HUMILITY_DISPLAY: { key: "humility"; label: string; imageSrc: string } = {
  key: "humility",
  label: "Humility",
  imageSrc: "/media/Egg_humility.webp",
};

export type VirtueTankEggKey = VirtueFuelKey | "humility";

/** Tank capacity by `backup.artifacts.tankLevel` (0-7); the tank is shared with the main farm. */
export const VIRTUE_TANK_CAPACITIES: readonly number[] = [
  2 * BILLION,
  200 * BILLION,
  10 * TRILLION,
  100 * TRILLION,
  200 * TRILLION,
  300 * TRILLION,
  400 * TRILLION,
  500 * TRILLION,
];

/** Where each virtue egg sits in `backup.virtue.afx.tankFuels` / `tankLimits`. */
export const VIRTUE_TANK_FUEL_INDEX: Record<VirtueTankEggKey, number> = {
  curiosity: 20,
  integrity: 21,
  humility: 22,
  resilience: 23,
  kindness: 24,
};

export type VirtueTankSnapshot = {
  tankLevel: number;
  capacity: number;
  /** Eggs currently stored per virtue egg. */
  fuels: Record<VirtueTankEggKey, number>;
  /** Per-egg fill cap as a fraction of `capacity` (the in-game slider, 1% steps). */
  limits: Record<VirtueTankEggKey, number>;
  fillingEnabled: boolean;
  /** Shifts already made; the next shift is priced at this count. */
  shiftCount: number;
  soulEggs: number;
  /**
   * Virtue egg the player is on, or null when they are on the main game.
   * Coming onto the Path of Virtue from the main game is not a shift (the
   * count does not move), so null must not be charged as one.
   */
  currentEgg: VirtueTankEggKey | null;
  /** Unix seconds of the backup the snapshot came from; null for synthetic profiles. */
  backupTimeSeconds: number | null;
};

export function virtueTankCapacityForLevel(level: number): number {
  const maxLevel = VIRTUE_TANK_CAPACITIES.length - 1;
  const index = Number.isFinite(level) ? Math.max(0, Math.min(maxLevel, Math.floor(level))) : 0;
  return VIRTUE_TANK_CAPACITIES[index];
}

function readVirtueTankValues(
  values: number[] | undefined,
  fallback: number,
  normalize: (value: number) => number
): Record<VirtueTankEggKey, number> {
  const read = (key: VirtueTankEggKey) => {
    const raw = values?.[VIRTUE_TANK_FUEL_INDEX[key]];
    return typeof raw === "number" && Number.isFinite(raw) ? normalize(raw) : fallback;
  };
  return {
    curiosity: read("curiosity"),
    integrity: read("integrity"),
    humility: read("humility"),
    resilience: read("resilience"),
    kindness: read("kindness"),
  };
}

/**
 * Virtue egg amounts out of `tank_fuels`. Values are taken as-is apart from
 * dropping negatives: the game stores float noise like 190000000000001.9 for a
 * tank filled to exactly 190T, which callers should compare with a tolerance.
 */
export function parseVirtueTankFuels(values: number[] | undefined): Record<VirtueTankEggKey, number> {
  return readVirtueTankValues(values, 0, (value) => Math.max(0, value));
}

/**
 * Virtue egg fill caps out of `tank_limits`, snapped to the in-game 1% steps
 * and clamped to 0..1. A missing entry means the egg is uncapped (1).
 */
export function parseVirtueTankLimits(values: number[] | undefined): Record<VirtueTankEggKey, number> {
  return readVirtueTankValues(values, 1, (value) => Math.max(0, Math.min(1, Math.round(value * 100) / 100)));
}

/** Soul Egg price of the next shift after `shiftCount` shifts (carpetsage `shiftCost`). */
export function virtueShiftCostSoulEggs(soulEggs: number, shiftCount: number): number {
  const eggs = Number.isFinite(soulEggs) ? Math.max(0, soulEggs) : 0;
  const count = Number.isFinite(shiftCount) ? Math.max(0, shiftCount) : 0;
  const basis = eggs * (0.02 * Math.pow(count / 120, 3) + 0.0001);
  return 1e11 + 0.6 * basis + Math.pow(0.4 * basis, 0.9);
}

/**
 * Total Soul Egg price of the next `shifts` shifts, each one priced at the
 * incremented shift count. The Soul Egg balance is assumed unchanged across
 * them — paying for each shift lowers it slightly and farming raises it, and
 * neither is modeled.
 */
export function virtueShiftsCostSoulEggs(soulEggs: number, startShiftCount: number, shifts: number): number {
  const count = Number.isFinite(shifts) ? Math.max(0, Math.floor(shifts)) : 0;
  const start = Number.isFinite(startShiftCount) ? Math.max(0, startShiftCount) : 0;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    total += virtueShiftCostSoulEggs(soulEggs, start + index);
  }
  return total;
}
