"use client";

import Image from "next/image";
import Link from "next/link";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import artifactDisplay from "../../data/artifact-display.json";
import artifactConsumption from "../../data/artifact-consumption.json";
import artifactShortNames from "../../data/artifact-short-names.json";
import recipes from "../../data/recipes.json";
import { MISSION_CRAFT_COPY } from "../../lib/mission-craft-copy";
import {
  buildTargetOptions,
  normalizedTargetQuantity,
  parseStoredTargetRows,
  serializeTargetRows,
  targetFamilyKey,
  targetRowToPlannerTarget,
  targetTierNumber,
  type PlannerTargetRow,
} from "../../lib/goal-rows";
import {
  afxIdToDisplayName,
  afxIdToItemKey,
  afxIdToTargetFamilyName,
  itemIdToCanonicalKey,
  itemKeyToDisplayName,
  itemKeyToIconUrl,
  itemKeyToId,
} from "../../lib/item-utils";
import {
  LOCAL_PREF_KEYS,
  readFirstStoredString,
  readStoredBoolean,
  readStoredInteger,
  writeStoredBoolean,
  writeStoredString,
} from "../../lib/local-preferences";
import useHighsWorker from "../../lib/use-highs-worker";
import { planForTarget, computeMonolithicPaths, type PlannerProgressEvent } from "../../lib/planner";
import { createDemoProfile, isBlankEid } from "../../lib/demo-profile";
import type { LootJson } from "../../lib/loot-data";
import {
  formatVirtueFuelQuantity,
  formatVirtueTankLimit,
  fractionDigitsForResolution,
  getVirtueFuelConfig,
  virtueTankLimitAmount,
  virtueShiftCostSoulEggs,
  virtueShiftsCostSoulEggs,
  VIRTUE_FUEL_DISPLAY,
  VIRTUE_HUMILITY_DISPLAY,
  type VirtueFuelKey,
  type VirtueTankEggKey,
  type VirtueTankSnapshot,
} from "../../lib/virtue-fuel";
import {
  buildVirtueTankPlannerOptions,
  DEFAULT_VIRTUE_SHIFT_CAP,
  snapVirtueTankReading,
  type VirtueTankPlannerResult,
  type VirtueTankPlanUnit,
} from "../../lib/virtue-tank-plan";
import {
  nearestVirtueShiftCapDetent,
  VIRTUE_REFILL_ROUTE_ORDER,
  VIRTUE_SHIFT_CAP_DETENTS,
  virtueFuelTolerance,
  type VirtueFuelVector,
  type VirtueTank,
  type VirtueTankPlan,
  type VirtueTankStartMode,
} from "../../lib/virtue-tanks";
import {
  virtueLastTankRoom,
  virtueLastTankRoomText,
  type VirtueLastTankTopUp,
  type VirtueTopUpFamily,
} from "../../lib/virtue-top-up";
import GoalRowsEditor, { type GoalRowsChange } from "../goal-rows-editor";
import styles from "./page.module.css";

type ShipLevelInfo = {
  ship: string;
  unlocked: boolean;
  launches: number;
  launchPoints: number;
  level: number;
  maxLevel: number;
};

type DurationType = "TUTORIAL" | "SHORT" | "LONG" | "EPIC";

type ShipLevelInfoDetailed = ShipLevelInfo & {
  launchesByDuration: Record<DurationType, number>;
};

type InventorySource = "main" | "virtue";

type MissionOption = {
  ship: string;
  missionId: string;
  durationType: DurationType;
  level: number;
  durationSeconds: number;
  capacity: number;
};

type ProfileSnapshot = {
  eid: string;
  inventory: Record<string, number>;
  craftCounts: Record<string, number>;
  craftingXp: number;
  epicResearchFTLLevel: number;
  epicResearchZerogLevel: number;
  shipLevels: ShipLevelInfoDetailed[];
  missionOptions: MissionOption[];
  /** Path of Virtue tank and shift state; absent on older saved sessions and backups without it. */
  virtueTank?: VirtueTankSnapshot;
};

type PlannerSourceFilters = {
  inventorySource: InventorySource;
  includeSlotted: boolean;
  includeInventoryRare: boolean;
  includeInventoryEpic: boolean;
  includeInventoryLegendary: boolean;
  includeInventoryFragments: boolean;
  includeDropRare: boolean;
  includeDropEpic: boolean;
  includeDropLegendary: boolean;
  includeDropFragments: boolean;
};

type ProfileApiResponse = ProfileSnapshot & { error?: string; details?: unknown };

type PlanResponse = {
  profile: {
    eid: string;
    epicResearchFTLLevel: number;
    epicResearchZerogLevel: number;
    shipLevels: ShipLevelInfo[];
  };
  plan: {
    targetItemId: string;
    quantity: number;
    targets: Array<{ targetItemId: string; quantity: number; craftGoal?: boolean }>;
    priorityTime: number;
    objectiveMode: "ge" | "virtueFuel";
    geCost: number;
    fuelCost: number;
    totalSlotSeconds: number;
    expectedHours: number;
    weightedScore: number;
    crafts: Array<{ itemId: string; count: number }>;
    consumptions: Array<{
      itemId: string;
      count: number;
      yields: Array<{ itemId: string; quantity: number }>;
    }>;
    missions: Array<{
      missionId: string;
      ship: string;
      durationType: string;
      level: number;
      targetAfxId: number;
      launches: number;
      durationSeconds: number;
      expectedYields: Array<{ itemId: string; quantity: number }>;
      inAir?: boolean;
      secondsRemaining?: number;
      launchSecondsRemaining?: number[];
      /** Stable row id that virtue tank units point back at. */
      rowKey?: string;
    }>;
    unmetItems: Array<{ itemId: string; quantity: number }>;
    targetBreakdown: {
      requested: number;
      fromInventory: number;
      fromCraft: number;
      fromMissionsExpected: number;
      shortfall: number;
    };
    targetBreakdowns: Array<{
      itemId: string;
      requested: number;
      fromInventory: number;
      fromCraft: number;
      fromMissionsExpected: number;
      shortfall: number;
    }>;
    progression: {
      prepHours: number;
      prepLaunches: Array<{
        ship: string;
        durationType: string;
        launches: number;
        durationSeconds: number;
        reason: string;
      }>;
      projectedShipLevels: Array<ShipLevelInfo>;
    };
    inFlight: {
      missionCount: number;
      secondsRemaining: number;
    };
    schedule: {
      missionSeconds: number;
      inAirSeconds: number;
      totalSeconds: number;
    };
    notes: string[];
    availableCombos: Array<{
      ship: string;
      durationType: string;
      targetAfxId: number;
    }>;
    /** Path of Virtue tank mode only; absent on main-farm plans and older saved sessions. */
    virtueTanks?: VirtueTankPlannerResult;
  };
};

type MonolithicPathResult = {
  ship: string;
  durationType: string;
  targetAfxId: number;
  totalLaunches: number;
  finalShipLevel: number | null;
  finalShipMaxLevel: number | null;
  expectedHours: number;
  geCost: number;
  feasible: boolean;
  ingredientBreakdown: Array<{
    itemId: string;
    requested: number;
    fromInventory: number;
    fromCraft: number;
    fromMissionsExpected: number;
    shortfall: number;
  }>;
  phases: Array<{ level: number; capacity: number; launches: number }>;
};

type SolveSnapshotRequest = {
  targetItemId: string;
  quantity: number;
  targets?: Array<{ targetItemId: string; quantity: number; craftGoal?: boolean }>;
  targetCraftedOnly: boolean;
  priorityTime: number;
  fastMode: boolean;
  allowedShipDurations?: Array<{ ship: string; durationType: "SHORT" | "LONG" | "EPIC" }>;
  selectedConsumptionItemIds?: string[];
  /** Path of Virtue only: the shift-cap slider and the Initial Tank toggle. */
  virtueShiftCap?: number;
  virtueStartTank?: VirtueTankStartMode;
};

type LastSolveInputs = SolveSnapshotRequest & {
  eid: string;
  sourceFilters: PlannerSourceFilters;
};

type PersistedPlannerSession = {
  schemaVersion: 1;
  savedAt: string;
  response: PlanResponse;
  profileSnapshot: ProfileSnapshot;
  lastSolveRequest: LastSolveInputs;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loose shape check for a saved tank plan and tank reading: what the tank views
 * read without guards. A session saved by an older build fails it and is
 * dropped, rather than breaking the page on every load.
 */
function isRestorableVirtueTankSession(tanks: unknown, virtueTank: unknown): boolean {
  if (
    virtueTank != null &&
    (!isPlainObject(virtueTank) || !isPlainObject(virtueTank.fuels) || !isPlainObject(virtueTank.limits))
  ) {
    return false;
  }
  if (tanks == null) {
    return true;
  }
  if (!isPlainObject(tanks) || !Array.isArray(tanks.units) || !Array.isArray(tanks.notes) || !isPlainObject(tanks.pack)) {
    return false;
  }
  const { pack } = tanks;
  return (
    typeof pack.totalShifts === "number" &&
    Array.isArray(pack.tanks) &&
    Array.isArray(pack.unplaced) &&
    Array.isArray(pack.notes) &&
    isPlainObject(pack.schedule) &&
    Array.isArray(pack.schedule.lanes) &&
    pack.schedule.lanes.every(Array.isArray) &&
    pack.tanks.every(
      (tank) =>
        isPlainObject(tank) &&
        Array.isArray(tank.launches) &&
        isPlainObject(tank.startContents) &&
        isPlainObject(tank.leftover) &&
        (tank.refill == null || (isPlainObject(tank.refill) && Array.isArray(tank.refill.route)))
    ) &&
    tanks.units.every((unit) => isPlainObject(unit) && typeof unit.id === "string")
  );
}

function readPersistedPlannerSession(): PersistedPlannerSession | null {
  const raw = readFirstStoredString([LOCAL_PREF_KEYS.plannerSession]);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedPlannerSession>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.savedAt !== "string" ||
      !parsed.response ||
      typeof parsed.response !== "object" ||
      !parsed.response.profile ||
      !parsed.response.plan ||
      !parsed.profileSnapshot ||
      typeof parsed.profileSnapshot !== "object" ||
      !parsed.lastSolveRequest ||
      typeof parsed.lastSolveRequest !== "object"
    ) {
      return null;
    }
    if (!isRestorableVirtueTankSession(parsed.response.plan.virtueTanks, parsed.profileSnapshot.virtueTank)) {
      return null;
    }
    if (typeof parsed.lastSolveRequest.eid !== "string") {
      parsed.lastSolveRequest.eid = parsed.profileSnapshot.eid === "DEMO" ? "" : parsed.profileSnapshot.eid;
    }
    return parsed as PersistedPlannerSession;
  } catch {
    return null;
  }
}

function writePersistedPlannerSession(
  response: PlanResponse,
  profileSnapshot: ProfileSnapshot,
  lastSolveRequest: LastSolveInputs
): void {
  const session: PersistedPlannerSession = {
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    response,
    profileSnapshot,
    lastSolveRequest,
  };
  writeStoredString([LOCAL_PREF_KEYS.plannerSession], JSON.stringify(session));
}

type SolveSnapshotCombo = {
  ship: string;
  durationType: DurationType;
  targetAfxId: number;
};

type SolveInputSnapshotFile = {
  schemaVersion: 1;
  kind: "mission-craft-planner-solve-input";
  capturedAt: string;
  request: SolveSnapshotRequest;
  sourceFilters: PlannerSourceFilters;
  profile: ProfileSnapshot;
  advancedCompare: {
    availableCombos: SolveSnapshotCombo[];
    selectedCombos: SolveSnapshotCombo[];
  };
};

type PlannerProgressPhase = "init" | "candidates" | "candidate" | "refinement" | "finalize" | "fallback";

type PlannerProgressState = {
  phase: PlannerProgressPhase;
  message: string;
  elapsedMs: number;
  completed: number | null;
  total: number | null;
  etaMs: number | null;
};

type PlanStreamMessage =
  | {
      type: "progress";
      progress: {
        phase: PlannerProgressPhase;
        message: string;
        elapsedMs: number;
        completed?: number;
        total?: number;
        etaMs?: number | null;
      };
    }
  | { type: "result"; data: PlanResponse }
  | { type: "error"; error: string; details?: unknown };

type PlanMissionRow = PlanResponse["plan"]["missions"][number];

type TimelineSegment = {
  id: string;
  label: string;
  subtitle: string;
  launches: number;
  durationSeconds: number;
  totalSlotSeconds: number;
  color: string;
  phase: "mission" | "prep" | "inAir";
  ship: string;
  durationType: string;
  level: number | null;
  targetAfxId: number | null;
};

type TimelineLaneBlock = {
  id: string;
  label: string;
  subtitle: string;
  color: string;
  phase: "mission" | "prep" | "inAir";
  launches: number;
  totalSeconds: number;
  startSeconds: number;
  endSeconds: number;
};

type CraftPlanDetailRow = {
  itemId: string;
  /** Set when a craft-count goal put this row in the table. */
  craftGoalLabel: string | null;
  plannedCraftCount: number;
  have: number | null;
  requiredForChain: number;
  expectedMission: number;
  fromConsumption: number;
  consumedCount: number;
  plannedCraftTooltip: string | null;
  neededTooltip: string | null;
  expectedMissionTooltip: string | null;
  fromConsumptionTooltip: string | null;
  consumedTooltip: string | null;
};

type MissionTimeline = {
  lanes: TimelineLaneBlock[][];
  segments: TimelineSegment[];
  totalSeconds: number;
  modelTotalSlotSeconds: number;
  missionSlotSeconds: number;
  prepSlotSeconds: number;
  hiddenPrepSlotSeconds: number;
};

type FuelChartSegment = {
  id: string;
  label: string;
  subtitle: string;
  quantity: number;
  color: string;
};

type FuelChartRow = {
  fuel: VirtueFuelKey;
  label: string;
  imageSrc: string;
  total: number;
  segments: FuelChartSegment[];
};

type FuelCharts = {
  rows: FuelChartRow[];
  maxTotal: number;
  total: number;
};

const DURATION_TYPES: DurationType[] = ["TUTORIAL", "SHORT", "LONG", "EPIC"];
const SHIP_SELECTOR_DURATIONS: Array<{ key: "SHORT" | "LONG" | "EPIC"; label: string }> = [
  { key: "SHORT", label: "Short" },
  { key: "LONG", label: "Standard" },
  { key: "EPIC", label: "Extended" },
];
const SHIP_IMAGE_HOST = "https://eggincassets.pages.dev";
const SHIP_IMAGE_HOST_FALLBACK = "https://eggincassets.tcl.sh";
const SHIP_DISPLAY_CONFIG: Array<{ ship: string; imageFiles: string[] }> = [
  { ship: "ATREGGIES", imageFiles: ["afx_ship_atreggies.png", "afx_ship_atreggies_henliner.png"] },
  { ship: "HENERPRISE", imageFiles: ["afx_ship_henerprise.png"] },
  { ship: "VOYEGGER", imageFiles: ["afx_ship_voyegger.png"] },
  { ship: "CHICKFIANT", imageFiles: ["afx_ship_defihent.png"] },
  { ship: "GALEGGTICA", imageFiles: ["afx_ship_galeggtica.png"] },
  { ship: "CORELLIHEN_CORVETTE", imageFiles: ["afx_ship_corellihen_corvette.png", "afx_ship_cornish_hen_corvette.png", "afx_ship_cornish_hen.png"] },
  { ship: "MILLENIUM_CHICKEN", imageFiles: ["afx_ship_millenium_chicken.png", "afx_ship_quintillion_chicken.png", "afx_ship_quintillion.png"] },
  { ship: "BCR", imageFiles: ["afx_ship_bcr.png"] },
  { ship: "CHICKEN_HEAVY", imageFiles: ["afx_ship_chicken_heavy.png"] },
  { ship: "CHICKEN_NINE", imageFiles: ["afx_ship_chicken_9.png", "afx_ship_chicken_nine.png"] },
  { ship: "CHICKEN_ONE", imageFiles: ["afx_ship_chicken_1.png", "afx_ship_chicken_one.png"] },
];
type ShipDurationSelection = Record<string, { SHORT: boolean; LONG: boolean; EPIC: boolean }>;
function buildDefaultShipDurations(): ShipDurationSelection {
  const result: ShipDurationSelection = {};
  for (const entry of SHIP_DISPLAY_CONFIG) {
    result[entry.ship] = { SHORT: true, LONG: true, EPIC: true };
  }
  return result;
}
function shipImageUrl(filename: string, host: string = SHIP_IMAGE_HOST): string {
  return `${host}/128/egginc/${filename}`;
}

type PlannerSourcePreferences = {
  targetRows?: Array<{ targetItemId?: string; itemId?: string; quantity?: number; quantityInput?: string; craftGoal?: boolean }>;
  targetCraftedOnly?: boolean;
  includeSlotted?: boolean;
  includeInventoryRare?: boolean;
  includeInventoryEpic?: boolean;
  includeInventoryLegendary?: boolean;
  includeInventoryFragments?: boolean;
  includeDropRare?: boolean;
  includeDropEpic?: boolean;
  includeDropLegendary?: boolean;
  includeDropFragments?: boolean;
  selectedConsumptionItemIds?: string[];
  shipDurations?: ShipDurationSelection;
};

type PlannerSourcePreferenceStore = Partial<Record<InventorySource, PlannerSourcePreferences>>;

const ARTIFACT_DISPLAY = artifactDisplay as Record<string, { id: string; name: string; tierName: string; tierNumber: number }>;
const ARTIFACT_CONSUMPTION = artifactConsumption as Record<string, Record<string, number>>;
const ARTIFACT_SHORT_NAMES = artifactShortNames as Array<{ familyKey: string; shortName: string }>;
const SHARED_EID_KEYS = [LOCAL_PREF_KEYS.sharedEid, LOCAL_PREF_KEYS.legacyEid] as const;
const SHARED_INCLUDE_SLOTTED_KEYS = [LOCAL_PREF_KEYS.sharedIncludeSlotted, LOCAL_PREF_KEYS.legacyIncludeSlotted] as const;

function buildDefaultConsumptionItemIds(): string[] {
  return ARTIFACT_SHORT_NAMES.flatMap((entry) => [1, 2, 3, 4].map((tier) => `${entry.familyKey}_${tier}`))
    .filter((itemKey) => ARTIFACT_DISPLAY[itemKey] && Object.keys(ARTIFACT_CONSUMPTION[itemKey] || {}).length > 0)
    .map((itemKey) => ARTIFACT_DISPLAY[itemKey]?.id || itemKeyToId(itemKey))
    .sort((a, b) => itemIdToCanonicalKey(a).localeCompare(itemIdToCanonicalKey(b)));
}

const DEFAULT_CONSUMPTION_ITEM_IDS = buildDefaultConsumptionItemIds();
const DEFAULT_CONSUMPTION_ITEM_ID_SET = new Set(DEFAULT_CONSUMPTION_ITEM_IDS);
const DISPLAY_ID_MISMATCH_CONSUMPTION_IDS = DEFAULT_CONSUMPTION_ITEM_IDS.filter((itemId) => {
  const canonicalKey = itemIdToCanonicalKey(itemId);
  return itemKeyToId(canonicalKey) !== itemId;
});

function isCraftedOnlyEligibleGoalKey(itemKey: string): boolean {
  if (/_stone_\d+$/.test(itemKey)) {
    return false;
  }
  return !(
    /^gold_meteorite_\d+$/.test(itemKey) ||
    /^tau_ceti_geode_\d+$/.test(itemKey) ||
    /^solar_titanium_\d+$/.test(itemKey)
  );
}

function durationTypeLabel(durationType: string): string {
  switch (durationType) {
    case "TUTORIAL":
      return "Tutorial";
    case "SHORT":
      return "Short";
    case "LONG":
      return "Standard";
    case "EPIC":
      return "Extended";
    default:
      return durationType;
  }
}

function durationTypeSortRank(durationType: string): number {
  switch (durationType) {
    case "TUTORIAL":
      return 0;
    case "SHORT":
      return 1;
    case "LONG":
      return 2;
    case "EPIC":
      return 3;
    default:
      return 99;
  }
}

function durationTypeWithLevelLabel(durationType: string, level: number): string {
  const base = durationTypeLabel(durationType);
  const safeLevel = Number.isFinite(level) ? Math.max(0, Math.round(level)) : 0;
  if (safeLevel <= 0) {
    return base;
  }
  return `${base} ${safeLevel}⭐`;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function prepTimelineColor(seed: string): string {
  return `color-mix(in oklab, hsl(${hashString(seed) % 360} 58% 62%), var(--panel) 20%)`;
}

const MISSION_COLOR_PALETTE: Array<[number, number, number]> = [
  [10, 78, 55],
  [26, 80, 54],
  [42, 82, 53],
  [58, 80, 50],
  [88, 72, 47],
  [114, 64, 45],
  [140, 66, 45],
  [164, 68, 43],
  [188, 76, 49],
  [206, 80, 52],
  [224, 82, 57],
  [242, 76, 60],
  [260, 74, 62],
  [278, 72, 58],
  [296, 72, 56],
  [314, 74, 58],
  [332, 78, 56],
  [350, 80, 54],
];

function missionTimelineColor(seed: string, usedPaletteIndexes: Set<number>): string {
  const hash = hashString(seed);
  const paletteLen = MISSION_COLOR_PALETTE.length;
  for (let attempt = 0; attempt < paletteLen; attempt += 1) {
    const index = (hash + attempt * 7) % paletteLen;
    if (usedPaletteIndexes.has(index)) {
      continue;
    }
    usedPaletteIndexes.add(index);
    const [hue, saturation, lightness] = MISSION_COLOR_PALETTE[index];
    return `hsl(${hue} ${saturation}% ${lightness}% / 0.66)`;
  }
  const [hue, saturation, lightness] = MISSION_COLOR_PALETTE[hash % paletteLen];
  return `hsl(${hue} ${saturation}% ${lightness}% / 0.66)`;
}

function missionColorKey(mission: Pick<PlanMissionRow, "ship" | "durationType" | "targetAfxId">): string {
  return `${mission.ship}|${mission.durationType}|${mission.targetAfxId}`;
}

function buildMissionColorMap(missions: PlanMissionRow[]): Map<string, string> {
  const usedPaletteIndexes = new Set<number>();
  const colorByKey = new Map<string, string>();
  for (const mission of missions) {
    const launches = Math.max(0, Math.round(mission.launches));
    const durationSeconds = Math.max(0, Math.round(mission.durationSeconds));
    if (launches <= 0 || launches * durationSeconds <= 0) {
      continue;
    }
    const key = missionColorKey(mission);
    if (!colorByKey.has(key)) {
      colorByKey.set(key, missionTimelineColor(key, usedPaletteIndexes));
    }
  }
  return colorByKey;
}

function laneOrderByLoad(loads: number[]): number[] {
  return [0, 1, 2].sort((a, b) => {
    const diff = loads[a] - loads[b];
    if (Math.abs(diff) > 1e-9) {
      return diff;
    }
    return a - b;
  });
}

function distributeLaunchesAcrossLanes(launches: number, durationSeconds: number, laneLoads: number[]): number[] {
  const allocations = [0, 0, 0];
  let remaining = Math.max(0, Math.round(launches));
  const safeDuration = Math.max(0, Math.round(durationSeconds));
  if (remaining <= 0 || safeDuration <= 0) {
    return allocations;
  }

  const baseLaunches = Math.floor(remaining / 3);
  for (let lane = 0; lane < 3; lane += 1) {
    allocations[lane] = baseLaunches;
    remaining -= baseLaunches;
  }

  const projected = laneLoads.map((load, lane) => load + allocations[lane] * safeDuration);
  while (remaining > 0) {
    const lane = laneOrderByLoad(projected)[0];
    allocations[lane] += 1;
    projected[lane] += safeDuration;
    remaining -= 1;
  }

  return allocations;
}

function distributeSecondsAcrossLanes(totalSlotSeconds: number, laneLoads: number[]): number[] {
  const allocations = [0, 0, 0];
  const projected = [...laneLoads];
  let remaining = Math.max(0, Math.round(totalSlotSeconds));
  if (remaining <= 0) {
    return allocations;
  }

  while (remaining > 0) {
    const order = laneOrderByLoad(projected);
    const first = order[0];
    const second = order[1];
    const gap = Math.max(0, Math.round(projected[second] - projected[first]));
    let chunk = 1;
    if (gap > 0) {
      chunk = gap;
    } else {
      const minLoad = projected[first];
      const tiedCount = order.filter((lane) => Math.abs(projected[lane] - minLoad) < 1e-9).length;
      chunk = Math.floor(remaining / Math.max(1, tiedCount));
    }
    const assign = Math.max(1, Math.min(remaining, chunk));
    allocations[first] += assign;
    projected[first] += assign;
    remaining -= assign;
  }

  return allocations;
}

function timelineScheduleRank(segment: TimelineSegment): number {
  if (segment.launches > 0 && segment.durationSeconds > 0) {
    return segment.durationSeconds;
  }
  return segment.totalSlotSeconds;
}

function timelinePrecedenceKey(segment: TimelineSegment): string {
  if (segment.ship && segment.durationType && (segment.phase === "mission" || segment.phase === "prep")) {
    return `${segment.ship}|${segment.durationType}`;
  }
  return segment.id;
}

function timelineSegmentOrder(a: TimelineSegment, b: TimelineSegment): number {
  const aPhaseRank = a.phase === "prep" ? 0 : 1;
  const bPhaseRank = b.phase === "prep" ? 0 : 1;
  if (aPhaseRank !== bPhaseRank) {
    return aPhaseRank - bPhaseRank;
  }
  const levelDiff = (a.level ?? -1) - (b.level ?? -1);
  if (levelDiff !== 0) {
    return levelDiff;
  }
  const rankDiff = timelineScheduleRank(b) - timelineScheduleRank(a);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  const totalDiff = b.totalSlotSeconds - a.totalSlotSeconds;
  if (totalDiff !== 0) {
    return totalDiff;
  }
  const launchDiff = b.launches - a.launches;
  if (launchDiff !== 0) {
    return launchDiff;
  }
  const targetDiff = (a.targetAfxId ?? Number.MAX_SAFE_INTEGER) - (b.targetAfxId ?? Number.MAX_SAFE_INTEGER);
  if (targetDiff !== 0) {
    return targetDiff;
  }
  return a.id.localeCompare(b.id);
}

function timelinePhaseKey(segment: TimelineSegment): string {
  if (segment.phase === "prep") {
    return "prep";
  }
  return `mission:${segment.level ?? -1}`;
}

function timelinePhaseRank(segment: TimelineSegment): number {
  if (segment.phase === "prep") {
    return 0;
  }
  return 1 + (segment.level ?? 0);
}

function groupTimelineSegmentsByPhase(group: TimelineSegment[]): TimelineSegment[][] {
  const phasesByKey = new Map<string, TimelineSegment[]>();
  for (const segment of group) {
    const key = timelinePhaseKey(segment);
    const phase = phasesByKey.get(key) || [];
    phase.push(segment);
    phasesByKey.set(key, phase);
  }
  return Array.from(phasesByKey.values())
    .map((phase) => phase.slice().sort(timelineSegmentOrder))
    .sort((a, b) => {
      const rankDiff = timelinePhaseRank(a[0]) - timelinePhaseRank(b[0]);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return (a[0]?.id || "").localeCompare(b[0]?.id || "");
    });
}

function groupTimelineSegmentsForLaneBalance(segments: TimelineSegment[]): TimelineSegment[][] {
  const groupByKey = new Map<string, TimelineSegment[]>();
  for (const segment of segments) {
    const key = timelinePrecedenceKey(segment);
    const group = groupByKey.get(key) || [];
    group.push(segment);
    groupByKey.set(key, group);
  }
  return Array.from(groupByKey.values())
    .map((group) => group.slice().sort(timelineSegmentOrder))
    .sort((a, b) => {
      // Prep gates the improved options the rest of the plan relies on, so any
      // group carrying prep launches schedules before pure mission groups even
      // when its per-launch duration would otherwise pack it last.
      const aPrepRank = a.some((segment) => segment.phase === "prep") ? 0 : 1;
      const bPrepRank = b.some((segment) => segment.phase === "prep") ? 0 : 1;
      if (aPrepRank !== bPrepRank) {
        return aPrepRank - bPrepRank;
      }
      const aRank = Math.max(...a.map(timelineScheduleRank));
      const bRank = Math.max(...b.map(timelineScheduleRank));
      const rankDiff = bRank - aRank;
      if (rankDiff !== 0) {
        return rankDiff;
      }
      const aTotal = a.reduce((sum, segment) => sum + segment.totalSlotSeconds, 0);
      const bTotal = b.reduce((sum, segment) => sum + segment.totalSlotSeconds, 0);
      const totalDiff = bTotal - aTotal;
      if (totalDiff !== 0) {
        return totalDiff;
      }
      return (a[0]?.id || "").localeCompare(b[0]?.id || "");
    });
}

function sortTimelineSegmentsForLegend(segments: TimelineSegment[]): TimelineSegment[] {
  return segments.slice().sort((a, b) => {
    const keyDiff = timelinePrecedenceKey(a).localeCompare(timelinePrecedenceKey(b));
    if (keyDiff !== 0) {
      return keyDiff;
    }
    const orderDiff = timelineSegmentOrder(a, b);
    if (orderDiff !== 0) {
      return orderDiff;
    }
    const rankDiff = timelineScheduleRank(b) - timelineScheduleRank(a);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return a.id.localeCompare(b.id);
  });
}

function buildMissionTimeline(plan: PlanResponse["plan"]): MissionTimeline | null {
  const missionColorByKey = buildMissionColorMap(plan.missions);
  // In-air missions are not launches to schedule — they are slots already
  // occupied, so they seed the lanes instead of being packed into them.
  const rawMissionSegments: TimelineSegment[] = plan.missions
    .filter((mission) => !mission.inAir)
    .map((mission: PlanMissionRow, index): TimelineSegment | null => {
      const launches = Math.max(0, Math.round(mission.launches));
      const durationSeconds = Math.max(0, Math.round(mission.durationSeconds));
      const totalSlotSeconds = launches * durationSeconds;
      if (launches <= 0 || totalSlotSeconds <= 0) {
        return null;
      }
      const targetName = afxIdToTargetFamilyName(mission.targetAfxId);
      const label = `${titleCaseShip(mission.ship)} ${durationTypeWithLevelLabel(mission.durationType, mission.level)}`;
      return {
        id: `mission:${index}:${mission.missionId}:${mission.targetAfxId}`,
        label,
        subtitle: targetName,
        launches,
        durationSeconds,
        totalSlotSeconds,
        color: missionColorByKey.get(missionColorKey(mission)) || prepTimelineColor(missionColorKey(mission)),
        phase: "mission",
        ship: mission.ship,
        durationType: mission.durationType,
        level: mission.level,
        targetAfxId: mission.targetAfxId,
      };
    })
    .filter((segment): segment is TimelineSegment => segment !== null)
    .sort((a, b) => {
      const shipDiff = a.ship.localeCompare(b.ship);
      if (shipDiff !== 0) {
        return shipDiff;
      }
      const levelDiff = (a.level ?? Number.MAX_SAFE_INTEGER) - (b.level ?? Number.MAX_SAFE_INTEGER);
      if (levelDiff !== 0) {
        return levelDiff;
      }
      const durationDiff = durationTypeSortRank(a.durationType) - durationTypeSortRank(b.durationType);
      if (durationDiff !== 0) {
        return durationDiff;
      }
      const targetLabelDiff = a.subtitle.localeCompare(b.subtitle);
      if (targetLabelDiff !== 0) {
        return targetLabelDiff;
      }
      const targetDiff = (a.targetAfxId ?? Number.MAX_SAFE_INTEGER) - (b.targetAfxId ?? Number.MAX_SAFE_INTEGER);
      if (targetDiff !== 0) {
        return targetDiff;
      }
      const durationSecondsDiff = b.durationSeconds - a.durationSeconds;
      if (durationSecondsDiff !== 0) {
        return durationSecondsDiff;
      }
      const launchesDiff = b.launches - a.launches;
      if (launchesDiff !== 0) {
        return launchesDiff;
      }
      return a.label.localeCompare(b.label);
    });

  const prepSegments: TimelineSegment[] = plan.progression.prepLaunches
    .map((prep, index): TimelineSegment | null => {
      const launches = Math.max(0, Math.round(prep.launches));
      const durationSeconds = Math.max(0, Math.round(prep.durationSeconds));
      const totalSlotSeconds = launches * durationSeconds;
      if (launches <= 0 || totalSlotSeconds <= 0) {
        return null;
      }
      return {
        id: `prep:${index}:${prep.ship}:${prep.durationType}`,
        label: `${titleCaseShip(prep.ship)} ${durationTypeLabel(prep.durationType)}`,
        subtitle: prep.reason,
        launches,
        durationSeconds,
        totalSlotSeconds,
        color: prepTimelineColor(`prep|${prep.ship}|${prep.durationType}|${prep.reason}`),
        phase: "prep",
        ship: prep.ship,
        durationType: prep.durationType,
        level: null,
        targetAfxId: null,
      };
    })
    .filter((segment): segment is TimelineSegment => segment !== null);

  const remainingPrepByShipDuration = new Map<string, number>();
  for (const prepSegment of prepSegments) {
    const key = `${prepSegment.ship}|${prepSegment.durationType}`;
    remainingPrepByShipDuration.set(key, (remainingPrepByShipDuration.get(key) || 0) + prepSegment.launches);
  }

  const missionSegments: TimelineSegment[] = rawMissionSegments
    .map((segment) => {
      const key = `${segment.ship}|${segment.durationType}`;
      const prepRemaining = remainingPrepByShipDuration.get(key) || 0;
      if (prepRemaining <= 0) {
        return segment;
      }
      const reduction = Math.min(prepRemaining, segment.launches);
      if (reduction <= 0) {
        return segment;
      }
      remainingPrepByShipDuration.set(key, prepRemaining - reduction);
      const launches = segment.launches - reduction;
      if (launches <= 0) {
        return null;
      }
      return {
        ...segment,
        launches,
        totalSlotSeconds: launches * segment.durationSeconds,
      };
    })
    .filter((segment): segment is TimelineSegment => segment !== null);

  const missionSlotSeconds = missionSegments.reduce((sum, segment) => sum + segment.totalSlotSeconds, 0);
  const prepSlotSeconds = prepSegments.reduce((sum, segment) => sum + segment.totalSlotSeconds, 0);
  const modelTotalSlotSeconds = Math.max(0, Math.round(plan.totalSlotSeconds ?? plan.expectedHours * 3 * 3600));
  let hiddenPrepSlotSeconds = Math.max(0, modelTotalSlotSeconds - (missionSlotSeconds + prepSlotSeconds));
  if (hiddenPrepSlotSeconds < 60) {
    hiddenPrepSlotSeconds = 0;
  }

  const segments = [...prepSegments, ...missionSegments];
  if (hiddenPrepSlotSeconds > 0) {
    segments.push({
      id: "prep-residual",
      label: "Progression-only prep",
      subtitle: "Unattributed prep slot-time",
      launches: 0,
      durationSeconds: 0,
      totalSlotSeconds: hiddenPrepSlotSeconds,
      color: prepTimelineColor("prep-only"),
      phase: "prep",
      ship: "",
      durationType: "",
      level: null,
      targetAfxId: null,
    });
  }

  const inAirLaunches = plan.missions
    .filter((mission) => mission.inAir)
    .flatMap((mission) =>
      (mission.launchSecondsRemaining || [mission.secondsRemaining || 0]).map((seconds) => ({
        mission,
        seconds: Math.max(0, Math.round(seconds)),
      }))
    )
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 3);

  if (segments.length === 0 && inAirLaunches.length === 0) {
    return null;
  }

  const lanes: TimelineLaneBlock[][] = [[], [], []];
  const laneLoads = [0, 0, 0];

  inAirLaunches.forEach(({ mission, seconds }, lane) => {
    if (seconds <= 0) {
      return;
    }
    lanes[lane].push({
      id: `in-air:${lane}:${mission.missionId}`,
      label: `${titleCaseShip(mission.ship)} ${durationTypeWithLevelLabel(mission.durationType, mission.level)}`,
      subtitle: `In air · ${afxIdToTargetFamilyName(mission.targetAfxId)}`,
      color: missionColorByKey.get(missionColorKey(mission)) || prepTimelineColor(missionColorKey(mission)),
      phase: "inAir",
      launches: 1,
      totalSeconds: seconds,
      startSeconds: 0,
      endSeconds: seconds,
    });
    laneLoads[lane] = seconds;
  });

  const scheduleSegment = (segment: TimelineSegment, earliestStartSeconds: number): number => {
    const effectiveLaneLoads = laneLoads.map((load) => Math.max(load, earliestStartSeconds));
    let nextPhaseStartSeconds = earliestStartSeconds;
    if (segment.launches > 0 && segment.durationSeconds > 0) {
      const launchAllocations = distributeLaunchesAcrossLanes(segment.launches, segment.durationSeconds, effectiveLaneLoads);
      for (let lane = 0; lane < 3; lane += 1) {
        const launches = launchAllocations[lane];
        if (launches <= 0) {
          continue;
        }
        const blockSeconds = launches * segment.durationSeconds;
        const startSeconds = effectiveLaneLoads[lane];
        const endSeconds = startSeconds + blockSeconds;
        lanes[lane].push({
          id: `${segment.id}:lane:${lane}`,
          label: segment.label,
          subtitle: segment.subtitle,
          color: segment.color,
          phase: segment.phase,
          launches,
          totalSeconds: blockSeconds,
          startSeconds,
          endSeconds,
        });
        laneLoads[lane] = endSeconds;
        nextPhaseStartSeconds = Math.max(nextPhaseStartSeconds, startSeconds + (launches - 1) * segment.durationSeconds);
      }
      return nextPhaseStartSeconds;
    }

    const secondAllocations = distributeSecondsAcrossLanes(segment.totalSlotSeconds, effectiveLaneLoads);
    for (let lane = 0; lane < 3; lane += 1) {
      const blockSeconds = secondAllocations[lane];
      if (blockSeconds <= 0) {
        continue;
      }
      const startSeconds = effectiveLaneLoads[lane];
      const endSeconds = startSeconds + blockSeconds;
      lanes[lane].push({
        id: `${segment.id}:lane:${lane}`,
        label: segment.label,
        subtitle: segment.subtitle,
        color: segment.color,
        phase: segment.phase,
        launches: 0,
        totalSeconds: blockSeconds,
        startSeconds,
        endSeconds,
      });
      laneLoads[lane] = endSeconds;
      nextPhaseStartSeconds = Math.max(nextPhaseStartSeconds, endSeconds);
    }
    return nextPhaseStartSeconds;
  };

  for (const group of groupTimelineSegmentsForLaneBalance(segments)) {
    let groupBarrierSeconds = 0;
    for (const phase of groupTimelineSegmentsByPhase(group)) {
      let nextBarrierSeconds = groupBarrierSeconds;
      for (const segment of phase) {
        nextBarrierSeconds = Math.max(nextBarrierSeconds, scheduleSegment(segment, groupBarrierSeconds));
      }
      groupBarrierSeconds = nextBarrierSeconds;
    }
  }

  const totalSeconds = Math.max(0, ...laneLoads);
  if (totalSeconds <= 0) {
    return null;
  }

  return {
    lanes,
    segments: sortTimelineSegmentsForLegend(segments),
    totalSeconds,
    modelTotalSlotSeconds,
    missionSlotSeconds,
    prepSlotSeconds,
    hiddenPrepSlotSeconds,
  };
}

function buildVirtueFuelCharts(plan: PlanResponse["plan"]): FuelCharts | null {
  const missionColorByKey = buildMissionColorMap(plan.missions);
  const segmentsByFuel = new Map<VirtueFuelKey, FuelChartSegment[]>();
  const totalsByFuel = new Map<VirtueFuelKey, number>();

  plan.missions.forEach((mission, missionIndex) => {
    const launches = Math.max(0, Math.round(mission.launches));
    // In-air missions paid for their fuel when they launched.
    if (launches <= 0 || mission.inAir) {
      return;
    }
    const fuelConfig = getVirtueFuelConfig(mission.ship, mission.durationType);
    if (Object.keys(fuelConfig).length === 0) {
      return;
    }
    const key = missionColorKey(mission);
    const label = `${titleCaseShip(mission.ship)} ${durationTypeWithLevelLabel(mission.durationType, mission.level)}`;
    const subtitle = afxIdToTargetFamilyName(mission.targetAfxId);
    const color = missionColorByKey.get(key) || prepTimelineColor(key);

    for (const fuel of VIRTUE_FUEL_DISPLAY) {
      const perLaunch = fuelConfig[fuel.key] || 0;
      const quantity = perLaunch * launches;
      if (quantity <= 0) {
        continue;
      }
      const segment: FuelChartSegment = {
        id: `${fuel.key}:${missionIndex}:${mission.missionId}:${mission.targetAfxId}`,
        label,
        subtitle,
        quantity,
        color,
      };
      segmentsByFuel.set(fuel.key, [...(segmentsByFuel.get(fuel.key) || []), segment]);
      totalsByFuel.set(fuel.key, (totalsByFuel.get(fuel.key) || 0) + quantity);
    }
  });

  const rows = VIRTUE_FUEL_DISPLAY.map((fuel): FuelChartRow | null => {
    const segments = segmentsByFuel.get(fuel.key) || [];
    const total = totalsByFuel.get(fuel.key) || 0;
    if (segments.length === 0 || total <= 0) {
      return null;
    }
    return {
      fuel: fuel.key,
      label: fuel.label,
      imageSrc: fuel.imageSrc,
      total,
      segments: segments.sort((a, b) => {
        const labelDiff = a.label.localeCompare(b.label);
        if (labelDiff !== 0) {
          return labelDiff;
        }
        return a.subtitle.localeCompare(b.subtitle);
      }),
    };
  }).filter((row): row is FuelChartRow => row !== null);

  const maxTotal = Math.max(0, ...rows.map((row) => row.total));
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return rows.length > 0 && maxTotal > 0 ? { rows, maxTotal, total } : null;
}

// ---------------------------------------------------------------------------
// Path of Virtue fuel tanks. The planner packs the plan's launches into tanks
// (PlannerResult.virtueTanks, from lib/virtue-tanks.ts); everything below only
// joins that packing to the plan's mission rows and the player's tank
// snapshot for the tank card, the Fuel tanks panel, the mission table grouped
// by tank and the tank timeline.
//
// Humility is never planned: ships fuel it straight from the Humility farm,
// so the advice is always a Humility limit of 0, and any Humility sitting in the
// tank is drained (free) before anything launches.
//
// Limit sliders: the game shows each limit as an egg amount snapping to 1% of
// the tank (5T steps on a 500T tank), so every instruction names the amount
// (formatVirtueTankLimit) and never the percent. limitPct stays an integer
// percent internally.
// ---------------------------------------------------------------------------

type VirtueEggDisplay = { key: VirtueTankEggKey; label: string; short: string; imageSrc: string };

const VIRTUE_EGG_DISPLAY = Object.fromEntries(
  [...VIRTUE_FUEL_DISPLAY, VIRTUE_HUMILITY_DISPLAY].map((egg) => [
    egg.key,
    { key: egg.key, label: egg.label, short: egg.label.charAt(0), imageSrc: egg.imageSrc },
  ])
) as Record<VirtueTankEggKey, VirtueEggDisplay>;

/** Tank readout order: the refuel route (C, R, I, K), then Humility. */
const VIRTUE_TANK_READOUT_ORDER: VirtueTankEggKey[] = [...VIRTUE_REFILL_ROUTE_ORDER, "humility"];

/**
 * Display only: amounts below this read as empty in the tank charts and readouts. Whether a
 * drain or a fill happens is decided with the packer's own tolerance (virtueFuelTolerance), which
 * is far smaller on the small tanks: the 2B tank drains in 20M steps and can drain 0.5M.
 */
const VIRTUE_FUEL_NOISE = 1e6;

/** A refuel window shorter than this means the next tank's first launch waits on the refuel. */
const VIRTUE_TIGHT_REFUEL_WINDOW_SECONDS = 30 * 60;

const VIRTUE_EID_PATTERN = /^EI\d{16}$/i;

/** Planner notes the shift-cap banners (over the cap, or a slow plan within it) already say; the notes panel skips them while a banner shows. */
const VIRTUE_BANNER_NOTE_PATTERNS = [
  /^These goals need at least \d+ shifts/,
  /^No plan (within \d+ shifts|without shifts)/,
  /^With \d+ shifts the goals take/,
];

/** Notes the page already shows in its own structure: drains, unplaced launches, the over-cap banner. */
const VIRTUE_TANK_NOTES_SHOWN_ELSEWHERE = [
  "Drain the leftover Humility",
  "Some refuel loops drain",
  "These goals need at least",
  "No plan within",
  "No plan without shifts",
];

type VirtueTankUnitView = {
  unit: VirtueTankPlanUnit;
  /** Index into plan.missions; null for prep launches that have no mission row. */
  missionIndex: number | null;
  label: string;
  subtitle: string;
  color: string;
  fuelPerLaunch: VirtueFuelVector;
};

type VirtueTankFill = {
  egg: VirtueFuelKey;
  /** Limit to set, in whole percent; shown to the player as an amount (formatVirtueTankLimit). */
  limitPct: number;
  /** The egg's limit before this fill, in whole percent; null when the snapshot is unknown. */
  limitWasPct: number | null;
  /** Contents once filled: the limit rounds up to a whole percent. */
  fillsTo: number;
  /** What the plan needs; below `fillsTo` when the limit rounds up. */
  needs: number;
  from: number;
  /** The tank is full before this egg reaches its limit, so it stops at `fillsTo`, below the limit. */
  stopsAtFull: boolean;
};

type VirtueTankDrain =
  | { egg: VirtueFuelKey; to: number; amount: number }
  /**
   * Drain Humility and zero its limit. `amount` is what the backup shows, or null when it is
   * unknown: Humility can come back in while the limit is still up, before the first refuel.
   */
  | { egg: "humility"; amount: number | null; limitWasPct: number | null }
  /** No tank data: the first fill starts from an empty tank. */
  | { egg: "all" };

type VirtueTankView = {
  tank: VirtueTank;
  /** "current" and "ideal" are the Initial Tank; every later tank is a refuel loop. */
  kind: "current" | "ideal" | "refill";
  /** Fuel eggs shifted to before going back to Humility, in route order. */
  route: VirtueFuelKey[];
  shifts: number;
  fills: VirtueTankFill[];
  /** Free drains before the first shift, or before the first launch from the current tank. */
  drains: VirtueTankDrain[];
  /** Eggs already in the tank that this fill leaves as they are. */
  kept: VirtueFuelKey[];
  launchCount: number;
  /** Refuel loops: the previous tanks' last launch to this tank's first, in seconds from the plan start. */
  window: { fromSeconds: number; toSeconds: number } | null;
  /** Current-contents Initial Tank only: Humility sitting in the tank now. Drawn, never planned. */
  humility: number;
};

/** The tank the virtue card shows; "pending" until the EID is complete enough to fetch. */
type VirtueTankPreview = {
  eid: string;
  status: "pending" | "loading" | "ready" | "error";
  virtueTank: VirtueTankSnapshot | null;
  error: string | null;
};

type VirtueTankPlanView = {
  result: VirtueTankPlannerResult;
  pack: VirtueTankPlan;
  capacity: number;
  tanks: VirtueTankView[];
  units: Map<string, VirtueTankUnitView>;
  /** Shifts to fill an ideal Initial Tank from what is in the tank now; not counted toward the cap. */
  firstFillShifts: number;
  /** Soul Egg prices, null without the player's Soul Eggs and shift count. */
  firstFillCostSoulEggs: number | null;
  planCostSoulEggs: number | null;
  perShiftCostSoulEggs: number[];
};

function virtueFuelAmount(vector: VirtueFuelVector | undefined, egg: VirtueFuelKey): number {
  const value = vector?.[egg];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function virtueFuelTotal(vector: VirtueFuelVector | undefined): number {
  return VIRTUE_REFILL_ROUTE_ORDER.reduce((sum, egg) => sum + virtueFuelAmount(vector, egg), 0);
}

function virtueTankPct(value: number, capacity: number): number {
  return capacity > 0 ? Math.max(0, Math.min(100, (value / capacity) * 100)) : 0;
}

function virtueEggStyle(egg: VirtueTankEggKey, extra?: CSSProperties): CSSProperties {
  return { "--egg": `var(--egg-${egg})`, ...extra } as CSSProperties;
}

/**
 * Tank amounts to one decimal ("108.7T", "42T"). formatVirtueFuelQuantity
 * drops the decimal from 10 up, which is too coarse for fill targets. With the
 * tank's capacity, amounts get the decimals its 1% steps need, so a drain
 * target reads the same as that step's limit ("1.02B" on the 2B tank).
 * Below 1M the eggs are counted ("500,000"): the 2B tank drains that little.
 */
function formatTankFuel(value: number, capacity = 0): string {
  const absValue = Math.abs(value);
  const units: Array<[number, string]> = [[1e18, "Q"], [1e15, "q"], [1e12, "T"], [1e9, "B"], [1e6, "M"]];
  for (const [unit, suffix] of units) {
    if (absValue >= unit * 0.9995) {
      const digits = Math.max(1, fractionDigitsForResolution(capacity / 100 / unit));
      const scaled = Math.round((value / unit) * 10 ** digits) / 10 ** digits;
      return `${scaled.toLocaleString(undefined, { maximumFractionDigits: digits })}${suffix}`;
    }
  }
  const eggs = Math.round(value);
  return (eggs === 0 ? 0 : eggs).toLocaleString();
}

/** Soul Eggs with the game's suffixes: one decimal below 10 ("1.4s"), whole numbers above ("803Q"). */
function formatSoulEggs(value: number): string {
  const units: Array<[number, string]> = [
    [1e33, "d"], [1e30, "N"], [1e27, "o"], [1e24, "S"], [1e21, "s"], [1e18, "Q"],
    [1e15, "q"], [1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"],
  ];
  for (const [unit, suffix] of units) {
    if (value >= unit) {
      const scaled = value / unit;
      return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled).toString()}${suffix}`;
    }
  }
  return Math.round(value).toLocaleString();
}

/** Weekday and time, e.g. "Mon 5:12 AM"; the date too ("Mon Oct 5, 5:12 AM") once the weekday could mean two days. */
function formatClockTime(at: Date, fromMs: number): string {
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (at.getTime() - fromMs < 6 * 24 * 3600 * 1000) {
    return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  return `${at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

function pluralize(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** "Backup 12 min ago", or null for a synthetic (demo) tank. */
function formatBackupAge(backupTimeSeconds: number | null, nowMs: number): string | null {
  if (backupTimeSeconds == null || !Number.isFinite(backupTimeSeconds)) {
    return null;
  }
  const minutes = Math.max(0, Math.round((nowMs / 1000 - backupTimeSeconds) / 60));
  if (minutes < 1) {
    return "Backup just now";
  }
  if (minutes < 60) {
    return `Backup ${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `Backup ${hours} h ago`;
  }
  return `Backup ${Math.round(hours / 24)} days ago`;
}

/** The smallest shift-cap detent that allows `shifts`, or null past the slider's end. */
function shiftCapDetentFor(shifts: number): number | null {
  return VIRTUE_SHIFT_CAP_DETENTS.find((detent) => detent >= shifts) ?? null;
}

type VirtueTankLaunchGroup = {
  key: string;
  /** plan.missions row; null for prep launches with no row, which stay one group per unit. */
  missionIndex: number | null;
  unitView: VirtueTankUnitView | null;
  launches: number;
};

/**
 * A tank's launches per mission row, in launch order. A row's prep and farming
 * launches are separate packer units but one line for the player.
 */
function groupTankLaunches(view: VirtueTankPlanView, tank: VirtueTank): VirtueTankLaunchGroup[] {
  const groups: VirtueTankLaunchGroup[] = [];
  for (const entry of tank.launches) {
    const unitView = view.units.get(entry.unitId) || null;
    const missionIndex = unitView?.missionIndex ?? null;
    const existing = missionIndex != null ? groups.find((group) => group.missionIndex === missionIndex) : null;
    if (existing) {
      existing.launches += entry.launches;
    } else {
      groups.push({
        key: missionIndex != null ? `row:${missionIndex}` : `unit:${entry.unitId}`,
        missionIndex,
        unitView,
        launches: entry.launches,
      });
    }
  }
  return groups;
}

function buildVirtueTankPlanView(
  plan: PlanResponse["plan"],
  snapshot: VirtueTankSnapshot | undefined
): VirtueTankPlanView | null {
  const result = plan.virtueTanks;
  if (!result?.pack) {
    return null;
  }
  const pack = result.pack;
  const capacity = pack.capacity > 0 ? pack.capacity : result.capacity;
  const missionColorByKey = buildMissionColorMap(plan.missions);
  const missionIndexByRowKey = new Map<string, number>();
  plan.missions.forEach((mission, index) => {
    if (mission.rowKey && !mission.inAir) {
      missionIndexByRowKey.set(mission.rowKey, index);
    }
  });
  const prepReasonByShape = new Map<string, string>();
  for (const prep of plan.progression.prepLaunches) {
    const key = `${prep.ship}|${prep.durationType}`;
    if (!prepReasonByShape.has(key)) {
      prepReasonByShape.set(key, prep.reason);
    }
  }

  const units = new Map<string, VirtueTankUnitView>();
  for (const unit of result.units) {
    const missionIndex = unit.missionRowKey ? missionIndexByRowKey.get(unit.missionRowKey) ?? null : null;
    const mission = missionIndex != null ? plan.missions[missionIndex] : null;
    const prepReason = prepReasonByShape.get(`${unit.ship}|${unit.durationType}`);
    const subtitle = mission
      ? afxIdToTargetFamilyName(mission.targetAfxId)
      : unit.isPrep && prepReason
        ? prepReasonLabel(prepReason)
        : unit.targetAfxId != null
          ? afxIdToTargetFamilyName(unit.targetAfxId)
          : "Ship prep";
    const colorKey = mission ? missionColorKey(mission) : `prep|${unit.ship}|${unit.durationType}`;
    units.set(unit.id, {
      unit,
      missionIndex,
      label: `${titleCaseShip(unit.ship)} ${durationTypeWithLevelLabel(unit.durationType, unit.level)}`,
      subtitle,
      color: missionColorByKey.get(colorKey) || prepTimelineColor(colorKey),
      fuelPerLaunch: unit.fuelPerLaunch ?? getVirtueFuelConfig(unit.ship, unit.durationType),
    });
  }

  // One start time per launch: a schedule block of n launches starts one every (end - start) / n.
  const launchStarts: Array<{ tankIndex: number; at: number }> = [];
  for (const lane of pack.schedule.lanes) {
    for (const block of lane) {
      const each = block.launches > 0 ? (block.endSeconds - block.startSeconds) / block.launches : 0;
      for (let launch = 0; launch < block.launches; launch += 1) {
        launchStarts.push({ tankIndex: block.tankIndex, at: block.startSeconds + launch * each });
      }
    }
  }

  // Limit sliders as the player walks through the fills ("now 150T" / "already set"), in whole percent.
  const limitPct: Partial<Record<VirtueTankEggKey, number>> = {};
  if (snapshot) {
    for (const egg of VIRTUE_TANK_READOUT_ORDER) {
      limitPct[egg] = Math.round((snapshot.limits[egg] ?? 1) * 100);
    }
  }
  // Drains and fills are compared the way the packer plans them: to its fuel tolerance (a couple
  // of eggs on the 2B tank), on the readings as the planner snapped them. A 0.5M drain there is
  // real room the route's last egg fills into.
  const tolerance = virtueFuelTolerance(capacity);
  const reading = (egg: VirtueTankEggKey) => (snapshot ? snapVirtueTankReading(snapshot.fuels[egg]) : 0);
  const humilityNow = reading("humility") > tolerance ? reading("humility") : 0;
  // Humility is drained and its limit zeroed before anything launches: on the
  // current tank, or with the ideal fill. Without tank data the ideal fill
  // starts by emptying the whole tank, since its amounts assume an empty one.
  const humilityDrain = (kind: "current" | "ideal", flagged: boolean): VirtueTankDrain | null => {
    if (!snapshot) {
      return kind === "ideal" ? { egg: "all" } : { egg: "humility", amount: null, limitWasPct: null };
    }
    const limitWasPct = limitPct.humility ?? null;
    if (humilityNow <= 0 && !flagged && !(limitWasPct != null && limitWasPct > 0)) {
      return null;
    }
    return { egg: "humility", amount: humilityNow, limitWasPct };
  };
  let firstFillShifts = 0;

  const tanks = pack.tanks.map((tank, tankIndex): VirtueTankView => {
    const launchCount = tank.launches.reduce((sum, entry) => sum + entry.launches, 0);
    const view: VirtueTankView = {
      tank,
      kind: tankIndex === 0 ? (pack.startMode === "ideal" ? "ideal" : "current") : "refill",
      route: [],
      shifts: 0,
      fills: [],
      drains: [],
      kept: [],
      launchCount,
      window: null,
      humility: 0,
    };
    if (view.kind === "current") {
      view.humility = humilityNow;
      const drain = humilityDrain("current", false);
      if (drain) {
        view.drains.push(drain);
      }
      limitPct.humility = 0;
      return view;
    }

    const refill = tank.refill;
    const previous = tankIndex > 0 ? pack.tanks[tankIndex - 1] : null;
    // A limit above what the egg fills to only happens when the tank fills up first.
    const tankFull = virtueFuelTotal(tank.startContents) >= capacity - tolerance;
    const stopsAtFull = (limit: number, fillsTo: number) =>
      tankFull && virtueTankLimitAmount(limit, capacity) - fillsTo > tolerance;
    for (const egg of VIRTUE_REFILL_ROUTE_ORDER) {
      const start = virtueFuelAmount(tank.startContents, egg);
      if (view.kind === "ideal") {
        const idealFill = tank.idealFill;
        const now = reading(egg);
        // From what the tank starts with, not idealFill.changeFromCurrent: an egg
        // needed below what is in it now stays as it is when there is room.
        const change = start - now;
        if (change > tolerance) {
          const limit = idealFill?.limitPct[egg] ?? Math.ceil(virtueTankPct(start, capacity));
          view.fills.push({
            egg,
            limitPct: limit,
            limitWasPct: limitPct[egg] ?? null,
            fillsTo: start,
            needs: virtueFuelAmount(idealFill?.fillTo, egg),
            from: now,
            stopsAtFull: stopsAtFull(limit, start),
          });
          limitPct[egg] = limit;
        } else if (change < -tolerance) {
          // Drain-only: no shift, just drain down to what the tank should start with.
          view.drains.push({ egg, to: start, amount: now - start });
        } else if (start > tolerance) {
          view.kept.push(egg);
        }
        continue;
      }
      // A drain leaves the egg at the previous tank's leftover minus the drain,
      // on a slider step. That is the loop's start level unless the egg is
      // then refilled (the route's last egg, drained below its room and
      // filled back to the brim).
      const drain = virtueFuelAmount(refill?.drain, egg);
      const leftover = virtueFuelAmount(previous?.leftover, egg);
      const drainedTo = drain > tolerance ? Math.max(0, leftover - drain) : leftover;
      const refilled = refill?.route.includes(egg) ?? false;
      if (refilled) {
        const limit = refill?.limitPct[egg] ?? Math.ceil(virtueTankPct(start, capacity));
        view.fills.push({
          egg,
          limitPct: limit,
          limitWasPct: limitPct[egg] ?? null,
          fillsTo: start,
          needs: virtueFuelAmount(refill?.fillTo, egg),
          from: drainedTo,
          stopsAtFull: stopsAtFull(limit, start),
        });
        limitPct[egg] = limit;
      } else if (start > tolerance) {
        view.kept.push(egg);
      }
      if (drain > tolerance) {
        view.drains.push({ egg, to: drainedTo, amount: drain });
      }
    }
    view.route = view.fills.map((fill) => fill.egg);
    if (view.kind === "ideal") {
      const drain = humilityDrain("ideal", Boolean(tank.idealFill?.drainHumility));
      if (drain) {
        view.drains.unshift(drain);
      }
      limitPct.humility = 0;
    } else if (tankIndex === 1 && pack.startMode === "current") {
      // Humility refills live while the current tank launches if its limit
      // went to 0 late, and this loop's fills need that room: drain whatever
      // is there, whatever the backup said.
      view.drains.unshift({ egg: "humility", amount: null, limitWasPct: 0 });
    }

    if (view.kind === "ideal") {
      view.shifts = view.route.length > 0 ? view.route.length + 1 : 0;
      firstFillShifts = view.shifts;
      return view;
    }
    view.shifts = refill?.shifts ?? 0;
    const ownStarts = launchStarts.filter((entry) => entry.tankIndex === tankIndex).map((entry) => entry.at);
    const earlierStarts = launchStarts.filter((entry) => entry.tankIndex < tankIndex).map((entry) => entry.at);
    if (ownStarts.length > 0) {
      view.window = {
        fromSeconds: earlierStarts.length > 0 ? Math.max(...earlierStarts) : 0,
        toSeconds: Math.min(...ownStarts),
      };
    }
    return view;
  });

  // The first fill happens first, so the plan's shifts are priced after it.
  let firstFillCostSoulEggs: number | null = null;
  let planCostSoulEggs: number | null = null;
  let perShiftCostSoulEggs: number[] = [];
  if (snapshot) {
    const planStartCount = snapshot.shiftCount + firstFillShifts;
    firstFillCostSoulEggs = virtueShiftsCostSoulEggs(snapshot.soulEggs, snapshot.shiftCount, firstFillShifts);
    planCostSoulEggs = virtueShiftsCostSoulEggs(snapshot.soulEggs, planStartCount, pack.totalShifts);
    perShiftCostSoulEggs = Array.from({ length: pack.totalShifts }, (_, index) =>
      virtueShiftCostSoulEggs(snapshot.soulEggs, planStartCount + index)
    );
  }

  return {
    result,
    pack,
    capacity,
    tanks,
    units,
    firstFillShifts,
    firstFillCostSoulEggs,
    planCostSoulEggs,
    perShiftCostSoulEggs,
  };
}

const VIRTUE_WARN_ICON = (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path d="M10 2.8 18 16.6H2Z" />
    <path d="M10 8v4" />
    <path d="M10 14.4v.1" />
  </svg>
);

const VIRTUE_INFO_ICON = (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <circle cx="10" cy="10" r="7.5" />
    <path d="M10 9v5" />
    <path d="M10 6.2v.1" />
  </svg>
);

const VIRTUE_REFUEL_ICON = (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M3 6.5a5 5 0 0 1 8.6-2.2L13 5.8" />
    <path d="M13 2.5v3.3H9.7" />
    <path d="M13 9.5a5 5 0 0 1-8.6 2.2L3 10.2" />
    <path d="M3 13.5v-3.3h3.3" />
  </svg>
);

function VirtueNotice({ tone, children }: { tone: "warn" | "info"; children: ReactNode }) {
  return (
    <p className={styles.virtueNotice} data-tone={tone}>
      {tone === "warn" ? VIRTUE_WARN_ICON : VIRTUE_INFO_ICON}
      <span>{children}</span>
    </p>
  );
}

function VirtueEggIcon({ egg, size }: { egg: VirtueTankEggKey; size: number }) {
  return <img className={styles.eggIcon} src={VIRTUE_EGG_DISPLAY[egg].imageSrc} alt="" width={size} height={size} />;
}

/** A shift route as egg chips: letters by default, icons only on the overview connectors ("xs"). */
function VirtueRouteChips({ eggs, size }: { eggs: VirtueTankEggKey[]; size?: "sm" | "xs" }) {
  return (
    <ol
      className={styles.routeChips}
      data-size={size}
      aria-label={`Route: ${eggs.map((egg) => VIRTUE_EGG_DISPLAY[egg].label).join(", then ")}`}
    >
      {eggs.map((egg, index) => (
        <Fragment key={`${egg}:${index}`}>
          {index > 0 && size !== "xs" && (
            <li className={styles.routeArrow} aria-hidden="true">→</li>
          )}
          <li className={styles.routeChip} style={virtueEggStyle(egg)} title={VIRTUE_EGG_DISPLAY[egg].label}>
            <VirtueEggIcon egg={egg} size={size ? 12 : 14} />
            {size === "xs" ? null : VIRTUE_EGG_DISPLAY[egg].short}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

/** Card A's readout of what is in the tank now, Humility included (hatched, never planned). */
function VirtueTankReadout({ tank }: { tank: VirtueTankSnapshot }) {
  const capacity = tank.capacity;
  const physical = VIRTUE_TANK_READOUT_ORDER.reduce((sum, egg) => sum + Math.max(0, tank.fuels[egg] || 0), 0);
  return (
    <div className={styles.tankReadout}>
      <div className={styles.tankReadoutHead}>
        <span className={styles.fieldLabel}>In your tank now</span>
        <span className={styles.tankReadoutTotal}>
          {formatTankFuel(physical)} <span>of {formatTankFuel(capacity)}</span>
        </span>
      </div>
      <div
        className={styles.tankReadoutBar}
        role="img"
        aria-label={`Tank holds ${formatTankFuel(physical)} of ${formatTankFuel(capacity)}`}
      >
        {VIRTUE_TANK_READOUT_ORDER.filter((egg) => tank.fuels[egg] > VIRTUE_FUEL_NOISE).map((egg) => (
          <span
            key={egg}
            className={styles.tankReadoutSeg}
            data-egg={egg}
            style={virtueEggStyle(egg, { width: `${virtueTankPct(tank.fuels[egg], capacity)}%` })}
            title={`${VIRTUE_EGG_DISPLAY[egg].label} ${formatTankFuel(tank.fuels[egg])}`}
          />
        ))}
      </div>
      <ul className={styles.tankEggList}>
        {VIRTUE_TANK_READOUT_ORDER.map((egg) => {
          const amount = tank.fuels[egg] || 0;
          const empty = amount <= VIRTUE_FUEL_NOISE;
          return (
            <li
              key={egg}
              className={styles.tankEggItem}
              data-egg={egg}
              data-empty={empty ? "1" : "0"}
              style={virtueEggStyle(egg)}
              title={egg === "humility" ? "Not planned: ships fuel it straight from the Humility farm" : undefined}
            >
              <VirtueEggIcon egg={egg} size={22} />
              <span className={styles.tankEggName}>{VIRTUE_EGG_DISPLAY[egg].label}</span>
              <span className={styles.tankEggAmount}>{empty ? "Empty" : formatTankFuel(amount)}</span>
            </li>
          );
        })}
      </ul>
      <p className={styles.tankFootnote}>
        <VirtueEggIcon egg="humility" size={14} />
        <span>
          <strong>Humility isn&apos;t planned:</strong> ships fuel it straight from the Humility farm. Drain any
          Humility in the tank and set its limit to 0.
        </span>
      </p>
    </div>
  );
}

function VirtueDrainItem({ drain, capacity }: { drain: VirtueTankDrain; capacity: number }) {
  if (drain.egg === "all") {
    return (
      <li className={styles.refuelDrain} style={virtueEggStyle("humility")}>
        <VirtueEggIcon egg="humility" size={18} />
        <span>
          No tank data, so these fills start from empty: drain <b>every egg</b>, Humility too, and set the Humility
          limit to <b>0</b>
        </span>
      </li>
    );
  }
  let text: ReactNode;
  if (drain.egg === "humility") {
    // The limit as the slider shows it: an amount ("250T"), never a percent.
    const limitWas = drain.limitWasPct != null ? formatVirtueTankLimit(drain.limitWasPct, capacity) : null;
    const limit =
      drain.limitWasPct === 0 ? (
        <>
          {" "}
          and keep its limit at <b>0</b>
        </>
      ) : (
        <>
          {" "}
          and set its limit to <b>0</b>
          {limitWas != null && <small> (now {limitWas})</small>}
        </>
      );
    if (drain.amount == null) {
      text = (
        <>
          Drain any <b>Humility</b> in the tank{limit}
        </>
      );
    } else if (drain.amount > 0) {
      text = (
        <>
          Drain <b>Humility {formatTankFuel(drain.amount, capacity)}</b>
          {limit}
        </>
      );
    } else if (limitWas != null) {
      text = (
        <>
          Set the <b>Humility</b> limit to <b>0</b> <small>(now {limitWas})</small>
        </>
      );
    } else {
      text = (
        <>
          Drain <b>Humility</b>
          {limit}
        </>
      );
    }
  } else if (drain.to <= VIRTUE_FUEL_NOISE) {
    text = (
      <>
        Drain all <b>{VIRTUE_EGG_DISPLAY[drain.egg].label}</b> <small>{formatTankFuel(drain.amount, capacity)}</small>
      </>
    );
  } else {
    text = (
      <>
        Drain <b>{VIRTUE_EGG_DISPLAY[drain.egg].label}</b> to <b>{formatTankFuel(drain.to, capacity)}</b>{" "}
        <small>−{formatTankFuel(drain.amount, capacity)}</small>
      </>
    );
  }
  return (
    <li className={styles.refuelDrain} style={virtueEggStyle(drain.egg)}>
      <VirtueEggIcon egg={drain.egg} size={18} />
      <span>{text}</span>
    </li>
  );
}

/** The free drains before a fill or a first launch. */
function VirtueDrainList({ drains, label, capacity }: { drains: VirtueTankDrain[]; label: string; capacity: number }) {
  return (
    <div className={styles.refuelPrep}>
      <span className={styles.fieldLabel}>{label}</span>
      <ul className={styles.refuelDrains}>
        {drains.map((drain) => (
          <VirtueDrainItem key={drain.egg} drain={drain} capacity={capacity} />
        ))}
      </ul>
    </div>
  );
}

function VirtueRefuelStep({ fill, step, capacity }: { fill: VirtueTankFill; step: number; capacity: number }) {
  const rounded = fill.fillsTo - fill.needs > VIRTUE_FUEL_NOISE;
  // Sliders snap to 1% of the tank, so the same whole percent is the same amount.
  const was =
    fill.limitWasPct == null
      ? null
      : fill.limitWasPct === fill.limitPct
        ? "already set"
        : `now ${formatVirtueTankLimit(fill.limitWasPct, capacity)}`;
  return (
    <li className={styles.refuelStep} style={virtueEggStyle(fill.egg)}>
      <div className={styles.refuelStepEgg}>
        <span className={styles.refuelStepNum}>{step}</span>
        <VirtueEggIcon egg={fill.egg} size={20} />
        Shift to {VIRTUE_EGG_DISPLAY[fill.egg].label}
      </div>
      <div className={styles.refuelStepLimit}>
        <span className={styles.fieldLabel}>Set limit</span>
        <span className={styles.refuelBig}>{formatVirtueTankLimit(fill.limitPct, capacity)}</span>
        {was && <span className={styles.refuelStepWas}>{was}</span>}
      </div>
      <div className={styles.refuelStepFill}>
        <span>
          Fills to <b>{formatTankFuel(fill.fillsTo, capacity)}</b>
          {fill.stopsAtFull ? " (tank full)" : ""}
        </span>{" "}
        <span>
          +{formatTankFuel(Math.max(0, fill.fillsTo - fill.from), capacity)} from{" "}
          {fill.from > virtueFuelTolerance(capacity) ? formatTankFuel(fill.from, capacity) : "empty"}
          {rounded ? ` · plan needs ${formatTankFuel(fill.needs, capacity)}` : ""}
        </span>
      </div>
    </li>
  );
}

/** Refuel instructions for one tank: the in-game reference while shifting. */
function VirtueRefuelStrip({
  view,
  tankView,
  planStartMs,
}: {
  view: VirtueTankPlanView;
  tankView: VirtueTankView;
  planStartMs: number;
}) {
  const { tank } = tankView;
  if (tankView.kind === "current") {
    // Nothing may launch from the tank as it is: the plan needs no missions, or
    // every launch waits for the first refuel loop.
    const refuelNext = view.tanks.length > 1;
    return (
      <>
        <p className={styles.refuelNote}>
          {tankView.launchCount > 0 ? (
            <>
              <b>No refuel.</b> Launch these from what&apos;s in your tank now, starting on Humility.
            </>
          ) : refuelNext ? (
            <>
              <b>Nothing launches from this tank.</b> Start with refuel loop 1.
            </>
          ) : (
            <>
              <b>Nothing to launch.</b> This plan needs no missions.
            </>
          )}
        </p>
        {tankView.drains.length > 0 && (
          <VirtueDrainList
            drains={tankView.drains}
            label={tankView.launchCount > 0 || refuelNext ? "Before you launch · free" : "Anytime · free"}
            capacity={view.capacity}
          />
        )}
      </>
    );
  }
  const homeStep = tankView.fills.length + 1;
  let head: ReactNode;
  if (tankView.kind === "ideal") {
    const cost = view.firstFillCostSoulEggs;
    head = (
      <div className={styles.refuelHead}>
        <span className={styles.refuelTitle}>Fill before you start</span>
        {tankView.route.length > 0 && <VirtueRouteChips eggs={[...tankView.route, "humility"]} size="sm" />}
        <span className={styles.shiftPill}>
          {tankView.shifts > 0 ? pluralize(tankView.shifts, "shift") : "No shifts"}
          {tankView.shifts > 0 && cost != null ? ` ≈ ${formatSoulEggs(cost)} SE` : ""}
        </span>
        <span className={styles.refuelHeadNote}>not counted toward the cap</span>
      </div>
    );
  } else {
    const refuelWindow = tankView.window;
    const windowSeconds = refuelWindow ? Math.max(0, refuelWindow.toSeconds - refuelWindow.fromSeconds) : 0;
    const tight = refuelWindow != null && windowSeconds < VIRTUE_TIGHT_REFUEL_WINDOW_SECONDS;
    head = (
      <div className={styles.refuelHead}>
        <span className={styles.refuelTitle}>Refuel loop {tank.index}</span>
        {tank.refill && <VirtueRouteChips eggs={tank.refill.route} />}
        <span className={styles.shiftPill}>{pluralize(tankView.shifts, "shift")}</span>
        {refuelWindow && (
          <span
            className={`${styles.refuelWindow} ${styles.tooltipValue}`}
            data-tight={tight ? "1" : "0"}
            title="After the last launch from the tank before and before the first launch from this one, while every slot is busy."
          >
            {tight ? (
              "No slack: refuel right after the last launch; the next launch waits for it"
            ) : (
              <>
                Refuel between <b>{formatClockTime(new Date(planStartMs + refuelWindow.fromSeconds * 1000), planStartMs)}</b>{" "}
                and <b>{formatClockTime(new Date(planStartMs + refuelWindow.toSeconds * 1000), planStartMs)}</b> ·{" "}
                {formatDurationFromHours(windowSeconds / 3600)}
              </>
            )}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className={styles.refuelStrip}>
      {head}
      {tankView.drains.length > 0 && (
        <VirtueDrainList drains={tankView.drains} label="Before you shift · free" capacity={view.capacity} />
      )}
      <ol className={styles.refuelSteps}>
        {tankView.fills.map((fill, index) => (
          <VirtueRefuelStep key={fill.egg} fill={fill} step={index + 1} capacity={view.capacity} />
        ))}
        <li className={`${styles.refuelStep} ${styles.refuelStepHome}`} style={virtueEggStyle("humility")}>
          <div className={styles.refuelStepEgg}>
            <span className={styles.refuelStepNum}>{homeStep}</span>
            <VirtueEggIcon egg="humility" size={20} />
            {homeStep === 1 ? "Start on Humility" : "Back to Humility"}
          </div>
          <p>
            {tankView.kind === "ideal" ? "Launch the Initial Tank missions from there." : `Then launch ${tank.label}.`}
          </p>
        </li>
      </ol>
      {tankView.kept.length > 0 && (
        <p className={styles.refuelNote}>
          {tankView.kept.map((egg, index) => (
            <Fragment key={egg}>
              {index > 0 && ", "}
              <b>
                {VIRTUE_EGG_DISPLAY[egg].label} {formatTankFuel(virtueFuelAmount(tank.startContents, egg), view.capacity)}
              </b>
            </Fragment>
          ))}
          {tankView.kind === "ideal" ? " already in the tank." : " carried over, no refill."}
        </p>
      )}
    </div>
  );
}

/** One egg's row in a tank chart, drawn against the full tank: burned by mission, carried over, limit tick. */
function VirtueTankChartRow({
  view,
  tankView,
  egg,
}: {
  view: VirtueTankPlanView;
  tankView: VirtueTankView;
  egg: VirtueFuelKey;
}) {
  const { tank } = tankView;
  const { capacity } = view;
  const start = virtueFuelAmount(tank.startContents, egg);
  const used = virtueFuelAmount(tank.used, egg);
  const left = virtueFuelAmount(tank.leftover, egg);
  const eggLabel = VIRTUE_EGG_DISPLAY[egg].label;
  const fill = tankView.fills.find((row) => row.egg === egg) || null;
  const segments = groupTankLaunches(view, tank)
    .map((group) => ({
      ...group,
      quantity: group.unitView ? virtueFuelAmount(group.unitView.fuelPerLaunch, egg) * group.launches : 0,
    }))
    .filter((segment) => segment.unitView && segment.quantity > 0);
  const label = [
    `${eggLabel}: ${formatTankFuel(start, capacity)} in tank, ${formatTankFuel(used)} used`,
    left > VIRTUE_FUEL_NOISE ? `, ${formatTankFuel(left, capacity)} left` : "",
    fill ? `, limit ${formatVirtueTankLimit(fill.limitPct, capacity)}` : "",
  ].join("");
  const sub = start <= VIRTUE_FUEL_NOISE ? "" : left > VIRTUE_FUEL_NOISE ? `${formatTankFuel(left, capacity)} left` : "all used";
  return (
    <div className={styles.tankRow}>
      <div className={styles.fuelLabel}>
        <VirtueEggIcon egg={egg} size={22} />
        <span>{eggLabel}</span>
      </div>
      <div className={styles.tankTrack} role="img" aria-label={label}>
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={`${styles.fuelSegment} ${styles.tankSegment}`}
            style={
              {
                width: `${virtueTankPct(segment.quantity, capacity)}%`,
                "--fuel-segment-color": segment.unitView?.color,
              } as CSSProperties
            }
            title={[
              `${segment.unitView?.label} ×${segment.launches.toLocaleString()}`,
              segment.unitView?.subtitle,
              `${formatTankFuel(segment.quantity)} ${eggLabel}`,
            ].join("\n")}
          >
            <span className={styles.fuelSegmentLabel}>{formatTankFuel(segment.quantity)}</span>
          </div>
        ))}
        {left > VIRTUE_FUEL_NOISE && (
          <div
            className={styles.tankCarry}
            style={virtueEggStyle(egg, { width: `${virtueTankPct(left, capacity)}%` })}
            title={`${formatTankFuel(left)} ${eggLabel} left in the tank`}
          >
            <span className={styles.fuelSegmentLabel}>{formatTankFuel(left)}</span>
          </div>
        )}
        {start <= VIRTUE_FUEL_NOISE && <div className={styles.tankEmpty}>empty</div>}
        {fill && (
          <span
            className={styles.tankLimitTick}
            style={{ left: `${fill.limitPct}%` }}
            title={`Set limit ${formatVirtueTankLimit(fill.limitPct, capacity)}`}
          />
        )}
      </div>
      <div className={styles.tankRowTotal}>
        {formatTankFuel(start, capacity)}
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}

function VirtueTankGauge({ view, tankView }: { view: VirtueTankPlanView; tankView: VirtueTankView }) {
  const { tank } = tankView;
  const { capacity } = view;
  const total = virtueFuelTotal(tank.startContents);
  const eggs = VIRTUE_REFILL_ROUTE_ORDER.filter((egg) => virtueFuelAmount(tank.startContents, egg) > VIRTUE_FUEL_NOISE);
  const humility = tankView.humility;
  const label = [
    `${tank.label}: ${formatTankFuel(total)} of ${formatTankFuel(capacity)}. `,
    VIRTUE_REFILL_ROUTE_ORDER.map(
      (egg) => `${VIRTUE_EGG_DISPLAY[egg].label} ${formatTankFuel(virtueFuelAmount(tank.startContents, egg), capacity)}`
    ).join(", "),
    humility > 0 ? `, plus Humility ${formatTankFuel(humility)}` : "",
  ].join("");
  const sub =
    humility > 0
      ? `+${formatTankFuel(humility)} Humility`
      : tankView.kind === "ideal"
        ? "ideal fill"
        : pluralize(tankView.launchCount, "launch", "launches");
  return (
    <a className={styles.tankGaugeItem} href={`#tank-${tank.index}`}>
      <span className={styles.tankGauge} role="img" aria-label={label}>
        {eggs.map((egg) => (
          <span
            key={egg}
            className={styles.tankGaugeLayer}
            style={virtueEggStyle(egg, { height: `${virtueTankPct(virtueFuelAmount(tank.startContents, egg), capacity)}%` })}
            title={`${VIRTUE_EGG_DISPLAY[egg].label} ${formatTankFuel(virtueFuelAmount(tank.startContents, egg), capacity)}`}
          />
        ))}
        {humility > 0 && (
          <span
            className={styles.tankGaugeLayer}
            data-egg="humility"
            style={virtueEggStyle("humility", { height: `${virtueTankPct(humility, capacity)}%` })}
            title={`Humility ${formatTankFuel(humility)}: not planned, drain it`}
          />
        )}
      </span>
      <span className={styles.tankGaugeName}>{tank.label}</span>
      <span className={styles.tankGaugeTotal}>
        <b>{formatTankFuel(total)}</b>
      </span>
      <span className={styles.tankGaugeSub}>{sub}</span>
    </a>
  );
}

const VIRTUE_TOP_UP_TARGET_WORD: Record<number, string> = { 17: "gold", 18: "geode", 43: "titanium" };
const VIRTUE_TOP_UP_FAMILY_WORD: Array<[VirtueTopUpFamily, string]> = [
  ["goldMeteorite", "gold"],
  ["tauCetiGeode", "geode"],
  ["solarTitanium", "titanium"],
];

/**
 * Advisory under the last tank: raise limits on this loop's own eggs (no extra
 * shifts) to also send ingredient launches. Never part of the plan.
 */
function VirtueTopUpCard({ topUp, tank, capacity }: { topUp: VirtueLastTankTopUp; tank: VirtueTank; capacity: number }) {
  const planLimits = tank.refill?.limitPct ?? {};
  const raised = VIRTUE_REFILL_ROUTE_ORDER.filter(
    (egg) => topUp.limitPct[egg] != null && topUp.limitPct[egg] !== planLimits[egg]
  );
  const launches = topUp.launches.map((launch, index) => (
    <Fragment key={`${launch.ship}|${launch.durationType}|${launch.targetAfxId}`}>
      {index > 0 && (index === topUp.launches.length - 1 ? " and " : ", ")}
      <b>
        {launch.launches.toLocaleString()} {titleCaseShip(launch.ship)} {durationTypeLabel(launch.durationType)}
      </b>{" "}
      ({launch.targetAfxId == null ? "untargeted" : VIRTUE_TOP_UP_TARGET_WORD[launch.targetAfxId] ?? afxIdToTargetFamilyName(launch.targetAfxId)})
    </Fragment>
  ));
  const expected = VIRTUE_TOP_UP_FAMILY_WORD.filter(([family]) => topUp.expected[family] >= 0.5).map(
    ([family, word]) => `${Math.round(topUp.expected[family]).toLocaleString()} ${word}`
  );
  return (
    <div className={styles.topUpCard}>
      <span className={styles.topUpTag}>Optional · for your next goals</span>
      <p>
        {raised.length > 0 ? (
          <>
            Room left: set{" "}
            {raised.map((egg, index) => (
              <Fragment key={egg}>
                {index > 0 && ", "}
                <b>
                  {VIRTUE_EGG_DISPLAY[egg].label} {formatVirtueTankLimit(topUp.limitPct[egg]!, capacity)}
                </b>
              </Fragment>
            ))}{" "}
            to also send {launches}
          </>
        ) : (
          <>Room left: the limits above also cover {launches}</>
        )}
        {expected.length > 0 && <> → ≈ {expected.join(" · ")} (T1)</>}.
      </p>
      <p className={styles.topUpMeta}>
        About {formatDurationFromHours(topUp.slotSeconds / 3 / 3600)} more across your 3 slots. Not part of this plan.
      </p>
    </div>
  );
}

/** Panel E: what each tank holds, how to refuel into it, and what burns it. */
function VirtueFuelTanksPanel({ view, planStartMs }: { view: VirtueTankPlanView; planStartMs: number }) {
  const { pack, capacity, tanks } = view;
  const chartsOpen = tanks.length <= 3;
  // The last refuel loop's tank, when it leaves much of the tank empty, and the optional top-up for it.
  const lastRoom = virtueLastTankRoom(pack);
  const topUp =
    lastRoom && view.result.lastTankTopUp?.tankIndex === lastRoom.tank.index ? view.result.lastTankTopUp : null;
  const notes = Array.from(new Set([...view.result.notes, ...pack.notes])).filter(
    (note) =>
      !VIRTUE_TANK_NOTES_SHOWN_ELSEWHERE.some((prefix) => note.startsWith(prefix)) &&
      !pack.unplaced.some((entry) => note.includes(entry.reason))
  );
  return (
    <div className="panel">
      <div className={styles.tankPanelHead}>
        <h2 id="virtue-fuel-tanks-title">Fuel tanks</h2>
        <span className={styles.tankPanelSummary}>
          {pluralize(tanks.length, "tank")} · {pluralize(pack.totalShifts, "shift")} · {formatTankFuel(capacity)} tank
        </span>
      </div>
      {pack.unplaced.length > 0 && (
        <div className={styles.tankPanelNotices}>
          {pack.unplaced.map((entry) => {
            const unitView = view.units.get(entry.unitId);
            return (
              <VirtueNotice key={entry.unitId} tone="warn">
                <strong>{pluralize(entry.launches, "launch", "launches")} left out.</strong>{" "}
                {unitView?.label || "This mission"} {entry.reason}. Upgrade the tank or pick another ship.
              </VirtueNotice>
            );
          })}
        </div>
      )}
      <div className={styles.tankOverview}>
        {tanks.map((tankView) => (
          <Fragment key={tankView.tank.index}>
            {tankView.kind === "refill" && tankView.tank.refill && (
              <div className={styles.tankConnector}>
                <VirtueRouteChips eggs={tankView.tank.refill.route} size="xs" />
                <span className={styles.tankConnectorLine} aria-hidden="true" />
                <span className={styles.tankConnectorShifts}>{pluralize(tankView.shifts, "shift")}</span>
              </div>
            )}
            <VirtueTankGauge view={view} tankView={tankView} />
          </Fragment>
        ))}
      </div>
      <div className={styles.tankLegend}>
        {VIRTUE_REFILL_ROUTE_ORDER.map((egg) => (
          <span key={egg}>
            <i className={styles.legendSwatch} style={virtueEggStyle(egg)} />
            {VIRTUE_EGG_DISPLAY[egg].label}
          </span>
        ))}
        <span>
          <i className={styles.legendSeg} />
          Burned, by mission
        </span>
        <span>
          <i className={styles.legendHatch} />
          Left in tank
        </span>
        <span>
          <i className={styles.legendTick} />
          Limit to set
        </span>
      </div>
      <div className={styles.tankBlocks}>
        {tanks.map((tankView) => {
          const { tank } = tankView;
          const kind =
            tankView.kind === "current"
              ? "current contents"
              : tankView.kind === "ideal"
                ? "ideal mix"
                : `after refuel loop ${tank.index}`;
          return (
            <article
              key={tank.index}
              className={styles.tankBlock}
              id={`tank-${tank.index}`}
              aria-labelledby={`tank-${tank.index}-title`}
            >
              <header className={styles.tankBlockHead}>
                <div className={styles.tankBlockTitle}>
                  <span className={styles.tankBadge} aria-hidden="true">
                    {tank.index + 1}
                  </span>
                  <h3 id={`tank-${tank.index}-title`}>{tank.label}</h3>
                  <span className={styles.tankBlockKind}>{kind}</span>
                </div>
                <div className={styles.tankBlockMeta}>
                  <b>{formatTankFuel(virtueFuelTotal(tank.startContents))}</b> of {formatTankFuel(capacity)} ·{" "}
                  {pluralize(tankView.launchCount, "launch", "launches")}
                </div>
              </header>
              <VirtueRefuelStrip view={view} tankView={tankView} planStartMs={planStartMs} />
              {lastRoom?.tank.index === tank.index && (
                <div className={styles.topUpArea}>
                  <VirtueNotice tone="info">{virtueLastTankRoomText(lastRoom)}</VirtueNotice>
                  {topUp && <VirtueTopUpCard topUp={topUp} tank={tank} capacity={capacity} />}
                </div>
              )}
              {tank.launches.length > 0 && (
                <ul className={styles.tankMissionChips} aria-label={`Missions launched from ${tank.label}`}>
                  {groupTankLaunches(view, tank).map((group) => (
                    <li
                      key={group.key}
                      className={styles.tankMissionChip}
                      style={{ "--fuel-segment-color": group.unitView?.color } as CSSProperties}
                    >
                      <i aria-hidden="true" />
                      <span>{group.unitView?.label || group.key}</span>
                      {/* One ship often farms several targets, so the chip names the target too. */}
                      <span className={styles.tankMissionChipTarget}>
                        <small>{group.missionIndex == null ? "prep" : group.unitView?.subtitle}</small>
                        <b>×{group.launches.toLocaleString()}</b>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <details className={styles.tankChartDetails} open={chartsOpen}>
                <summary>Fuel by mission</summary>
                <div className={styles.tankChart}>
                  <div className={styles.tankAxis} aria-hidden="true">
                    <span />
                    <div className={styles.tankAxisScale}>
                      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
                        <span
                          key={fraction}
                          style={{ left: `${fraction * 100}%` }}
                          data-quarter={fraction === 0.25 || fraction === 0.75 ? "1" : undefined}
                        >
                          {fraction === 0 ? "0" : formatTankFuel(capacity * fraction)}
                        </span>
                      ))}
                    </div>
                    <span className={styles.tankAxisNote}>in tank</span>
                  </div>
                  {VIRTUE_REFILL_ROUTE_ORDER.map((egg) => (
                    <VirtueTankChartRow key={egg} view={view} tankView={tankView} egg={egg} />
                  ))}
                </div>
              </details>
            </article>
          );
        })}
      </div>
      <div className={styles.tankPanelFoot}>
        <p className={styles.tankFootnote}>
          <VirtueEggIcon egg="humility" size={14} />
          <span>
            Humility isn&apos;t in these tanks: ships fuel it straight from the Humility farm. Keep its limit at 0 and
            drain any that&apos;s in the tank.
          </span>
        </p>
        {!pack.exact && (
          <p className={styles.tankFootnote}>
            <span>Tank split is the best found in the time allowed, not proven optimal.</span>
          </p>
        )}
        {notes.map((note) => (
          <p key={note} className={styles.tankFootnote}>
            <span>{note}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

/** Panel G in tank mode: the packer's schedule, each block badged with the tank it launches from. */
function VirtueTankTimeline({ view, plan }: { view: VirtueTankPlanView; plan: PlanResponse["plan"] }) {
  const { pack } = view;
  const totalSeconds = Math.max(1, pack.schedule.makespanSeconds);
  const at = (seconds: number) => Math.max(0, Math.min(100, (seconds / totalSeconds) * 100));
  const missionColorByKey = buildMissionColorMap(plan.missions);
  // In-air ships seed the lanes the way the packer does: longest wait on slot 1.
  const inAirLaunches = plan.missions
    .filter((mission) => mission.inAir)
    .flatMap((mission) =>
      (mission.launchSecondsRemaining || [mission.secondsRemaining || 0]).map((seconds) => ({
        mission,
        seconds: Math.max(0, Math.round(seconds)),
      }))
    )
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 3);
  const legendIds: string[] = [];
  for (const tank of pack.tanks) {
    for (const entry of tank.launches) {
      if (!legendIds.includes(entry.unitId)) {
        legendIds.push(entry.unitId);
      }
    }
  }

  return (
    <div className={styles.timelinePanel}>
      <p className={`muted ${styles.timelineIntro}`}>
        The number on each block is the tank it launches from.
      </p>
      <div className={styles.timelineStats}>
        <span>
          Model total: <strong>{formatDurationFromHours(plan.expectedHours)}</strong>
        </span>
        <span>
          Timeline makespan: <strong>{formatDurationFromHours(pack.schedule.makespanSeconds / 3600)}</strong>
        </span>
      </div>
      <div className={styles.timelineLanes}>
        {pack.schedule.lanes.map((lane, laneIndex) => {
          const seed = inAirLaunches[laneIndex];
          let cursor = 0;
          const items: ReactNode[] = [];
          if (seed && seed.seconds > 0) {
            const color =
              missionColorByKey.get(missionColorKey(seed.mission)) || prepTimelineColor(missionColorKey(seed.mission));
            items.push(
              <div
                key="in-air"
                className={styles.timelineBlock}
                data-phase="inAir"
                style={
                  {
                    left: "0%",
                    width: `${Math.max(at(seed.seconds), 0.7)}%`,
                    "--timeline-block-color": color,
                  } as CSSProperties
                }
                title={[
                  `${titleCaseShip(seed.mission.ship)} ${durationTypeWithLevelLabel(seed.mission.durationType, seed.mission.level)}`,
                  `In air · ${afxIdToTargetFamilyName(seed.mission.targetAfxId)}`,
                  "Already launched — this slot is busy until it lands",
                  `0m → ${formatDurationFromHours(seed.seconds / 3600)}`,
                ].join("\n")}
              >
                <span className={styles.timelineBlockLabel}>in air</span>
              </div>
            );
            cursor = seed.seconds;
          }
          lane.forEach((block, blockIndex) => {
            if (block.startSeconds - cursor > 60) {
              items.push(
                <div
                  key={`idle:${blockIndex}`}
                  className={styles.timelineIdle}
                  style={{ left: `${at(cursor)}%`, width: `${at(block.startSeconds) - at(cursor)}%` }}
                  title={`Slot idle ${formatDurationFromHours((block.startSeconds - cursor) / 3600)}`}
                />
              );
            }
            const unitView = view.units.get(block.unitId);
            items.push(
              <div
                key={`block:${blockIndex}`}
                className={styles.timelineBlock}
                data-phase={unitView && unitView.missionIndex == null ? "prep" : "mission"}
                style={
                  {
                    left: `${at(block.startSeconds)}%`,
                    width: `${Math.max(at(block.endSeconds) - at(block.startSeconds), 0.7)}%`,
                    "--timeline-block-color": unitView?.color,
                  } as CSSProperties
                }
                title={[
                  unitView?.label || block.unitId,
                  unitView?.subtitle || "",
                  `${pluralize(block.launches, "launch", "launches")} from ${pack.tanks[block.tankIndex]?.label || "a tank"}`,
                  `${formatDurationFromHours(block.startSeconds / 3600)} → ${formatDurationFromHours(block.endSeconds / 3600)}`,
                ].join("\n")}
              >
                <span className={styles.timelineBlockLabel}>
                  <span className={styles.timelineTankBadge}>{block.tankIndex + 1}</span>x{block.launches.toLocaleString()}
                </span>
              </div>
            );
            cursor = block.endSeconds;
          });
          return (
            <div key={`lane:${laneIndex}`} className={styles.timelineLaneRow}>
              <div className={styles.timelineLaneLabel}>Slot {laneIndex + 1}</div>
              <div className={styles.timelineTrack}>
                {items}
              </div>
            </div>
          );
        })}
      </div>
      <div className={styles.timelineLegend} data-tanks="1">
        {legendIds.map((unitId) => {
          const unitView = view.units.get(unitId);
          const where = pack.tanks.filter((tank) => tank.launches.some((entry) => entry.unitId === unitId));
          const launches = where.reduce(
            (sum, tank) =>
              sum + tank.launches.filter((entry) => entry.unitId === unitId).reduce((total, entry) => total + entry.launches, 0),
            0
          );
          const slotSeconds = launches * (unitView?.unit.durationSeconds || 0);
          return (
            <div key={unitId} className={styles.timelineLegendRow}>
              <span className={styles.timelineSwatch} style={{ background: unitView?.color }} aria-hidden="true" />
              <span>{unitView?.label || unitId}</span>
              <span className={styles.timelineLegendMuted}>{unitView?.subtitle}</span>
              <span className={styles.timelineLegendMeta}>
                {pluralize(launches, "launch", "launches")} · {formatDurationFromHours(slotSeconds / 3600)} slot-time ·{" "}
                {where.map((tank) => tank.label).join(", ")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A plan.missions row in the mission table; tank mode passes the launches that go in one tank. */
function renderMissionTableRow(
  mission: PlanMissionRow,
  missionIndex: number,
  targetOverride: string | null,
  options: { key: string; launches?: number; splitAcrossTanks?: boolean }
) {
  const targetLabel = targetOverride || afxIdToTargetFamilyName(mission.targetAfxId);
  const targetItemKey = targetOverride ? null : afxIdToItemKey(mission.targetAfxId);
  const targetIconUrl = targetItemKey ? itemKeyToIconUrl(targetItemKey) : null;
  const launches = options.launches ?? mission.launches;
  // A row split across tanks shows its share of the row's expected yields.
  const yieldScale = mission.launches > 0 && options.launches != null ? options.launches / mission.launches : 1;
  return (
    <tr key={options.key} className={mission.inAir ? styles.inAirRow : undefined}>
      <td>
        {mission.inAir && (
          <span className={styles.inAirBadge} title="Already launched — nothing to send">
            In air
          </span>
        )}
        {titleCaseShip(mission.ship)}<br />
        <span className="muted">{durationTypeWithLevelLabel(mission.durationType, mission.level)}</span>
      </td>
      <td>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {targetIconUrl && (
            <img
              src={targetIconUrl}
              alt={afxIdToDisplayName(mission.targetAfxId)}
              width={24}
              height={24}
              loading="lazy"
            />
          )}
          <div>
            <div>{targetLabel}</div>
          </div>
        </div>
      </td>
      <td>
        {mission.inAir ? (
          <span className="muted" title="Already sent — do not launch these again">
            {mission.launches.toLocaleString()} sent
          </span>
        ) : (
          <>
            {launches.toLocaleString()}
            {options.splitAcrossTanks && <span className={styles.splitNote}>split across tanks</span>}
          </>
        )}
      </td>
      <td>
        {mission.inAir
          ? formatInAirReturnLabel(mission.launchSecondsRemaining, mission.secondsRemaining)
          : formatDurationFromHours(mission.durationSeconds / 3600)}
      </td>
      <td>
        {mission.expectedYields.slice(0, 3).map((yieldRow) => {
          const iconUrl = itemIdToIconUrl(yieldRow.itemId);
          return (
            <div key={yieldRow.itemId} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {iconUrl && (
                <img
                  src={iconUrl}
                  alt={itemIdToLabel(yieldRow.itemId)}
                  width={18}
                  height={18}
                  loading="lazy"
                />
              )}
              <span>{itemIdToLabel(yieldRow.itemId)}: {(yieldRow.quantity * yieldScale).toFixed(2)}</span>
            </div>
          );
        })}
      </td>
    </tr>
  );
}

/** Tank-mode mission table body: in-air rows, then one tbody per tank with a refuel row between. */
function VirtueTankMissionRows({
  view,
  plan,
  targetOverrideByIndex,
}: {
  view: VirtueTankPlanView;
  plan: PlanResponse["plan"];
  targetOverrideByIndex: Map<number, string>;
}) {
  const tankRows = view.tanks.map((tankView) => groupTankLaunches(view, tankView.tank));
  const tanksByMissionIndex = new Map<number, number>();
  tankRows.forEach((rows) =>
    rows.forEach((row) => {
      if (row.missionIndex != null) {
        tanksByMissionIndex.set(row.missionIndex, (tanksByMissionIndex.get(row.missionIndex) || 0) + 1);
      }
    })
  );
  const inAirRows = Array.from(plan.missions.entries()).filter(([, mission]) => mission.inAir);
  const unpackedRows = Array.from(plan.missions.entries()).filter(
    ([missionIndex, mission]) => !mission.inAir && mission.launches > 0 && !tanksByMissionIndex.has(missionIndex)
  );

  return (
    <>
      {inAirRows.length > 0 && (
        <tbody>
          {inAirRows.map(([missionIndex, mission]) =>
            renderMissionTableRow(mission, missionIndex, null, {
              key: `${missionIndex}:${mission.ship}:${mission.durationType}:${mission.missionId}:${mission.targetAfxId}`,
            })
          )}
        </tbody>
      )}
      {view.tanks.map((tankView, tankIndex) => {
        const { tank } = tankView;
        const rows = tankRows[tankIndex];
        return (
          <tbody key={tank.index} data-tank={tank.index}>
            {tankView.kind === "refill" ? (
              <tr className={styles.tankMarkerRow}>
                <th colSpan={5} scope="rowgroup">
                  <div>
                    {VIRTUE_REFUEL_ICON}
                    <span>Shift &amp; refuel → {tank.label}</span>
                    {tank.refill && <VirtueRouteChips eggs={tank.refill.route} size="sm" />}
                    <span className={styles.shiftPill}>{pluralize(tankView.shifts, "shift")}</span>
                    <a href={`#tank-${tank.index}`}>Refuel steps</a>
                  </div>
                </th>
              </tr>
            ) : (
              <tr className={styles.missionTankGroupRow}>
                <th colSpan={5} scope="rowgroup">
                  <div>
                    <span className={styles.tankBadge} aria-hidden="true">
                      {tank.index + 1}
                    </span>
                    <span>{tank.label}</span>
                    <span className="muted">
                      {tankView.kind === "ideal" ? "ideal mix, filled before you start" : "current contents"} ·{" "}
                      {pluralize(tankView.launchCount, "launch", "launches")}
                    </span>
                  </div>
                </th>
              </tr>
            )}
            {rows.map((row) => {
              if (row.missionIndex != null) {
                const mission = plan.missions[row.missionIndex];
                return renderMissionTableRow(
                  mission,
                  row.missionIndex,
                  targetOverrideByIndex.get(row.missionIndex) || null,
                  {
                    key: `${tank.index}:${row.key}`,
                    launches: row.launches,
                    splitAcrossTanks: (tanksByMissionIndex.get(row.missionIndex) || 0) > 1,
                  }
                );
              }
              const unit = row.unitView?.unit;
              return (
                <tr key={`${tank.index}:${row.key}`}>
                  <td>
                    <span
                      className={styles.prepBadge}
                      title="Ship-leveling launch with no target drops; see the Horizon progression plan"
                    >
                      Prep
                    </span>
                    {unit ? titleCaseShip(unit.ship) : row.key}
                    <br />
                    <span className="muted">{unit ? durationTypeWithLevelLabel(unit.durationType, unit.level) : ""}</span>
                  </td>
                  <td>{row.unitView?.subtitle || "Ship prep"}</td>
                  <td>{row.launches.toLocaleString()}</td>
                  <td>{unit ? formatDurationFromHours(unit.durationSeconds / 3600) : "—"}</td>
                  <td>
                    <span className="muted">—</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        );
      })}
      {unpackedRows.length > 0 && (
        <tbody data-tank="none">
          <tr className={styles.missionTankGroupRow}>
            <th colSpan={5} scope="rowgroup">
              <div>
                <span>Not in a tank</span>
                <span className="muted">see Fuel tanks for why these can&apos;t launch from this tank</span>
              </div>
            </th>
          </tr>
          {unpackedRows.map(([missionIndex, mission]) =>
            renderMissionTableRow(mission, missionIndex, targetOverrideByIndex.get(missionIndex) || null, {
              key: `none:${missionIndex}`,
            })
          )}
        </tbody>
      )}
    </>
  );
}

/** "returns in 14h", or "returns in 9h – 14h" when a grouped row lands staggered. */
function formatInAirReturnLabel(launchSecondsRemaining?: number[], secondsRemaining?: number): string {
  const waits = (launchSecondsRemaining || []).filter((seconds) => Number.isFinite(seconds));
  const longest = waits.length > 0 ? Math.max(...waits) : secondsRemaining || 0;
  const shortest = waits.length > 0 ? Math.min(...waits) : longest;
  const longestLabel = formatDurationFromHours(longest / 3600);
  if (shortest === longest) {
    return `returns in ${longestLabel}`;
  }
  return `returns in ${formatDurationFromHours(shortest / 3600)} – ${longestLabel}`;
}

/** Calendar stamp for a projected finish, e.g. "Thu Aug 20, 4:12 PM". */
function formatPlanCompletion(at: Date): string {
  const day = at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
}

function formatDurationFromHours(hours: number): string {
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hrs = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;
  const parts: string[] = [];
  if (days) {
    parts.push(`${days}d`);
  }
  if (hrs) {
    parts.push(`${hrs}h`);
  }
  if (mins) {
    parts.push(`${mins}m`);
  }
  return parts.length > 0 ? parts.join(" ") : "0m";
}

function formatDurationFromMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hrs = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;
  const parts: string[] = [];
  if (days) {
    parts.push(`${days}d`);
  }
  if (hrs) {
    parts.push(`${hrs}h`);
  }
  if (mins) {
    parts.push(`${mins}m`);
  }
  return parts.length > 0 ? parts.join(" ") : "0m";
}

function detailsText(details: unknown): string {
  if (typeof details === "string") {
    return details;
  }
  if (Array.isArray(details)) {
    return details
      .filter((entry) => typeof entry === "string")
      .join("; ");
  }
  return "";
}

function prepReasonLevel(reason: string): number | null {
  const match = reason.match(/\blevel\s+(\d+)\b/i);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed);
}

function prepReasonLabel(reason: string): string {
  const level = prepReasonLevel(reason);
  if (level != null) {
    return `Level ${level.toLocaleString()}`;
  }
  const unlockMatch = reason.match(/^Unlock\s+([A-Z_]+)\s+/);
  if (unlockMatch) {
    return `Unlock ${titleCaseShip(unlockMatch[1])}`;
  }
  return reason;
}

function titleCaseShip(ship: string): string {
  const overrides: Record<string, string> = {
    ATREGGIES: "Henliner",
    CHICKFIANT: "Defihent",
    CORELLIHEN_CORVETTE: "Cornish-Hen Corvette",
    MILLENIUM_CHICKEN: "Quintillion Chicken",
    BCR: "BCR",
  };
  const override = overrides[ship];
  if (override) {
    return override;
  }
  return ship
    .toLowerCase()
    .split("_")
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function compactShipName(ship: string): string {
  const overrides: Record<string, string> = {
    ATREGGIES: "Henliner",
    HENERPRISE: "Henerprise",
    VOYEGGER: "Voyegger",
    CHICKFIANT: "Defihent",
    GALEGGTICA: "Galeggtica",
    CORELLIHEN_CORVETTE: "CHC",
    MILLENIUM_CHICKEN: "Quintillion",
    BCR: "BCR",
    CHICKEN_HEAVY: "Heavy",
    CHICKEN_NINE: "Chicken 9",
    CHICKEN_ONE: "Chicken 1",
  };
  return overrides[ship] || titleCaseShip(ship);
}

function durationChipLabel(durationType: "SHORT" | "LONG" | "EPIC"): string {
  switch (durationType) {
    case "SHORT":
      return "S";
    case "LONG":
      return "M";
    case "EPIC":
      return "L";
  }
}

// Item IDs go through the canonical key: a few display IDs differ from their
// artifact key ("gusset-2" is ornate_gusset_2, "vial-of-martian-dust-2" is
// vial_martian_dust_2), and recipes, craft counts and ARTIFACT_DISPLAY all use the key.
function itemIdToLabel(itemId: string): string {
  const itemKey = itemIdToCanonicalKey(itemId);
  const displayInfo = ARTIFACT_DISPLAY[itemKey];
  if (displayInfo && Number.isFinite(displayInfo.tierNumber)) {
    return `${displayInfo.name} (T${displayInfo.tierNumber})`;
  }
  return itemKeyToDisplayName(itemKey);
}

function itemIdToIconUrl(itemId: string): string | null {
  return itemKeyToIconUrl(itemIdToCanonicalKey(itemId));
}

function normalizeShipDurations(value: unknown): ShipDurationSelection | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const parsed = value as ShipDurationSelection;
  const merged = buildDefaultShipDurations();
  for (const entry of SHIP_DISPLAY_CONFIG) {
    const saved = parsed[entry.ship];
    if (saved && typeof saved === "object") {
      merged[entry.ship] = {
        SHORT: typeof saved.SHORT === "boolean" ? saved.SHORT : true,
        LONG: typeof saved.LONG === "boolean" ? saved.LONG : true,
        EPIC: typeof saved.EPIC === "boolean" ? saved.EPIC : true,
      };
    }
  }
  return merged;
}

function normalizeConsumptionSelection(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      continue;
    }
    const canonicalKey = itemIdToCanonicalKey(raw);
    if (!ARTIFACT_CONSUMPTION[canonicalKey]) {
      continue;
    }
    const itemId = ARTIFACT_DISPLAY[canonicalKey]?.id || itemKeyToId(canonicalKey);
    if (!DEFAULT_CONSUMPTION_ITEM_ID_SET.has(itemId) || seen.has(itemId)) {
      continue;
    }
    seen.add(itemId);
    selected.push(itemId);
  }
  const selectedSet = new Set(selected);
  const nonMismatchDefaults = DEFAULT_CONSUMPTION_ITEM_IDS.filter(
    (itemId) => !DISPLAY_ID_MISMATCH_CONSUMPTION_IDS.includes(itemId)
  );
  const looksLikeAllSelectedBeforeDisplayIdRepair =
    selected.length === nonMismatchDefaults.length &&
    nonMismatchDefaults.every((itemId) => selectedSet.has(itemId));
  if (looksLikeAllSelectedBeforeDisplayIdRepair) {
    return DEFAULT_CONSUMPTION_ITEM_IDS;
  }
  return selected;
}

function readPlannerSourcePreferenceStore(): PlannerSourcePreferenceStore {
  const raw = readFirstStoredString([LOCAL_PREF_KEYS.plannerSourcePreferences]);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as Record<string, PlannerSourcePreferences>;
    return {
      main: record.main && typeof record.main === "object" ? record.main : undefined,
      virtue: record.virtue && typeof record.virtue === "object" ? record.virtue : undefined,
    };
  } catch {
    return {};
  }
}

function writePlannerSourcePreferences(source: InventorySource, preferences: PlannerSourcePreferences): void {
  const store = readPlannerSourcePreferenceStore();
  store[source] = preferences;
  writeStoredString([LOCAL_PREF_KEYS.plannerSourcePreferences], JSON.stringify(store));
}

function profileUrl(eid: string, filters: PlannerSourceFilters): string {
  const params = new URLSearchParams({
    eid,
    inventorySource: filters.inventorySource,
    includeSlotted: filters.includeSlotted ? "1" : "0",
    includeInventoryRare: filters.includeInventoryRare ? "1" : "0",
    includeInventoryEpic: filters.includeInventoryEpic ? "1" : "0",
    includeInventoryLegendary: filters.includeInventoryLegendary ? "1" : "0",
    includeInventoryFragments: filters.includeInventoryFragments ? "1" : "0",
  });
  return `/api/profile?${params.toString()}`;
}

async function fetchProfileSnapshot(eid: string, filters: PlannerSourceFilters): Promise<ProfileSnapshot> {
  const response = await fetch(profileUrl(eid, filters));
  const payload = (await response.json()) as ProfileApiResponse;
  if (!response.ok) {
    const detailText =
      typeof payload.details === "string"
        ? payload.details
        : Array.isArray(payload.details)
          ? payload.details.join("; ")
          : "";
    throw new Error(detailText || payload.error || "profile refresh failed");
  }
  return payload;
}

function buildReplanDeltas(previous: ProfileSnapshot, current: ProfileSnapshot): {
  observedReturns: Array<{ itemId: string; quantity: number }>;
  missionLaunches: Array<{ ship: string; durationType: DurationType; launches: number }>;
} {
  const observedReturns: Array<{ itemId: string; quantity: number }> = [];
  const inventoryKeys = new Set([...Object.keys(previous.inventory), ...Object.keys(current.inventory)]);
  for (const itemKey of inventoryKeys) {
    const delta = (current.inventory[itemKey] || 0) - (previous.inventory[itemKey] || 0);
    if (delta > 1e-9) {
      observedReturns.push({
        itemId: itemKeyToId(itemKey),
        quantity: delta,
      });
    }
  }

  const previousShipMap = new Map(previous.shipLevels.map((ship) => [ship.ship, ship]));
  const missionLaunches: Array<{ ship: string; durationType: DurationType; launches: number }> = [];
  for (const ship of current.shipLevels) {
    const previousShip = previousShipMap.get(ship.ship);
    for (const durationType of DURATION_TYPES) {
      const currentCount = ship.launchesByDuration?.[durationType] || 0;
      const previousCount = previousShip?.launchesByDuration?.[durationType] || 0;
      const delta = Math.max(0, Math.round(currentCount - previousCount));
      if (delta > 0) {
        missionLaunches.push({
          ship: ship.ship,
          durationType,
          launches: delta,
        });
      }
    }
  }

  return { observedReturns, missionLaunches };
}

function buildDemoProfileSnapshot(response: PlanResponse): ProfileSnapshot {
  return {
    eid: "DEMO",
    inventory: {},
    craftCounts: {},
    craftingXp: 0,
    epicResearchFTLLevel: response.profile.epicResearchFTLLevel,
    epicResearchZerogLevel: response.profile.epicResearchZerogLevel,
    shipLevels: [],
    missionOptions: [],
  };
}

function ShipSelectorImage({ ship, imageFiles }: { ship: string; imageFiles: string[] }) {
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [fallback, setFallback] = useState(false);

  const candidates = useMemo(() => {
    const urls: string[] = [];
    for (const file of imageFiles) {
      urls.push(shipImageUrl(file, SHIP_IMAGE_HOST));
    }
    for (const file of imageFiles) {
      urls.push(shipImageUrl(file, SHIP_IMAGE_HOST_FALLBACK));
    }
    return urls;
  }, [imageFiles]);

  useEffect(() => {
    setCandidateIndex(0);
    setFallback(false);
  }, [ship]);

  if (fallback || candidateIndex >= candidates.length) {
    const initials = ship
      .split("_")
      .map((w) => w.charAt(0))
      .join("")
      .slice(0, 2);
    return <span className={styles.shipSelectorImageFallback}>{initials}</span>;
  }

  return (
    <img
      className={styles.shipSelectorImage}
      src={candidates[candidateIndex]}
      alt={titleCaseShip(ship)}
      loading="lazy"
      onError={() => {
        const next = candidateIndex + 1;
        if (next < candidates.length) {
          setCandidateIndex(next);
        } else {
          setFallback(true);
        }
      }}
    />
  );
}

export default function MissionCraftPlannerPage() {
  const [eid, setEid] = useState("");
  const [targetItemId, setTargetItemId] = useState("soul-stone-2");
  const [targetRows, setTargetRows] = useState<PlannerTargetRow[]>([
    { id: "target-1", itemId: "soul-stone-2", quantityInput: "1", craftGoal: false },
  ]);
  const [quantity, setQuantity] = useState(1);
  const [quantityInput, setQuantityInput] = useState("1");
  const [targetCraftedOnly, setTargetCraftedOnly] = useState(false);
  const [priorityTimePct, setPriorityTimePct] = useState(50);
  const [virtueShiftCap, setVirtueShiftCap] = useState(DEFAULT_VIRTUE_SHIFT_CAP);
  /** Set with a new shift cap to build as soon as the cap is in state (the banner's "Plan with S shifts"). */
  const [buildQueued, setBuildQueued] = useState(false);
  /** The shift cap the last "Plan with S shifts" built at, until the next build: the status region says so. */
  const [fasterOptionPlanned, setFasterOptionPlanned] = useState<number | null>(null);
  const [virtueStartTank, setVirtueStartTank] = useState<VirtueTankStartMode>("current");
  // The virtue tank card shows the tank before any plan is built, so it keeps
  // its own copy of the latest fetched tank for the EID in the field.
  const [virtueTankPreview, setVirtueTankPreview] = useState<VirtueTankPreview | null>(null);
  const [inventorySource, setInventorySource] = useState<InventorySource>("main");
  const [includeSlotted, setIncludeSlotted] = useState(false);
  const [includeInventoryRare, setIncludeInventoryRare] = useState(false);
  const [includeInventoryEpic, setIncludeInventoryEpic] = useState(false);
  const [includeInventoryLegendary, setIncludeInventoryLegendary] = useState(false);
  const [includeInventoryFragments, setIncludeInventoryFragments] = useState(true);
  const [includeDropRare, setIncludeDropRare] = useState(false);
  const [includeDropEpic, setIncludeDropEpic] = useState(false);
  const [includeDropLegendary, setIncludeDropLegendary] = useState(false);
  const [includeDropFragments, setIncludeDropFragments] = useState(true);
  const [fastMode, setFastMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<string | null>(null);
  const [plannerProgress, setPlannerProgress] = useState<PlannerProgressState | null>(null);
  const [planningStartedAtMs, setPlanningStartedAtMs] = useState<number | null>(null);
  const [response, setResponse] = useState<PlanResponse | null>(null);
  // When the plan's clock starts. A restored plan keeps its original stamp so
  // the projected completion does not silently slide forward with the page.
  const [planReceivedAtMs, setPlanReceivedAtMs] = useState<number | null>(null);
  const [profileSnapshot, setProfileSnapshot] = useState<ProfileSnapshot | null>(null);
  const [demoNoticeDismissed, setDemoNoticeDismissed] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareSelected, setCompareSelected] = useState<Set<string>>(new Set());
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareResults, setCompareResults] = useState<MonolithicPathResult[] | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareExpandedRow, setCompareExpandedRow] = useState<number | null>(null);
  const [lastSolveRequest, setLastSolveRequest] = useState<LastSolveInputs | null>(null);
  const [shipDurations, setShipDurations] = useState<ShipDurationSelection>(buildDefaultShipDurations);
  const [shipSelectorOpen, setShipSelectorOpen] = useState(false);
  const [consumptionDrawerOpen, setConsumptionDrawerOpen] = useState(false);
  const [selectedConsumptionItemIds, setSelectedConsumptionItemIds] = useState<string[]>(DEFAULT_CONSUMPTION_ITEM_IDS);
  const [lootData, setLootData] = useState<LootJson | null>(null);
  const lootDataRef = useRef<LootJson | null>(null);
  const skipNextScopedPreferenceSaveRef = useRef(false);
  const highs = useHighsWorker();
  const highsRef = useRef(highs);
  highsRef.current = highs;
  const responseRef = useRef<PlanResponse | null>(null);
  responseRef.current = response;
  const shiftCapSliderRef = useRef<HTMLInputElement | null>(null);
  const trimmedEid = eid.trim();
  const isDemoMode = trimmedEid.length === 0;
  const showDemoNotice = isDemoMode && !demoNoticeDismissed;
  const sourceFilters: PlannerSourceFilters = {
    inventorySource,
    includeSlotted,
    includeInventoryRare,
    includeInventoryEpic,
    includeInventoryLegendary,
    includeInventoryFragments,
    includeDropRare,
    includeDropEpic,
    includeDropLegendary,
    includeDropFragments,
  };
  // Virtue mode plans for time under the shift cap, so the Balance slider only drives main-farm plans.
  const solvePriorityTime = inventorySource === "virtue" ? 1 : priorityTimePct / 100;
  const demoVirtueTank = useMemo(() => createDemoProfile("virtue").virtueTank ?? null, []);
  // The tank the virtue card reads: the demo tank without an EID, else the
  // latest one fetched for this EID, else the one saved with the current plan.
  const virtueTankForCard = useMemo((): VirtueTankPreview => {
    if (isDemoMode) {
      return { eid: "", status: "ready", virtueTank: demoVirtueTank, error: null };
    }
    if (virtueTankPreview && virtueTankPreview.eid === trimmedEid) {
      if (virtueTankPreview.virtueTank || virtueTankPreview.status !== "loading") {
        return virtueTankPreview;
      }
    }
    if (profileSnapshot?.eid === trimmedEid && profileSnapshot.virtueTank) {
      return { eid: trimmedEid, status: "ready", virtueTank: profileSnapshot.virtueTank, error: null };
    }
    if (virtueTankPreview && virtueTankPreview.eid === trimmedEid) {
      return virtueTankPreview;
    }
    return { eid: trimmedEid, status: "pending", virtueTank: null, error: null };
  }, [demoVirtueTank, isDemoMode, profileSnapshot, trimmedEid, virtueTankPreview]);
  // Without tank data the Initial Tank can only be the ideal mix.
  const virtueTankMissing = virtueTankForCard.status === "ready" && !virtueTankForCard.virtueTank;
  const effectiveVirtueStartTank: VirtueTankStartMode = virtueTankMissing ? "ideal" : virtueStartTank;
  const virtueShiftCapIndex = Math.max(0, VIRTUE_SHIFT_CAP_DETENTS.indexOf(nearestVirtueShiftCapDetent(virtueShiftCap)));

  const buildCurrentSourcePreferences = (): PlannerSourcePreferences => ({
    targetRows: targetRows.map(targetRowToPlannerTarget),
    targetCraftedOnly,
    includeSlotted,
    includeInventoryRare,
    includeInventoryEpic,
    includeInventoryLegendary,
    includeInventoryFragments,
    includeDropRare,
    includeDropEpic,
    includeDropLegendary,
    includeDropFragments,
    selectedConsumptionItemIds,
    shipDurations,
  });

  const applySourcePreferences = (preferences: PlannerSourcePreferences | null | undefined) => {
    const rows = preferences?.targetRows
      ? parseStoredTargetRows(JSON.stringify(preferences.targetRows), targetOptions)
      : null;
    const nextRows = rows || [{ id: "target-1", itemId: "soul-stone-2", quantityInput: "1", craftGoal: false }];
    const primaryTarget = nextRows[0];
    setTargetRows(nextRows);
    setTargetItemId(primaryTarget.itemId);
    const primaryQuantity = normalizedTargetQuantity(primaryTarget.quantityInput);
    setQuantity(primaryQuantity);
    setQuantityInput(String(primaryQuantity));
    setTargetCraftedOnly(Boolean(preferences?.targetCraftedOnly));
    setIncludeSlotted(Boolean(preferences?.includeSlotted));
    setIncludeInventoryRare(Boolean(preferences?.includeInventoryRare));
    setIncludeInventoryEpic(Boolean(preferences?.includeInventoryEpic));
    setIncludeInventoryLegendary(Boolean(preferences?.includeInventoryLegendary));
    setIncludeInventoryFragments(preferences?.includeInventoryFragments !== false);
    setIncludeDropRare(Boolean(preferences?.includeDropRare));
    setIncludeDropEpic(Boolean(preferences?.includeDropEpic));
    setIncludeDropLegendary(Boolean(preferences?.includeDropLegendary));
    setIncludeDropFragments(preferences?.includeDropFragments !== false);
    setSelectedConsumptionItemIds(
      preferences && Object.prototype.hasOwnProperty.call(preferences, "selectedConsumptionItemIds")
        ? normalizeConsumptionSelection(preferences.selectedConsumptionItemIds)
        : DEFAULT_CONSUMPTION_ITEM_IDS
    );
    setShipDurations(normalizeShipDurations(preferences?.shipDurations) || buildDefaultShipDurations());
  };

  const handleInventorySourceChange = (nextSource: InventorySource) => {
    if (nextSource === inventorySource) {
      return;
    }
    try {
      writePlannerSourcePreferences(inventorySource, buildCurrentSourcePreferences());
      writeStoredString([LOCAL_PREF_KEYS.plannerInventorySource], nextSource);
    } catch {
      // Ignore localStorage persistence errors.
    }
    skipNextScopedPreferenceSaveRef.current = true;
    setInventorySource(nextSource);
    applySourcePreferences(readPlannerSourcePreferenceStore()[nextSource] || null);
  };

  const shipSelectorSummary = useMemo(() => {
    const totalShips = SHIP_DISPLAY_CONFIG.length;
    let selectedShips = 0;
    let allSelected = true;
    const allowed: Array<{ ship: string; durationType: "SHORT" | "LONG" | "EPIC" }> = [];
    for (const entry of SHIP_DISPLAY_CONFIG) {
      const dur = shipDurations[entry.ship];
      if (!dur) {
        continue;
      }
      let hasAny = false;
      for (const d of SHIP_SELECTOR_DURATIONS) {
        if (dur[d.key]) {
          allowed.push({ ship: entry.ship, durationType: d.key });
          hasAny = true;
        } else {
          allSelected = false;
        }
      }
      if (hasAny) {
        selectedShips += 1;
      } else {
        allSelected = false;
      }
    }
    return { totalShips, selectedShips, allSelected, allowed };
  }, [shipDurations]);

  // Pre-fetch loot data for client-side solving.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/loot")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: LootJson) => {
        if (!cancelled) {
          setLootData(data);
          lootDataRef.current = data;
        }
      })
      .catch(() => {
        // Loot fetch failure is non-fatal; client-side solve will fall back to server.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const targetOptions = useMemo(() => buildTargetOptions(), []);
  const consumptionFamilies = useMemo(
    () =>
      ARTIFACT_SHORT_NAMES.map((entry) => {
        const tiers = [1, 2, 3, 4]
          .map((tier) => {
            const itemKey = `${entry.familyKey}_${tier}`;
            const displayInfo = ARTIFACT_DISPLAY[itemKey];
            if (!displayInfo) {
              return null;
            }
            const yields = ARTIFACT_CONSUMPTION[itemKey] || {};
            return {
              itemKey,
              itemId: displayInfo.id || itemKeyToId(itemKey),
              tier,
              label: `${displayInfo.name} (T${tier})`,
              iconUrl: itemKeyToIconUrl(itemKey, 32),
              hasYield: Object.keys(yields).length > 0,
            };
          })
          .filter((tier): tier is NonNullable<typeof tier> => tier !== null);
        return { ...entry, tiers };
      }),
    []
  );
  const selectedConsumptionSet = useMemo(() => new Set(selectedConsumptionItemIds), [selectedConsumptionItemIds]);
  const allConsumptionItemIds = useMemo(
    () =>
      consumptionFamilies
        .flatMap((family) => family.tiers)
        .filter((tier) => tier.hasYield)
        .map((tier) => tier.itemId)
        .sort((a, b) => itemIdToCanonicalKey(a).localeCompare(itemIdToCanonicalKey(b))),
    [consumptionFamilies]
  );
  const solveTargets = useMemo(() => targetRows.map(targetRowToPlannerTarget), [targetRows]);

  // Tank mode schedules launches tank by tank (the packer's schedule), so its
  // timeline replaces the heuristic one below.
  const virtueTankView = useMemo(
    () => (response ? buildVirtueTankPlanView(response.plan, profileSnapshot?.virtueTank) : null),
    [profileSnapshot, response]
  );
  const missionTimeline = useMemo(
    () => (response && !response.plan.virtueTanks ? buildMissionTimeline(response.plan) : null),
    [response]
  );
  // Virtue plans from before tank mode (restored sessions) keep the old fuel chart.
  const virtueFuelCharts = useMemo(
    () =>
      response && response.plan.objectiveMode === "virtueFuel" && !response.plan.virtueTanks
        ? buildVirtueFuelCharts(response.plan)
        : null,
    [response]
  );
  const timelineTotalSeconds = virtueTankView
    ? virtueTankView.pack.schedule.makespanSeconds
    : missionTimeline
      ? missionTimeline.totalSeconds
      : null;
  // Taken from the timeline makespan so the headline number always agrees with
  // the chart below it and genuinely includes in-air ships holding their slots;
  // plan.expectedHours only covers the launches still to be made.
  const expectedMissionHours = timelineTotalSeconds != null
    ? timelineTotalSeconds / 3600
    : response?.plan.expectedHours ?? 0;
  const inFlightSummary = response?.plan.inFlight;
  const planSchedule = response?.plan.schedule;
  // Wall-clock finish if the player starts launching now. Taken from the
  // timeline makespan so the date always agrees with the chart below it: in-air
  // ships hold their slots first, then prep and the plan's own launches.
  const projectedCompletion = useMemo(() => {
    if (timelineTotalSeconds == null || planReceivedAtMs == null || timelineTotalSeconds <= 0) {
      return null;
    }
    return {
      totalSeconds: timelineTotalSeconds,
      at: new Date(planReceivedAtMs + timelineTotalSeconds * 1000),
    };
  }, [timelineTotalSeconds, planReceivedAtMs]);
  const craftPlanDetailRows = useMemo(() => {
    if (!response) {
      return [] as CraftPlanDetailRow[];
    }

    const recipeMap = recipes as Record<string, { ingredients: Record<string, number> } | null>;
    const requiredByItemKey: Record<string, number> = {};
    const targetKey = itemIdToCanonicalKey(response.plan.targetItemId);
    const planTargets = response.plan.targets?.length
      ? response.plan.targets
      : [{ targetItemId: response.plan.targetItemId, quantity: response.plan.quantity }];
    // A craft-count goal is a floor on crafts, not demand for copies, so it
    // must not add a "Needed" row -- its crafts show up under Planned Craft and
    // their ingredients come from the craft loop below.
    const demandTargets = planTargets.filter((target) => !target.craftGoal);
    const craftGoalTotalByItemKey = new Map<string, number>();
    for (const target of planTargets) {
      if (target.craftGoal) {
        const key = itemIdToCanonicalKey(target.targetItemId);
        craftGoalTotalByItemKey.set(key, Math.max(craftGoalTotalByItemKey.get(key) || 0, target.quantity));
      }
    }
    const targetKeys = new Set(demandTargets.map((target) => itemIdToCanonicalKey(target.targetItemId)));
    const planTargetCraftedOnly = Boolean(lastSolveRequest?.targetCraftedOnly);
    for (const target of demandTargets) {
      const key = itemIdToCanonicalKey(target.targetItemId);
      requiredByItemKey[key] = (requiredByItemKey[key] || 0) + target.quantity;
    }
    for (const craft of response.plan.crafts) {
      const craftKey = itemIdToCanonicalKey(craft.itemId);
      const recipe = recipeMap[craftKey];
      if (!recipe) {
        continue;
      }
      for (const [ingredientKey, ingredientQty] of Object.entries(recipe.ingredients)) {
        requiredByItemKey[ingredientKey] = (requiredByItemKey[ingredientKey] || 0) + craft.count * ingredientQty;
      }
    }

    const missionExpectedByItemId = new Map<string, number>();
    const missionExpectedBreakdownByItemId = new Map<string, Array<{ mission: PlanMissionRow; quantity: number }>>();
    for (const mission of response.plan.missions) {
      for (const yieldRow of mission.expectedYields) {
        missionExpectedByItemId.set(
          yieldRow.itemId,
          (missionExpectedByItemId.get(yieldRow.itemId) || 0) + yieldRow.quantity
        );
        const existing = missionExpectedBreakdownByItemId.get(yieldRow.itemId) || [];
        existing.push({ mission, quantity: yieldRow.quantity });
        missionExpectedBreakdownByItemId.set(yieldRow.itemId, existing);
      }
    }

    const consumedCountByItemId = new Map<string, number>();
    const consumptionYieldByItemId = new Map<string, number>();
    const consumptionYieldBreakdownByItemId = new Map<
      string,
      Array<{ sourceItemId: string; sourceCount: number; quantity: number }>
    >();
    for (const consumption of response.plan.consumptions || []) {
      consumedCountByItemId.set(
        consumption.itemId,
        (consumedCountByItemId.get(consumption.itemId) || 0) + Math.max(0, consumption.count)
      );
      for (const yieldRow of consumption.yields) {
        consumptionYieldByItemId.set(
          yieldRow.itemId,
          (consumptionYieldByItemId.get(yieldRow.itemId) || 0) + yieldRow.quantity
        );
        const existing = consumptionYieldBreakdownByItemId.get(yieldRow.itemId) || [];
        existing.push({
          sourceItemId: consumption.itemId,
          sourceCount: consumption.count,
          quantity: yieldRow.quantity,
        });
        consumptionYieldBreakdownByItemId.set(yieldRow.itemId, existing);
      }
    }

    const neededUsesByItemKey = new Map<string, Map<string, number>>();
    const addNeededUse = (itemKey: string, consumerKey: string, quantity: number): void => {
      const safeQty = Math.max(0, quantity);
      if (safeQty <= 0) {
        return;
      }
      const usage = neededUsesByItemKey.get(itemKey) || new Map<string, number>();
      usage.set(consumerKey, (usage.get(consumerKey) || 0) + safeQty);
      neededUsesByItemKey.set(itemKey, usage);
    };
    for (const target of demandTargets) {
      addNeededUse(itemIdToCanonicalKey(target.targetItemId), "__plan_target__", target.quantity);
    }
    for (const craft of response.plan.crafts) {
      const craftKey = itemIdToCanonicalKey(craft.itemId);
      const recipe = recipeMap[craftKey];
      if (!recipe) {
        continue;
      }
      for (const [ingredientKey, ingredientQty] of Object.entries(recipe.ingredients)) {
        addNeededUse(ingredientKey, craft.itemId, craft.count * ingredientQty);
      }
    }

    const plannedCraftCountByItemId = new Map<string, number>();
    response.plan.crafts.forEach((craft) => {
      plannedCraftCountByItemId.set(craft.itemId, Math.max(0, craft.count));
    });

    const rowItemKeys = new Set<string>([
      ...Object.keys(requiredByItemKey),
      ...craftGoalTotalByItemKey.keys(),
      ...response.plan.crafts.map((craft) => itemIdToCanonicalKey(craft.itemId)),
      ...(response.plan.consumptions || []).flatMap((consumption) => [
        itemIdToCanonicalKey(consumption.itemId),
        ...consumption.yields.map((yieldRow) => itemIdToCanonicalKey(yieldRow.itemId)),
      ]),
    ]);

    const rows = Array.from(rowItemKeys)
      .map((itemKey) => {
        const requiredQty = requiredByItemKey[itemKey] || 0;
        const requiredForChain = Math.max(0, requiredQty);
        const itemId = itemKeyToId(itemKey);
        const plannedCraftCount = plannedCraftCountByItemId.get(itemId) || 0;
        const fromConsumption = Math.max(0, consumptionYieldByItemId.get(itemId) || 0);
        const consumedCount = Math.max(0, consumedCountByItemId.get(itemId) || 0);
        const craftGoalTotal = craftGoalTotalByItemKey.get(itemKey) || 0;
        if (
          craftGoalTotal <= 0 &&
          requiredForChain <= 0 &&
          plannedCraftCount <= 0 &&
          fromConsumption <= 0 &&
          consumedCount <= 0
        ) {
          return null;
        }
        let craftGoalLabel: string | null = null;
        if (craftGoalTotal > 0) {
          const craftedBefore = profileSnapshot
            ? Math.max(0, Math.round(profileSnapshot.craftCounts[itemKey] || 0))
            : null;
          craftGoalLabel =
            craftedBefore == null
              ? `craft goal ${craftGoalTotal.toLocaleString()}`
              : `craft goal ${craftGoalTotal.toLocaleString()} · ${craftedBefore.toLocaleString()} → ${(craftedBefore + plannedCraftCount).toLocaleString()}`;
        }
        const have = profileSnapshot ? Math.max(0, profileSnapshot.inventory[itemKey] || 0) : null;
        const expectedMission =
          planTargetCraftedOnly && targetKeys.has(itemKey) && isCraftedOnlyEligibleGoalKey(itemKey)
            ? 0
            : Math.max(0, missionExpectedByItemId.get(itemId) || 0);
        let plannedCraftTooltip: string | null = null;
        if (plannedCraftCount > 0) {
          const recipe = recipeMap[itemKey];
          if (recipe) {
            const lines = Object.entries(recipe.ingredients)
              .map(([ingredientKey, ingredientQty]) => ({
                itemId: itemKeyToId(ingredientKey),
                quantity: plannedCraftCount * ingredientQty,
              }))
              .filter((entry) => entry.quantity > 0)
              .sort((a, b) => b.quantity - a.quantity || itemIdToLabel(a.itemId).localeCompare(itemIdToLabel(b.itemId)))
              .map(
                (entry) =>
                  `${entry.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} - ${itemIdToLabel(entry.itemId)}`
              );
            if (lines.length > 0) {
              plannedCraftTooltip = ["Direct ingredients consumed:", ...lines].join("\n");
            }
          }
        }

        let neededTooltip: string | null = null;
        const neededUses = neededUsesByItemKey.get(itemKey);
        if (neededUses && neededUses.size > 0) {
          const lines = Array.from(neededUses.entries())
            .map(([consumerKey, quantity]) => ({
              label: consumerKey === "__plan_target__" ? "Plan target" : itemIdToLabel(consumerKey),
              quantity,
            }))
            .sort((a, b) => b.quantity - a.quantity || a.label.localeCompare(b.label))
            .map(
              (entry) =>
                `${entry.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} - ${entry.label}`
            );
          if (lines.length > 0) {
            neededTooltip = ["Used by:", ...lines].join("\n");
          }
        }

        let expectedMissionTooltip: string | null = null;
        if (expectedMission > 0) {
          const missionBreakdown = missionExpectedBreakdownByItemId.get(itemId) || [];
          const lines = missionBreakdown
            .map((entry) => {
              const missionLabel = `${titleCaseShip(entry.mission.ship)} ${durationTypeWithLevelLabel(entry.mission.durationType, entry.mission.level)} / ${afxIdToTargetFamilyName(entry.mission.targetAfxId)}`;
              return {
                quantity: entry.quantity,
                label: missionLabel,
              };
            })
            .sort((a, b) => b.quantity - a.quantity || a.label.localeCompare(b.label))
            .map(
              (entry) =>
                `${entry.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} - ${entry.label}`
            );
          if (lines.length > 0) {
            expectedMissionTooltip = ["Expected from missions:", ...lines].join("\n");
          }
        }

        let fromConsumptionTooltip: string | null = null;
        if (fromConsumption > 0) {
          const lines = (consumptionYieldBreakdownByItemId.get(itemId) || [])
            .map((entry) => ({
              quantity: entry.quantity,
              label: `${entry.sourceCount.toLocaleString()} consumed ${itemIdToLabel(entry.sourceItemId)}`,
            }))
            .sort((a, b) => b.quantity - a.quantity || a.label.localeCompare(b.label))
            .map(
              (entry) =>
                `${entry.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} - ${entry.label}`
            );
          if (lines.length > 0) {
            fromConsumptionTooltip = ["From consumption:", ...lines].join("\n");
          }
        }

        const consumedTooltip = consumedCount > 0
          ? `Consume ${consumedCount.toLocaleString()} ${itemIdToLabel(itemId)}`
          : null;

        return {
          itemId,
          craftGoalLabel,
          plannedCraftCount,
          have,
          requiredForChain,
          expectedMission,
          fromConsumption,
          consumedCount,
          plannedCraftTooltip,
          neededTooltip,
          expectedMissionTooltip,
          fromConsumptionTooltip,
          consumedTooltip,
        } satisfies CraftPlanDetailRow;
      })
      .filter((row): row is CraftPlanDetailRow => row !== null);

    rows.sort((a, b) => {
      const aItemKey = itemIdToCanonicalKey(a.itemId);
      const bItemKey = itemIdToCanonicalKey(b.itemId);
      const familyCompare = targetFamilyKey(aItemKey).localeCompare(targetFamilyKey(bItemKey));
      if (familyCompare !== 0) {
        return familyCompare;
      }
      const aTier = targetTierNumber(aItemKey, ARTIFACT_DISPLAY[aItemKey]?.tierNumber);
      const bTier = targetTierNumber(bItemKey, ARTIFACT_DISPLAY[bItemKey]?.tierNumber);
      if (aTier !== bTier) {
        return aTier - bTier;
      }
      return itemIdToLabel(a.itemId).localeCompare(itemIdToLabel(b.itemId));
    });

    return rows;
  }, [lastSolveRequest?.targetCraftedOnly, profileSnapshot, response]);
  const missionPrepTargetOverrideByIndex = useMemo(() => {
    const overrides = new Map<number, string>();
    if (!response) {
      return overrides;
    }

    type PrepReasonBucket = {
      reason: string;
      remainingLaunches: number;
    };

    const prepBucketsByMissionShape = new Map<string, PrepReasonBucket[]>();
    for (const prep of response.plan.progression.prepLaunches) {
      const launches = Math.max(0, Math.round(prep.launches));
      if (launches <= 0) {
        continue;
      }
      const key = `${prep.ship}|${prep.durationType}`;
      const buckets = prepBucketsByMissionShape.get(key) || [];
      buckets.push({
        reason: prep.reason,
        remainingLaunches: launches,
      });
      prepBucketsByMissionShape.set(key, buckets);
    }

    response.plan.missions.forEach((mission, missionIndex) => {
      const missionKey = `${mission.ship}|${mission.durationType}`;
      const buckets = prepBucketsByMissionShape.get(missionKey);
      if (!buckets || buckets.length === 0) {
        return;
      }
      const missionLaunches = Math.max(0, Math.round(mission.launches));
      if (missionLaunches <= 0) {
        return;
      }

      let prepAssigned = 0;
      let remainingToAssign = missionLaunches;
      const reasons = new Set<string>();
      for (const bucket of buckets) {
        if (remainingToAssign <= 0) {
          break;
        }
        if (bucket.remainingLaunches <= 0) {
          continue;
        }
        const taken = Math.min(remainingToAssign, bucket.remainingLaunches);
        if (taken <= 0) {
          continue;
        }
        bucket.remainingLaunches -= taken;
        remainingToAssign -= taken;
        prepAssigned += taken;
        reasons.add(bucket.reason);
      }

      if (prepAssigned <= 0) {
        return;
      }
      const reasonList = Array.from(reasons);
      if (prepAssigned >= missionLaunches && reasonList.length === 1) {
        overrides.set(missionIndex, prepReasonLabel(reasonList[0]));
        return;
      }
      if (prepAssigned >= missionLaunches && reasonList.length > 1) {
        overrides.set(missionIndex, "Prep progression");
        return;
      }
      if (reasonList.length === 1) {
        overrides.set(missionIndex, `${prepReasonLabel(reasonList[0])} + target`);
        return;
      }
      overrides.set(missionIndex, "Prep progression + target");
    });

    return overrides;
  }, [response]);
  useEffect(() => {
    if (!loading || planningStartedAtMs == null) {
      return;
    }
    const timer = window.setInterval(() => {
      setPlannerProgress((current) => {
        if (!current) {
          return current;
        }
        const localElapsed = Math.max(0, Date.now() - planningStartedAtMs);
        if (localElapsed <= current.elapsedMs) {
          return current;
        }
        return {
          ...current,
          elapsedMs: localElapsed,
        };
      });
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [loading, planningStartedAtMs]);

  useEffect(() => {
    try {
      const savedEid = readFirstStoredString(SHARED_EID_KEYS);
      if (savedEid) {
        setEid(savedEid);
      }
      const savedIncludeSlotted = readStoredBoolean(SHARED_INCLUDE_SLOTTED_KEYS);
      if (savedIncludeSlotted != null) {
        setIncludeSlotted(savedIncludeSlotted);
      }
      const savedInventorySource = readFirstStoredString([LOCAL_PREF_KEYS.plannerInventorySource]);
      const initialInventorySource: InventorySource =
        savedInventorySource === "main" || savedInventorySource === "virtue" ? savedInventorySource : "main";
      setInventorySource(initialInventorySource);
      const scopedSourcePreferences = readPlannerSourcePreferenceStore()[initialInventorySource];
      const loadedScopedSourcePreferences = Boolean(scopedSourcePreferences);
      if (scopedSourcePreferences) {
        applySourcePreferences(scopedSourcePreferences);
      }
      if (!loadedScopedSourcePreferences) {
        const savedTargetRows = parseStoredTargetRows(
          readFirstStoredString([LOCAL_PREF_KEYS.plannerTargets]),
          targetOptions
        );
        if (savedTargetRows) {
          const primaryTarget = savedTargetRows[0];
          setTargetRows(savedTargetRows);
          setTargetItemId(primaryTarget.itemId);
          const primaryQuantity = normalizedTargetQuantity(primaryTarget.quantityInput);
          setQuantity(primaryQuantity);
          setQuantityInput(String(primaryQuantity));
        } else {
          const savedTarget = readFirstStoredString([LOCAL_PREF_KEYS.plannerTargetItemId]);
          if (savedTarget && targetOptions.some((option) => option.itemId === savedTarget)) {
            setTargetItemId(savedTarget);
            setTargetRows((rows) => {
              const next = rows.length > 0 ? [...rows] : [{ id: "target-1", itemId: savedTarget, quantityInput: "1", craftGoal: false }];
              next[0] = { ...next[0], itemId: savedTarget };
              return next;
            });
          }
          const savedQuantity = readStoredInteger([LOCAL_PREF_KEYS.plannerQuantity], 1, 9999);
          if (savedQuantity != null) {
            setQuantity(savedQuantity);
            setQuantityInput(String(savedQuantity));
            setTargetRows((rows) => {
              const next = rows.length > 0
                ? [...rows]
                : [{ id: "target-1", itemId: targetItemId, quantityInput: String(savedQuantity), craftGoal: false }];
              next[0] = { ...next[0], quantityInput: String(savedQuantity) };
              return next;
            });
          }
        }
        const savedTargetCraftedOnly = readStoredBoolean([LOCAL_PREF_KEYS.plannerTargetCraftedOnly]);
        if (savedTargetCraftedOnly != null) {
          setTargetCraftedOnly(savedTargetCraftedOnly);
        }
      }
      const savedPriority = readStoredInteger([LOCAL_PREF_KEYS.plannerPriorityTimePct], 0, 100);
      if (savedPriority != null) {
        setPriorityTimePct(savedPriority);
      }
      // The schema accepts any cap 0..15; the slider only stops on detents.
      const savedVirtueShiftCap = readStoredInteger([LOCAL_PREF_KEYS.plannerVirtueShiftCap], 0, 15);
      if (savedVirtueShiftCap != null) {
        setVirtueShiftCap(nearestVirtueShiftCapDetent(savedVirtueShiftCap));
      }
      const savedVirtueStartTank = readFirstStoredString([LOCAL_PREF_KEYS.plannerVirtueStartTank]);
      if (savedVirtueStartTank === "current" || savedVirtueStartTank === "ideal") {
        setVirtueStartTank(savedVirtueStartTank);
      }
      const savedFastMode = readStoredBoolean([LOCAL_PREF_KEYS.plannerFastMode]);
      if (savedFastMode != null) {
        setFastMode(savedFastMode);
      }
      if (!loadedScopedSourcePreferences) {
        const savedIncludeInventoryRare = readStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryRare]);
        if (savedIncludeInventoryRare != null) {
          setIncludeInventoryRare(savedIncludeInventoryRare);
        }
        const savedIncludeInventoryEpic = readStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryEpic]);
        if (savedIncludeInventoryEpic != null) {
          setIncludeInventoryEpic(savedIncludeInventoryEpic);
        }
        const savedIncludeInventoryLegendary = readStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryLegendary]);
        if (savedIncludeInventoryLegendary != null) {
          setIncludeInventoryLegendary(savedIncludeInventoryLegendary);
        }
        const savedIncludeInventoryFragments = readStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryFragments]);
        if (savedIncludeInventoryFragments != null) {
          setIncludeInventoryFragments(savedIncludeInventoryFragments);
        }
        const savedIncludeDropRare = readStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropRare]);
        if (savedIncludeDropRare != null) {
          setIncludeDropRare(savedIncludeDropRare);
        }
        const savedIncludeDropEpic = readStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropEpic]);
        if (savedIncludeDropEpic != null) {
          setIncludeDropEpic(savedIncludeDropEpic);
        }
        const savedIncludeDropLegendary = readStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropLegendary]);
        if (savedIncludeDropLegendary != null) {
          setIncludeDropLegendary(savedIncludeDropLegendary);
        }
        const savedIncludeDropFragments = readStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropFragments]);
        if (savedIncludeDropFragments != null) {
          setIncludeDropFragments(savedIncludeDropFragments);
        }
      }
      const savedDemoNoticeDismissed = readStoredBoolean([LOCAL_PREF_KEYS.plannerDemoNoticeDismissed]);
      if (savedDemoNoticeDismissed != null) {
        setDemoNoticeDismissed(savedDemoNoticeDismissed);
      }
      if (!loadedScopedSourcePreferences) {
        const savedShipDurations = readFirstStoredString([LOCAL_PREF_KEYS.plannerShipDurations]);
        if (savedShipDurations) {
          try {
            const parsed = normalizeShipDurations(JSON.parse(savedShipDurations));
            if (parsed) {
              setShipDurations(parsed);
            }
          } catch {
            // Ignore malformed saved ship durations.
          }
        }
      }
      const savedSession = readPersistedPlannerSession();
      if (savedSession) {
        setResponse(savedSession.response);
        setProfileSnapshot(savedSession.profileSnapshot);
        setLastSolveRequest(savedSession.lastSolveRequest);
        const savedAtMs = new Date(savedSession.savedAt).getTime();
        setPlanReceivedAtMs(Number.isNaN(savedAtMs) ? Date.now() : savedAtMs);
        const savedDate = new Date(savedSession.savedAt);
        const savedLabel = Number.isNaN(savedDate.getTime()) ? "an earlier visit" : savedDate.toLocaleString();
        setRefreshSummary(`Restored the plan saved ${savedLabel}. Replan to update it with current profile data.`);
      }
    } catch {
      // Ignore localStorage hydration errors.
    } finally {
      setPrefsLoaded(true);
    }
  }, [targetOptions]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredString([LOCAL_PREF_KEYS.plannerInventorySource], inventorySource);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [inventorySource, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredString(SHARED_EID_KEYS, eid.trim());
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [eid, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean(SHARED_INCLUDE_SLOTTED_KEYS, includeSlotted);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [includeSlotted, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredString([LOCAL_PREF_KEYS.plannerTargets], serializeTargetRows(targetRows));
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [targetRows, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredString([LOCAL_PREF_KEYS.plannerTargetItemId], targetItemId);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [targetItemId, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredString([LOCAL_PREF_KEYS.plannerQuantity], String(quantity));
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [quantity, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerTargetCraftedOnly], targetCraftedOnly);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [targetCraftedOnly, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredString([LOCAL_PREF_KEYS.plannerPriorityTimePct], String(priorityTimePct));
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [priorityTimePct, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredString([LOCAL_PREF_KEYS.plannerVirtueShiftCap], String(virtueShiftCap));
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [virtueShiftCap, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredString([LOCAL_PREF_KEYS.plannerVirtueStartTank], virtueStartTank);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [virtueStartTank, prefsLoaded]);

  // The virtue tank card needs the tank before the first plan: fetch the
  // profile when switching to Path of Virtue and whenever the EID settles.
  useEffect(() => {
    if (!prefsLoaded || inventorySource !== "virtue" || isDemoMode || !VIRTUE_EID_PATTERN.test(trimmedEid)) {
      return;
    }
    let cancelled = false;
    const filters: PlannerSourceFilters = { ...sourceFilters, inventorySource: "virtue" };
    const timer = window.setTimeout(() => {
      setVirtueTankPreview((current) => ({
        eid: trimmedEid,
        status: "loading",
        virtueTank: current?.eid === trimmedEid ? current.virtueTank : null,
        error: null,
      }));
      fetchProfileSnapshot(trimmedEid, filters)
        .then((profile) => {
          if (cancelled) {
            return;
          }
          setVirtueTankPreview({ eid: trimmedEid, status: "ready", virtueTank: profile.virtueTank ?? null, error: null });
          // Before any plan this also fills in craft counts and ship stars; a
          // built plan keeps the profile it was solved with.
          if (!responseRef.current) {
            setProfileSnapshot(profile);
          }
        })
        .catch((caught) => {
          if (cancelled) {
            return;
          }
          const message = caught instanceof Error && caught.message ? caught.message : "profile fetch failed";
          setVirtueTankPreview({ eid: trimmedEid, status: "error", virtueTank: null, error: message });
        });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // sourceFilters is rebuilt every render; the tank does not depend on it.
  }, [inventorySource, isDemoMode, prefsLoaded, trimmedEid]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerFastMode], fastMode);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [fastMode, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryRare], includeInventoryRare);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [includeInventoryRare, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryEpic], includeInventoryEpic);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [includeInventoryEpic, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryLegendary], includeInventoryLegendary);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [includeInventoryLegendary, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryFragments], includeInventoryFragments);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [includeInventoryFragments, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropRare], includeDropRare);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [includeDropRare, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropEpic], includeDropEpic);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [includeDropEpic, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropLegendary], includeDropLegendary);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [includeDropLegendary, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropFragments], includeDropFragments);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [includeDropFragments, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerDemoNoticeDismissed], demoNoticeDismissed);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [demoNoticeDismissed, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredString([LOCAL_PREF_KEYS.plannerShipDurations], JSON.stringify(shipDurations));
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [shipDurations, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    if (skipNextScopedPreferenceSaveRef.current) {
      skipNextScopedPreferenceSaveRef.current = false;
      return;
    }
    try {
      writePlannerSourcePreferences(inventorySource, buildCurrentSourcePreferences());
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [
    targetRows,
    targetCraftedOnly,
    includeSlotted,
    includeInventoryRare,
    includeInventoryEpic,
    includeInventoryLegendary,
    includeInventoryFragments,
    includeDropRare,
    includeDropEpic,
    includeDropLegendary,
    includeDropFragments,
    selectedConsumptionItemIds,
    shipDurations,
    inventorySource,
    prefsLoaded,
  ]);

  const currentNormalizedTargets = solveTargets.length > 0 ? solveTargets : [{ targetItemId, quantity }];
  const currentPrimaryTarget = currentNormalizedTargets[0];
  const currentAllowedShipDurations = shipSelectorSummary.allSelected
    ? undefined
    : shipSelectorSummary.allowed.map((entry) => ({ ...entry }));
  const currentSolveRequest: LastSolveInputs = {
    eid: trimmedEid,
    targetItemId: currentPrimaryTarget.targetItemId,
    quantity: currentPrimaryTarget.quantity,
    targets: currentNormalizedTargets,
    targetCraftedOnly,
    priorityTime: solvePriorityTime,
    fastMode,
    allowedShipDurations: currentAllowedShipDurations,
    selectedConsumptionItemIds,
    // Left undefined in main mode so JSON.stringify drops them and main-farm
    // requests compare the same as before.
    virtueShiftCap: inventorySource === "virtue" ? virtueShiftCap : undefined,
    virtueStartTank: inventorySource === "virtue" ? virtueStartTank : undefined,
    sourceFilters: { ...sourceFilters },
  };
  const planInputsChanged =
    !response || !lastSolveRequest || JSON.stringify(currentSolveRequest) !== JSON.stringify(lastSolveRequest);
  const plannerReady = highs.ready && lootData !== null;

  async function runBuildPlan(options: { fasterOption?: boolean } = {}) {
    if (!plannerReady) {
      setError("The local planner is still loading. Try again in a moment.");
      return;
    }
    setFasterOptionPlanned(null);
    const snapshotRequest = currentSolveRequest;
    const normalizedTargets = snapshotRequest.targets || [
      { targetItemId: snapshotRequest.targetItemId, quantity: snapshotRequest.quantity },
    ];
    const primaryTarget = normalizedTargets[0];
    const normalizedQuantity = primaryTarget.quantity;
    const allowedShipDurationsForSolve = shipSelectorSummary.allSelected
      ? undefined
      : shipSelectorSummary.allowed.map((entry) => ({ ...entry }));
    // Only a profile a plan was built from is a replan baseline; the virtue
    // tank card can load one before the first plan.
    const baselineProfile = response ? profileSnapshot : null;
    setTargetItemId(primaryTarget.targetItemId);
    setQuantity(normalizedQuantity);
    setQuantityInput(String(normalizedQuantity));

    setError(null);
    setRefreshSummary(null);
    setLoading(true);
    const startedAt = Date.now();
    setPlanningStartedAtMs(startedAt);
    setPlannerProgress({
      phase: "init",
      message: "Submitting planning request...",
      elapsedMs: 0,
      completed: null,
      total: null,
      etaMs: null,
    });

    try {
      writeStoredString(SHARED_EID_KEYS, trimmedEid);
      writeStoredString([LOCAL_PREF_KEYS.plannerInventorySource], inventorySource);
      writeStoredBoolean(SHARED_INCLUDE_SLOTTED_KEYS, includeSlotted);
      writeStoredString([LOCAL_PREF_KEYS.plannerTargets], JSON.stringify(normalizedTargets));
      writeStoredString([LOCAL_PREF_KEYS.plannerTargetItemId], primaryTarget.targetItemId);
      writeStoredString([LOCAL_PREF_KEYS.plannerQuantity], String(normalizedQuantity));
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerTargetCraftedOnly], targetCraftedOnly);
      writeStoredString([LOCAL_PREF_KEYS.plannerPriorityTimePct], String(priorityTimePct));
      writeStoredString([LOCAL_PREF_KEYS.plannerVirtueShiftCap], String(virtueShiftCap));
      writeStoredString([LOCAL_PREF_KEYS.plannerVirtueStartTank], virtueStartTank);
      writePlannerSourcePreferences(inventorySource, buildCurrentSourcePreferences());
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerFastMode], fastMode);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryRare], includeInventoryRare);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryEpic], includeInventoryEpic);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryLegendary], includeInventoryLegendary);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryFragments], includeInventoryFragments);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropRare], includeDropRare);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropEpic], includeDropEpic);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropLegendary], includeDropLegendary);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropFragments], includeDropFragments);

      if (!highsRef.current.ready || !lootDataRef.current) {
        throw new Error("The local planner is still loading. Try again in a moment.");
      }

      {
        // Client-side solve: fetch profile from server, run planner locally.
        setPlannerProgress({
          phase: "init",
          message: "Fetching profile data...",
          elapsedMs: Math.max(0, Date.now() - startedAt),
          completed: null,
          total: null,
          etaMs: null,
        });

        let profile: ProfileSnapshot;
        if (isDemoMode) {
          profile = createDemoProfile(inventorySource) as unknown as ProfileSnapshot;
        } else {
          profile = await fetchProfileSnapshot(trimmedEid, sourceFilters);
        }

        setPlannerProgress({
          phase: "init",
          message: "Profile loaded. Starting client-side solve...",
          elapsedMs: Math.max(0, Date.now() - startedAt),
          completed: null,
          total: null,
          etaMs: null,
        });

        const result = await planForTarget(
          profile as Parameters<typeof planForTarget>[0],
          primaryTarget.targetItemId,
          normalizedQuantity,
          snapshotRequest.priorityTime,
          {
            objectiveMode: inventorySource === "virtue" ? "virtueFuel" : "ge",
            virtueTank:
              inventorySource === "virtue"
                ? buildVirtueTankPlannerOptions(profile.virtueTank, virtueShiftCap, virtueStartTank)
                : undefined,
            fastMode,
            missionDropRarities: {
              rare: includeDropRare,
              epic: includeDropEpic,
              legendary: includeDropLegendary,
              fragments: includeDropFragments,
            },
            targetCraftedOnly,
            targets: normalizedTargets,
            allowedShipDurations: allowedShipDurationsForSolve,
            selectedConsumptionItemIds,
            solverFn: highsRef.current.solve,
            lootData: lootDataRef.current!,
            onProgress: (progress: PlannerProgressEvent) => {
              setPlannerProgress({
                phase: progress.phase,
                message: progress.message,
                elapsedMs: Number.isFinite(progress.elapsedMs) ? Math.max(0, Math.round(progress.elapsedMs)) : 0,
                completed: typeof progress.completed === "number" ? Math.max(0, Math.round(progress.completed)) : null,
                total: typeof progress.total === "number" ? Math.max(0, Math.round(progress.total)) : null,
                etaMs:
                  typeof progress.etaMs === "number"
                    ? Math.max(0, Math.round(progress.etaMs))
                    : progress.etaMs === null
                      ? null
                      : null,
              });
            },
          }
        );

        const planResponse: PlanResponse = {
          profile: {
            eid: profile.eid,
            epicResearchFTLLevel: profile.epicResearchFTLLevel,
            epicResearchZerogLevel: profile.epicResearchZerogLevel,
            shipLevels: profile.shipLevels,
          },
          plan: result,
        };
        setResponse(planResponse);
        setPlanReceivedAtMs(Date.now());
        setProfileSnapshot(profile);
        setLastSolveRequest(snapshotRequest);
        if (options.fasterOption && snapshotRequest.virtueShiftCap != null) {
          setFasterOptionPlanned(snapshotRequest.virtueShiftCap);
        }
        if (inventorySource === "virtue" && !isDemoMode) {
          setVirtueTankPreview({ eid: trimmedEid, status: "ready", virtueTank: profile.virtueTank ?? null, error: null });
        }
        writePersistedPlannerSession(planResponse, profile, snapshotRequest);
        if (baselineProfile && baselineProfile.eid === profile.eid) {
          const deltas = buildReplanDeltas(baselineProfile, profile);
          const totalLaunches = deltas.missionLaunches.reduce((sum, launch) => sum + launch.launches, 0);
          const totalReturnItems = deltas.observedReturns.reduce((sum, item) => sum + item.quantity, 0);
          if (deltas.missionLaunches.length === 0 && deltas.observedReturns.length === 0) {
            setRefreshSummary("No new completed launches or item drops were detected in live profile data.");
          } else {
            setRefreshSummary(
              `Detected ${deltas.missionLaunches.length} launch updates (${totalLaunches.toLocaleString()} launches) and ${deltas.observedReturns.length} drop deltas (${totalReturnItems.toFixed(
                2
              )} total item quantity).`
            );
          }
        }
      }
    } catch (caught) {
      const message = caught instanceof Error && caught.message ? caught.message : "planning request failed";
      setError(message);
    } finally {
      setLoading(false);
      setPlannerProgress(null);
      setPlanningStartedAtMs(null);
    }
  }

  // Runs after the render that applied the queued cap, so runBuildPlan reads it.
  useEffect(() => {
    if (!buildQueued) {
      return;
    }
    setBuildQueued(false);
    void runBuildPlan({ fasterOption: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildQueued]);

  // The Goals rows live in GoalRowsEditor. The first row is mirrored into
  // targetItemId / quantity (saved as the legacy single-target preferences).
  function handleTargetRowsChange(
    update: (rows: PlannerTargetRow[]) => PlannerTargetRow[],
    change: GoalRowsChange
  ): void {
    setTargetRows((rows) => {
      const next = update(rows);
      const primary = next[0];
      switch (change.kind) {
        case "select":
          if (primary) {
            setTargetItemId(primary.itemId);
            if (primary.id === change.rowId) {
              const primaryQuantity = normalizedTargetQuantity(primary.quantityInput);
              setQuantity(primaryQuantity);
              setQuantityInput(String(primaryQuantity));
            }
          }
          break;
        case "quantity":
          if (primary?.id === change.rowId) {
            const parsed = Number(change.rawValue);
            if (Number.isFinite(parsed)) {
              const nextQuantity = Math.max(1, Math.min(9999, Math.round(parsed)));
              setQuantity(nextQuantity);
              setQuantityInput(String(nextQuantity));
            }
          }
          break;
        case "toggleCraftGoal":
          if (primary?.id === change.rowId) {
            const primaryQuantity = normalizedTargetQuantity(primary.quantityInput);
            setQuantity(primaryQuantity);
            setQuantityInput(String(primaryQuantity));
          }
          break;
        case "normalizeQuantity":
          if (primary) {
            const parsed = Number(primary.quantityInput);
            const nextQuantity = Number.isFinite(parsed) ? Math.max(1, Math.min(9999, Math.round(parsed))) : 1;
            setQuantity(nextQuantity);
            setQuantityInput(String(nextQuantity));
          }
          break;
        case "remove":
          if (primary) {
            setTargetItemId(primary.itemId);
            const parsed = Number(primary.quantityInput);
            if (Number.isFinite(parsed)) {
              const nextQuantity = Math.max(1, Math.min(9999, Math.round(parsed)));
              setQuantity(nextQuantity);
              setQuantityInput(String(nextQuantity));
            }
          }
          break;
        case "add":
          break;
      }
      return next;
    });
  }

  const comboKey = (c: { ship: string; durationType: string; targetAfxId: number }) =>
    `${c.ship}|${c.durationType}|${c.targetAfxId}`;

  const downloadSolveSnapshot = (): void => {
    if (!response || !profileSnapshot || !lastSolveRequest) {
      setError("Build a plan first, then download the solve snapshot.");
      return;
    }
    const availableCombos: SolveSnapshotCombo[] = response.plan.availableCombos.map((combo) => ({
      ship: combo.ship,
      durationType: combo.durationType as DurationType,
      targetAfxId: combo.targetAfxId,
    }));
    const selectedCombos: SolveSnapshotCombo[] = availableCombos.filter((combo) => compareSelected.has(comboKey(combo)));
    const sanitizedProfile: ProfileSnapshot = {
      ...profileSnapshot,
      eid: profileSnapshot.eid === "DEMO" ? "DEMO" : "REDACTED",
    };
    const payload: SolveInputSnapshotFile = {
      schemaVersion: 1,
      kind: "mission-craft-planner-solve-input",
      capturedAt: new Date().toISOString(),
      request: {
        targetItemId: lastSolveRequest.targetItemId,
        quantity: lastSolveRequest.quantity,
        targets: lastSolveRequest.targets,
        targetCraftedOnly: lastSolveRequest.targetCraftedOnly,
        priorityTime: lastSolveRequest.priorityTime,
        fastMode: lastSolveRequest.fastMode,
        allowedShipDurations: lastSolveRequest.allowedShipDurations,
        selectedConsumptionItemIds: lastSolveRequest.selectedConsumptionItemIds,
        virtueShiftCap: lastSolveRequest.virtueShiftCap,
        virtueStartTank: lastSolveRequest.virtueStartTank,
      },
      sourceFilters: lastSolveRequest.sourceFilters,
      profile: sanitizedProfile,
      advancedCompare: {
        availableCombos,
        selectedCombos,
      },
    };
    const capturedDate = payload.capturedAt.slice(0, 19).replaceAll(":", "-").replace("T", "_");
    const fileName = `mission-craft-solve-input-${capturedDate}.json`;
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const toggleCompareCombo = (key: string) => {
    setCompareSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const runComparison = async () => {
    if (!profileSnapshot || !response || compareSelected.size === 0) {
      return;
    }
    setCompareLoading(true);
    setCompareError(null);
    setCompareResults(null);
    setCompareExpandedRow(null);
    try {
      const selectedCombos = response.plan.availableCombos.filter((c) => compareSelected.has(comboKey(c)));
      const compareTargetCraftedOnly = lastSolveRequest?.targetCraftedOnly ?? targetCraftedOnly;
      const compareSourceFilters = lastSolveRequest?.sourceFilters ?? sourceFilters;
      const compareConsumptionItemIds = lastSolveRequest?.selectedConsumptionItemIds ?? selectedConsumptionItemIds;
      const canCompareClientSide = highsRef.current.ready && lootDataRef.current != null;

      if (canCompareClientSide) {
        const results = await computeMonolithicPaths({
          profile: profileSnapshot as Parameters<typeof computeMonolithicPaths>[0]["profile"],
          targetItemId: response.plan.targetItemId,
          targets: response.plan.targets,
          quantity: response.plan.quantity,
          targetCraftedOnly: compareTargetCraftedOnly,
          priorityTime: response.plan.priorityTime,
          selectedCombos: selectedCombos as Parameters<typeof computeMonolithicPaths>[0]["selectedCombos"],
          selectedConsumptionItemIds: compareConsumptionItemIds,
          missionDropRarities: {
            rare: compareSourceFilters.includeDropRare,
            epic: compareSourceFilters.includeDropEpic,
            legendary: compareSourceFilters.includeDropLegendary,
            fragments: compareSourceFilters.includeDropFragments,
          },
          solverFn: highsRef.current.solve,
          lootData: lootDataRef.current!,
        });
        setCompareResults(results as unknown as MonolithicPathResult[]);
      } else {
        const body = {
          profile: profileSnapshot,
          targetItemId: response.plan.targetItemId,
          targets: response.plan.targets,
          quantity: response.plan.quantity,
          targetCraftedOnly: compareTargetCraftedOnly,
          priorityTime: response.plan.priorityTime,
          selectedCombos,
          selectedConsumptionItemIds: compareConsumptionItemIds,
          includeDropRare: compareSourceFilters.includeDropRare,
          includeDropEpic: compareSourceFilters.includeDropEpic,
          includeDropLegendary: compareSourceFilters.includeDropLegendary,
          includeDropFragments: compareSourceFilters.includeDropFragments,
        };
        const res = await fetch("/api/plan/compare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.details || data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setCompareResults(data.paths as MonolithicPathResult[]);
      }
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompareLoading(false);
    }
  };

  const renderSourceToggle = (
    enabled: boolean,
    setEnabled: (next: boolean) => void,
    ariaLabel: string
  ) => (
    <button
      type="button"
      className={styles.matrixToggle}
      data-state={enabled ? "use" : "skip"}
      aria-pressed={enabled}
      aria-label={ariaLabel}
      onClick={() => setEnabled(!enabled)}
    >
      {enabled ? "Use" : "Skip"}
    </button>
  );

  const toggleConsumptionItem = (itemId: string) => {
    setSelectedConsumptionItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return Array.from(next).sort((a, b) => {
        const aKey = itemIdToCanonicalKey(a);
        const bKey = itemIdToCanonicalKey(b);
        return aKey.localeCompare(bKey);
      });
    });
  };

  const cardVirtueTank = virtueTankForCard.virtueTank;
  const planVirtueTanks = response?.plan.virtueTanks ?? null;
  // Shifts the last plan needs past its cap: the fewest that meet the goals
  // when the solve went over, or what packing took when it came out above
  // what the solve counted.
  const planOverCapByPacking =
    planVirtueTanks != null && !planVirtueTanks.overCap && planVirtueTanks.pack.totalShifts > planVirtueTanks.shiftCap;
  const planNeededShifts = planVirtueTanks?.overCap
    ? planVirtueTanks.neededShifts ?? planVirtueTanks.plannedShiftCap
    : planOverCapByPacking
      ? planVirtueTanks!.pack.totalShifts
      : null;
  // "plan needs N" sits over the slider only while the cap is still below it.
  const shiftCapNeedIndex = (() => {
    if (inventorySource !== "virtue" || planNeededShifts == null || planNeededShifts <= virtueShiftCap) {
      return null;
    }
    const detent = shiftCapDetentFor(planNeededShifts);
    return detent == null ? VIRTUE_SHIFT_CAP_DETENTS.length - 1 : VIRTUE_SHIFT_CAP_DETENTS.indexOf(detent);
  })();
  const planNeededShiftsDetent = planNeededShifts != null ? shiftCapDetentFor(planNeededShifts) : null;
  const virtueBannerShown = Boolean(virtueTankView && planVirtueTanks && planNeededShifts != null);
  // Over the cap, the count is a minimum only when the planner's search finished;
  // otherwise it is the fewest it found in its time limits. Older plans don't say.
  const planNeededShiftsProven = planVirtueTanks?.overCap ? planVirtueTanks.neededShiftsProven !== false : false;

  const setShiftCapToPlanNeed = () => {
    if (planNeededShiftsDetent == null) {
      return;
    }
    setVirtueShiftCap(planNeededShiftsDetent);
    shiftCapSliderRef.current?.focus();
  };
  // The planner may also offer a plan with a few more shifts that scores clearly
  // better: over the cap, or within it when the plan it found is slow. The button
  // plans it outright when its shift count is a slider setting; otherwise the
  // banner only says what it gives.
  const planFasterOption = planVirtueTanks?.fasterOption ?? null;
  // Within the cap the offer is information, not a warning: the plan is valid
  // and fits, it is just slow next to one with a few more shifts.
  const virtueSlowPlanBannerShown = Boolean(
    virtueTankView &&
      planVirtueTanks &&
      planNeededShifts == null &&
      planFasterOption &&
      planFasterOption.shifts > planVirtueTanks.shiftCap
  );
  const planFasterOptionCap =
    planFasterOption != null && shiftCapDetentFor(planFasterOption.shifts) === planFasterOption.shifts
      ? planFasterOption.shifts
      : null;
  const planWithFasterOption = () => {
    if (planFasterOptionCap == null || loading || !plannerReady) {
      return;
    }
    setVirtueShiftCap(planFasterOptionCap);
    setBuildQueued(true);
    // The button disables while the plan builds and the banner goes with the
    // old plan, so keep keyboard focus on the cap it just set.
    shiftCapSliderRef.current?.focus();
  };

  const clearShipDurations = () => {
    const cleared: ShipDurationSelection = {};
    for (const entry of SHIP_DISPLAY_CONFIG) {
      cleared[entry.ship] = { SHORT: false, LONG: false, EPIC: false };
    }
    setShipDurations(cleared);
  };

  return (
    <main className="page">
      <div className="panel brand-panel" style={{ marginBottom: 12 }}>
        <div className="brand-header" data-compact="1">
          <Link href="/" className="brand-mark-shell brand-mark-link" aria-label="Back to menu">
            <Image src="/media/hamster_egg_poly.png" alt="" width={1024} height={1536} className="brand-mark" priority />
          </Link>
          <div className="brand-copy">
            <h1 className="brand-title">{MISSION_CRAFT_COPY.title}</h1>
            <p className="muted brand-subtitle">{MISSION_CRAFT_COPY.subtitle}</p>
            <details className="info-disclosure">
              <summary className="subtle-info-link">More info</summary>
              <p className="muted">{MISSION_CRAFT_COPY.longDescription}</p>
            </details>
          </div>
          <Link href="/" className="brand-home-link" aria-label="Back to main menu" title="Back to main menu">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M3.5 10.5 12 3.5l8.5 7v9a1 1 0 0 1-1 1h-5.5v-6h-4v6H4.5a1 1 0 0 1-1-1z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>
      </div>

      <form
        className={styles.plannerForm}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void runBuildPlan();
        }}
      >
        <div className={styles.plannerControlGrid}>
          <div className={styles.controlColumn}>
            <div className={`${styles.controlCard} ${styles.profileCard}`}>
              <div className={styles.profileRow}>
                <div className={styles.fieldBlock}>
                  <label className={styles.fieldLabel} htmlFor="eid">EID</label>
                  <input
                    id="eid"
                    className={styles.textInput}
                    type="text"
                    value={eid}
                    onChange={(event) => setEid(event.target.value)}
                    placeholder="EI123... (blank for demo)"
                    autoComplete="off"
                  />
                </div>
                <div className={styles.fieldBlock}>
                  <label className={styles.fieldLabel} htmlFor="planner-inventory-source">Inventory source</label>
                  <div className={styles.selectWrap}>
                    <select
                      id="planner-inventory-source"
                      className={styles.selectInput}
                      value={inventorySource}
                      onChange={(event) => handleInventorySourceChange(event.target.value as InventorySource)}
                    >
                      <option value="main">Main farm</option>
                      <option value="virtue">Path of Virtue</option>
                    </select>
                  </div>
                </div>
              </div>
              <div className={styles.helpText}>
                Enter your EID for personalized plans, or leave blank to run a demo profile.
              </div>
            </div>

            <div className={`${styles.controlCard} ${styles.tightControlCard}`}>
              <div className={styles.controlCardHeader}>
                <div className={styles.controlCardTitle}>
                  <span className={styles.titleDot} aria-hidden="true" />
                  Ingredient sources
                </div>
                <div className={styles.cardSub}>Use = included in planning. Skip = excluded.</div>
              </div>
              <div className={styles.sourceMatrix} role="group" aria-label="Ingredient source filters">
                <span className={styles.matrixSpacer} aria-hidden="true" />
                <span className={`${styles.matrixHeader} ${styles.matrixHeaderRare}`} title="Rare shiny">R</span>
                <span className={`${styles.matrixHeader} ${styles.matrixHeaderEpic}`} title="Epic shiny">E</span>
                <span className={`${styles.matrixHeader} ${styles.matrixHeaderLegendary}`} title="Legendary shiny">L</span>
                <span className={styles.matrixHeader} title="Slotted stones/artifacts">Slotted</span>
                <span className={styles.matrixHeader} title="Stone fragments">Fragments</span>

                <span className={styles.matrixRowLabel}>Inventory</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeInventoryRare, setIncludeInventoryRare, "Inventory rare shiny artifacts")}</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeInventoryEpic, setIncludeInventoryEpic, "Inventory epic shiny artifacts")}</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeInventoryLegendary, setIncludeInventoryLegendary, "Inventory legendary shiny artifacts")}</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeSlotted, setIncludeSlotted, "Inventory slotted stones and artifacts")}</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeInventoryFragments, setIncludeInventoryFragments, "Inventory stone fragments")}</span>

                <span className={styles.matrixRowLabel}>Dropped</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeDropRare, setIncludeDropRare, "Dropped rare shiny artifacts")}</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeDropEpic, setIncludeDropEpic, "Dropped epic shiny artifacts")}</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeDropLegendary, setIncludeDropLegendary, "Dropped legendary shiny artifacts")}</span>
                <span
                  className={`${styles.matrixCell} ${styles.matrixCellMuted}`}
                  title="Dropped slotted stones are not possible"
                  aria-label="Dropped slotted stones are not possible"
                >
                  -
                </span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeDropFragments, setIncludeDropFragments, "Dropped stone fragments")}</span>
              </div>
              <div className={styles.consumptionDrawer}>
                <div className={styles.selectorHeader}>
                  <button
                    type="button"
                    className={styles.consumptionDrawerToggle}
                    onClick={() => setConsumptionDrawerOpen((prev) => !prev)}
                    aria-expanded={consumptionDrawerOpen}
                  >
                    <span className={styles.shipSelectorToggleLeft}>
                      <span className={styles.shipSelectorChevron} data-open={consumptionDrawerOpen ? "1" : "0"} />
                      <span>Consumption</span>
                    </span>
                  </button>
                  <span className={styles.selectorMeta}>
                    <span className={styles.shipSelectorCount}>
                      {selectedConsumptionItemIds.length} <em>selected</em>
                    </span>
                    <span className={styles.selectorMetaDivider} aria-hidden="true">·</span>
                    <button
                      type="button"
                      className={`${styles.selectorQuickAction} ${styles.selectorQuickAll}`}
                      onClick={() => setSelectedConsumptionItemIds(allConsumptionItemIds)}
                    >
                      <span aria-hidden="true">✓</span>ALL
                    </button>
                    <button
                      type="button"
                      className={`${styles.selectorQuickAction} ${styles.selectorQuickNone}`}
                      onClick={() => setSelectedConsumptionItemIds([])}
                    >
                      <span aria-hidden="true">×</span>NONE
                    </button>
                  </span>
                </div>
                {consumptionDrawerOpen && (
                  <>
                    <div className={styles.consumptionHelpText}>
                      Artifacts consumed only if it helps overall plan and you have stone goals
                    </div>
                    <div className={styles.consumptionGrid}>
                      {consumptionFamilies.map((family) => (
                        <div key={family.familyKey} className={styles.consumptionFamily}>
                          <div className={styles.consumptionFamilyName}>{family.shortName}</div>
                          <div className={styles.consumptionTiers}>
                            {family.tiers.map((tier) => {
                              const selected = selectedConsumptionSet.has(tier.itemId);
                              return (
                                <button
                                  key={tier.itemId}
                                  type="button"
                                  className={styles.consumptionTierButton}
                                  data-selected={selected ? "1" : "0"}
                                  data-disabled={tier.hasYield ? "0" : "1"}
                                  aria-pressed={selected}
                                  title={tier.hasYield ? tier.label : `${tier.label}: no stone yield`}
                                  disabled={!tier.hasYield}
                                  onClick={() => toggleConsumptionItem(tier.itemId)}
                                >
                                  {tier.iconUrl ? (
                                    <img src={tier.iconUrl} alt="" width={18} height={18} loading="lazy" />
                                  ) : (
                                    <span className={styles.targetPickerFallbackIcon} aria-hidden="true">?</span>
                                  )}
                                  <span>T{tier.tier}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className={styles.shipSelectorWrap}>
              <div className={styles.selectorHeader}>
                <button
                  type="button"
                  className={styles.shipSelectorToggle}
                  onClick={() => setShipSelectorOpen((prev) => !prev)}
                  aria-expanded={shipSelectorOpen}
                >
                  <span className={styles.shipSelectorToggleLeft}>
                    <span className={styles.shipSelectorChevron} data-open={shipSelectorOpen ? "1" : "0"} />
                    <span>Ships</span>
                  </span>
                </button>
                <span className={styles.selectorMeta}>
                  <span className={styles.shipSelectorCount}>
                    {shipSelectorSummary.selectedShips} <em>selected</em>
                  </span>
                  <span className={styles.selectorMetaDivider} aria-hidden="true">·</span>
                  <button
                    type="button"
                    className={`${styles.selectorQuickAction} ${styles.selectorQuickAll}`}
                    onClick={() => setShipDurations(buildDefaultShipDurations())}
                  >
                    <span aria-hidden="true">✓</span>ALL
                  </button>
                  <button
                    type="button"
                    className={`${styles.selectorQuickAction} ${styles.selectorQuickNone}`}
                    onClick={clearShipDurations}
                  >
                    <span aria-hidden="true">×</span>NONE
                  </button>
                </span>
              </div>

              {!shipSelectorOpen && (
                <div className={styles.shipChips} aria-label="Selected ship durations">
                  {SHIP_DISPLAY_CONFIG.map((entry) => {
                    const dur = shipDurations[entry.ship] || { SHORT: true, LONG: true, EPIC: true };
                    const selectedDurations = SHIP_SELECTOR_DURATIONS.filter((duration) => dur[duration.key]);
                    if (selectedDurations.length === 0) {
                      return null;
                    }
                    return (
                      <span key={entry.ship} className={styles.shipChip}>
                        {compactShipName(entry.ship)}
                        <span className={styles.shipChipDurations}>
                          {selectedDurations.map((duration) => (
                            <span key={duration.key} className={styles[`shipChip${duration.key}`]}>
                              {durationChipLabel(duration.key)}
                            </span>
                          ))}
                        </span>
                      </span>
                    );
                  })}
                </div>
              )}

              {shipSelectorOpen && (
                <div className={styles.shipSelectorPanel}>
                  <div className={styles.shipSelectorList}>
                    {SHIP_DISPLAY_CONFIG.map((entry) => {
                      const dur = shipDurations[entry.ship] || { SHORT: true, LONG: true, EPIC: true };
                      const shipLevel = profileSnapshot?.shipLevels?.find(
                        (sl: ShipLevelInfo) => sl.ship === entry.ship
                      );
                      return (
                        <div key={entry.ship} className={styles.shipSelectorRow}>
                          <ShipSelectorImage ship={entry.ship} imageFiles={entry.imageFiles} />
                          <div className={styles.shipSelectorNameBlock}>
                            <div className={styles.shipSelectorName}>{compactShipName(entry.ship)}</div>
                            {shipLevel != null && (
                              <div className={styles.shipSelectorStars}>
                                {shipLevel.level}/{shipLevel.maxLevel} ⭐
                              </div>
                            )}
                          </div>
                          <div className={styles.shipSelectorDurations}>
                            {SHIP_SELECTOR_DURATIONS.map((d) => (
                              <label
                                key={d.key}
                                className={`${styles.shipSelectorDurLabel} ${
                                  d.key === "SHORT"
                                    ? styles.shipSelectorDurShort
                                    : d.key === "LONG"
                                      ? styles.shipSelectorDurStandard
                                      : styles.shipSelectorDurExtended
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={dur[d.key]}
                                  onChange={() => {
                                    setShipDurations((prev) => ({
                                      ...prev,
                                      [entry.ship]: {
                                        ...prev[entry.ship],
                                        [d.key]: !prev[entry.ship][d.key],
                                      },
                                    }));
                                  }}
                                />
                                <span>{durationChipLabel(d.key)}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className={styles.controlColumn}>
            <div className={styles.controlCard}>
              <div className={styles.controlCardHeader}>
                <div className={styles.controlCardTitle}>
                  <span className={styles.titleDot} aria-hidden="true" />
                  Goals
                </div>
                <label className={styles.customCheck} htmlFor="targetCraftedOnly">
                  <input
                    id="targetCraftedOnly"
                    type="checkbox"
                    checked={targetCraftedOnly}
                    onChange={(event) => setTargetCraftedOnly(event.target.checked)}
                  />
                  <span aria-hidden="true" />
                  <span
                    className={styles.tooltipValue}
                    title="For artifact goals only, count crafted copies toward the requested goal and ignore mission drops of that same artifact. Stone, gold meteorite, geode, and solar titanium goals still count mission drops because they cannot be shiny."
                  >
                    Artifacts: only crafted
                  </span>
                </label>
              </div>
              <GoalRowsEditor
                rows={targetRows}
                onRowsChange={handleTargetRowsChange}
                options={targetOptions}
                craftCounts={profileSnapshot ? profileSnapshot.craftCounts : null}
                newRowItemId={targetItemId}
              />
            </div>

            {inventorySource === "virtue" && (
              <section className={`${styles.controlCard} ${styles.virtueOptCard}`} aria-labelledby="virtue-tank-title">
                <div className={styles.controlCardHeader}>
                  <div className={styles.controlCardTitle} id="virtue-tank-title">
                    <span className={styles.titleDot} aria-hidden="true" />
                    Virtue tank
                  </div>
                  {cardVirtueTank && (
                    <span className={styles.virtueOptMeta}>
                      {formatBackupAge(cardVirtueTank.backupTimeSeconds, Date.now()) ?? "Demo tank"}
                    </span>
                  )}
                </div>
                <div className={styles.virtueOptRow}>
                  <span className={styles.fieldLabel} aria-hidden="true">Initial Tank</span>
                  <fieldset className={styles.virtueOptSegment}>
                    <legend>Initial Tank</legend>
                    <label htmlFor="virtueStartTankCurrent">
                      <input
                        id="virtueStartTankCurrent"
                        type="radio"
                        name="virtueStartTank"
                        value="current"
                        checked={effectiveVirtueStartTank === "current"}
                        disabled={virtueTankMissing}
                        onChange={() => setVirtueStartTank("current")}
                      />
                      Current contents
                    </label>
                    <label htmlFor="virtueStartTankIdeal">
                      <input
                        id="virtueStartTankIdeal"
                        type="radio"
                        name="virtueStartTank"
                        value="ideal"
                        checked={effectiveVirtueStartTank === "ideal"}
                        onChange={() => setVirtueStartTank("ideal")}
                      />
                      Ideal mix
                    </label>
                  </fieldset>
                </div>
                <p className={styles.virtueOptHint} aria-live="polite">
                  {effectiveVirtueStartTank === "current" ? (
                    <>
                      <strong>Plan from what&apos;s in the tank now.</strong> You start on Humility with these amounts;
                      every refuel after that counts toward the shift cap.
                    </>
                  ) : (
                    <>
                      <strong>Plan as if you first fill the tank with the best mix for these goals.</strong> Use your
                      build-up phase to match the Initial Tank.
                    </>
                  )}
                </p>
                {virtueTankMissing && (
                  <VirtueNotice tone="info">No tank data in this backup, so the Initial Tank uses the ideal mix.</VirtueNotice>
                )}
                {virtueTankForCard.status === "error" && (
                  <VirtueNotice tone="info">
                    Couldn&apos;t load your tank ({virtueTankForCard.error}). Building the plan fetches your profile again.
                  </VirtueNotice>
                )}
                {cardVirtueTank ? (
                  <VirtueTankReadout tank={cardVirtueTank} />
                ) : virtueTankForCard.status === "loading" ? (
                  <p className={styles.virtueOptHint}>Loading your tank from your latest backup…</p>
                ) : virtueTankForCard.status === "pending" ? (
                  <p className={styles.virtueOptHint}>
                    Your tank loads once your full EID is in, or leave the EID blank for the demo tank.
                  </p>
                ) : null}
              </section>
            )}

            <div className={styles.buildCard}>
              {inventorySource === "virtue" ? (
                <>
                  <div className={styles.shiftCapBlock}>
                    <div className={styles.shiftCapHead}>
                      <label className={styles.fieldLabel} htmlFor="virtueShiftCap">Shift cap</label>
                      <output className={styles.shiftCapValue} htmlFor="virtueShiftCap">
                        {virtueShiftCap === 0 ? (
                          "No refuels"
                        ) : (
                          <>
                            Up to {virtueShiftCap} <span>shifts</span>
                          </>
                        )}
                      </output>
                    </div>
                    <div
                      className={styles.sliderWrap}
                      data-need={shiftCapNeedIndex != null ? "1" : "0"}
                      style={
                        {
                          "--pct": `${(virtueShiftCapIndex / (VIRTUE_SHIFT_CAP_DETENTS.length - 1)) * 100}%`,
                        } as CSSProperties
                      }
                    >
                      <input
                        ref={shiftCapSliderRef}
                        id="virtueShiftCap"
                        type="range"
                        min={0}
                        max={VIRTUE_SHIFT_CAP_DETENTS.length - 1}
                        step={1}
                        value={virtueShiftCapIndex}
                        onChange={(event) =>
                          setVirtueShiftCap(VIRTUE_SHIFT_CAP_DETENTS[Number(event.target.value)] ?? DEFAULT_VIRTUE_SHIFT_CAP)
                        }
                        aria-valuetext={virtueShiftCap === 0 ? "No refuels" : `Up to ${virtueShiftCap} shifts`}
                        aria-describedby="virtueShiftCapHint"
                      />
                      {shiftCapNeedIndex != null && planNeededShifts != null && (
                        <div
                          className={styles.shiftCapNeed}
                          data-edge={shiftCapNeedIndex === VIRTUE_SHIFT_CAP_DETENTS.length - 1 ? "end" : undefined}
                          style={{
                            left: `calc(9px + (100% - 18px) * ${shiftCapNeedIndex / (VIRTUE_SHIFT_CAP_DETENTS.length - 1)})`,
                          }}
                        >
                          <span>
                            plan {planNeededShiftsProven ? "needs" : "takes"} {planNeededShifts}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className={styles.shiftCapTicks} aria-hidden="true">
                      {VIRTUE_SHIFT_CAP_DETENTS.map((detent, index) => (
                        <span
                          key={detent}
                          className={styles.shiftCapTick}
                          data-on={index <= virtueShiftCapIndex ? "1" : "0"}
                          data-current={index === virtueShiftCapIndex ? "1" : "0"}
                        >
                          <span>{detent}</span>
                        </span>
                      ))}
                    </div>
                    <div className={styles.sliderLabels}>
                      <span>Fewer shifts</span>
                      <span>Save time</span>
                    </div>
                    <div className={styles.shiftCapHint} id="virtueShiftCapHint">
                      {virtueShiftCap === 0 ? (
                        <span>
                          No refuels unless your goals need them. Then the plan uses the fewest shifts that work and says
                          so above the results.
                        </span>
                      ) : (
                        <>
                          <span>
                            Room for up to {pluralize(Math.floor(virtueShiftCap / 2), "refuel loop")}. A loop costs 1
                            shift per egg refilled + 1 back to Humility, e.g.{" "}
                            <span className={styles.shiftCapRoute}>C → R → K → H</span> = 4.
                          </span>
                          {cardVirtueTank && (
                            <span>
                              Using all {virtueShiftCap} costs about{" "}
                              <strong>
                                {formatSoulEggs(
                                  virtueShiftsCostSoulEggs(cardVirtueTank.soulEggs, cardVirtueTank.shiftCount, virtueShiftCap)
                                )}{" "}
                                SE
                              </strong>{" "}
                              at your Soul Eggs and shift count.
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className={styles.sliderBlock}>
                  <div className={styles.sliderWrap} style={{ "--pct": `${priorityTimePct}%` } as CSSProperties}>
                    <input
                      id="priority"
                      type="range"
                      min={0}
                      max={100}
                      value={priorityTimePct}
                      onChange={(event) => setPriorityTimePct(Number(event.target.value))}
                      aria-label="Optimization priority"
                    />
                  </div>
                  <div className={styles.sliderLabels}>
                    <span>Save GE</span>
                    <b>Balance</b>
                    <span>Save time</span>
                  </div>
                </div>
              )}
              <label className={styles.customCheck} htmlFor="fastMode">
                <input
                  id="fastMode"
                  type="checkbox"
                  checked={fastMode}
                  onChange={(event) => setFastMode(event.target.checked)}
                />
                <span aria-hidden="true" />
                <span>Faster, less optimal solve</span>
              </label>
              <button type="submit" className={styles.buildButton} disabled={loading || !plannerReady}>
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M8.9 1.25 3.6 8.45h3.55l-.05 6.3 5.3-7.2H8.85l.05-6.3Z" />
                </svg>
                {loading
                  ? "Planning..."
                  : !plannerReady
                    ? "Loading planner..."
                    : planInputsChanged
                      ? "Build plan"
                      : "Update plan"}
              </button>
            </div>
          </div>
        </div>

        {showDemoNotice && (
          <div className={styles.demoNotice}>
            <div>
              Demo mode is active. This runs with an empty inventory, maxed research, and all ships unlocked at 0 stars to show
              how the planner works. For customized advice, enter your EID.
            </div>
            <button type="button" onClick={() => setDemoNoticeDismissed(true)}>
              Dismiss
            </button>
          </div>
        )}
      </form>

      {loading && plannerProgress && (
        <div className="panel" style={{ marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <strong>{plannerProgress.message}</strong>
            {plannerProgress.completed != null && plannerProgress.total != null && plannerProgress.total > 0 && (
              <span className="muted">
                {plannerProgress.completed.toLocaleString()} / {plannerProgress.total.toLocaleString()}
              </span>
            )}
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            Elapsed {formatDurationFromMs(plannerProgress.elapsedMs)}
            {plannerProgress.etaMs != null ? ` · ETA ${formatDurationFromMs(plannerProgress.etaMs)}` : ""}
          </div>
          {plannerProgress.completed != null && plannerProgress.total != null && plannerProgress.total > 0 && (
            <progress
              value={Math.min(plannerProgress.completed, plannerProgress.total)}
              max={plannerProgress.total}
              style={{ marginTop: 8, width: "100%" }}
            />
          )}
        </div>
      )}

      {error && (
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="error">{error}</div>
        </div>
      )}

      {refreshSummary && (
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="muted">{refreshSummary}</div>
        </div>
      )}

      {response && (
        <div className={styles.resultsDivider} role="separator" aria-label="Plan output section">
          <span>PLAN OUTPUT</span>
        </div>
      )}
      {/* Mounted empty in virtue mode, before any plan, so the banner is announced when it appears. */}
      {(inventorySource === "virtue" || virtueTankView) && (
        <div role="status">
          {virtueBannerShown && planVirtueTanks && planNeededShifts != null && (
            <div className={styles.shiftCapBanner} data-tone="warn">
              {VIRTUE_WARN_ICON}
              <div className={styles.shiftCapBannerText}>
                {planVirtueTanks.overCap && planNeededShiftsProven ? (
                  <>
                    <strong>
                      These goals need at least {planNeededShifts} shifts; the slider allows {planVirtueTanks.shiftCap}.
                    </strong>{" "}
                    Planned with {planNeededShifts} shifts.
                  </>
                ) : planVirtueTanks.overCap ? (
                  <>
                    <strong>
                      No plan {planVirtueTanks.shiftCap > 0 ? `within ${planVirtueTanks.shiftCap} shifts` : "without shifts"}{" "}
                      was found in the time allowed.
                    </strong>{" "}
                    This plan takes {planNeededShifts} shifts; fewer may be possible.
                  </>
                ) : (
                  <>
                    <strong>
                      This plan takes {planNeededShifts} shifts; the slider allows {planVirtueTanks.shiftCap}.
                    </strong>{" "}
                    Packing its launches into tanks took more shifts than the solve counted.
                  </>
                )}
                {planFasterOption && (
                  <>
                    {" "}
                    With {pluralize(planFasterOption.shifts, "shift")} it would take{" "}
                    <b className={styles.shiftCapBannerTime}>{formatDurationFromHours(planFasterOption.expectedHours)}</b>{" "}
                    instead of{" "}
                    <span className={styles.shiftCapBannerTime}>{formatDurationFromHours(expectedMissionHours)}</span>.
                  </>
                )}
              </div>
              {inventorySource === "virtue" &&
                ((planNeededShiftsDetent != null && virtueShiftCap < planNeededShiftsDetent) ||
                  planFasterOptionCap != null) && (
                  <div className={styles.shiftCapBannerActions}>
                    {planFasterOptionCap != null && (
                      <button
                        type="button"
                        className={styles.shiftCapBannerAction}
                        data-primary="1"
                        onClick={planWithFasterOption}
                        disabled={loading || !plannerReady}
                      >
                        Plan with {planFasterOptionCap} shifts
                      </button>
                    )}
                    {planNeededShiftsDetent != null && virtueShiftCap < planNeededShiftsDetent && (
                      <button type="button" className={styles.shiftCapBannerAction} onClick={setShiftCapToPlanNeed}>
                        Set cap to {planNeededShiftsDetent}
                      </button>
                    )}
                  </div>
                )}
            </div>
          )}
          {virtueSlowPlanBannerShown && planVirtueTanks && planFasterOption && (
            <div className={styles.shiftCapBanner} data-tone="info">
              {VIRTUE_INFO_ICON}
              <div className={styles.shiftCapBannerText}>
                <strong>
                  {planVirtueTanks.shiftCap > 0
                    ? `This plan fits your ${planVirtueTanks.shiftCap}-shift cap but is slow.`
                    : "This plan needs no shifts but is slow."}
                </strong>{" "}
                With {pluralize(planFasterOption.shifts, "shift")} it would take{" "}
                <b className={styles.shiftCapBannerTime}>{formatDurationFromHours(planFasterOption.expectedHours)}</b>{" "}
                instead of <span className={styles.shiftCapBannerTime}>{formatDurationFromHours(expectedMissionHours)}</span>.
              </div>
              {inventorySource === "virtue" && planFasterOptionCap != null && (
                <div className={styles.shiftCapBannerActions}>
                  <button
                    type="button"
                    className={styles.shiftCapBannerAction}
                    data-primary="1"
                    onClick={planWithFasterOption}
                    disabled={loading || !plannerReady}
                  >
                    Plan with {planFasterOptionCap} shifts
                  </button>
                </div>
              )}
            </div>
          )}
          {fasterOptionPlanned != null && !loading && planVirtueTanks && (
            <p className={styles.srOnly}>
              Planned with {pluralize(planVirtueTanks.pack.totalShifts, "shift")}. Expected mission time{" "}
              {formatDurationFromHours(expectedMissionHours)}.
            </p>
          )}
        </div>
      )}
      {response && (
        <>
          <div className={`grid ${styles.resultsGrid}`} style={{ marginTop: 14 }}>
          <div className="grid cards">
            <div className="card">
              <div className="muted">Expected mission time</div>
              <div className="kpi">{formatDurationFromHours(expectedMissionHours)}</div>
              {inFlightSummary && inFlightSummary.missionCount > 0 ? (
                <div
                  className={`muted ${styles.tooltipValue}`}
                  title={`${inFlightSummary.missionCount} mission${inFlightSummary.missionCount === 1 ? "" : "s"} already in the air hold their slots for another ${formatDurationFromHours((planSchedule?.inAirSeconds || 0) / 3600)}. Their expected drops are already counted in this plan, so they are not launches you still need to send.`}
                >
                  Includes {formatDurationFromHours((planSchedule?.inAirSeconds || 0) / 3600)} of in-air ship time
                </div>
              ) : (
                <div className="muted">Nothing currently in the air</div>
              )}
            </div>
            {projectedCompletion && (
              <div className="card">
                <div className="muted">Projected completion</div>
                <div className="kpi">{formatPlanCompletion(projectedCompletion.at)}</div>
                <div
                  className={`muted ${styles.tooltipValue}`}
                  title={`Assumes you start launching now and keep all three mission slots busy. Total ${formatDurationFromHours(projectedCompletion.totalSeconds / 3600)} from ${new Date(planReceivedAtMs ?? Date.now()).toLocaleString()}.`}
                >
                  {formatDurationFromHours(projectedCompletion.totalSeconds / 3600)} from now
                </div>
              </div>
            )}
            {virtueTankView && (() => {
              const shifts = virtueTankView.pack.totalShifts;
              const allowed = virtueTankView.result.shiftCap;
              const overCap = virtueTankView.result.overCap || shifts > allowed;
              const costTitle =
                shifts === 0
                  ? "No shifts in this plan."
                  : virtueTankView.planCostSoulEggs == null
                    ? "Soul Egg prices need your Soul Eggs and shift count from a backup."
                    : `Soul Egg price of the plan's ${pluralize(shifts, "shift")}, each priced at your shift count at the time (${virtueTankView.perShiftCostSoulEggs.map(formatSoulEggs).join(", ")}).${virtueTankView.firstFillShifts > 0 ? ` Priced after the first fill's ${pluralize(virtueTankView.firstFillShifts, "shift")}.` : ""}`;
              return (
                <div className={`card ${styles.kpiShiftCard}`} data-over={overCap ? "1" : "0"}>
                  <div className="muted">
                    Shifts
                    {overCap && <span className={styles.kpiFlag}>Over cap</span>}
                  </div>
                  <div className="kpi">
                    {shifts} <span>/ {allowed} allowed</span>
                  </div>
                  <div className={`muted ${styles.tooltipValue}`} title={costTitle}>
                    {pluralize(virtueTankView.tanks.length, "tank")}
                    {virtueTankView.planCostSoulEggs != null && shifts > 0
                      ? ` · ≈ ${formatSoulEggs(virtueTankView.planCostSoulEggs)} SE`
                      : ""}
                  </div>
                  {virtueTankView.firstFillShifts > 0 && (
                    <span
                      className={`${styles.kpiSub} ${styles.tooltipValue}`}
                      title="Filling the ideal Initial Tank before you start. Not counted toward the cap."
                    >
                      First fill: {pluralize(virtueTankView.firstFillShifts, "shift")}
                      {virtueTankView.firstFillCostSoulEggs != null
                        ? ` ≈ ${formatSoulEggs(virtueTankView.firstFillCostSoulEggs)} SE`
                        : ""}
                      , not counted
                    </span>
                  )}
                </div>
              );
            })()}
            <div className="card">
              <div className="muted">Progression prep time</div>
              <div className="kpi">{formatDurationFromHours(response.plan.progression.prepHours)}</div>
              <div className="muted">
                {response.plan.progression.prepLaunches.length > 0
                  ? `${response.plan.progression.prepLaunches.reduce((sum, row) => sum + row.launches, 0).toLocaleString()} prep launches`
                  : "No prep launches selected"}
              </div>
            </div>
            <div className="card">
              <div className="muted">Estimated GE craft cost</div>
              <div className="kpi">{Math.round(response.plan.geCost).toLocaleString()}</div>
            </div>
            <div className="card">
              <div className="muted">Research levels</div>
              <div>FTL: <strong>{response.profile.epicResearchFTLLevel}</strong></div>
              <div>Zero-G: <strong>{response.profile.epicResearchZerogLevel}</strong></div>
            </div>
          </div>

          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Craft plan</h2>
            {craftPlanDetailRows.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No crafting needed.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Needed</th>
                      <th>Have</th>
                      <th><span className={styles.stackedTableHeader}>Planned<br />Craft</span></th>
                      <th><span className={styles.stackedTableHeader}>Expected<br />Mission</span></th>
                      <th><span className={styles.stackedTableHeader}>From<br />Consumption</span></th>
                      <th>Consumed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {craftPlanDetailRows.map((craft) => {
                      const iconUrl = itemIdToIconUrl(craft.itemId);
                      return (
                        <tr key={craft.itemId}>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              {iconUrl && (
                                <img
                                  src={iconUrl}
                                  alt={itemIdToLabel(craft.itemId)}
                                  width={24}
                                  height={24}
                                  loading="lazy"
                                />
                              )}
                              <div>
                                <div>{itemIdToLabel(craft.itemId)}</div>
                                {craft.craftGoalLabel && (
                                  <div className={styles.craftGoalTag}>{craft.craftGoalLabel}</div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td>
                            <span
                              className={craft.neededTooltip ? styles.tooltipValue : undefined}
                              title={craft.neededTooltip || undefined}
                            >
                              {craft.requiredForChain.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span>
                          </td>
                          <td>{craft.have == null ? "—" : craft.have.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td>
                            <span
                              className={craft.plannedCraftCount > 0 && craft.plannedCraftTooltip ? styles.tooltipValue : undefined}
                              title={craft.plannedCraftCount > 0 ? craft.plannedCraftTooltip || undefined : undefined}
                            >
                              {craft.plannedCraftCount.toLocaleString()}
                            </span>
                          </td>
                          <td>
                            <span
                              className={craft.expectedMission > 0 && craft.expectedMissionTooltip ? styles.tooltipValue : undefined}
                              title={craft.expectedMission > 0 ? craft.expectedMissionTooltip || undefined : undefined}
                            >
                              {craft.expectedMission.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span>
                          </td>
                          <td>
                            <span
                              className={craft.fromConsumption > 0 && craft.fromConsumptionTooltip ? styles.tooltipValue : undefined}
                              title={craft.fromConsumption > 0 ? craft.fromConsumptionTooltip || undefined : undefined}
                            >
                              {craft.fromConsumption.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span>
                          </td>
                          <td>
                            <span
                              className={craft.consumedCount > 0 && craft.consumedTooltip ? styles.tooltipValue : undefined}
                              title={craft.consumedCount > 0 ? craft.consumedTooltip || undefined : undefined}
                            >
                              {craft.consumedCount > 0 ? craft.consumedCount.toLocaleString() : "0"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {virtueFuelCharts && (
              <div className={styles.fuelPanel}>
                <div className={styles.fuelHeader}>
                  <span>Virtue fuel use</span>
                  <span className={styles.fuelHeaderMuted}>
                    Humility excluded total: {formatVirtueFuelQuantity(virtueFuelCharts.total)}
                  </span>
                </div>
                <div className={styles.fuelRows}>
                  {virtueFuelCharts.rows.map((row) => (
                    <div key={row.fuel} className={styles.fuelRow}>
                      <div className={styles.fuelLabel}>
                        <img className={styles.fuelIcon} src={row.imageSrc} alt={`${row.label} egg`} loading="lazy" />
                        <span>{row.label}</span>
                      </div>
                      <div className={styles.fuelTrack} aria-label={`${row.label} fuel use`}>
                        {row.segments.map((segment) => {
                          const widthPct = (segment.quantity / virtueFuelCharts.maxTotal) * 100;
                          const quantityLabel = formatVirtueFuelQuantity(segment.quantity);
                          return (
                            <div
                              key={segment.id}
                              className={styles.fuelSegment}
                              style={
                                {
                                  width: `${widthPct}%`,
                                  "--fuel-segment-color": segment.color,
                                } as CSSProperties
                              }
                              title={[
                                segment.label,
                                segment.subtitle,
                                `${quantityLabel} ${row.label}`,
                                `Total ${row.label}: ${formatVirtueFuelQuantity(row.total)}`,
                              ].join("\n")}
                            >
                              <span className={styles.fuelSegmentLabel}>{quantityLabel}</span>
                            </div>
                          );
                        })}
                      </div>
                      <div className={styles.fuelTotal}>{formatVirtueFuelQuantity(row.total)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {virtueTankView && (
            <VirtueFuelTanksPanel view={virtueTankView} planStartMs={planReceivedAtMs ?? Date.now()} />
          )}

          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Mission plan</h2>
            {virtueTankView && (
              <VirtueTankTimeline view={virtueTankView} plan={response.plan} />
            )}
            {missionTimeline && (
              <div className={styles.timelinePanel}>
                <p className={`muted ${styles.timelineIntro}`}>
                  Heuristic 3-slot timeline view of recommended launches. Exact ordering can vary, but total workload matches the plan.
                </p>
                <div className={styles.timelineStats}>
                  <span>
                    Model total: <strong>{formatDurationFromHours(response.plan.expectedHours)}</strong>
                  </span>
                  <span>
                    Timeline makespan: <strong>{formatDurationFromHours(missionTimeline.totalSeconds / 3600)}</strong>
                  </span>
                  <span>
                    Horizon prep workload: <strong>{formatDurationFromHours(missionTimeline.prepSlotSeconds / 3 / 3600)}</strong>
                  </span>
                  <span>
                    Farming mission workload:{" "}
                    <strong>{formatDurationFromHours(missionTimeline.missionSlotSeconds / 3 / 3600)}</strong>
                  </span>
                  {missionTimeline.hiddenPrepSlotSeconds > 0 && (
                    <span>
                      Unattributed prep: <strong>{formatDurationFromHours(missionTimeline.hiddenPrepSlotSeconds / 3 / 3600)}</strong>
                    </span>
                  )}
                </div>

                <div className={styles.timelineLanes}>
                  {missionTimeline.lanes.map((laneBlocks, laneIndex) => (
                    <div key={`lane:${laneIndex}`} className={styles.timelineLaneRow}>
                      <div className={styles.timelineLaneLabel}>Slot {laneIndex + 1}</div>
                      <div className={styles.timelineTrack}>
                        {laneBlocks.map((block) => {
                          const leftPct = (block.startSeconds / missionTimeline.totalSeconds) * 100;
                          const widthPct = Math.max((block.totalSeconds / missionTimeline.totalSeconds) * 100, 0.7);
                          const titleLines = [
                            block.label,
                            block.subtitle,
                            block.phase === "inAir"
                              ? "Already launched — this slot is busy until it lands"
                              : block.launches > 0
                                ? `${block.launches.toLocaleString()} launches`
                                : "Progression-only slot workload",
                            `Slot workload: ${formatDurationFromHours(block.totalSeconds / 3600)}`,
                            `${formatDurationFromHours(block.startSeconds / 3600)} → ${formatDurationFromHours(block.endSeconds / 3600)}`,
                          ];
                          return (
                            <div
                              key={block.id}
                              className={styles.timelineBlock}
                              data-phase={block.phase}
                              style={
                                {
                                  left: `${leftPct}%`,
                                  width: `${widthPct}%`,
                                  "--timeline-block-color": block.color,
                                } as CSSProperties
                              }
                              title={titleLines.join("\n")}
                            >
                              <span className={styles.timelineBlockLabel}>
                                {block.phase === "inAir"
                                  ? "in air"
                                  : block.launches > 0
                                    ? `x${block.launches.toLocaleString()}`
                                    : "prep"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                <div className={styles.timelineLegend}>
                  {missionTimeline.segments.map((segment) => (
                    <div key={segment.id} className={styles.timelineLegendRow}>
                      <span className={styles.timelineSwatch} style={{ background: segment.color }} aria-hidden="true" />
                      <span>{segment.label}</span>
                      <span className={styles.timelineLegendMuted}>{segment.subtitle}</span>
                      <span className={styles.timelineLegendMeta}>
                        {segment.launches > 0 ? `${segment.launches.toLocaleString()} launches` : "prep-only"} ·{" "}
                        {formatDurationFromHours(segment.totalSlotSeconds / 3600)} slot-time
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {response.plan.missions.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No mission launches required by the current model.</p>
            ) : virtueTankView ? (
              <div className={`table-wrap ${styles.missionTableWrap}`}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Ship / Launch</th>
                      <th scope="col">Target</th>
                      <th scope="col">Launches</th>
                      <th scope="col">Duration</th>
                      <th scope="col">Top expected yields</th>
                    </tr>
                  </thead>
                  <VirtueTankMissionRows
                    view={virtueTankView}
                    plan={response.plan}
                    targetOverrideByIndex={missionPrepTargetOverrideByIndex}
                  />
                </table>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ship / Launch</th>
                      <th>Target</th>
                      <th>Launches</th>
                      <th>Duration</th>
                      <th>Top expected yields</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Already-launched missions lead the table: their drops are
                        counted below, so the launch counts are what is still
                        left to send. */}
                    {Array.from(response.plan.missions.entries())
                      .sort(([, a], [, b]) => Number(Boolean(b.inAir)) - Number(Boolean(a.inAir)))
                      .map(([missionIndex, mission]) =>
                        renderMissionTableRow(
                          mission,
                          missionIndex,
                          mission.inAir ? null : missionPrepTargetOverrideByIndex.get(missionIndex) || null,
                          { key: `${missionIndex}:${mission.ship}:${mission.durationType}:${mission.missionId}:${mission.targetAfxId}` }
                        )
                      )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Horizon progression plan</h2>
            {response.plan.progression.prepLaunches.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No ship-level/unlock prep launches were selected for this target.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Prep action</th>
                      <th>Ship</th>
                      <th>Duration</th>
                      <th>Launches</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {response.plan.progression.prepLaunches.map((prep, index) => (
                      <tr key={`${prep.ship}:${prep.durationType}:${index}`}>
                        <td>{prep.reason}</td>
                        <td>{titleCaseShip(prep.ship)}</td>
                        <td>{prep.durationType}</td>
                        <td>{prep.launches.toLocaleString()}</td>
                        <td>{formatDurationFromHours((prep.durationSeconds * prep.launches) / 3600)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Ship progression snapshot (after planned launches)</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ship</th>
                    <th>Unlocked</th>
                    <th>Level</th>
                    <th>Launches</th>
                    <th>Launch points</th>
                  </tr>
                </thead>
                <tbody>
                  {response.plan.progression.projectedShipLevels.map((ship) => (
                    <tr key={ship.ship}>
                      <td>{titleCaseShip(ship.ship)}</td>
                      <td>{ship.unlocked ? <span className="good">yes</span> : "no"}</td>
                      <td>
                        {ship.level}/{ship.maxLevel}
                      </td>
                      <td>{ship.launches.toLocaleString()}</td>
                      <td>{ship.launchPoints.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Planner notes</h2>
            <ul style={{ margin: 0 }}>
              {(virtueBannerShown || virtueSlowPlanBannerShown
                ? response.plan.notes.filter((note) => !VIRTUE_BANNER_NOTE_PATTERNS.some((pattern) => pattern.test(note)))
                : response.plan.notes
              ).map((note, index) => (
                <li key={`${index}:${note}`}>{note}</li>
              ))}
            </ul>
            {response.plan.unmetItems.length > 0 && (
              <>
                <h3>Unmet items</h3>
                <ul style={{ marginTop: 0 }}>
                  {response.plan.unmetItems.map((item) => (
                    <li key={item.itemId}>
                      {itemIdToLabel(item.itemId)}: {item.quantity.toFixed(3)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {response.plan.availableCombos.length > 0 && (
            <div className="panel">
              <div className={styles.compareHeader}>
                <button
                  type="button"
                  className={styles.compareToggle}
                  onClick={() => {
                    if (!compareOpen) {
                      // Pre-select combos that appear in the solver's solution
                      const solverCombos = new Set(
                        response.plan.missions.map((m) => `${m.ship}|${m.durationType}|${m.targetAfxId}`)
                      );
                      setCompareSelected(solverCombos);
                    }
                    setCompareOpen((prev) => !prev);
                  }}
                >
                  {compareOpen ? "▾" : "▸"} Advanced: Path Comparison
                </button>
                <button
                  type="button"
                  className={styles.compareSnapshotButton}
                  onClick={downloadSolveSnapshot}
                  disabled={!profileSnapshot || !lastSolveRequest}
                  title="Download a reproducible input snapshot (settings + profile state)"
                >
                  Download solve snapshot
                </button>
              </div>
              {compareOpen && (
                <div className={styles.comparePanel}>
                  <p className="muted" style={{ margin: "0 0 8px", fontSize: 12 }}>
                    Compare monolithic single-combo paths against the solver&apos;s mixed result. Select combos and click Compare.
                  </p>
                  <div className={styles.compareComboList}>
                    {response.plan.availableCombos.map((combo) => {
                      const key = comboKey(combo);
                      const checked = compareSelected.has(key);
                      const targetLabel = afxIdToTargetFamilyName(combo.targetAfxId);
                      return (
                        <label key={key} className={styles.compareComboLabel}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCompareCombo(key)}
                          />
                          <span>
                            {titleCaseShip(combo.ship)} {durationTypeLabel(combo.durationType)} → {targetLabel}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="button"
                    style={{ marginTop: 8 }}
                    disabled={compareLoading || compareSelected.size === 0}
                    onClick={runComparison}
                  >
                    {compareLoading ? "Comparing..." : "Compare"}
                  </button>
                  {compareError && (
                    <p className="error" style={{ margin: "8px 0 0" }}>{compareError}</p>
                  )}
                  {compareResults && compareResults.length > 0 && (
                    <div className="table-wrap" style={{ marginTop: 10 }}>
                      <table>
                        <thead>
                          <tr>
                            <th>Ship / Duration</th>
                            <th>Target</th>
                            <th>Launches</th>
                            <th>Final ship level</th>
                            <th>Time</th>
                            <th>GE Cost</th>
                            <th>Feasible</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className={styles.compareRowSolver}>
                            <td colSpan={2}><strong>Solver&apos;s mixed result</strong></td>
                            <td>{response.plan.missions.reduce((s, m) => s + m.launches, 0).toLocaleString()}</td>
                            <td>—</td>
                            <td>{formatDurationFromHours(response.plan.expectedHours)}</td>
                            <td>{response.plan.geCost.toLocaleString()}</td>
                            <td><span className="good">yes</span></td>
                          </tr>
                          {compareResults.map((path, pathIndex) => {
                            const targetLabel = afxIdToTargetFamilyName(path.targetAfxId);
                            const isExpanded = compareExpandedRow === pathIndex;
                            const isBestTime = path.feasible && path.expectedHours ===
                              Math.min(...compareResults.filter((p) => p.feasible).map((p) => p.expectedHours));
                            const isBestGe = path.feasible && path.geCost ===
                              Math.min(...compareResults.filter((p) => p.feasible).map((p) => p.geCost));
                            return (
                              <tr
                                key={`${path.ship}:${path.durationType}:${path.targetAfxId}`}
                                className={styles.compareRow}
                                style={{ cursor: path.ingredientBreakdown.length > 0 ? "pointer" : undefined }}
                                onClick={() => setCompareExpandedRow(isExpanded ? null : pathIndex)}
                              >
                                <td>{titleCaseShip(path.ship)} {durationTypeLabel(path.durationType)}</td>
                                <td>{targetLabel}</td>
                                <td>{path.totalLaunches.toLocaleString()}</td>
                                <td>
                                  {path.finalShipLevel != null && path.finalShipMaxLevel != null
                                    ? `${path.finalShipLevel}/${path.finalShipMaxLevel}`
                                    : "—"}
                                </td>
                                <td className={isBestTime ? styles.compareBest : undefined}>
                                  {path.expectedHours > 0 ? formatDurationFromHours(path.expectedHours) : "—"}
                                </td>
                                <td className={isBestGe ? styles.compareBest : undefined}>
                                  {path.geCost.toLocaleString()}
                                </td>
                                <td>{path.feasible ? <span className="good">yes</span> : <span className="error">no</span>}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {compareExpandedRow !== null && compareResults[compareExpandedRow] && (
                        <div className={styles.compareBreakdown}>
                          <h4 style={{ margin: "8px 0 4px" }}>Ingredient breakdown</h4>
                          <table>
                            <thead>
                              <tr>
                                <th>Item</th>
                                <th>Requested</th>
                                <th>Inventory</th>
                                <th>Craft</th>
                                <th>Missions (exp)</th>
                                <th>Shortfall</th>
                              </tr>
                            </thead>
                            <tbody>
                              {compareResults[compareExpandedRow].ingredientBreakdown
                                .filter((i) => i.requested > 0 || i.shortfall > 0)
                                .map((item) => (
                                  <tr key={item.itemId}>
                                    <td>{itemIdToLabel(item.itemId)}</td>
                                    <td>{item.requested.toFixed(1)}</td>
                                    <td>{item.fromInventory.toFixed(1)}</td>
                                    <td>{item.fromCraft.toFixed(1)}</td>
                                    <td>{item.fromMissionsExpected.toFixed(1)}</td>
                                    <td className={item.shortfall > 0.01 ? "error" : undefined}>
                                      {item.shortfall.toFixed(2)}
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                          {compareResults[compareExpandedRow].phases.length > 0 && (
                            <>
                              <h4 style={{ margin: "8px 0 4px" }}>Level phases</h4>
                              <table>
                                <thead>
                                  <tr>
                                    <th>Level</th>
                                    <th>Capacity</th>
                                    <th>Launches</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {compareResults[compareExpandedRow].phases.map((phase) => (
                                    <tr key={phase.level}>
                                      <td>{phase.level}</td>
                                      <td>{phase.capacity}</td>
                                      <td>{phase.launches.toLocaleString()}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          </div>
        </>
      )}
    </main>
  );
}
