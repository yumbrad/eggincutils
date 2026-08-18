"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";

import artifactDisplay from "../../data/artifact-display.json";
import artifactConsumption from "../../data/artifact-consumption.json";
import artifactShortNames from "../../data/artifact-short-names.json";
import recipes from "../../data/recipes.json";
import { MISSION_CRAFT_COPY } from "../../lib/mission-craft-copy";
import {
  afxIdToDisplayName,
  afxIdToItemKey,
  afxIdToTargetFamilyName,
  itemIdToCanonicalKey,
  itemIdToKey,
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
  getVirtueFuelConfig,
  VIRTUE_FUEL_DISPLAY,
  type VirtueFuelKey,
} from "../../lib/virtue-fuel";
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
    targets: Array<{ targetItemId: string; quantity: number }>;
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
  targets?: Array<{ targetItemId: string; quantity: number }>;
  targetCraftedOnly: boolean;
  priorityTime: number;
  fastMode: boolean;
  allowedShipDurations?: Array<{ ship: string; durationType: "SHORT" | "LONG" | "EPIC" }>;
  selectedConsumptionItemIds?: string[];
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

type TargetOption = {
  itemId: string;
  itemKey: string;
  label: string;
  familyKey: string;
  tierNumber: number;
  iconUrl: string | null;
  searchText: string;
};

type PlannerTargetRow = {
  id: string;
  itemId: string;
  quantityInput: string;
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
  targetRows?: Array<{ targetItemId?: string; itemId?: string; quantity?: number; quantityInput?: string }>;
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
    .sort((a, b) => itemIdToKey(a).localeCompare(itemIdToKey(b)));
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
    if (launches <= 0) {
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

function itemIdToLabel(itemId: string): string {
  const itemKey = itemIdToKey(itemId);
  const displayInfo = ARTIFACT_DISPLAY[itemKey];
  if (displayInfo && Number.isFinite(displayInfo.tierNumber)) {
    return `${displayInfo.name} (T${displayInfo.tierNumber})`;
  }
  return itemKeyToDisplayName(itemKey);
}

function itemIdToIconUrl(itemId: string): string | null {
  return itemKeyToIconUrl(itemIdToKey(itemId));
}

function targetFamilyKey(itemKey: string): string {
  const match = itemKey.match(/^(.*)_\d+$/);
  return match ? match[1] : itemKey;
}

function targetTierNumber(itemKey: string, displayTierNumber?: number): number {
  if (displayTierNumber != null && Number.isFinite(displayTierNumber)) {
    return displayTierNumber;
  }
  const match = itemKey.match(/_(\d+)$/);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function normalizedTargetQuantity(rawValue: string): number {
  return Math.max(1, Math.min(9999, Math.round(Number(rawValue) || 1)));
}

function parseStoredTargetRows(raw: string | null, targetOptions: TargetOption[]): PlannerTargetRow[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const availableTargets = new Set(targetOptions.map((option) => option.itemId));
    const rows: PlannerTargetRow[] = [];
    for (const value of parsed) {
      if (!value || typeof value !== "object" || rows.length >= 10) {
        continue;
      }
      const record = value as { targetItemId?: unknown; itemId?: unknown; quantity?: unknown; quantityInput?: unknown };
      const itemId = typeof record.targetItemId === "string"
        ? record.targetItemId
        : typeof record.itemId === "string"
          ? record.itemId
          : "";
      if (!availableTargets.has(itemId)) {
        continue;
      }
      const quantity = Math.max(1, Math.min(9999, Math.round(Number(record.quantity ?? record.quantityInput) || 1)));
      rows.push({ id: `target-${rows.length + 1}`, itemId, quantityInput: String(quantity) });
    }
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

function serializeTargetRows(rows: PlannerTargetRow[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      targetItemId: row.itemId,
      quantity: normalizedTargetQuantity(row.quantityInput),
    }))
  );
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
    { id: "target-1", itemId: "soul-stone-2", quantityInput: "1" },
  ]);
  const [activeTargetRowId, setActiveTargetRowId] = useState("target-1");
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [targetFilter, setTargetFilter] = useState("");
  const [targetActiveIndex, setTargetActiveIndex] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [quantityInput, setQuantityInput] = useState("1");
  const [targetCraftedOnly, setTargetCraftedOnly] = useState(false);
  const [priorityTimePct, setPriorityTimePct] = useState(50);
  const [virtuePriorityTimePct, setVirtuePriorityTimePct] = useState(50);
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
  const targetPickerRef = useRef<HTMLDivElement | null>(null);
  const targetFilterInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextScopedPreferenceSaveRef = useRef(false);
  const highs = useHighsWorker();
  const highsRef = useRef(highs);
  highsRef.current = highs;
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
  const activePriorityTimePct = inventorySource === "virtue" ? virtuePriorityTimePct : priorityTimePct;
  const setActivePriorityTimePct = inventorySource === "virtue" ? setVirtuePriorityTimePct : setPriorityTimePct;

  const buildCurrentSourcePreferences = (): PlannerSourcePreferences => ({
    targetRows: targetRows.map((row) => ({
      targetItemId: row.itemId,
      quantity: normalizedTargetQuantity(row.quantityInput),
    })),
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
    const nextRows = rows || [{ id: "target-1", itemId: "soul-stone-2", quantityInput: "1" }];
    const primaryTarget = nextRows[0];
    setTargetRows(nextRows);
    setActiveTargetRowId(primaryTarget.id);
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

  const targetOptions = useMemo(() => {
    const recipeMap = recipes as Record<string, unknown>;

    return Object.keys(recipeMap)
      .map((itemKey) => {
        const displayInfo = ARTIFACT_DISPLAY[itemKey];
        const itemId = displayInfo?.id || itemKeyToId(itemKey);
        const tierNumber = targetTierNumber(itemKey, displayInfo?.tierNumber);
        const familyKey = targetFamilyKey(itemKey);
        const label =
          displayInfo && Number.isFinite(displayInfo.tierNumber)
            ? `${displayInfo.name} (T${displayInfo.tierNumber})`
            : itemKeyToDisplayName(itemKey);
        const iconUrl = itemKeyToIconUrl(itemKey);
        const searchText = [label, itemId, itemKey, familyKey].join(" ").toLowerCase();
        return { itemId, itemKey, label, familyKey, tierNumber, iconUrl, searchText } satisfies TargetOption;
      })
      .sort((a, b) => {
        const familyCompare = a.familyKey.localeCompare(b.familyKey);
        if (familyCompare !== 0) {
          return familyCompare;
        }
        if (a.tierNumber !== b.tierNumber) {
          return a.tierNumber - b.tierNumber;
        }
        return a.label.localeCompare(b.label);
      });
  }, []);
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
        .sort((a, b) => itemIdToKey(a).localeCompare(itemIdToKey(b))),
    [consumptionFamilies]
  );
  const activeTargetRow = useMemo(
    () => targetRows.find((row) => row.id === activeTargetRowId) || targetRows[0] || null,
    [activeTargetRowId, targetRows]
  );
  const selectedTargetOption = useMemo(
    () => targetOptions.find((option) => option.itemId === (activeTargetRow?.itemId || targetItemId)) || null,
    [activeTargetRow?.itemId, targetItemId, targetOptions]
  );
  const solveTargets = useMemo(
    () =>
      targetRows.map((row) => ({
        targetItemId: row.itemId,
        quantity: normalizedTargetQuantity(row.quantityInput),
      })),
    [targetRows]
  );
  const filteredTargetOptions = useMemo(() => {
    if (!targetPickerOpen) {
      return targetOptions;
    }
    const query = targetFilter.trim().toLowerCase();
    if (!query) {
      return targetOptions;
    }
    const terms = query.split(/\s+/).filter((term) => term.length > 0);
    if (terms.length === 0) {
      return targetOptions;
    }
    return targetOptions.filter((option) => terms.every((term) => option.searchText.includes(term)));
  }, [targetFilter, targetOptions, targetPickerOpen]);

  const missionTimeline = useMemo(() => (response ? buildMissionTimeline(response.plan) : null), [response]);
  const virtueFuelCharts = useMemo(
    () => (response && inventorySource === "virtue" ? buildVirtueFuelCharts(response.plan) : null),
    [inventorySource, response]
  );
  const expectedMissionHours = response?.plan.expectedHours ?? (missionTimeline ? missionTimeline.totalSeconds / 3600 : 0);
  const inFlightSummary = response?.plan.inFlight;
  const planSchedule = response?.plan.schedule;
  // Wall-clock finish if the player starts launching now. Taken from the
  // timeline makespan so the date always agrees with the chart below it: in-air
  // ships hold their slots first, then prep and the plan's own launches.
  const projectedCompletion = useMemo(() => {
    if (!missionTimeline || planReceivedAtMs == null || missionTimeline.totalSeconds <= 0) {
      return null;
    }
    return {
      totalSeconds: missionTimeline.totalSeconds,
      at: new Date(planReceivedAtMs + missionTimeline.totalSeconds * 1000),
    };
  }, [missionTimeline, planReceivedAtMs]);
  const craftPlanDetailRows = useMemo(() => {
    if (!response) {
      return [] as CraftPlanDetailRow[];
    }

    const recipeMap = recipes as Record<string, { ingredients: Record<string, number> } | null>;
    const requiredByItemKey: Record<string, number> = {};
    const targetKey = itemIdToKey(response.plan.targetItemId);
    const planTargets = response.plan.targets?.length
      ? response.plan.targets
      : [{ targetItemId: response.plan.targetItemId, quantity: response.plan.quantity }];
    const targetKeys = new Set(planTargets.map((target) => itemIdToKey(target.targetItemId)));
    const planTargetCraftedOnly = Boolean(lastSolveRequest?.targetCraftedOnly);
    for (const target of planTargets) {
      const key = itemIdToKey(target.targetItemId);
      requiredByItemKey[key] = (requiredByItemKey[key] || 0) + target.quantity;
    }
    for (const craft of response.plan.crafts) {
      const craftKey = itemIdToKey(craft.itemId);
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
    for (const target of planTargets) {
      addNeededUse(itemIdToKey(target.targetItemId), "__plan_target__", target.quantity);
    }
    for (const craft of response.plan.crafts) {
      const craftKey = itemIdToKey(craft.itemId);
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
      ...response.plan.crafts.map((craft) => itemIdToKey(craft.itemId)),
      ...(response.plan.consumptions || []).flatMap((consumption) => [
        itemIdToKey(consumption.itemId),
        ...consumption.yields.map((yieldRow) => itemIdToKey(yieldRow.itemId)),
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
        if (requiredForChain <= 0 && plannedCraftCount <= 0 && fromConsumption <= 0 && consumedCount <= 0) {
          return null;
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
      const aItemKey = itemIdToKey(a.itemId);
      const bItemKey = itemIdToKey(b.itemId);
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
          setActiveTargetRowId(primaryTarget.id);
          setTargetItemId(primaryTarget.itemId);
          const primaryQuantity = normalizedTargetQuantity(primaryTarget.quantityInput);
          setQuantity(primaryQuantity);
          setQuantityInput(String(primaryQuantity));
        } else {
          const savedTarget = readFirstStoredString([LOCAL_PREF_KEYS.plannerTargetItemId]);
          if (savedTarget && targetOptions.some((option) => option.itemId === savedTarget)) {
            setTargetItemId(savedTarget);
            setTargetRows((rows) => {
              const next = rows.length > 0 ? [...rows] : [{ id: "target-1", itemId: savedTarget, quantityInput: "1" }];
              next[0] = { ...next[0], itemId: savedTarget };
              return next;
            });
          }
          const savedQuantity = readStoredInteger([LOCAL_PREF_KEYS.plannerQuantity], 1, 9999);
          if (savedQuantity != null) {
            setQuantity(savedQuantity);
            setQuantityInput(String(savedQuantity));
            setTargetRows((rows) => {
              const next = rows.length > 0 ? [...rows] : [{ id: "target-1", itemId: targetItemId, quantityInput: String(savedQuantity) }];
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
      const savedVirtuePriority = readStoredInteger([LOCAL_PREF_KEYS.plannerVirtuePriorityTimePct], 0, 100);
      if (savedVirtuePriority != null) {
        setVirtuePriorityTimePct(savedVirtuePriority);
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
    if (targetPickerOpen) {
      return;
    }
    setTargetFilter(selectedTargetOption?.label || "");
  }, [selectedTargetOption, targetPickerOpen]);

  useEffect(() => {
    if (!targetPickerOpen) {
      return;
    }
    targetFilterInputRef.current?.focus();
    targetFilterInputRef.current?.select();
  }, [targetPickerOpen, activeTargetRowId]);

  useEffect(() => {
    if (!targetPickerOpen) {
      return;
    }
    const selectedIndex = filteredTargetOptions.findIndex((option) => option.itemId === (activeTargetRow?.itemId || targetItemId));
    if (selectedIndex >= 0) {
      setTargetActiveIndex(selectedIndex);
      return;
    }
    setTargetActiveIndex(filteredTargetOptions.length > 0 ? 0 : -1);
  }, [activeTargetRow?.itemId, filteredTargetOptions, targetItemId, targetPickerOpen]);

  useEffect(() => {
    if (!targetPickerOpen || targetActiveIndex < 0) {
      return;
    }
    const activeNode = targetPickerRef.current?.querySelector<HTMLElement>(
      `[data-target-option-index="${targetActiveIndex}"]`
    );
    activeNode?.scrollIntoView({ block: "nearest" });
  }, [targetActiveIndex, targetPickerOpen, filteredTargetOptions]);

  useEffect(() => {
    if (!targetPickerOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      closeTargetPicker();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [targetPickerOpen, selectedTargetOption]);

  useEffect(() => {
    if (!targetPickerOpen) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const activeRowNode = targetPickerRef.current?.querySelector<HTMLElement>(
        `[data-target-row-id="${activeTargetRowId}"]`
      );
      if (activeRowNode?.contains(target)) {
        return;
      }
      setTargetPickerOpen(false);
      setTargetFilter(selectedTargetOption?.label || "");
    };
    window.addEventListener("mousedown", handleMouseDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
    };
  }, [activeTargetRowId, selectedTargetOption, targetPickerOpen]);

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
      writeStoredString([LOCAL_PREF_KEYS.plannerVirtuePriorityTimePct], String(virtuePriorityTimePct));
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [virtuePriorityTimePct, prefsLoaded]);

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
    priorityTime: activePriorityTimePct / 100,
    fastMode,
    allowedShipDurations: currentAllowedShipDurations,
    selectedConsumptionItemIds,
    sourceFilters: { ...sourceFilters },
  };
  const planInputsChanged =
    !response || !lastSolveRequest || JSON.stringify(currentSolveRequest) !== JSON.stringify(lastSolveRequest);
  const plannerReady = highs.ready && lootData !== null;

  async function runBuildPlan() {
    if (!plannerReady) {
      setError("The local planner is still loading. Try again in a moment.");
      return;
    }
    const snapshotRequest = currentSolveRequest;
    const normalizedTargets = snapshotRequest.targets || [
      { targetItemId: snapshotRequest.targetItemId, quantity: snapshotRequest.quantity },
    ];
    const primaryTarget = normalizedTargets[0];
    const normalizedQuantity = primaryTarget.quantity;
    const allowedShipDurationsForSolve = shipSelectorSummary.allSelected
      ? undefined
      : shipSelectorSummary.allowed.map((entry) => ({ ...entry }));
    const baselineProfile = profileSnapshot;
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
      writeStoredString([LOCAL_PREF_KEYS.plannerVirtuePriorityTimePct], String(virtuePriorityTimePct));
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
          activePriorityTimePct / 100,
          {
            objectiveMode: inventorySource === "virtue" ? "virtueFuel" : "ge",
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

  function openTargetPicker(rowId?: string): void {
    if (rowId && targetPickerOpen && rowId === activeTargetRowId) {
      closeTargetPicker();
      return;
    }
    if (rowId) {
      setActiveTargetRowId(rowId);
    }
    setTargetPickerOpen(true);
    setTargetFilter("");
  }

  function closeTargetPicker(): void {
    setTargetPickerOpen(false);
    setTargetFilter(selectedTargetOption?.label || "");
  }

  function selectTargetOption(option: TargetOption): void {
    setTargetRows((rows) => {
      const activeId = activeTargetRow?.id || rows[0]?.id || "target-1";
      const next = rows.map((row) => (row.id === activeId ? { ...row, itemId: option.itemId } : row));
      if (next[0]) {
        setTargetItemId(next[0].itemId);
      }
      return next.length > 0 ? next : [{ id: activeId, itemId: option.itemId, quantityInput: "1" }];
    });
    setTargetPickerOpen(false);
    setTargetFilter(option.label);
  }

  function updateTargetQuantity(rowId: string, rawValue: string): void {
    setTargetRows((rows) => {
      const next = rows.map((row) => (row.id === rowId ? { ...row, quantityInput: rawValue } : row));
      if (next[0]?.id === rowId) {
        const parsed = Number(rawValue);
        if (Number.isFinite(parsed)) {
          const nextQuantity = Math.max(1, Math.min(9999, Math.round(parsed)));
          setQuantity(nextQuantity);
          setQuantityInput(String(nextQuantity));
        }
      }
      return next;
    });
  }

  function normalizeTargetQuantity(rowId: string): void {
    setTargetRows((rows) => {
      const next = rows.map((row) => {
        if (row.id !== rowId) {
          return row;
        }
        const parsed = Number(row.quantityInput);
        const quantity = Number.isFinite(parsed) ? Math.max(1, Math.min(9999, Math.round(parsed))) : 1;
        return { ...row, quantityInput: String(quantity) };
      });
      if (next[0]) {
        const parsed = Number(next[0].quantityInput);
        const nextQuantity = Number.isFinite(parsed) ? Math.max(1, Math.min(9999, Math.round(parsed))) : 1;
        setQuantity(nextQuantity);
        setQuantityInput(String(nextQuantity));
      }
      return next;
    });
  }

  function addTargetRow(): void {
    const id = `target-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const itemId = targetRows[targetRows.length - 1]?.itemId || targetItemId;
    setTargetRows((rows) => [...rows, { id, itemId, quantityInput: "1" }].slice(0, 10));
    setActiveTargetRowId(id);
    setTargetPickerOpen(true);
    setTargetFilter("");
  }

  function removeTargetRow(rowId: string): void {
    setTargetRows((rows) => {
      const next = rows.filter((row) => row.id !== rowId);
      const safeNext = next.length > 0 ? next : rows;
      if (safeNext[0]) {
        setTargetItemId(safeNext[0].itemId);
        const parsed = Number(safeNext[0].quantityInput);
        if (Number.isFinite(parsed)) {
          const nextQuantity = Math.max(1, Math.min(9999, Math.round(parsed)));
          setQuantity(nextQuantity);
          setQuantityInput(String(nextQuantity));
        }
      }
      return safeNext;
    });
  }

  function onTargetInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      if (!targetPickerOpen) {
        return;
      }
      event.preventDefault();
      closeTargetPicker();
      return;
    }
    if (event.key === "Tab") {
      if (targetPickerOpen) {
        closeTargetPicker();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!targetPickerOpen) {
        openTargetPicker();
        return;
      }
      if (filteredTargetOptions.length === 0) {
        return;
      }
      setTargetActiveIndex((current) => {
        const base = current < 0 ? 0 : current;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = (base + delta + filteredTargetOptions.length) % filteredTargetOptions.length;
        return next;
      });
      return;
    }
    if (event.key === "Home" || event.key === "PageUp") {
      if (!targetPickerOpen || filteredTargetOptions.length === 0) {
        return;
      }
      event.preventDefault();
      setTargetActiveIndex(0);
      return;
    }
    if (event.key === "End" || event.key === "PageDown") {
      if (!targetPickerOpen || filteredTargetOptions.length === 0) {
        return;
      }
      event.preventDefault();
      setTargetActiveIndex(filteredTargetOptions.length - 1);
      return;
    }
    if (event.key === "Enter") {
      if (!targetPickerOpen) {
        return;
      }
      event.preventDefault();
      if (filteredTargetOptions.length === 0) {
        return;
      }
      const selected = filteredTargetOptions[Math.max(0, targetActiveIndex)];
      if (selected) {
        selectTargetOption(selected);
      }
    }
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
        targetCraftedOnly: lastSolveRequest.targetCraftedOnly,
        priorityTime: lastSolveRequest.priorityTime,
        fastMode: lastSolveRequest.fastMode,
        allowedShipDurations: lastSolveRequest.allowedShipDurations,
        selectedConsumptionItemIds: lastSolveRequest.selectedConsumptionItemIds,
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
        const aKey = itemIdToKey(a);
        const bKey = itemIdToKey(b);
        return aKey.localeCompare(bKey);
      });
    });
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
                <span className={styles.matrixHeader} title="Slotted stones">Slotted</span>
                <span className={styles.matrixHeader} title="Stone fragments">Fragments</span>

                <span className={styles.matrixRowLabel}>Inventory</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeInventoryRare, setIncludeInventoryRare, "Inventory rare shiny artifacts")}</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeInventoryEpic, setIncludeInventoryEpic, "Inventory epic shiny artifacts")}</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeInventoryLegendary, setIncludeInventoryLegendary, "Inventory legendary shiny artifacts")}</span>
                <span className={styles.matrixCell}>{renderSourceToggle(includeSlotted, setIncludeSlotted, "Inventory slotted stones")}</span>
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
            <div className={styles.controlCard} ref={targetPickerRef}>
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
              <div className={styles.targetRows}>
                {targetRows.map((row, rowIndex) => {
                  const option = targetOptions.find((candidate) => candidate.itemId === row.itemId) || null;
                  const rowActive = row.id === activeTargetRowId;
                  return (
                    <div key={row.id} className={styles.targetRow} data-target-row-id={row.id}>
                      <span className={styles.targetIcon} aria-hidden="true">
                        {option?.iconUrl ? (
                          <img src={option.iconUrl} alt="" width={32} height={32} loading="lazy" />
                        ) : (
                          <span className={styles.targetPickerFallbackIcon}>?</span>
                        )}
                      </span>
                      <button
                        type="button"
                        className={styles.targetRowSelect}
                        onClick={() => openTargetPicker(row.id)}
                      >
                        <span>{option?.label || row.itemId}</span>
                        <span className={styles.targetPickerChevron} aria-hidden="true" />
                      </button>
                      <div className={styles.targetStepper}>
                        <button
                          type="button"
                          aria-label={`Decrease ${option?.label || "target"} quantity`}
                          onClick={() => updateTargetQuantity(row.id, String(Math.max(1, (Number(row.quantityInput) || 1) - 1)))}
                        >
                          -
                        </button>
                        <input
                          aria-label={`${option?.label || "Target"} quantity`}
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={row.quantityInput}
                          onChange={(event) => updateTargetQuantity(row.id, event.target.value)}
                          onBlur={() => normalizeTargetQuantity(row.id)}
                        />
                        <button
                          type="button"
                          aria-label={`Increase ${option?.label || "target"} quantity`}
                          onClick={() => updateTargetQuantity(row.id, String(Math.min(9999, (Number(row.quantityInput) || 1) + 1)))}
                        >
                          +
                        </button>
                      </div>
                      <button
                        type="button"
                        className={styles.targetRemove}
                        onClick={() => removeTargetRow(row.id)}
                        disabled={targetRows.length <= 1}
                        aria-label={`Remove target ${rowIndex + 1}`}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                          <path d="M4.25 4.25 11.75 11.75M11.75 4.25 4.25 11.75" />
                        </svg>
                      </button>
                      {targetPickerOpen && rowActive && (
                        <div className={styles.targetRowDropdown}>
                          <div className={styles.targetPicker}>
                            <input
                              ref={targetFilterInputRef}
                              id="targetItemFilter"
                              type="text"
                              value={targetFilter}
                              onChange={(event) => setTargetFilter(event.target.value)}
                              onKeyDown={onTargetInputKeyDown}
                              placeholder="Filter artifacts"
                              autoComplete="off"
                              className={styles.targetPickerInput}
                              role="combobox"
                              aria-expanded={targetPickerOpen}
                              aria-controls="targetItemDropdown"
                            />
                          </div>
                          <ul id="targetItemDropdown" className={styles.targetPickerDropdown} role="listbox">
                            {filteredTargetOptions.length === 0 ? (
                              <li className={styles.targetPickerEmpty}>No match</li>
                            ) : (
                              filteredTargetOptions.map((optionRow, index) => {
                                const selected = optionRow.itemId === row.itemId;
                                const active = index === targetActiveIndex;
                                return (
                                  <li
                                    key={optionRow.itemId}
                                    data-target-option-index={index}
                                    className={styles.targetPickerOption}
                                    data-active={active ? "1" : "0"}
                                    data-selected={selected ? "1" : "0"}
                                    role="option"
                                    aria-selected={selected}
                                    onMouseDown={(event) => {
                                      event.preventDefault();
                                      selectTargetOption(optionRow);
                                    }}
                                    onMouseEnter={() => setTargetActiveIndex(index)}
                                  >
                                    {optionRow.iconUrl ? (
                                      <img src={optionRow.iconUrl} alt="" width={22} height={22} className={styles.targetPickerOptionIcon} loading="lazy" />
                                    ) : (
                                      <span className={styles.targetPickerFallbackIcon} aria-hidden="true">?</span>
                                    )}
                                    <span className={styles.targetPickerOptionLabel}>{optionRow.label}</span>
                                    {selected && <span className={styles.targetPickerCheck}>✓</span>}
                                  </li>
                                );
                              })
                            )}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button type="button" className={styles.addTargetButton} onClick={addTargetRow} disabled={targetRows.length >= 10}>
                  <span aria-hidden="true">+</span>
                  Add target
                </button>
              </div>
            </div>

            <div className={styles.buildCard}>
              <div className={styles.sliderBlock}>
                <div className={styles.sliderWrap} style={{ "--pct": `${activePriorityTimePct}%` } as CSSProperties}>
                  <input
                    id="priority"
                    type="range"
                    min={0}
                    max={100}
                    value={activePriorityTimePct}
                    onChange={(event) => setActivePriorityTimePct(Number(event.target.value))}
                    aria-label="Optimization priority"
                  />
                </div>
                <div className={styles.sliderLabels}>
                  <span>{inventorySource === "virtue" ? "Save fuel" : "Save GE"}</span>
                  <b>Balance</b>
                  <span>Save time</span>
                </div>
              </div>
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
        <>
          <div className={styles.resultsDivider} role="separator" aria-label="Plan output section">
            <span>PLAN OUTPUT</span>
          </div>
          <div className="grid" style={{ marginTop: 14 }}>
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

          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Mission plan</h2>
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
                      .map(([missionIndex, mission]) => {
                      const targetOverride = mission.inAir
                        ? null
                        : missionPrepTargetOverrideByIndex.get(missionIndex) || null;
                      const targetLabel = targetOverride || afxIdToTargetFamilyName(mission.targetAfxId);
                      const targetItemKey = targetOverride ? null : afxIdToItemKey(mission.targetAfxId);
                      const targetIconUrl = targetItemKey ? itemKeyToIconUrl(targetItemKey) : null;
                      return (
                        <tr
                          key={`${missionIndex}:${mission.ship}:${mission.durationType}:${mission.missionId}:${mission.targetAfxId}`}
                          className={mission.inAir ? styles.inAirRow : undefined}
                        >
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
                              mission.launches.toLocaleString()
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
                                  <span>{itemIdToLabel(yieldRow.itemId)}: {yieldRow.quantity.toFixed(2)}</span>
                                </div>
                              );
                            })}
                          </td>
                        </tr>
                      );
                    })}
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
              {response.plan.notes.map((note, index) => (
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
