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

export function getShipOrder(): string[] {
  return SHIP_ORDER;
}

export function computeShipLevels(missions: MissionRecord[]): ShipLevelInfo[] {
  const launchesByShip = new Map<string, number>();
  const launchesByShipDuration = new Map<string, Record<DurationType, number>>();

  for (const ship of SHIP_ORDER) {
    launchesByShip.set(ship, 0);
    launchesByShipDuration.set(ship, {
      TUTORIAL: 0,
      SHORT: 0,
      LONG: 0,
      EPIC: 0,
    });
  }

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
    launchesByShip.set(mission.ship, (launchesByShip.get(mission.ship) || 0) + 1);
    const byDuration = launchesByShipDuration.get(mission.ship)!;
    byDuration[durationType] += 1;
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
    const byDuration = launchesByShipDuration.get(shipEntry.ship)!;
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
