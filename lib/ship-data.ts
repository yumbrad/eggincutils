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
