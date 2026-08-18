import type { InFlightMission, InventorySource, PlayerProfile } from "./profile";
import { buildMissionOptions, computeShipLevelsFromLaunchCounts, type DurationType } from "./ship-data";

const DEMO_EID = "DEMO";
const DEMO_FTL_LEVEL = 30;
const DEMO_ZEROG_LEVEL = 20;
const QUANTUM_METRONOME_AFX_ID = 24;
const TAU_CETI_GEODE_AFX_ID = 18;

// A couple of outstanding missions so the demo shows how ships already in the
// air feed the plan instead of being planned for a second time.
const DEMO_IN_FLIGHT: Array<{
  ship: string;
  durationType: DurationType;
  targetAfxId: number;
  secondsRemaining: number;
}> = [
  { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: QUANTUM_METRONOME_AFX_ID, secondsRemaining: 9 * 3600 },
  { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: QUANTUM_METRONOME_AFX_ID, secondsRemaining: 14 * 3600 },
  { ship: "VOYEGGER", durationType: "LONG", targetAfxId: TAU_CETI_GEODE_AFX_ID, secondsRemaining: 3 * 3600 },
];

export function isBlankEid(eid: string): boolean {
  return eid.trim().length === 0;
}

export function createDemoProfile(inventorySource: InventorySource = "main"): PlayerProfile {
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
  // The demo's outstanding missions belong to the main farm, so a virtue plan
  // sees none — the same split a real profile gets from MissionInfo.type.
  const inFlightMissions: InFlightMission[] = (inventorySource === "virtue" ? [] : DEMO_IN_FLIGHT).flatMap((entry) => {
    const option = missionOptions.find(
      (candidate) => candidate.ship === entry.ship && candidate.durationType === entry.durationType
    );
    if (!option) {
      return [];
    }
    return [
      {
        ship: entry.ship,
        durationType: entry.durationType,
        status: "EXPLORING",
        level: option.level,
        capacity: option.capacity,
        targetAfxId: entry.targetAfxId,
        secondsRemaining: entry.secondsRemaining,
      },
    ];
  });

  return {
    eid: DEMO_EID,
    inventory: {},
    craftCounts: {},
    craftingXp: 0,
    epicResearchFTLLevel: DEMO_FTL_LEVEL,
    epicResearchZerogLevel: DEMO_ZEROG_LEVEL,
    shipLevels,
    missionOptions,
    inFlightMissions,
  };
}
