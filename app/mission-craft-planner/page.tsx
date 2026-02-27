"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";

import artifactDisplay from "../../data/artifact-display.json";
import recipes from "../../data/recipes.json";
import { MISSION_CRAFT_COPY } from "../../lib/mission-craft-copy";
import {
  afxIdToDisplayName,
  afxIdToItemKey,
  afxIdToTargetFamilyName,
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
  epicResearchFTLLevel: number;
  epicResearchZerogLevel: number;
  shipLevels: ShipLevelInfoDetailed[];
  missionOptions: MissionOption[];
};

type PlannerSourceFilters = {
  includeSlotted: boolean;
  includeInventoryRare: boolean;
  includeInventoryEpic: boolean;
  includeInventoryLegendary: boolean;
  includeDropRare: boolean;
  includeDropEpic: boolean;
  includeDropLegendary: boolean;
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
    priorityTime: number;
    geCost: number;
    totalSlotSeconds: number;
    expectedHours: number;
    weightedScore: number;
    crafts: Array<{ itemId: string; count: number }>;
    missions: Array<{
      missionId: string;
      ship: string;
      durationType: string;
      targetAfxId: number;
      launches: number;
      durationSeconds: number;
      expectedYields: Array<{ itemId: string; quantity: number }>;
    }>;
    unmetItems: Array<{ itemId: string; quantity: number }>;
    targetBreakdown: {
      requested: number;
      fromInventory: number;
      fromCraft: number;
      fromMissionsExpected: number;
      shortfall: number;
    };
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
    notes: string[];
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
  phase: "mission" | "prep";
  ship: string;
  durationType: string;
};

type TimelineLaneBlock = {
  id: string;
  label: string;
  subtitle: string;
  color: string;
  phase: "mission" | "prep";
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
  additionalNeeded: number | null;
  expectedMission: number;
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

type MissionTimeline = {
  lanes: TimelineLaneBlock[][];
  segments: TimelineSegment[];
  totalSeconds: number;
  modelTotalSlotSeconds: number;
  missionSlotSeconds: number;
  prepSlotSeconds: number;
  hiddenPrepSlotSeconds: number;
};

const DURATION_TYPES: DurationType[] = ["TUTORIAL", "SHORT", "LONG", "EPIC"];
const ARTIFACT_DISPLAY = artifactDisplay as Record<string, { id: string; name: string; tierName: string; tierNumber: number }>;
const SHARED_EID_KEYS = [LOCAL_PREF_KEYS.sharedEid, LOCAL_PREF_KEYS.legacyEid] as const;
const SHARED_INCLUDE_SLOTTED_KEYS = [LOCAL_PREF_KEYS.sharedIncludeSlotted, LOCAL_PREF_KEYS.legacyIncludeSlotted] as const;

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
  const projected = [...laneLoads];
  let remaining = Math.max(0, Math.round(launches));
  const safeDuration = Math.max(0, Math.round(durationSeconds));
  if (remaining <= 0 || safeDuration <= 0) {
    return allocations;
  }

  while (remaining > 0) {
    const order = laneOrderByLoad(projected);
    const first = order[0];
    const second = order[1];
    const gap = projected[second] - projected[first];
    let chunk = 1;
    if (gap > 0) {
      chunk = Math.ceil(gap / safeDuration);
    } else {
      const minLoad = projected[first];
      const tiedCount = order.filter((lane) => Math.abs(projected[lane] - minLoad) < 1e-9).length;
      chunk = Math.floor(remaining / Math.max(1, tiedCount));
    }
    const assign = Math.max(1, Math.min(remaining, chunk));
    allocations[first] += assign;
    projected[first] += assign * safeDuration;
    remaining -= assign;
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

function buildMissionTimeline(plan: PlanResponse["plan"]): MissionTimeline | null {
  const usedMissionPaletteIndexes = new Set<number>();
  const rawMissionSegments: TimelineSegment[] = plan.missions
    .map((mission: PlanMissionRow, index) => {
      const launches = Math.max(0, Math.round(mission.launches));
      const durationSeconds = Math.max(0, Math.round(mission.durationSeconds));
      const totalSlotSeconds = launches * durationSeconds;
      if (launches <= 0 || totalSlotSeconds <= 0) {
        return null;
      }
      const targetName = afxIdToTargetFamilyName(mission.targetAfxId);
      const label = `${titleCaseShip(mission.ship)} ${durationTypeLabel(mission.durationType)}`;
      return {
        id: `mission:${index}:${mission.missionId}:${mission.targetAfxId}`,
        label,
        subtitle: targetName,
        launches,
        durationSeconds,
        totalSlotSeconds,
        color: missionTimelineColor(
          `${mission.ship}|${mission.durationType}|${mission.targetAfxId}`,
          usedMissionPaletteIndexes
        ),
        phase: "mission",
        ship: mission.ship,
        durationType: mission.durationType,
      };
    })
    .filter((segment): segment is TimelineSegment => segment !== null)
    .sort((a, b) => b.durationSeconds - a.durationSeconds || b.launches - a.launches || a.label.localeCompare(b.label));

  const prepSegments: TimelineSegment[] = plan.progression.prepLaunches
    .map((prep, index) => {
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
    });
  }

  if (segments.length === 0) {
    return null;
  }

  const lanes: TimelineLaneBlock[][] = [[], [], []];
  const laneLoads = [0, 0, 0];

  for (const segment of segments) {
    if (segment.launches > 0 && segment.durationSeconds > 0) {
      const launchAllocations = distributeLaunchesAcrossLanes(segment.launches, segment.durationSeconds, laneLoads);
      for (let lane = 0; lane < 3; lane += 1) {
        const launches = launchAllocations[lane];
        if (launches <= 0) {
          continue;
        }
        const blockSeconds = launches * segment.durationSeconds;
        const startSeconds = laneLoads[lane];
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
      }
      continue;
    }

    const secondAllocations = distributeSecondsAcrossLanes(segment.totalSlotSeconds, laneLoads);
    for (let lane = 0; lane < 3; lane += 1) {
      const blockSeconds = secondAllocations[lane];
      if (blockSeconds <= 0) {
        continue;
      }
      const startSeconds = laneLoads[lane];
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
    }
  }

  const totalSeconds = Math.max(0, ...laneLoads);
  if (totalSeconds <= 0) {
    return null;
  }

  return {
    lanes,
    segments,
    totalSeconds,
    modelTotalSlotSeconds,
    missionSlotSeconds,
    prepSlotSeconds,
    hiddenPrepSlotSeconds,
  };
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
  return ship
    .toLowerCase()
    .split("_")
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
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

function profileUrl(eid: string, filters: PlannerSourceFilters): string {
  const params = new URLSearchParams({
    eid,
    includeSlotted: filters.includeSlotted ? "1" : "0",
    includeInventoryRare: filters.includeInventoryRare ? "1" : "0",
    includeInventoryEpic: filters.includeInventoryEpic ? "1" : "0",
    includeInventoryLegendary: filters.includeInventoryLegendary ? "1" : "0",
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
    epicResearchFTLLevel: response.profile.epicResearchFTLLevel,
    epicResearchZerogLevel: response.profile.epicResearchZerogLevel,
    shipLevels: [],
    missionOptions: [],
  };
}

export default function MissionCraftPlannerPage() {
  const [eid, setEid] = useState("");
  const [targetItemId, setTargetItemId] = useState("soul-stone-2");
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [targetFilter, setTargetFilter] = useState("");
  const [targetActiveIndex, setTargetActiveIndex] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [quantityInput, setQuantityInput] = useState("1");
  const [priorityTimePct, setPriorityTimePct] = useState(50);
  const [includeSlotted, setIncludeSlotted] = useState(false);
  const [includeInventoryRare, setIncludeInventoryRare] = useState(false);
  const [includeInventoryEpic, setIncludeInventoryEpic] = useState(false);
  const [includeInventoryLegendary, setIncludeInventoryLegendary] = useState(false);
  const [includeDropRare, setIncludeDropRare] = useState(false);
  const [includeDropEpic, setIncludeDropEpic] = useState(false);
  const [includeDropLegendary, setIncludeDropLegendary] = useState(false);
  const [fastMode, setFastMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<string | null>(null);
  const [plannerProgress, setPlannerProgress] = useState<PlannerProgressState | null>(null);
  const [planningStartedAtMs, setPlanningStartedAtMs] = useState<number | null>(null);
  const [response, setResponse] = useState<PlanResponse | null>(null);
  const [profileSnapshot, setProfileSnapshot] = useState<ProfileSnapshot | null>(null);
  const [demoNoticeDismissed, setDemoNoticeDismissed] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const targetPickerRef = useRef<HTMLDivElement | null>(null);
  const trimmedEid = eid.trim();
  const isDemoMode = trimmedEid.length === 0;
  const showDemoNotice = isDemoMode && !demoNoticeDismissed;
  const sourceFilters: PlannerSourceFilters = {
    includeSlotted,
    includeInventoryRare,
    includeInventoryEpic,
    includeInventoryLegendary,
    includeDropRare,
    includeDropEpic,
    includeDropLegendary,
  };

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
  const selectedTargetOption = useMemo(
    () => targetOptions.find((option) => option.itemId === targetItemId) || null,
    [targetItemId, targetOptions]
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
  const expectedMissionHours = missionTimeline ? missionTimeline.totalSeconds / 3600 : response?.plan.expectedHours ?? 0;
  const craftPlanDetailRows = useMemo(() => {
    if (!response) {
      return [] as CraftPlanDetailRow[];
    }

    const recipeMap = recipes as Record<string, { ingredients: Record<string, number> } | null>;
    const requiredByItemKey: Record<string, number> = {};
    const targetKey = itemIdToKey(response.plan.targetItemId);
    requiredByItemKey[targetKey] = (requiredByItemKey[targetKey] || 0) + response.plan.quantity;

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
    for (const mission of response.plan.missions) {
      for (const yieldRow of mission.expectedYields) {
        missionExpectedByItemId.set(
          yieldRow.itemId,
          (missionExpectedByItemId.get(yieldRow.itemId) || 0) + yieldRow.quantity
        );
      }
    }

    return response.plan.crafts.map((craft) => {
      const itemKey = itemIdToKey(craft.itemId);
      const have = profileSnapshot ? Math.max(0, profileSnapshot.inventory[itemKey] || 0) : null;
      const requiredForChain = Math.max(0, requiredByItemKey[itemKey] || 0);
      const additionalNeeded = have == null ? null : Math.max(0, requiredForChain - have);
      return {
        itemId: craft.itemId,
        plannedCraftCount: craft.count,
        have,
        requiredForChain,
        additionalNeeded,
        expectedMission: Math.max(0, missionExpectedByItemId.get(craft.itemId) || 0),
      };
    });
  }, [profileSnapshot, response]);
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
      const savedTarget = readFirstStoredString([LOCAL_PREF_KEYS.plannerTargetItemId]);
      if (savedTarget && targetOptions.some((option) => option.itemId === savedTarget)) {
        setTargetItemId(savedTarget);
      }
      const savedQuantity = readStoredInteger([LOCAL_PREF_KEYS.plannerQuantity], 1, 9999);
      if (savedQuantity != null) {
        setQuantity(savedQuantity);
        setQuantityInput(String(savedQuantity));
      }
      const savedPriority = readStoredInteger([LOCAL_PREF_KEYS.plannerPriorityTimePct], 0, 100);
      if (savedPriority != null) {
        setPriorityTimePct(savedPriority);
      }
      const savedFastMode = readStoredBoolean([LOCAL_PREF_KEYS.plannerFastMode]);
      if (savedFastMode != null) {
        setFastMode(savedFastMode);
      }
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
      const savedDemoNoticeDismissed = readStoredBoolean([LOCAL_PREF_KEYS.plannerDemoNoticeDismissed]);
      if (savedDemoNoticeDismissed != null) {
        setDemoNoticeDismissed(savedDemoNoticeDismissed);
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
    const selectedIndex = filteredTargetOptions.findIndex((option) => option.itemId === targetItemId);
    if (selectedIndex >= 0) {
      setTargetActiveIndex(selectedIndex);
      return;
    }
    setTargetActiveIndex(filteredTargetOptions.length > 0 ? 0 : -1);
  }, [filteredTargetOptions, targetItemId, targetPickerOpen]);

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
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (targetPickerRef.current?.contains(target)) {
        return;
      }
      setTargetPickerOpen(false);
      setTargetFilter(selectedTargetOption?.label || "");
    };
    window.addEventListener("mousedown", handleMouseDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
    };
  }, [selectedTargetOption, targetPickerOpen]);

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
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerDemoNoticeDismissed], demoNoticeDismissed);
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [demoNoticeDismissed, prefsLoaded]);

  async function runBuildPlan() {
    const normalizedQuantity = Math.max(1, Math.min(9999, Math.round(Number(quantityInput) || quantity || 1)));
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
      writeStoredBoolean(SHARED_INCLUDE_SLOTTED_KEYS, includeSlotted);
      writeStoredString([LOCAL_PREF_KEYS.plannerTargetItemId], targetItemId);
      writeStoredString([LOCAL_PREF_KEYS.plannerQuantity], String(normalizedQuantity));
      writeStoredString([LOCAL_PREF_KEYS.plannerPriorityTimePct], String(priorityTimePct));
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerFastMode], fastMode);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryRare], includeInventoryRare);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryEpic], includeInventoryEpic);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeInventoryLegendary], includeInventoryLegendary);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropRare], includeDropRare);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropEpic], includeDropEpic);
      writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDropLegendary], includeDropLegendary);

      const requestPayload = {
        eid: trimmedEid,
        targetItemId,
        quantity: normalizedQuantity,
        priorityTime: priorityTimePct / 100,
        includeSlotted,
        includeInventoryRare,
        includeInventoryEpic,
        includeInventoryLegendary,
        includeDropRare,
        includeDropEpic,
        includeDropLegendary,
        fastMode,
      };

      const planResp = await fetch("/api/plan/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestPayload),
      });

      if (!planResp.ok) {
        const data = (await planResp.json()) as { error?: string; details?: unknown };
        throw new Error(detailsText(data.details) || data.error || "planning request failed");
      }

      let streamResult: PlanResponse | null = null;
      if (planResp.body) {
        const reader = planResp.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";

        const handleLine = (line: string) => {
          if (!line) {
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            return;
          }

          if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
            return;
          }
          const message = parsed as PlanStreamMessage;
          if (message.type === "progress") {
            const progress = message.progress;
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
            return;
          }
          if (message.type === "result") {
            streamResult = message.data;
            return;
          }
          if (message.type === "error") {
            throw new Error(detailsText(message.details) || message.error || "planning stream failed");
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            buffered += decoder.decode();
            break;
          }
          buffered += decoder.decode(value, { stream: true });
          let newlineIndex = buffered.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = buffered.slice(0, newlineIndex).trim();
            buffered = buffered.slice(newlineIndex + 1);
            handleLine(line);
            newlineIndex = buffered.indexOf("\n");
          }
        }
        const trailing = buffered.trim();
        if (trailing.length > 0) {
          handleLine(trailing);
        }
      } else {
        const fallbackResp = await fetch("/api/plan", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestPayload),
        });
        const fallbackData = (await fallbackResp.json()) as PlanResponse & { error?: string; details?: unknown };
        if (!fallbackResp.ok) {
          throw new Error(detailsText(fallbackData.details) || fallbackData.error || "planning request failed");
        }
        streamResult = fallbackData;
      }

      if (!streamResult) {
        throw new Error("planning stream completed without a result");
      }
      setResponse(streamResult);
      if (isDemoMode) {
        setProfileSnapshot(buildDemoProfileSnapshot(streamResult));
      } else {
        const snapshot = await fetchProfileSnapshot(trimmedEid, sourceFilters);
        setProfileSnapshot(snapshot);
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

  async function onRefreshFromLive() {
    if (!response) {
      return;
    }
    if (isDemoMode) {
      setError("Live refresh is unavailable in demo mode. Enter your EID to replan from your account data.");
      return;
    }

    setError(null);
    setRefreshSummary(null);
    setRefreshing(true);
    const normalizedQuantity = Math.max(1, Math.min(9999, Math.round(Number(quantityInput) || quantity || 1)));
    setQuantity(normalizedQuantity);
    setQuantityInput(String(normalizedQuantity));

    try {
      const liveProfile = await fetchProfileSnapshot(trimmedEid, sourceFilters);
      const baselineProfile = profileSnapshot || liveProfile;
      const deltas = buildReplanDeltas(baselineProfile, liveProfile);

      const replanResp = await fetch("/api/plan/replan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          profile: liveProfile,
          targetItemId,
          quantity: normalizedQuantity,
          priorityTime: priorityTimePct / 100,
          fastMode,
          includeDropRare,
          includeDropEpic,
          includeDropLegendary,
          observedReturns: [],
          missionLaunches: [],
        }),
      });

      const data = (await replanResp.json()) as PlanResponse & { error?: string; details?: unknown };
      if (!replanResp.ok) {
        const detailText =
          typeof data.details === "string"
            ? data.details
            : Array.isArray(data.details)
              ? data.details.join("; ")
              : "";
        throw new Error(detailText || data.error || "replan request failed");
      }

      setResponse(data);
      setProfileSnapshot(liveProfile);

      const totalLaunches = deltas.missionLaunches.reduce((sum, launch) => sum + launch.launches, 0);
      const totalReturnItems = deltas.observedReturns.reduce((sum, item) => sum + item.quantity, 0);
      if (deltas.missionLaunches.length === 0 && deltas.observedReturns.length === 0) {
        setRefreshSummary("No new completed launches or item drops were detected in live profile data.");
      } else {
        setRefreshSummary(
          `Applied ${deltas.missionLaunches.length} launch updates (${totalLaunches.toLocaleString()} launches) and ${deltas.observedReturns.length} drop deltas (${totalReturnItems.toFixed(
            2
          )} total item quantity).`
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "unknown refresh error");
    } finally {
      setRefreshing(false);
    }
  }

  function openTargetPicker(): void {
    setTargetPickerOpen(true);
    setTargetFilter("");
  }

  function closeTargetPicker(): void {
    setTargetPickerOpen(false);
    setTargetFilter(selectedTargetOption?.label || "");
  }

  function selectTargetOption(option: TargetOption): void {
    setTargetItemId(option.itemId);
    setTargetPickerOpen(false);
    setTargetFilter(option.label);
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
        </div>
      </div>

      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void runBuildPlan();
        }}
      >
        <div className="row">
          <div className="field" style={{ minWidth: 320, flex: 2 }}>
            <label htmlFor="eid">EID</label>
            <input
              id="eid"
              type="text"
              value={eid}
              onChange={(event) => setEid(event.target.value)}
              placeholder="EI123... (leave blank for demo mode)"
              autoComplete="off"
            />
            <div className="muted" style={{ fontSize: 12 }}>
              Enter your EID for personalized plans, or leave blank to run a demo profile.
            </div>
          </div>

          <div className="field" style={{ minWidth: 280, flex: 2 }} ref={targetPickerRef}>
            <label htmlFor="targetItemFilter">Target artifact/stone</label>
            <div className={styles.targetPicker}>
              <div className={styles.targetPickerIconWrap}>
                {selectedTargetOption?.iconUrl ? (
                  <img
                    src={selectedTargetOption.iconUrl}
                    alt=""
                    width={22}
                    height={22}
                    className={styles.targetPickerIcon}
                    loading="lazy"
                  />
                ) : (
                  <span className={styles.targetPickerFallbackIcon} aria-hidden="true">
                    ?
                  </span>
                )}
              </div>
              <input
                id="targetItemFilter"
                type="text"
                value={targetFilter}
                onFocus={openTargetPicker}
                onChange={(event) => {
                  if (!targetPickerOpen) {
                    setTargetPickerOpen(true);
                  }
                  setTargetFilter(event.target.value);
                }}
                onKeyDown={onTargetInputKeyDown}
                placeholder="Select artifact (type to filter)"
                autoComplete="off"
                className={styles.targetPickerInput}
                role="combobox"
                aria-expanded={targetPickerOpen}
                aria-controls="targetItemDropdown"
              />
              <span className={styles.targetPickerChevron} aria-hidden="true">
                ▾
              </span>
              {targetPickerOpen && (
                <ul id="targetItemDropdown" className={styles.targetPickerDropdown} role="listbox">
                  {filteredTargetOptions.length === 0 ? (
                    <li className={styles.targetPickerEmpty}>No match</li>
                  ) : (
                    filteredTargetOptions.map((option, index) => {
                      const selected = option.itemId === targetItemId;
                      const active = index === targetActiveIndex;
                      return (
                        <li
                          key={option.itemId}
                          data-target-option-index={index}
                          className={styles.targetPickerOption}
                          data-active={active ? "1" : "0"}
                          data-selected={selected ? "1" : "0"}
                          role="option"
                          aria-selected={selected}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            selectTargetOption(option);
                          }}
                          onMouseEnter={() => setTargetActiveIndex(index)}
                        >
                          {option.iconUrl ? (
                            <img
                              src={option.iconUrl}
                              alt=""
                              width={22}
                              height={22}
                              className={styles.targetPickerOptionIcon}
                              loading="lazy"
                            />
                          ) : (
                            <span className={styles.targetPickerFallbackIcon} aria-hidden="true">
                              ?
                            </span>
                          )}
                          <span className={styles.targetPickerOptionLabel}>{option.label}</span>
                          {selected && <span className={styles.targetPickerCheck}>✓</span>}
                        </li>
                      );
                    })
                  )}
                </ul>
              )}
            </div>
          </div>

          <div className="field" style={{ minWidth: 120 }}>
            <label htmlFor="quantity">Quantity</label>
            <input
              id="quantity"
              type="number"
              min={1}
              max={9999}
              value={quantityInput}
              onChange={(event) => {
                const nextRaw = event.target.value;
                if (nextRaw === "") {
                  setQuantityInput("");
                  return;
                }
                const parsed = Number(nextRaw);
                if (!Number.isFinite(parsed)) {
                  return;
                }
                const nextQuantity = Math.max(1, Math.min(9999, Math.round(parsed)));
                setQuantity(nextQuantity);
                setQuantityInput(String(nextQuantity));
              }}
              onBlur={() => {
                if (quantityInput.trim() === "") {
                  setQuantityInput(String(quantity));
                  return;
                }
                const parsed = Number(quantityInput);
                const nextQuantity = Number.isFinite(parsed) ? Math.max(1, Math.min(9999, Math.round(parsed))) : quantity;
                setQuantity(nextQuantity);
                setQuantityInput(String(nextQuantity));
              }}
            />
          </div>
        </div>

        {showDemoNotice && (
          <div
            style={{
              marginTop: 12,
              padding: 10,
              borderRadius: 10,
              border: "1px solid var(--stroke)",
              background: "color-mix(in oklab, var(--panel), var(--accent) 8%)",
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div className="muted" style={{ fontSize: 13 }}>
              Demo mode is active. This runs with an empty inventory, maxed research, and all ships unlocked at 0 stars to show
              how the planner works. For customized advice, enter your EID.
            </div>
            <button type="button" onClick={() => setDemoNoticeDismissed(true)} style={{ whiteSpace: "nowrap" }}>
              Dismiss
            </button>
          </div>
        )}

        <div className="row" style={{ marginTop: 10, alignItems: "stretch" }}>
          <div className="field" style={{ minWidth: 340, flex: 1 }}>
            <label htmlFor="priority">Optimization priority ({priorityTimePct}% time / {100 - priorityTimePct}% GE)</label>
            <input
              id="priority"
              type="range"
              min={0}
              max={100}
              value={priorityTimePct}
              onChange={(event) => setPriorityTimePct(Number(event.target.value))}
            />
          </div>

          <div className={`field ${styles.sourceMatrixField}`} style={{ minWidth: 340, flex: 1 }}>
            <label>Ingredient source filters</label>
            <div className="muted" style={{ fontSize: 12 }}>
              Use = included in planning. Skip = excluded.
            </div>
            <div className={styles.sourceMatrix} role="group" aria-label="Ingredient source filters">
              <span className={styles.matrixSpacer} aria-hidden="true" />
              <span className={styles.matrixHeader} title="Rare shiny">
                R
              </span>
              <span className={styles.matrixHeader} title="Epic shiny">
                E
              </span>
              <span className={styles.matrixHeader} title="Legendary shiny">
                L
              </span>
              <span className={styles.matrixHeader} title="Slotted stones">
                Slotted
              </span>

              <span className={styles.matrixRowLabel}>Inventory</span>
              <span className={styles.matrixCell}>
                {renderSourceToggle(
                  includeInventoryRare,
                  setIncludeInventoryRare,
                  "Inventory rare shiny artifacts"
                )}
              </span>
              <span className={styles.matrixCell}>
                {renderSourceToggle(
                  includeInventoryEpic,
                  setIncludeInventoryEpic,
                  "Inventory epic shiny artifacts"
                )}
              </span>
              <span className={styles.matrixCell}>
                {renderSourceToggle(
                  includeInventoryLegendary,
                  setIncludeInventoryLegendary,
                  "Inventory legendary shiny artifacts"
                )}
              </span>
              <span className={styles.matrixCell}>
                {renderSourceToggle(includeSlotted, setIncludeSlotted, "Inventory slotted stones")}
              </span>

              <span className={styles.matrixRowLabel}>Dropped</span>
              <span className={styles.matrixCell}>
                {renderSourceToggle(includeDropRare, setIncludeDropRare, "Dropped rare shiny artifacts")}
              </span>
              <span className={styles.matrixCell}>
                {renderSourceToggle(includeDropEpic, setIncludeDropEpic, "Dropped epic shiny artifacts")}
              </span>
              <span className={styles.matrixCell}>
                {renderSourceToggle(includeDropLegendary, setIncludeDropLegendary, "Dropped legendary shiny artifacts")}
              </span>
              <span className={`${styles.matrixCell} ${styles.matrixCellMuted}`}>n/a</span>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Common rarity is always included for both inventory and drops.
            </div>
          </div>

          <div className={styles.actionColumn}>
            <div className={styles.buildActionStack}>
              <button type="submit" disabled={loading}>
                {loading ? "Planning..." : "Build plan"}
              </button>
              <label className={styles.fastModeToggle} htmlFor="fastMode">
                <input
                  id="fastMode"
                  type="checkbox"
                  checked={fastMode}
                  onChange={(event) => setFastMode(event.target.checked)}
                />
                <span className="muted">Faster, less optimal solve</span>
              </label>
            </div>
            <button type="button" disabled={loading || refreshing || !response || isDemoMode} onClick={onRefreshFromLive}>
              {refreshing ? "Replanning..." : "Replan after ship returns"}
            </button>
          </div>
        </div>
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
        <div className="grid" style={{ marginTop: 12 }}>
          <div className="grid cards">
            <div className="card">
              <div className="muted">Expected mission time</div>
              <div className="kpi">{formatDurationFromHours(expectedMissionHours)}</div>
              <div className="muted">3 mission slots assumed</div>
            </div>
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
            {response.plan.crafts.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No crafting needed.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Have</th>
                      <th>Addl. needed</th>
                      <th>Planned craft</th>
                      <th>Expected mission</th>
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
                          <td>{craft.have == null ? "—" : craft.have.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td>
                            {craft.additionalNeeded == null
                              ? "—"
                              : craft.additionalNeeded.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </td>
                          <td>{craft.plannedCraftCount.toLocaleString()}</td>
                          <td>{craft.expectedMission.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
                            block.launches > 0 ? `${block.launches.toLocaleString()} launches` : "Progression-only slot workload",
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
                                {block.launches > 0 ? `x${block.launches.toLocaleString()}` : "prep"}
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
                    {response.plan.missions.map((mission, missionIndex) => {
                      const targetOverride = missionPrepTargetOverrideByIndex.get(missionIndex) || null;
                      const targetLabel = targetOverride || afxIdToTargetFamilyName(mission.targetAfxId);
                      const targetItemKey = targetOverride ? null : afxIdToItemKey(mission.targetAfxId);
                      const targetIconUrl = targetItemKey ? itemKeyToIconUrl(targetItemKey) : null;
                      return (
                        <tr
                          key={`${missionIndex}:${mission.ship}:${mission.durationType}:${mission.missionId}:${mission.targetAfxId}`}
                        >
                          <td>
                            {titleCaseShip(mission.ship)}<br />
                            <span className="muted">{durationTypeLabel(mission.durationType)}</span>
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
                          <td>{mission.launches.toLocaleString()}</td>
                          <td>{formatDurationFromHours(mission.durationSeconds / 3600)}</td>
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
        </div>
      )}
    </main>
  );
}
