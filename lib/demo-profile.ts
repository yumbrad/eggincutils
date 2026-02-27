import { PlayerProfile } from "./profile";
import { buildMissionOptions, computeShipLevelsFromLaunchCounts } from "./ship-data";

const DEMO_EID = "DEMO";
const DEMO_FTL_LEVEL = 30;
const DEMO_ZEROG_LEVEL = 20;

export function isBlankEid(eid: string): boolean {
  return eid.trim().length === 0;
}

export function createDemoProfile(): PlayerProfile {
  const shipLevels = computeShipLevelsFromLaunchCounts({}).map((entry) => ({
    ...entry,
    unlocked: true,
    launches: 0,
    launchPoints: 0,
    level: 0,
    launchesByDuration: {
      TUTORIAL: 0,
      SHORT: 0,
      LONG: 0,
      EPIC: 0,
    },
  }));
  const missionOptions = buildMissionOptions(shipLevels, DEMO_FTL_LEVEL, DEMO_ZEROG_LEVEL);

  return {
    eid: DEMO_EID,
    inventory: {},
    craftCounts: {},
    epicResearchFTLLevel: DEMO_FTL_LEVEL,
    epicResearchZerogLevel: DEMO_ZEROG_LEVEL,
    shipLevels,
    missionOptions,
  };
}
