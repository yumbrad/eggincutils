import eiafxConfig from "../data/eiafx-config.json";

export type DurationType = "TUTORIAL" | "SHORT" | "LONG" | "EPIC";

export type MissionRecord = {
  ship: string;
  durationType: string;
  status: string;
};

export type ShipLevelInfo = {
  ship: string;
  unlocked: boolean;
  launches: number;
  launchPoints: number;
  level: number;
  maxLevel: number;
  launchesByDuration: Record<DurationType, number>;
};

export type ShipLaunchCounts = Record<string, Record<DurationType, number>>;

export type MissionOption = {
  ship: string;
  missionId: string;
  durationType: DurationType;
  level: number;
  durationSeconds: number;
  capacity: number;
};

type MissionDurationConfig = {
  durationType: DurationType;
  seconds: number;
  capacity: number;
  levelCapacityBump: number;
};

type MissionShipConfig = {
  ship: string;
  durations: MissionDurationConfig[];
  levelMissionRequirements: number[];
};

const shipConfig = (eiafxConfig as { missionParameters: MissionShipConfig[] }).missionParameters;

const SHIP_ORDER = shipConfig.map((entry) => entry.ship);

const ALL_DURATIONS: DurationType[] = ["TUTORIAL", "SHORT", "LONG", "EPIC"];
const DURATIONS: DurationType[] = ["SHORT", "LONG", "EPIC"];

const DURATION_SUFFIX: Record<DurationType, string> = {
  TUTORIAL: "tutorial",
  SHORT: "short",
  LONG: "standard",
  EPIC: "extended",
};

const DURATION_LAUNCH_POINTS: Record<DurationType, number> = {
  TUTORIAL: 1,
  SHORT: 1,
  LONG: 1.4,
  EPIC: 1.8,
};

const UNLOCK_LAUNCHES: Record<string, number> = {
  CHICKEN_ONE: 4,
  CHICKEN_NINE: 6,
  CHICKEN_HEAVY: 12,
  BCR: 15,
  MILLENIUM_CHICKEN: 18,
  CORELLIHEN_CORVETTE: 21,
  GALEGGTICA: 24,
  CHICKFIANT: 27,
  VOYEGGER: 30,
  HENERPRISE: 40,
  ATREGGIES: Number.POSITIVE_INFINITY,
};

const FTL_START_SHIP = "MILLENIUM_CHICKEN";

function missionIdFor(ship: string, durationType: DurationType): string {
  const shipPrefix = ship.toLowerCase().replaceAll("_", "-");
  return `${shipPrefix}-${DURATION_SUFFIX[durationType]}`;
}

function cumulativeThresholds(levelMissionRequirements: number[]): number[] {
  let sum = 0;
  const result = [0];
  for (const delta of levelMissionRequirements) {
    sum += delta;
    result.push(sum);
  }
  return result;
}

function getLevelFromLaunchPoints(launchPoints: number, levelMissionRequirements: number[]): number {
  const thresholds = cumulativeThresholds(levelMissionRequirements);
  let level = 0;
  while (level + 1 < thresholds.length && launchPoints >= thresholds[level + 1]) {
    level += 1;
  }
  return level;
}

function isLaunchedStatus(status: string): boolean {
  return ["EXPLORING", "RETURNED", "ANALYZING", "COMPLETE", "ARCHIVED"].includes(status);
}

function emptyDurationCounts(): Record<DurationType, number> {
  return {
    TUTORIAL: 0,
    SHORT: 0,
    LONG: 0,
    EPIC: 0,
  };
}

function initializeLaunchCounts(): ShipLaunchCounts {
  const launchCounts: ShipLaunchCounts = {};
  for (const ship of SHIP_ORDER) {
    launchCounts[ship] = emptyDurationCounts();
  }
  return launchCounts;
}

function cloneDurationCounts(counts: Record<DurationType, number>): Record<DurationType, number> {
  return {
    TUTORIAL: counts.TUTORIAL,
    SHORT: counts.SHORT,
    LONG: counts.LONG,
    EPIC: counts.EPIC,
  };
}

function normalizeCount(value: unknown): number {
  const asNumber = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(asNumber)) {
    return 0;
  }
  return Math.max(0, Math.round(asNumber));
}

function buildLevelInfoFromLaunchCounts(launchCounts: ShipLaunchCounts): ShipLevelInfo[] {
  const launchesByShip = new Map<string, number>();
  for (const ship of SHIP_ORDER) {
    const byDuration = launchCounts[ship] || emptyDurationCounts();
    const launches = ALL_DURATIONS.reduce((sum, durationType) => sum + normalizeCount(byDuration[durationType]), 0);
    launchesByShip.set(ship, launches);
  }

  const unlocked = new Map<string, boolean>();
  unlocked.set(SHIP_ORDER[0], true);
  for (let index = 1; index < SHIP_ORDER.length; index += 1) {
    const previousShip = SHIP_ORDER[index - 1];
    const ship = SHIP_ORDER[index];
    const previousLaunches = launchesByShip.get(previousShip) || 0;
    unlocked.set(ship, previousLaunches >= (UNLOCK_LAUNCHES[previousShip] || Number.POSITIVE_INFINITY));
  }

  return shipConfig.map((shipEntry) => {
    const byDurationRaw = launchCounts[shipEntry.ship] || emptyDurationCounts();
    const byDuration = cloneDurationCounts(byDurationRaw);
    const launchPoints =
      byDuration.TUTORIAL * DURATION_LAUNCH_POINTS.TUTORIAL +
      byDuration.SHORT * DURATION_LAUNCH_POINTS.SHORT +
      byDuration.LONG * DURATION_LAUNCH_POINTS.LONG +
      byDuration.EPIC * DURATION_LAUNCH_POINTS.EPIC;

    const maxLevel = shipEntry.levelMissionRequirements.length;
    const level = unlocked.get(shipEntry.ship)
      ? Math.min(getLevelFromLaunchPoints(launchPoints, shipEntry.levelMissionRequirements), maxLevel)
      : 0;

    return {
      ship: shipEntry.ship,
      unlocked: Boolean(unlocked.get(shipEntry.ship)),
      launches: launchesByShip.get(shipEntry.ship) || 0,
      launchPoints,
      level,
      maxLevel,
      launchesByDuration: byDuration,
    };
  });
}

export function getShipOrder(): string[] {
  return SHIP_ORDER;
}

export function getNominalMissionCapacity(ship: string, durationType: DurationType, level: number): number | null {
  const entry = shipConfig.find((candidate) => candidate.ship === ship);
  const params = entry?.durations.find((duration) => duration.durationType === durationType);
  if (!params) {
    return null;
  }
  return Math.floor(params.capacity + params.levelCapacityBump * Math.max(0, Math.round(level)));
}

export function shipLevelsToLaunchCounts(shipLevels: ShipLevelInfo[]): ShipLaunchCounts {
  const launchCounts = initializeLaunchCounts();
  const byShip = new Map(shipLevels.map((entry) => [entry.ship, entry]));

  for (const ship of SHIP_ORDER) {
    const info = byShip.get(ship);
    for (const durationType of ALL_DURATIONS) {
      launchCounts[ship][durationType] = normalizeCount(info?.launchesByDuration?.[durationType]);
    }
  }

  return launchCounts;
}

export function computeShipLevelsFromLaunchCounts(
  launchCountsInput: Partial<Record<string, Partial<Record<DurationType, number>>>>
): ShipLevelInfo[] {
  const launchCounts = initializeLaunchCounts();
  for (const ship of SHIP_ORDER) {
    const shipCounts = launchCountsInput[ship];
    if (!shipCounts) {
      continue;
    }
    for (const durationType of ALL_DURATIONS) {
      launchCounts[ship][durationType] = normalizeCount(shipCounts[durationType]);
    }
  }

  return buildLevelInfoFromLaunchCounts(launchCounts);
}

export function computeShipLevels(missions: MissionRecord[]): ShipLevelInfo[] {
  const launchCounts = initializeLaunchCounts();

  for (const mission of missions) {
    if (!SHIP_ORDER.includes(mission.ship)) {
      continue;
    }
    if (!isLaunchedStatus(mission.status)) {
      continue;
    }
    const durationType = mission.durationType as DurationType;
    if (!["TUTORIAL", "SHORT", "LONG", "EPIC"].includes(durationType)) {
      continue;
    }
    launchCounts[mission.ship][durationType] += 1;
  }

  return buildLevelInfoFromLaunchCounts(launchCounts);
}

export function buildMissionOptions(shipLevels: ShipLevelInfo[], epicResearchFTLLevel: number, epicResearchZerogLevel: number): MissionOption[] {
  const ftlStartIndex = SHIP_ORDER.indexOf(FTL_START_SHIP);
  const levelMap = new Map(shipLevels.map((info) => [info.ship, info]));
  const options: MissionOption[] = [];

  for (const entry of shipConfig) {
    const info = levelMap.get(entry.ship);
    if (!info?.unlocked) {
      continue;
    }
    for (const durationType of DURATIONS) {
      const params = entry.durations.find((d) => d.durationType === durationType);
      if (!params) {
        continue;
      }

      const isFtl = SHIP_ORDER.indexOf(entry.ship) >= ftlStartIndex;
      const durationSeconds = isFtl
        ? Math.max(1, Math.round(params.seconds * (1 - 0.01 * epicResearchFTLLevel)))
        : params.seconds;
      const capacity = Math.floor((params.capacity + params.levelCapacityBump * info.level) * (1 + 0.05 * epicResearchZerogLevel));

      options.push({
        ship: entry.ship,
        missionId: missionIdFor(entry.ship, durationType),
        durationType,
        level: info.level,
        durationSeconds,
        capacity,
      });
    }
  }

  return options;
}

/** Every ship in unlock order with its star count, for pickers. */
export function shipStarRanges(): Array<{ ship: string; maxLevel: number }> {
  return shipConfig.map((entry) => ({ ship: entry.ship, maxLevel: entry.levelMissionRequirements.length }));
}

/**
 * Ship levels with some ships set to a star count (a customized profile).
 * Stars come from launch points and each ship unlocks after enough launches
 * of the one before, so a set ship gets the short launches its stars need,
 * the ships before it get enough launches to unlock it, and a ship that
 * unlocks the next keeps the launches that does (so its stars may stay above
 * what was asked: 0★ with the next ship unlocked can't happen in the game).
 * Launch counts stay consistent, so anything that replays launches from them
 * keeps the stars. Ships not set keep their entries.
 */
export function withShipStars(
  shipLevels: ShipLevelInfo[],
  stars: Record<string, number>
): { shipLevels: ShipLevelInfo[]; effective: Record<string, number> } {
  const setShips = SHIP_ORDER.filter((ship) => stars[ship] != null && Number.isFinite(stars[ship]));
  if (setShips.length === 0) {
    return { shipLevels, effective: {} };
  }
  const byShip = new Map(shipLevels.map((entry) => [entry.ship, entry]));
  const counts = shipLevelsToLaunchCounts(shipLevels);
  const touched = new Set<string>();
  const launchesOf = (ship: string) => ALL_DURATIONS.reduce((sum, duration) => sum + counts[ship][duration], 0);
  for (const ship of setShips) {
    const entry = shipConfig.find((candidate) => candidate.ship === ship)!;
    const index = SHIP_ORDER.indexOf(ship);
    const level = Math.max(0, Math.min(entry.levelMissionRequirements.length, Math.round(stars[ship])));
    const points = Math.ceil(cumulativeThresholds(entry.levelMissionRequirements)[level] || 0);
    const next = SHIP_ORDER[index + 1];
    const keepsNextUnlocked = next != null && (byShip.get(next)?.unlocked || setShips.includes(next));
    const launches = Math.max(points, keepsNextUnlocked ? UNLOCK_LAUNCHES[ship] || 0 : 0);
    counts[ship] = { TUTORIAL: 0, SHORT: launches, LONG: 0, EPIC: 0 };
    touched.add(ship);
    // Unlock it: every earlier ship needs its unlock launches.
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const earlierShip = SHIP_ORDER[earlier];
      const needed = UNLOCK_LAUNCHES[earlierShip] || 0;
      if (launchesOf(earlierShip) < needed) {
        counts[earlierShip].SHORT += needed - launchesOf(earlierShip);
        touched.add(earlierShip);
      }
    }
  }
  const rebuilt = new Map(buildLevelInfoFromLaunchCounts(counts).map((entry) => [entry.ship, entry]));
  const effective: Record<string, number> = {};
  const next = shipLevels.map((entry) => {
    if (!touched.has(entry.ship)) {
      return entry;
    }
    const rebuiltEntry = rebuilt.get(entry.ship)!;
    // A set ship is unlocked; a profile can list ships unlocked with no launches (the demo).
    const merged = { ...rebuiltEntry, unlocked: rebuiltEntry.unlocked || entry.unlocked || setShips.includes(entry.ship) };
    if (merged.unlocked && !rebuiltEntry.unlocked) {
      merged.level = Math.min(
        merged.maxLevel,
        getLevelFromLaunchPoints(merged.launchPoints, shipConfig.find((c) => c.ship === entry.ship)!.levelMissionRequirements)
      );
    }
    if (setShips.includes(entry.ship)) {
      effective[entry.ship] = merged.level;
    }
    return merged;
  });
  return { shipLevels: next, effective };
}

const SHIP_DISPLAY_NAMES: Record<string, string> = {
  ATREGGIES: "Henliner",
  CHICKFIANT: "Defihent",
  CORELLIHEN_CORVETTE: "Cornish-Hen Corvette",
  MILLENIUM_CHICKEN: "Quintillion Chicken",
  BCR: "BCR",
};

/** A ship's in-game name ("HENERPRISE" -> "Henerprise", "ATREGGIES" -> "Henliner"). */
export function shipDisplayName(ship: string): string {
  return (
    SHIP_DISPLAY_NAMES[ship] ||
    ship
      .toLowerCase()
      .split("_")
      .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
      .join(" ")
  );
}
