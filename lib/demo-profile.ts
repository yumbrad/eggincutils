import { getCraftingLevelTotalXpForLevel } from "./crafting-levels";
import type { InFlightMission, InventorySource, PlayerProfile } from "./profile";
import { buildMissionOptions, computeShipLevelsFromLaunchCounts, type DurationType } from "./ship-data";
import { TRILLION, virtueTankCapacityForLevel, type VirtueTankSnapshot } from "./virtue-fuel";

const DEMO_EID = "DEMO";
const DEMO_FTL_LEVEL = 60;
const DEMO_ZEROG_LEVEL = 10;
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

// A max-level tank part-way through a Path of Virtue run, parked on Humility
// so missions can launch without a shift first. The limits are the usual
// Henerprise mix (C35 R28 K35, 2% Integrity for lower ships) with Humility at
// 0%, since Humility is fueled live on its own farm.
const DEMO_VIRTUE_TANK_LEVEL = 7;
const DEMO_VIRTUE_TANK: VirtueTankSnapshot = {
  tankLevel: DEMO_VIRTUE_TANK_LEVEL,
  capacity: virtueTankCapacityForLevel(DEMO_VIRTUE_TANK_LEVEL),
  fuels: {
    curiosity: 120 * TRILLION,
    integrity: 10 * TRILLION,
    humility: 0,
    resilience: 60 * TRILLION,
    kindness: 175 * TRILLION,
  },
  limits: { curiosity: 0.35, integrity: 0.02, humility: 0, resilience: 0.28, kindness: 0.35 },
  fillingEnabled: true,
  shiftCount: 20,
  soulEggs: 1e21,
  currentEgg: "humility",
  backupTimeSeconds: null,
};

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
    virtueTank:
      inventorySource === "virtue"
        ? { ...DEMO_VIRTUE_TANK, fuels: { ...DEMO_VIRTUE_TANK.fuels }, limits: { ...DEMO_VIRTUE_TANK.limits } }
        : undefined,
  };
}

// The XP planner's demo: a couple hundred items, enough for a small craft
// tree (T2s, a T3 puzzle cube, a T3 ankh), and a couple of craft counts so
// "Customize profile" and the shiny odds have something to show.
const XP_DEMO_INVENTORY: Record<string, number> = {
  puzzle_cube_1: 50,
  puzzle_cube_2: 6,
  ornate_gusset_1: 20,
  tungsten_ankh_1: 45,
  tungsten_ankh_2: 4,
  solar_titanium_1: 25,
  interstellar_compass_1: 24,
  gold_meteorite_1: 27,
};
const XP_DEMO_CRAFT_COUNTS: Record<string, number> = { puzzle_cube_2: 120, tungsten_ankh_2: 40 };
const XP_DEMO_CRAFTING_LEVEL = 8;

/** The demo profile with the XP planner's small sample inventory. */
export function createXpDemoProfile(inventorySource: InventorySource = "main"): PlayerProfile {
  return {
    ...createDemoProfile(inventorySource),
    inventory: { ...XP_DEMO_INVENTORY },
    craftCounts: { ...XP_DEMO_CRAFT_COUNTS },
    craftingXp: getCraftingLevelTotalXpForLevel(XP_DEMO_CRAFTING_LEVEL),
  };
}
