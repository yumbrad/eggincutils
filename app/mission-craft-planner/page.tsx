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
import { APP_BUILD } from "../../lib/app-build";
import { getCraftingLevelProgress } from "../../lib/crafting-levels";
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
import { plannerPlanFueling, writeSavedPlannerPlanLaunches } from "../../lib/preplan-import";
import { planLaunchProgress, type LaunchRecord, type PlanLaunchProgress } from "../../lib/launch-progress";
import useHighsWorker from "../../lib/use-highs-worker";
import { planForTarget, computeMonolithicPaths, type PlanBudget, type PlannerProgressEvent } from "../../lib/planner";
import { createDemoProfile, isBlankEid } from "../../lib/demo-profile";
import type { LootJson } from "../../lib/loot-data";
import type { DubcapPlan, DubcapScheduleBlock } from "../../lib/dubcap";
import { profileAfter } from "../../lib/in-flight";
import {
  bestStartTime,
  isAsleepAt,
  scheduleAroundSleep,
  sleepIntervals,
  sleepLengthMinutes,
  type ClockFixedLaunch,
  type ClockSchedule,
  type ClockScheduleInput,
  type ClockStage,
  type SleepWindow,
  type StartTimeOption,
} from "../../lib/sleep-schedule";
import type { LiveDubcapEvent } from "../../lib/dubcap-events";
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
  type VirtueFuelingShip,
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
import GoalRowsEditor, { formatShinyPercent, type GoalRowsChange } from "../goal-rows-editor";
import ProfileCustomizer, { useProfileOverrides } from "../profile-customizer";
import {
  applyProfileOverrides,
  profileOverrideCount,
  summarizeProfile,
  type ProfileOverrides,
  type ProfileSummary,
} from "../../lib/profile-overrides";
import {
  MAX_SHINY_GOAL_CRAFTS,
  SHINY_RARITY_LABELS,
  shinyOddsForPlan,
  shinyRaritiesFor,
  type ShinyGoalPlan,
  type ShinyOdds,
  type ShinyRarity,
} from "../../lib/shiny-odds";
import { durationLaunchPoints, getShipOrder, shipDisplayName as titleCaseShip, shipLevelPointThresholds } from "../../lib/ship-data";
import { isShipStarsItem, shipFromStarsItem, shipStarsGoalLabel, shipStarsTargetOptions } from "../../lib/ship-star-goals";
import {
  MAX_LOCKED_LAUNCH_ROWS,
  MAX_LOCKED_LAUNCHES_PER_ROW,
  sanitizeLockedLaunches,
  type LockedLaunch,
} from "../../lib/locked-launches";
import {
  SEND_DURATIONS,
  SEND_SHIPS,
  SEND_TARGET_OPTIONS,
  SEND_UNTARGETED_ONLY_SHIPS,
  type SendDurationType,
} from "../../lib/ship-sends";
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
  /** The tank the plan was solved from: `virtueTank` with the card's hand edits, when there were any. */
  plannedVirtueTank?: VirtueTankSnapshot;
  /** The dubcap running when the profile was read. */
  liveDubcap?: LiveDubcapEvent;
  /** Client-side: when that dubcap ends, from when the page read the profile. */
  liveDubcapEndsAtMs?: number;
  /** The newest launches from either farm; absent on profiles read before progress tracking. */
  recentLaunches?: LaunchRecord[];
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
    /** What each shiny goal became: the crafts that give its chance. */
    shinyGoals?: ShinyGoalPlan[];
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
      /** In-air rows launched in a dubcap: its multiplier, already in their drops. */
      inAirDubcapMultiplier?: number;
      /** Stable row id that virtue tank units point back at. */
      rowKey?: string;
      dubcap?: boolean;
      /** How many of the row's launches are locked launches. */
      lockedLaunches?: number;
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
      craftGoal?: boolean;
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
    dubcap?: DubcapPlan;
    budget?: PlanBudget;
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
  includeDubcap?: boolean;
  allowedShipDurations?: Array<{ ship: string; durationType: "SHORT" | "LONG" | "EPIC" }>;
  selectedConsumptionItemIds?: string[];
  /** Left out when there are none. */
  lockedLaunches?: LockedLaunch[];
  /** Fly only the locked launches; left out when off or there are none. */
  onlyLockedLaunches?: boolean;
  /** Finish by (epoch ms); left out when there's no finish time. */
  finishByMs?: number;
  /** Snapshot files only: the finish time as the plan got it, in seconds from when it was built. */
  finishWithinSeconds?: number;
  /** A start later than when the plan is built (epoch ms); left out for a start now. */
  startAtMs?: number;
  /** A finish-time plan that starts at a dubcap expected then (epoch ms): the finish time counts from it. */
  dubcapStartMs?: number;
  /** Snapshot files only: how far ahead the start was, in seconds; the plan moved ships in the air on that much. */
  startDelaySeconds?: number;
  /** Path of Virtue only: the shift-cap slider and the Initial Tank toggle. */
  virtueShiftCap?: number;
  virtueStartTank?: VirtueTankStartMode;
};

type LastSolveInputs = SolveSnapshotRequest & {
  eid: string;
  sourceFilters: PlannerSourceFilters;
  /** Customized profile values the plan used; absent when none were set. */
  profileOverrides?: ProfileOverrides;
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
  lastSolveRequest: LastSolveInputs,
  savedAt: string = new Date().toISOString()
): void {
  const session: PersistedPlannerSession = {
    schemaVersion: 1,
    savedAt,
    response,
    profileSnapshot,
    lastSolveRequest,
  };
  writeStoredString([LOCAL_PREF_KEYS.plannerSession], JSON.stringify(session));
}

/**
 * Load a downloaded plan file on this device: its goals, settings and plan
 * become the saved state the page restores on load, so a reload shows the
 * plan as if it had been built here. The file's EID is redacted, so the plan
 * takes this device's EID. Returns why the file can't be loaded, or null.
 */
function storePlanFile(raw: string, deviceEid: string): string | null {
  let file: Partial<SolveInputSnapshotFile>;
  try {
    file = JSON.parse(raw) as Partial<SolveInputSnapshotFile>;
  } catch {
    return "That file isn't a plan file (it isn't JSON).";
  }
  if (
    file?.kind !== "mission-craft-planner-solve-input" ||
    file.schemaVersion !== 1 ||
    !isPlainObject(file.request) ||
    !isPlainObject(file.sourceFilters) ||
    !isPlainObject(file.profile) ||
    !isPlainObject(file.output) ||
    !isPlainObject(file.output.plan) ||
    !isPlainObject(file.output.profile)
  ) {
    return "That file isn't a plan file. Use one saved with Save plan file or Download solve snapshot.";
  }
  const demo = file.profile.eid === "DEMO";
  if (!demo && !deviceEid) {
    return "Enter your EID first, then load the plan file.";
  }
  const profileEid = demo ? "DEMO" : deviceEid;
  const request = file.request as SolveSnapshotRequest;
  const sourceFilters = file.sourceFilters as PlannerSourceFilters;
  const source: InventorySource = sourceFilters.inventorySource === "virtue" ? "virtue" : "main";
  const response = {
    profile: { ...file.output.profile, eid: profileEid },
    plan: file.output.plan,
  } as PlanResponse;
  const profileSnapshot = { ...file.profile, eid: profileEid } as ProfileSnapshot;
  if (!isRestorableVirtueTankSession(response.plan.virtueTanks, profileSnapshot.virtueTank)) {
    return "That plan file is from an older version of the planner and can't be loaded.";
  }
  // What the page compares its inputs against leaves out snapshot-only fields.
  const requestInputs: SolveSnapshotRequest = { ...request };
  delete requestInputs.finishWithinSeconds;
  delete requestInputs.startDelaySeconds;
  const lastSolveRequest: LastSolveInputs = {
    ...requestInputs,
    eid: demo ? "" : deviceEid,
    sourceFilters: { ...sourceFilters, inventorySource: source },
    ...(file.profileOverrides ? { profileOverrides: file.profileOverrides } : {}),
  };
  const plannedAt = file.output.plannedAt || file.capturedAt || new Date().toISOString();

  const allowed = request.allowedShipDurations;
  const shipDurations = buildDefaultShipDurations();
  if (allowed) {
    for (const durations of Object.values(shipDurations)) {
      durations.SHORT = durations.LONG = durations.EPIC = false;
    }
    for (const entry of allowed) {
      if (shipDurations[entry.ship]) {
        shipDurations[entry.ship][entry.durationType] = true;
      }
    }
  }
  writePlannerSourcePreferences(source, {
    targetRows: request.targets?.length ? request.targets : [{ targetItemId: request.targetItemId, quantity: request.quantity }],
    targetCraftedOnly: request.targetCraftedOnly,
    includeSlotted: sourceFilters.includeSlotted,
    includeInventoryRare: sourceFilters.includeInventoryRare,
    includeInventoryEpic: sourceFilters.includeInventoryEpic,
    includeInventoryLegendary: sourceFilters.includeInventoryLegendary,
    includeInventoryFragments: sourceFilters.includeInventoryFragments,
    includeDropRare: sourceFilters.includeDropRare,
    includeDropEpic: sourceFilters.includeDropEpic,
    includeDropLegendary: sourceFilters.includeDropLegendary,
    includeDropFragments: sourceFilters.includeDropFragments,
    ...(request.selectedConsumptionItemIds ? { selectedConsumptionItemIds: request.selectedConsumptionItemIds } : {}),
    shipDurations,
    lockedLaunches: sanitizeLockedLaunches(request.lockedLaunches),
    ...(request.onlyLockedLaunches ? { onlyLockedLaunches: true } : {}),
    ...(request.finishByMs != null && request.finishByMs > Date.now() ? { finishByMs: request.finishByMs, finishByOn: true } : {}),
  });
  writeStoredString([LOCAL_PREF_KEYS.plannerInventorySource], source);
  if (source === "main") {
    writeStoredString([LOCAL_PREF_KEYS.plannerPriorityTimePct], String(Math.round(request.priorityTime * 100)));
  }
  if (request.virtueShiftCap != null) {
    writeStoredString([LOCAL_PREF_KEYS.plannerVirtueShiftCap], String(request.virtueShiftCap));
  }
  if (request.virtueStartTank) {
    writeStoredString([LOCAL_PREF_KEYS.plannerVirtueStartTank], request.virtueStartTank);
  }
  writeStoredBoolean([LOCAL_PREF_KEYS.plannerFastMode], Boolean(request.fastMode));
  writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDubcap], Boolean(request.includeDubcap));
  writePersistedPlannerSession(response, profileSnapshot, lastSolveRequest, plannedAt);
  if (!demo) {
    writeSavedPlannerPlanLaunches(source, {
      savedAt: plannedAt,
      eid: deviceEid,
      plan: { ...response.plan, fueling: plannerPlanFueling(response.plan) },
    });
  }
  return null;
}

type SolveSnapshotCombo = {
  ship: string;
  durationType: DurationType;
  targetAfxId: number;
};

/**
 * The download: the solve's inputs (what scripts/mission-craft-run-snapshot.ts
 * replays) and, under `output`, the plan they produced. `kind` stays
 * "solve-input" because the replay script checks it; readers skip sections
 * they don't use.
 */
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
  /** Customized profile values the plan used, so a loaded file plans the same way. */
  profileOverrides?: ProfileOverrides;
  output: {
    /** When the plan was solved (or restored from the saved session). */
    plannedAt: string | null;
    /** The plan response as the planner returned it, EID redacted. */
    profile: PlanResponse["profile"];
    plan: PlanResponse["plan"];
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

type ShinyOddsPill = {
  rarity: ShinyRarity;
  chance: number;
  /** The shiny goal's chance, on the rarity it aims for. */
  goalChance: number | null;
  title: string;
};

type CraftPlanDetailRow = {
  itemId: string;
  /** Set when a craft-count goal put this row in the table. */
  craftGoalLabel: string | null;
  /** A goal artifact's odds of ending with each shiny rarity, when there's any chance. */
  shinyOdds: ShinyOddsPill[] | null;
  /** One of the goals you entered (copies, craft count or shiny). */
  isGoal: boolean;
  plannedCraftCount: number;
  have: number | null;
  requiredForChain: number;
  expectedMission: number;
  fromConsumption: number;
  consumedCount: number;
  /** XP from this row's own planned crafts; its ingredients' crafts count on their own rows. */
  craftXp: number;
  plannedCraftTooltip: string | null;
  neededTooltip: string | null;
  expectedMissionTooltip: string | null;
  fromConsumptionTooltip: string | null;
  consumedTooltip: string | null;
};

/**
 * Gained (+, stones and fragments from consuming artifacts) or consumed (−,
 * artifacts). Consumption only yields stones and only artifacts are consumed,
 * so a row has one or the other; both show if that ever changes.
 */
function CraftConsumptionCell({ craft }: { craft: CraftPlanDetailRow }): JSX.Element {
  const parts: Array<{ text: string; tooltip: string | null }> = [];
  if (craft.fromConsumption > 0) {
    parts.push({
      text: `+${craft.fromConsumption.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
      tooltip: craft.fromConsumptionTooltip,
    });
  }
  if (craft.consumedCount > 0) {
    parts.push({ text: `−${craft.consumedCount.toLocaleString()}`, tooltip: craft.consumedTooltip });
  }
  if (parts.length === 0) {
    return <>—</>;
  }
  return (
    <>
      {parts.map((part, index) => (
        <span key={part.text}>
          {index > 0 && " / "}
          <span className={part.tooltip ? styles.tooltipValue : undefined} title={part.tooltip || undefined}>
            {part.text}
          </span>
        </span>
      ))}
    </>
  );
}

/** A plan's chance as a whole percent, never rounded to a certain 100% (or to 0% when there's any chance). */
function formatOddsPercent(chance: number): string {
  const percent = chance * 100;
  if (percent <= 0) {
    return "0%";
  }
  if (percent < 0.5) {
    return "<1%";
  }
  // Never certain: hundreds of crafts round to exactly 1 in floating point.
  if (percent >= 99.5) {
    return ">99%";
  }
  return `${Math.round(percent)}%`;
}

/**
 * The odds pills for a goal artifact: each of its shiny rarities' chance of at
 * least one by the end of the plan, with where it comes from in the tooltip.
 * Null when nothing in the plan can make it shiny and no shiny goal asks.
 */
function buildShinyOddsPills(odds: ShinyOdds[], goal: ShinyGoalPlan | undefined, itemLabel: string): ShinyOddsPill[] | null {
  if (odds.length === 0 || (!goal && odds.every((entry) => entry.chance <= 0))) {
    return null;
  }
  return odds.map((entry) => {
    const name = SHINY_RARITY_LABELS[entry.rarity];
    const rolls = entry.crafts;
    const lines = [
      `${name}: ${formatOddsPercent(entry.chance)} chance of at least one ${itemLabel} ${
        entry.rarity === "legendary" ? "" : "of this rarity or better "
      }by the end of the plan.`,
    ];
    if (rolls.crafts > 0) {
      const each =
        rolls.firstChance === rolls.lastChance
          ? formatShinyPercent(rolls.firstChance)
          : `${formatShinyPercent(rolls.firstChance)} → ${formatShinyPercent(rolls.lastChance)}`;
      const levels =
        rolls.startLevel === rolls.endLevel
          ? `crafting level ${rolls.startLevel}`
          : `crafting level ${rolls.startLevel} → ${rolls.endLevel}`;
      lines.push(
        `From ${rolls.crafts.toLocaleString()} planned ${rolls.crafts === 1 ? "craft" : "crafts"}: ${each} each (crafted ${rolls.craftedBefore.toLocaleString()} → ${(rolls.craftedBefore + rolls.crafts).toLocaleString()}, ${levels}): ${formatOddsPercent(rolls.chance)} from crafting alone.`
      );
    } else {
      lines.push("No planned crafts.");
    }
    if (entry.drops > 0) {
      lines.push(
        `From drops: ${entry.drops.toLocaleString(undefined, { maximumFractionDigits: 3 })} expected from the planned missions: ${formatOddsPercent(1 - Math.exp(-entry.drops))} from drops alone.`
      );
    }
    const goalChance = goal && goal.rarity === entry.rarity ? goal.targetChance : null;
    if (goalChance != null && goal) {
      lines.push(
        goal.reached
          ? `Goal: ${Math.round(goalChance * 100)}%, which takes ${goal.crafts.toLocaleString()} ${goal.crafts === 1 ? "craft" : "crafts"} from crafting alone; drops and ingredient crafts' XP add the rest.`
          : `Goal: ${Math.round(goalChance * 100)}%, more than ${MAX_SHINY_GOAL_CRAFTS.toLocaleString()} crafts can reach.`
      );
    }
    if (entry.rarity !== "legendary" && rolls.crafts > 0 && entry.lastExactChance < 0.0005) {
      const higher = entry.rarity === "rare" ? "epic or better" : "legendary";
      lines.push(
        `By the last planned craft, a craft can't come out exactly ${entry.rarity}: at this crafting level and craft count, ${higher} takes its whole share. Crafts count toward ${name} only by landing ${higher}${
          entry.drops > 0 ? `; the rest of this chance comes from ${entry.rarity} drops` : ""
        }.`
      );
    }
    return { rarity: entry.rarity, chance: entry.chance, goalChance, title: lines.join("\n") };
  });
}

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
  lockedLaunches?: LockedLaunch[];
  onlyLockedLaunches?: boolean;
  /** Finish by (epoch ms), dropped once it has passed; kept while unticked so ticking brings it back. */
  finishByMs?: number;
  finishByOn?: boolean;
  /** When the plan starts; times that have passed are dropped. */
  startMode?: PlanStartMode;
  startAtMs?: number;
  dubcapStartMs?: number;
};

/** Now, when a dubcap starts (one running now, or the time set for the next), or a time set by hand. */
type PlanStartMode = "now" | "dubcap" | "custom";

/** Bedtime and wake-up, saved for every farm (LOCAL_PREF_KEYS.plannerSleep). */
type SleepPreferences = { on: boolean; bedMinutes: number; wakeMinutes: number };

const DEFAULT_SLEEP: SleepPreferences = { on: false, bedMinutes: 23 * 60, wakeMinutes: 7 * 60 };
/** The player is up when they build a plan: sends in its first half hour never wait for the morning. */
const AWAKE_AT_START_SECONDS = 30 * 60;

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

type MissionSegments = {
  segments: TimelineSegment[];
  prepSegments: TimelineSegment[];
  missionSegments: TimelineSegment[];
  missionSlotSeconds: number;
  prepSlotSeconds: number;
  modelTotalSlotSeconds: number;
  hiddenPrepSlotSeconds: number;
  missionColorByKey: Map<string, string>;
};

/** The plan's launches as timeline segments (prep, then mission rows less the prep they cover). */
function buildMissionSegments(plan: PlanResponse["plan"]): MissionSegments {
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
  return {
    segments,
    prepSegments,
    missionSegments,
    missionSlotSeconds,
    prepSlotSeconds,
    modelTotalSlotSeconds,
    hiddenPrepSlotSeconds,
    missionColorByKey,
  };
}

/** In-air ships hold the slots first, the longest wait on slot 1 (as the planners seed them). */
function inAirTimelineSeeds(plan: PlanResponse["plan"], missionColorByKey: Map<string, string>) {
  return plan.missions
    .filter((mission) => mission.inAir)
    .flatMap((mission) =>
      (mission.launchSecondsRemaining || [mission.secondsRemaining || 0]).map((seconds) => ({
        mission,
        seconds: Math.max(0, Math.round(seconds)),
      }))
    )
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 3)
    .map(({ mission, seconds }) => ({
      mission,
      seconds,
      label: `${titleCaseShip(mission.ship)} ${durationTypeWithLevelLabel(mission.durationType, mission.level)}`,
      subtitle: `In air · ${afxIdToTargetFamilyName(mission.targetAfxId)}`,
      color: missionColorByKey.get(missionColorKey(mission)) || prepTimelineColor(missionColorKey(mission)),
    }));
}

function buildMissionTimeline(plan: PlanResponse["plan"]): MissionTimeline | null {
  if (plan.dubcap) return buildDubcapTimeline(plan);
  const {
    segments,
    missionSlotSeconds,
    prepSlotSeconds,
    modelTotalSlotSeconds,
    hiddenPrepSlotSeconds,
    missionColorByKey,
  } = buildMissionSegments(plan);

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

/** A dubcap schedule block's legend entry: one per mission row (event launches apart from ordinary ones) or prep shape. */
function dubcapBlockLook(plan: PlanResponse["plan"], block: DubcapScheduleBlock, colors: Map<string, string>) {
  const mission = plan.missions.find((row) => row.rowKey === block.missionRowKey);
  const colorKey = mission ? missionColorKey(mission) : `${block.ship}|${block.durationType}`;
  const phase: "prep" | "mission" = block.isPrep ? "prep" : "mission";
  const id = block.isPrep
    ? `event-prep:${block.ship}|${block.durationType}|${block.level}`
    : `event-plan:${block.fueling ? "fueling" : block.missionRowKey ?? colorKey}:${block.dubcap ? "dubcap" : block.locked ? "locked" : "ordinary"}`;
  return {
    id,
    label: `${titleCaseShip(block.ship)} ${durationTypeWithLevelLabel(block.durationType, block.level)}`,
    subtitle: `${block.fueling ? "Partly fueled · " : ""}${block.locked ? "Locked · " : ""}${block.isPrep ? "Prep" : afxIdToTargetFamilyName(block.targetAfxId ?? 10000)}${block.dubcap ? ` · dubcap ×${plan.dubcap?.multiplier ?? 2}` : ""}`,
    phase,
    color: colors.get(colorKey) ?? prepTimelineColor(colorKey),
  };
}

function buildDubcapTimeline(plan: PlanResponse["plan"]): MissionTimeline | null {
  const event = plan.dubcap!;
  const colors = buildMissionColorMap(plan.missions);
  // One legend entry per mission row (event launches apart from ordinary
  // ones) or prep shape; lane blocks are the runs that make it up.
  const segmentsById = new Map<string, TimelineSegment>();
  const lanes: TimelineLaneBlock[][] = event.fullLanes.map((lane, laneIndex) => lane.map((block, index) => {
    const { id, label, subtitle, phase, color } = dubcapBlockLook(plan, block, colors);
    const totalSeconds = block.endSeconds - block.startSeconds;
    let segment = segmentsById.get(id);
    if (!segment) {
      segment = {
        id,
        label,
        subtitle,
        phase,
        color,
        launches: 0,
        durationSeconds: totalSeconds / block.launches,
        totalSlotSeconds: 0,
        ship: block.ship,
        durationType: block.durationType,
        level: block.level,
        targetAfxId: block.targetAfxId ?? null,
      };
      segmentsById.set(id, segment);
    }
    segment.launches += block.launches;
    segment.totalSlotSeconds += totalSeconds;
    return {
      id: `${id}:lane:${laneIndex}:${index}`,
      label: segment.label,
      subtitle: segment.subtitle,
      phase,
      color: segment.color,
      launches: block.launches,
      totalSeconds,
      startSeconds: block.startSeconds,
      endSeconds: block.endSeconds,
    };
  }));
  const inAir = plan.missions.filter((mission) => mission.inAir)
    .flatMap((mission) => (mission.launchSecondsRemaining ?? [mission.secondsRemaining ?? 0]).map((seconds) => ({ mission, seconds })))
    .sort((a, b) => b.seconds - a.seconds).slice(0, 3);
  inAir.forEach(({ mission, seconds }, lane) => {
    lanes[lane].unshift({ id: `event-air:${lane}`, label: titleCaseShip(mission.ship), subtitle: "In air",
      phase: "inAir", color: colors.get(missionColorKey(mission)) ?? prepTimelineColor(mission.ship),
      launches: 1, totalSeconds: seconds, startSeconds: 0, endSeconds: seconds });
  });
  const segments = Array.from(segmentsById.values());
  const slotSeconds = (phase: TimelineSegment["phase"]) =>
    segments.filter((segment) => segment.phase === phase).reduce((sum, segment) => sum + segment.totalSlotSeconds, 0);
  const missionSlotSeconds = slotSeconds("mission");
  const prepSlotSeconds = slotSeconds("prep");
  return event.makespanSeconds > 0
    ? {
        lanes,
        segments: sortTimelineSegmentsForLegend(segments),
        totalSeconds: event.makespanSeconds,
        modelTotalSlotSeconds: missionSlotSeconds + prepSlotSeconds,
        missionSlotSeconds,
        prepSlotSeconds,
        hiddenPrepSlotSeconds: 0,
      }
    : null;
}

/** How a clock-schedule key is drawn. */
type ClockDisplay = {
  label: string;
  subtitle: string;
  color: string;
  phase: TimelineSegment["phase"];
  /** The fuel tank it launches from (Path of Virtue). */
  tankIndex?: number;
  /** The dubcap schedule block it came from, for the event's launch table. */
  block?: DubcapScheduleBlock;
};

type ClockInAirSeed = { label: string; subtitle: string; color: string; seconds: number };

/** A plan's launches as the sleep-aware scheduler takes them, and how to draw its keys. */
type PlanClockParts = {
  input: Omit<ClockScheduleInput, "startMs" | "sleep">;
  display: Map<string, ClockDisplay>;
  inAir: ClockInAirSeed[];
};

type PlanClock = PlanClockParts & { input: ClockScheduleInput; schedule: ClockSchedule };

function addClockKind(kinds: ClockStage["kinds"], kind: ClockStage["kinds"][number]): void {
  const existing = kinds.find((entry) => entry.key === kind.key);
  if (existing) {
    existing.count += kind.count;
  } else {
    kinds.push({ ...kind });
  }
}

/**
 * Main farm: prep first, in any order, then the mission rows in any order,
 * each ship's levels in turn. Unattributed prep slot time sits at the front
 * of every slot.
 */
function mainFarmClockParts(plan: PlanResponse["plan"]): PlanClockParts | null {
  const built = buildMissionSegments(plan);
  const inAir = inAirTimelineSeeds(plan, built.missionColorByKey);
  if (built.segments.length === 0 && inAir.length === 0) {
    return null;
  }
  const display = new Map<string, ClockDisplay>(
    built.segments.map((segment) => [
      segment.id,
      { label: segment.label, subtitle: segment.subtitle, color: segment.color, phase: segment.phase },
    ])
  );
  const prepKinds = built.prepSegments
    .filter((segment) => segment.launches > 0)
    .map((segment) => ({ key: segment.id, durationSeconds: segment.durationSeconds, count: segment.launches }));
  // The heuristic timeline's packing order, so the unchanged order is the one it draws.
  const missionKinds = groupTimelineSegmentsForLaneBalance(built.missionSegments)
    .flatMap((group) => groupTimelineSegmentsByPhase(group).flat())
    .map((segment) => ({
      key: segment.id,
      durationSeconds: segment.durationSeconds,
      count: segment.launches,
      chain: `${segment.ship}|${segment.durationType}`,
      rank: segment.level ?? 0,
    }));
  const fixed: ClockFixedLaunch[] =
    built.hiddenPrepSlotSeconds > 0
      ? [0, 1, 2].map((lane) => ({
          key: "prep-residual",
          lane,
          startSeconds: 0,
          durationSeconds: built.hiddenPrepSlotSeconds / 3,
          pseudo: true,
        }))
      : [];
  return {
    input: {
      laneFreeSeconds: inAir.map((seed) => seed.seconds),
      fixed,
      stages: [{ kinds: prepKinds }, { kinds: missionKinds }],
    },
    display,
    inAir,
  };
}

/**
 * Dubcap plans: prep and locked launches keep their slots and order ahead of
 * the event; the event's launches go in any order (tank by tank) as long as
 * they leave by its last-launch time; ordinary launches follow once the event
 * is over and its ships are back. `anchorSeconds` pins a fresh event to its
 * expected start.
 */
function dubcapClockParts(plan: PlanResponse["plan"], anchorSeconds: number | null): PlanClockParts | null {
  const event = plan.dubcap;
  if (!event) {
    return null;
  }
  const colors = buildMissionColorMap(plan.missions);
  const inAir = inAirTimelineSeeds(plan, colors);
  const display = new Map<string, ClockDisplay>();
  const fixed: ClockFixedLaunch[] = [];
  let fueling: ClockStage | null = null;
  const eventByTank = new Map<number, ClockStage["kinds"]>();
  const ordinaryByTank = new Map<number, ClockStage["kinds"]>();
  const blocks = event.fullLanes
    .flatMap((lane, laneIndex) => lane.map((block) => ({ block, laneIndex })))
    .sort((a, b) => a.block.startSeconds - b.block.startSeconds || a.laneIndex - b.laneIndex);
  for (const { block, laneIndex } of blocks) {
    if (block.launches <= 0) continue;
    const look = dubcapBlockLook(plan, block, colors);
    const key = block.tankIndex != null ? `${look.id}|tank${block.tankIndex}` : look.id;
    if (!display.has(key)) {
      display.set(key, { label: look.label, subtitle: look.subtitle, color: look.color, phase: look.phase, tankIndex: block.tankIndex, block });
    }
    const each = (block.endSeconds - block.startSeconds) / block.launches;
    const kind = { key, durationSeconds: each, count: block.launches, chain: `${block.ship}|${block.durationType}`, rank: block.level };
    if (block.dubcap && block.fueling) {
      if (event.live) {
        fixed.push({ key, lane: laneIndex, startSeconds: block.startSeconds, durationSeconds: each, event: true });
      } else {
        fueling = { event: true, ordered: true, kinds: [{ key, durationSeconds: each, count: 1 }] };
      }
    } else if (block.dubcap) {
      const kinds = eventByTank.get(block.tankIndex ?? 0) ?? [];
      addClockKind(kinds, kind);
      eventByTank.set(block.tankIndex ?? 0, kinds);
    } else if (block.isPrep || block.locked) {
      for (let launch = 0; launch < block.launches; launch += 1) {
        fixed.push({ key, lane: laneIndex, startSeconds: block.startSeconds + launch * each, durationSeconds: each });
      }
    } else {
      const kinds = ordinaryByTank.get(block.tankIndex ?? 0) ?? [];
      addClockKind(kinds, kind);
      ordinaryByTank.set(block.tankIndex ?? 0, kinds);
    }
  }
  const byTank = (stages: Map<number, ClockStage["kinds"]>) => Array.from(stages.entries()).sort((a, b) => a[0] - b[0]);
  const stages: ClockStage[] = [
    ...(fueling ? [fueling] : []),
    ...byTank(eventByTank).map(([, kinds]): ClockStage => ({ event: true, kinds })),
    ...byTank(ordinaryByTank).map(([, kinds], index): ClockStage => ({
      gate: index === 0 ? "return" : "start",
      chainGate: "return",
      kinds,
    })),
  ];
  return {
    input: {
      laneFreeSeconds: inAir.map((seed) => seed.seconds),
      fixed,
      stages,
      event: {
        windowSeconds: event.windowSeconds,
        marginSeconds: event.launchMarginSeconds,
        ...(event.live ? { startSeconds: 0 } : anchorSeconds != null ? { startSeconds: Math.max(0, anchorSeconds) } : {}),
      },
    },
    display,
    inAir,
  };
}

/**
 * Path of Virtue: tank by tank in the packer's order. Within a tank the
 * launches go in any order (they share its fuel), locked launches and each
 * prep phase first.
 */
function virtueClockParts(plan: PlanResponse["plan"], view: VirtueTankPlanView): PlanClockParts | null {
  const unitById = new Map(view.result.units.map((unit) => [unit.id, unit]));
  const inAir = inAirTimelineSeeds(plan, buildMissionColorMap(plan.missions));
  const display = new Map<string, ClockDisplay>();
  const stages: ClockStage[] = [];
  let stageKey: string | null = null;
  for (const entry of view.pack.launchOrder) {
    const unit = unitById.get(entry.unitId);
    if (!unit || entry.launches <= 0) continue;
    const kindOf = unit.locked ? "locked" : unit.isPrep || unit.preFueled ? `prep:${unit.prepOrder ?? 0}` : "fly";
    const nextKey = `${entry.tankIndex}|${kindOf}`;
    if (nextKey !== stageKey) {
      stages.push({ kinds: [] });
      stageKey = nextKey;
    }
    const key = `${entry.unitId}|tank${entry.tankIndex}`;
    const unitView = view.units.get(entry.unitId);
    if (!display.has(key)) {
      display.set(key, {
        label: unitView?.label ?? entry.unitId,
        subtitle: unitView?.subtitle ?? "",
        color: unitView?.color ?? prepTimelineColor(entry.unitId),
        phase: unitView && unitView.missionIndex == null ? "prep" : "mission",
        tankIndex: entry.tankIndex,
      });
    }
    addClockKind(stages[stages.length - 1].kinds, {
      key,
      durationSeconds: unit.durationSeconds,
      count: entry.launches,
      chain: `${unit.ship}|${unit.durationType}`,
      rank: unit.level,
    });
  }
  if (stages.length === 0 && inAir.length === 0) {
    return null;
  }
  return { input: { laneFreeSeconds: inAir.map((seed) => seed.seconds), stages }, display, inAir };
}

function clockAt(startMs: number, seconds: number): string {
  return formatClockTime(new Date(startMs + seconds * 1000), startMs);
}

/** The plan's three slots on the clock: nights shaded, waits for the morning marked. */
function ClockLanes({ clock, sleep }: { clock: PlanClock; sleep: SleepWindow | null }) {
  const { schedule, display, inAir } = clock;
  const startMs = schedule.startMs;
  const totalSeconds = Math.max(1, schedule.makespanSeconds, ...inAir.map((seed) => seed.seconds));
  const at = (seconds: number) => Math.max(0, Math.min(100, (seconds / totalSeconds) * 100));
  const nights = sleep
    ? sleepIntervals(startMs, startMs + totalSeconds * 1000, sleep).map((night) => ({
        from: (night.fromMs - startMs) / 1000,
        to: (night.toMs - startMs) / 1000,
      }))
    : [];
  // Midnights, labeled with the day they start (thinned out on long plans).
  const days: Array<{ seconds: number; label: string }> = [];
  const midnight = new Date(startMs);
  midnight.setHours(24, 0, 0, 0);
  while (midnight.getTime() < startMs + totalSeconds * 1000 && days.length < 400) {
    days.push({
      seconds: (midnight.getTime() - startMs) / 1000,
      label: midnight.toLocaleDateString(undefined, { weekday: "short" }),
    });
    midnight.setDate(midnight.getDate() + 1);
  }
  const labelEvery = Math.max(1, Math.ceil(days.length / 10));
  const nightBands = nights.map((night, index) => (
    <div
      key={`night:${index}`}
      className={styles.clockNight}
      style={{ left: `${at(night.from)}%`, width: `${at(night.to) - at(night.from)}%` }}
      aria-hidden="true"
    />
  ));
  return (
    <div className={styles.timelineLanes}>
      {schedule.lanes.map((lane, laneIndex) => {
        const seed = inAir[laneIndex];
        let cursor = 0;
        const items: ReactNode[] = [];
        if (seed && seed.seconds > 0) {
          items.push(
            <div
              key="in-air"
              className={styles.timelineBlock}
              data-phase="inAir"
              style={{ left: "0%", width: `${Math.max(at(seed.seconds), 0.7)}%`, "--timeline-block-color": seed.color } as CSSProperties}
              title={[seed.label, seed.subtitle, "Already launched — this slot is busy until it lands", `Lands ${clockAt(startMs, seed.seconds)}`].join("\n")}
            >
              <span className={styles.timelineBlockLabel}>in air</span>
            </div>
          );
          cursor = seed.seconds;
        }
        lane.forEach((block, blockIndex) => {
          const waitFrom = block.waitFromSeconds ?? block.startSeconds;
          if (waitFrom - cursor > 60) {
            items.push(
              <div
                key={`idle:${blockIndex}`}
                className={styles.timelineIdle}
                style={{ left: `${at(cursor)}%`, width: `${at(waitFrom) - at(cursor)}%` }}
                title={`Slot idle ${formatDurationFromHours((waitFrom - cursor) / 3600)}`}
              />
            );
          }
          if (block.waitFromSeconds != null) {
            items.push(
              <div
                key={`wait:${blockIndex}`}
                className={styles.clockWait}
                style={{ left: `${at(block.waitFromSeconds)}%`, width: `${at(block.startSeconds) - at(block.waitFromSeconds)}%` }}
                title={`Back ${clockAt(startMs, block.waitFromSeconds)} while you're asleep: the next send waits until ${clockAt(startMs, block.startSeconds)}`}
              />
            );
          }
          const look = display.get(block.key);
          const each = (block.endSeconds - block.startSeconds) / Math.max(1, block.launches);
          items.push(
            <div
              key={`block:${blockIndex}`}
              className={styles.timelineBlock}
              data-phase={look?.phase ?? "mission"}
              data-alarm={block.alarm || block.late ? "1" : undefined}
              style={
                {
                  left: `${at(block.startSeconds)}%`,
                  width: `${Math.max(at(block.endSeconds) - at(block.startSeconds), 0.7)}%`,
                  "--timeline-block-color": look?.color,
                } as CSSProperties
              }
              title={[
                look?.label ?? block.key,
                look?.subtitle ?? "",
                block.pseudo
                  ? "Progression-only slot workload"
                  : block.launches > 1
                    ? `${block.launches.toLocaleString()} launches, one every ${formatDurationFromHours(each / 3600)}`
                    : "1 launch",
                `${clockAt(startMs, block.startSeconds)} → ${clockAt(startMs, block.endSeconds)}`,
                ...(block.alarm ? ["Sent while you'd be asleep, to leave before the dubcap's last launch"] : []),
                ...(block.late ? ["Leaves after the dubcap's last launch: no double drops"] : []),
              ]
                .filter(Boolean)
                .join("\n")}
            >
              <span className={styles.timelineBlockLabel}>
                {look?.tankIndex != null && <span className={styles.timelineTankBadge}>{look.tankIndex + 1}</span>}
                {block.pseudo ? "prep" : `x${block.launches.toLocaleString()}`}
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
              {nightBands}
            </div>
          </div>
        );
      })}
      {days.length > 0 && (
        <div className={styles.timelineLaneRow} aria-hidden="true">
          <span />
          <div className={styles.clockAxis}>
            {days.map((day, index) =>
              index % labelEvery === 0 ? (
                <span key={day.seconds} style={{ left: `${at(day.seconds)}%` }}>
                  {day.label}
                </span>
              ) : null
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** What the clock schedule means for the player: when it ends, which relaunches wait for the morning. */
function ClockSummary({
  clock,
  sleep,
  finishByMs,
  dubcapAnchorMs,
  bestStart,
  onUseStart,
}: {
  clock: PlanClock;
  sleep: SleepWindow | null;
  finishByMs: number | null;
  dubcapAnchorMs: number | null;
  bestStart: { current: StartTimeOption; best: StartTimeOption } | null;
  onUseStart: (ms: number) => void;
}) {
  const { schedule, display } = clock;
  const startMs = schedule.startMs;
  const endMs = startMs + schedule.makespanSeconds * 1000;
  const slotLabel = (lane: number) => `Slot ${lane + 1}`;
  const nameOf = (key: string) => display.get(key)?.label ?? key;
  const prepEnd = Math.max(0, ...schedule.sends.filter((send) => !send.event).filter((send) => !schedule.event || send.startSeconds < schedule.event.startSeconds).map((send) => send.endSeconds));
  const lateForEvent = dubcapAnchorMs != null && schedule.event && prepEnd > schedule.event.startSeconds + 60;
  // Only a start that gets the plan done sooner is worth a mention: a wait overnight is just sleep.
  const better = bestStart && bestStart.best.offsetSeconds > 0 &&
    startMs + bestStart.best.offsetSeconds * 1000 > Date.now() &&
    bestStart.best.finishSeconds < bestStart.current.finishSeconds - 30 * 60
    ? bestStart.best
    : null;
  return (
    <div className={styles.clockSummary}>
      <p>
        {sleep ? (
          <>
            Sends only while you&apos;re up (asleep {formatTimeOfDay(sleep.bedMinutes)} – {formatTimeOfDay(sleep.wakeMinutes)}).{" "}
          </>
        ) : null}
        Starts <b>{formatShortDateTime(startMs)}</b>, last ship back <b>{formatShortDateTime(endMs)}</b>.
        {schedule.event && dubcapAnchorMs != null && (
          <> The dubcap starts <b>{formatShortDateTime(startMs + schedule.event.startSeconds * 1000)}</b>.</>
        )}
      </p>
      {lateForEvent && (
        <p className={styles.clockWarn}>
          Prep and current missions aren&apos;t back until {formatShortDateTime(startMs + prepEnd * 1000)}, after the dubcap
          starts: its launches wait for them.
        </p>
      )}
      {sleep &&
        (schedule.waits.length === 0 ? (
          <p>Every relaunch lands while you&apos;re up.</p>
        ) : (
          <details className={styles.clockWaits}>
            <summary>
              {pluralize(schedule.waits.length, "relaunch waits", "relaunches wait")} for the morning (
              {formatDurationFromHours(schedule.waitSeconds / 3600)} idle in all).
            </summary>
            <ul>
              {schedule.waits.slice(0, 12).map((send, index) => (
                <li key={index}>
                  {slotLabel(send.lane)} frees up {clockAt(startMs, send.readySeconds)}: send the {nameOf(send.key)} at{" "}
                  {clockAt(startMs, send.startSeconds)}
                </li>
              ))}
              {schedule.waits.length > 12 && <li>…and {schedule.waits.length - 12} more</li>}
            </ul>
          </details>
        ))}
      {schedule.alarms > 0 && (
        <p className={styles.clockWarn}>
          To leave before the dubcap&apos;s last launch,{" "}
          {schedule.sends
            .filter((send) => send.alarm)
            .map((send) => `${slotLabel(send.lane)}'s ${nameOf(send.key)} goes at ${clockAt(startMs, send.startSeconds)}`)
            .join("; ")}
          , while you&apos;d be asleep.
        </p>
      )}
      {schedule.late > 0 && (
        <p className={styles.clockWarn}>
          {pluralize(schedule.late, "event launch leaves", "event launches leave")} after the dubcap&apos;s last launch time and
          won&apos;t get its drops.
        </p>
      )}
      {finishByMs != null && endMs > finishByMs + 60_000 && (
        <p className={styles.clockWarn}>
          {sleep ? "With your sleep hours, the" : "The"} last ship is back after your finish time ({formatShortDateTime(finishByMs)}).
        </p>
      )}
      {better && (
        <p className={styles.clockHint}>
          Start at <b>{formatShortDateTime(startMs + better.offsetSeconds * 1000)}</b> instead and{" "}
          {better.schedule.waits.length === 0
            ? "no relaunch waits for the morning"
            : `only ${pluralize(better.schedule.waits.length, "relaunch waits", "relaunches wait")} for the morning`}
          , and the last ship is back{" "}
          {formatDurationFromHours((bestStart!.current.finishSeconds - better.finishSeconds) / 3600)} sooner.{" "}
          <button type="button" className={styles.clockHintButton} onClick={() => onUseStart(startMs + better.offsetSeconds * 1000)}>
            Start then
          </button>
        </p>
      )}
    </div>
  );
}

function eventClock(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * The event's launches per slot, timed from the event's start (a fresh event)
 * or from when the profile was read (a live one). `tankLabels` names the fuel
 * tanks in Path of Virtue.
 */
function DubcapTimeline({ event, tankLabels, clockPlan }: { event: DubcapPlan; tankLabels?: string[]; clockPlan?: PlanClock | null }) {
  const drops = event.multiplier === 2 ? "double" : `${event.multiplier}×`;
  if (clockPlan?.schedule.event) {
    const startMs = clockPlan.schedule.startMs;
    const lanes = clockPlan.schedule.lanes.map((lane) => lane.filter((block) => block.event));
    const launches = lanes.flat().reduce((sum, block) => sum + block.launches, 0);
    return (
      <section className={styles.timelinePanel}>
        <h3 style={{ marginTop: 0 }}>{event.live ? "Live dubcap launches" : "Dubcap launch window"}</h3>
        <p className="muted">
          {pluralize(launches, "launch", "launches")} with {drops} drops. The event runs{" "}
          {clockAt(startMs, clockPlan.schedule.event.startSeconds)} to {clockAt(startMs, clockPlan.schedule.event.endSeconds)}; the last
          launch leaves by {clockAt(startMs, clockPlan.schedule.event.lastLaunchSeconds)}.
        </p>
        {launches > 0 ? (
          <div className={styles.dubcapLanes}>
            {lanes.map((lane, index) => (
              <div className={styles.dubcapLane} key={index}>
                <h4>Slot {index + 1}</h4>
                <table>
                  <thead><tr><th>Launch</th><th>Ship / target</th><th>Return</th></tr></thead>
                  <tbody>{lane.map((block, blockIndex) => {
                    const source = clockPlan.display.get(block.key)?.block;
                    const duration = (block.endSeconds - block.startSeconds) / block.launches;
                    return (
                      <tr key={`${block.key}:${blockIndex}`} data-alarm={block.alarm || block.late ? "1" : undefined}>
                        <td className={styles.dubcapClock}>
                          {clockAt(startMs, block.startSeconds)}
                          {block.launches > 1 && <>–{clockAt(startMs, block.endSeconds - duration)}</>}
                        </td>
                        <td>
                          {block.launches > 1 && <>{block.launches}× </>}{source ? titleCaseShip(source.ship) : block.key}<br />
                          {source && (
                            <span className="muted">
                              {durationTypeWithLevelLabel(source.durationType, source.level)} · {afxIdToTargetFamilyName(source.targetAfxId ?? 10000)}
                              {source.fueling && <> · partly fueled</>}
                            </span>
                          )}
                          {block.launches > 1 && <div className="muted">Every {formatDurationFromHours(duration / 3600)}</div>}
                          {source?.tankIndex != null && (
                            <div className="muted">{tankLabels?.[source.tankIndex] ?? `Tank ${source.tankIndex + 1}`}</div>
                          )}
                          {block.alarm && <div className={styles.clockWarn}>While you&apos;d be asleep</div>}
                          {block.late && <div className={styles.clockWarn}>After the last launch time</div>}
                        </td>
                        <td className={styles.dubcapClock}>{clockAt(startMs, block.endSeconds)}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
                {lane.length === 0 && <p className="muted">No event launches in this slot.</p>}
              </div>
            ))}
          </div>
        ) : <p className="muted">This plan needs no launches during the event.</p>}
      </section>
    );
  }
  // A live event's clock counts from now, so it reads "+h:mm".
  const clock = (seconds: number) => `${event.live ? "+" : ""}${eventClock(seconds)}`;
  return (
    <section className={styles.timelinePanel}>
      <h3 style={{ marginTop: 0 }}>{event.live ? "Live dubcap launches" : "Dubcap launch window"}</h3>
      {event.live ? (
        <p className="muted">
          {pluralize(event.launches, "launch", "launches")} with {drops} drops in the event running now. Times are from
          when your profile was read; the event ends at {clock(event.windowSeconds)}, so the last launch leaves by{" "}
          {clock(event.windowSeconds - event.launchMarginSeconds)}. Each slot joins once its ship in the air returns.
        </p>
      ) : (
        <p className="muted">
          {pluralize(event.launches, "launch", "launches")} with {drops} drops. Times are from the event&apos;s start; last
          launch by {eventClock(event.windowSeconds - event.launchMarginSeconds)}.
          {event.startSeconds > 0 && (
            <>
              {" "}
              {event.fullLanes.some((lane) => lane.some((block) => block.locked)) ? "Locked launches, prep" : "Prep"} and
              current missions take {formatDurationFromHours(event.startSeconds / 3600)} first.
            </>
          )}
        </p>
      )}
      {event.launches > 0 ? (
        <div className={styles.dubcapLanes}>
          {event.lanes.map((lane, index) => (
            <div className={styles.dubcapLane} key={index}>
              <h4>Slot {index + 1}</h4>
              <table>
                <thead><tr><th>Launch</th><th>Ship / target</th><th>Return</th></tr></thead>
                <tbody>{lane.map((block, blockIndex) => {
                  const duration = (block.endSeconds - block.startSeconds) / block.launches;
                  const lastStart = block.endSeconds - duration;
                  return (
                    <tr key={`${block.missionRowKey ?? "fueling"}:${blockIndex}`}>
                      <td className={styles.dubcapClock}>
                        {clock(block.startSeconds)}{block.launches > 1 && <>–{clock(lastStart)}</>}
                      </td>
                      <td>
                        {block.launches > 1 && <>{block.launches}× </>}{titleCaseShip(block.ship)}<br />
                        <span className="muted">
                          {durationTypeWithLevelLabel(block.durationType, block.level)} · {afxIdToTargetFamilyName(block.targetAfxId)}
                          {block.fueling && <> · partly fueled</>}
                        </span>
                        {block.launches > 1 && <div className="muted">Every {formatDurationFromHours(duration / 3600)}</div>}
                        {block.tankIndex != null && (
                          <div className="muted">{tankLabels?.[block.tankIndex] ?? `Tank ${block.tankIndex + 1}`}</div>
                        )}
                      </td>
                      <td className={styles.dubcapClock}>{clock(block.endSeconds)}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
              {lane.length === 0 && <p className="muted">No event launches in this slot.</p>}
            </div>
          ))}
        </div>
      ) : <p className="muted">This plan needs no launches during the event.</p>}
    </section>
  );
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
  /^No complete plan (within \d+ shifts|without shifts)/,
  /^Some goals could not be reached within \d+ shifts/,
  /^With \d+ shifts the goals take/,
];

/** Notes the page already shows in its own structure: drains, unplaced launches, the over-cap banner. */
const VIRTUE_TANK_NOTES_SHOWN_ELSEWHERE = [
  "Drain the leftover Humility",
  "Some refuel loops drain",
  "These goals need at least",
  "No plan within",
  "No plan without shifts",
  "No complete plan",
];

/**
 * The shift-cap banner's bold headline and the sentence after it. Current
 * plans stay within the cap and only warn about goal shortfalls; the other
 * cases are older saved plans whose launches exceed the cap.
 */
function shiftCapBannerCopy(
  tanks: VirtueTankPlannerResult,
  neededShifts: number | null,
  proven: boolean,
  hasShortfalls: boolean
): { headline: string; detail: string } {
  const cap = tanks.shiftCap;
  const withinCap = cap > 0 ? `within ${cap} shifts` : "without shifts";
  const provenNeed = `These goals need at least ${neededShifts} shifts; the slider allows ${cap}.`;
  if (hasShortfalls) {
    return {
      headline: neededShifts != null && proven ? provenNeed : `Some goals could not be reached ${withinCap}.`,
      detail:
        `Planned as much as possible within your cap (${pluralize(tanks.pack.totalShifts, "shift")}).` +
        (neededShifts != null && !proven ? ` A complete plan was found with ${neededShifts} shifts; fewer may be possible.` : ""),
    };
  }
  if (tanks.overCap) {
    return proven
      ? { headline: provenNeed, detail: `Planned with ${neededShifts} shifts.` }
      : {
          headline: `No plan ${withinCap} was found in the time allowed.`,
          detail: `This plan takes ${neededShifts} shifts; fewer may be possible.`,
        };
  }
  return {
    headline: `This plan takes ${neededShifts} shifts; the slider allows ${cap}.`,
    detail: "Packing its launches into tanks took more shifts than the solve counted.",
  };
}

/** Goal amounts in the shortfall list: crafts are whole, copies are expected values. */
function formatGoalAmount(value: number, craftGoal?: boolean): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: craftGoal ? 0 : 2 });
}

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
  /** Of `launches`, the row's locked ones (its locked unit's). */
  lockedLaunches: number;
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
    const lockedLaunches = unitView?.unit.locked ? entry.launches : 0;
    if (existing) {
      existing.launches += entry.launches;
      existing.lockedLaunches += lockedLaunches;
    } else {
      groups.push({
        key: missionIndex != null ? `row:${missionIndex}` : `unit:${entry.unitId}`,
        missionIndex,
        unitView,
        launches: entry.launches,
        lockedLaunches,
      });
    }
  }
  return groups;
}

function buildVirtueTankPlanView(
  plan: PlanResponse["plan"],
  snapshot: VirtueTankSnapshot | undefined,
  /** Launch times from the clock schedule (sleep or a dubcap's start), for the refuel windows. */
  clockLaunchStarts?: Array<{ tankIndex: number; at: number }>
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
      ? `${unit.locked ? "Locked · " : ""}${afxIdToTargetFamilyName(mission.targetAfxId)}${
          mission.dubcap ? ` · dubcap ×${plan.dubcap?.multiplier ?? 2}` : ""
        }`
      : unit.preFueled
        ? `Partly fueled · ${afxIdToTargetFamilyName(unit.targetAfxId ?? 10000)}${
            plan.dubcap?.lanes.some((lane) => lane.some((block) => block.fueling)) ? ` · dubcap ×${plan.dubcap.multiplier}` : ""
          } · add the rest and launch`
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
  const launchStarts: Array<{ tankIndex: number; at: number }> = clockLaunchStarts ? [...clockLaunchStarts] : [];
  for (const lane of clockLaunchStarts ? [] : pack.schedule.lanes) {
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

/**
 * Card A's hand edits to the tank, for planning from what it will hold rather than what the backup
 * says (say, mid-fill on Resilience): amounts per egg that replace the backup's readings. They hold
 * for one EID ("" for the demo tank) across newer backups, until "Use backup values".
 */
type VirtueTankEdits = {
  eid: string;
  fuels: Partial<Record<VirtueTankEggKey, number>>;
};

function parseStoredVirtueTankEdits(raw: string | null): VirtueTankEdits | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || typeof parsed.eid !== "string" || !isPlainObject(parsed.fuels)) {
      return null;
    }
    const fuels: Partial<Record<VirtueTankEggKey, number>> = {};
    for (const egg of VIRTUE_TANK_READOUT_ORDER) {
      const value = parsed.fuels[egg];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        fuels[egg] = value;
      }
    }
    return Object.keys(fuels).length > 0 ? { eid: parsed.eid, fuels } : null;
  } catch {
    return null;
  }
}

/** The tank with the card's hand edits in place, or as it is when they belong to another EID. */
function applyVirtueTankEdits(
  tank: VirtueTankSnapshot | null | undefined,
  edits: VirtueTankEdits | null,
  eid: string
): VirtueTankSnapshot | null | undefined {
  if (!tank || !edits || edits.eid !== eid) {
    return tank;
  }
  return { ...tank, fuels: { ...tank.fuels, ...edits.fuels } };
}

/** Tank amounts are typed in trillions from the 10T tank up, in billions below. */
function virtueTankEditUnit(capacity: number): { eggs: number; suffix: string } {
  return capacity >= 1e13 ? { eggs: 1e12, suffix: "T" } : { eggs: 1e9, suffix: "B" };
}

/** An amount as the edit field shows it: in the field's unit, as precise as the readout. */
function virtueTankEditText(amount: number, capacity: number): string {
  const unit = virtueTankEditUnit(capacity);
  const digits = Math.max(1, fractionDigitsForResolution(capacity / 100 / unit.eggs));
  const scale = 10 ** digits;
  return String(Math.round((Math.max(0, amount) / unit.eggs) * scale) / scale);
}

/**
 * Edits may fill the tank past its capacity: the first tank then plans as fuel the player will have
 * before their first refuel (a second trip, say). Each egg stops at this many tanks, against typos.
 */
const VIRTUE_TANK_EDIT_MAX_TANKS = 10;

/** A hand-entered amount on the tank's 1% grid (the game's limit and drain sliders: 5T steps on the 500T tank). */
function snapVirtueTankEdit(amount: number, capacity: number): number {
  const step = capacity / 100;
  const snapped = step > 0 ? Math.round(Math.max(0, amount) / step) * step : 0;
  return Math.max(0, Math.min(snapped, capacity * VIRTUE_TANK_EDIT_MAX_TANKS));
}

/**
 * Card A's readout of what is in the tank now, Humility included (hatched, never planned). With
 * `onEdit`, "Edit" turns the amounts into fields; `tank` carries the edits and `backup` the readings.
 */
function VirtueTankReadout({
  tank,
  backup,
  onEdit,
  onReset,
}: {
  tank: VirtueTankSnapshot;
  backup: VirtueTankSnapshot;
  onEdit?: (egg: VirtueTankEggKey, amount: number) => void;
  onReset: () => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<VirtueTankEggKey, string>>>({});
  const editing = editOpen && Boolean(onEdit);
  const capacity = tank.capacity;
  const unit = virtueTankEditUnit(capacity);
  const physical = VIRTUE_TANK_READOUT_ORDER.reduce((sum, egg) => sum + Math.max(0, tank.fuels[egg] || 0), 0);
  // An overfull (edited) tank draws to its total, with a mark where the tank's capacity ends.
  const overfull = physical - capacity > virtueFuelTolerance(capacity);
  const barScale = overfull ? physical : capacity;
  const isEdited = (egg: VirtueTankEggKey) => Math.abs((tank.fuels[egg] || 0) - (backup.fuels[egg] || 0)) > VIRTUE_FUEL_NOISE;
  const edited = VIRTUE_TANK_READOUT_ORDER.some(isEdited);

  const setAmount = (egg: VirtueTankEggKey, amount: number) => {
    onEdit?.(egg, snapVirtueTankEdit(amount, capacity));
  };
  const dropDraft = (egg: VirtueTankEggKey) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[egg];
      return next;
    });
  // Only a changed field commits: an untouched one keeps its off-grid reading.
  const commit = (egg: VirtueTankEggKey) => {
    const draft = drafts[egg]?.trim();
    dropDraft(egg);
    if (draft == null || draft === "" || draft === virtueTankEditText(tank.fuels[egg] || 0, capacity)) {
      return;
    }
    const value = Number(draft);
    if (Number.isFinite(value)) {
      setAmount(egg, value * unit.eggs);
    }
  };
  // Arrow keys step along the 1% grid, as the game's sliders do.
  const nudge = (egg: VirtueTankEggKey, direction: 1 | -1) => {
    const step = capacity / 100;
    const draft = Number(drafts[egg]?.trim());
    const from = drafts[egg] != null && Number.isFinite(draft) ? draft * unit.eggs : tank.fuels[egg] || 0;
    const steps = from / step;
    const next = direction > 0 ? Math.floor(steps + 1e-6) + 1 : Math.ceil(steps - 1e-6) - 1;
    dropDraft(egg);
    setAmount(egg, next * step);
  };

  return (
    <div className={styles.tankReadout}>
      <div className={styles.tankReadoutHead}>
        <span className={styles.tankReadoutTitle}>
          <span className={styles.fieldLabel}>In your tank now</span>
          {edited && <span className={styles.tankEditedBadge}>Edited</span>}
          {onEdit && (
            <button
              type="button"
              className={styles.tankEditLink}
              aria-expanded={editing}
              title={editing ? undefined : "Set the amounts by hand if the tank has changed since the backup"}
              onClick={() => {
                setDrafts({});
                setEditOpen(!editing);
              }}
            >
              {editing ? "Done" : "Edit"}
            </button>
          )}
          {edited && (
            <button
              type="button"
              className={styles.tankEditLink}
              onClick={() => {
                setDrafts({});
                onReset();
              }}
            >
              Use backup values
            </button>
          )}
        </span>
        <span className={styles.tankReadoutTotal} data-over={overfull ? "1" : "0"}>
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
            style={virtueEggStyle(egg, { width: `${virtueTankPct(tank.fuels[egg], barScale)}%` })}
            title={`${VIRTUE_EGG_DISPLAY[egg].label} ${formatTankFuel(tank.fuels[egg])}`}
          />
        ))}
        {overfull && (
          <span
            className={styles.tankReadoutCapacityMark}
            style={{ left: `${(capacity / barScale) * 100}%` }}
            title={`The tank holds ${formatTankFuel(capacity)}`}
          />
        )}
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
              {editing ? (
                <span className={styles.tankEggField}>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label={`${VIRTUE_EGG_DISPLAY[egg].label} in the tank, in ${unit.suffix}`}
                    value={drafts[egg] ?? virtueTankEditText(amount, capacity)}
                    onChange={(event) => {
                      const text = event.target.value;
                      setDrafts((current) => ({ ...current, [egg]: text }));
                    }}
                    onBlur={() => commit(egg)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        // The card sits in the build form: Enter sets the amount, it doesn't build.
                        event.preventDefault();
                        event.currentTarget.blur();
                      } else if (event.key === "Escape") {
                        dropDraft(egg);
                      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault();
                        nudge(egg, event.key === "ArrowUp" ? 1 : -1);
                      }
                    }}
                  />
                  <span aria-hidden="true">{unit.suffix}</span>
                </span>
              ) : (
                <span className={styles.tankEggAmount}>{empty ? "Empty" : formatTankFuel(amount)}</span>
              )}
              {isEdited(egg) && (
                <span className={styles.tankEggBackup}>
                  backup {(backup.fuels[egg] || 0) > VIRTUE_FUEL_NOISE ? formatTankFuel(backup.fuels[egg], capacity) : "empty"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {tank.fuelingShip && <VirtueFuelingShipNote ship={tank.fuelingShip} capacity={capacity} />}
    </div>
  );
}

/** The ship the player is partway through fueling: plans launch it first, with what it holds. */
function VirtueFuelingShipNote({ ship, capacity }: { ship: VirtueFuelingShip; capacity: number }) {
  const loaded = VIRTUE_FUEL_DISPLAY.filter((fuel) => (ship.loaded[fuel.key] || 0) > VIRTUE_FUEL_NOISE);
  return (
    <p className={styles.tankFuelingNote}>
      <span className={styles.fieldLabel}>Partly fueled</span>{" "}
      <b>
        {titleCaseShip(ship.ship)} {durationTypeLabel(ship.durationType)}
      </b>{" "}
      for {ship.targetAfxId != null ? afxIdToTargetFamilyName(ship.targetAfxId) : "no target"}, holding{" "}
      {loaded.map((fuel, index) => (
        <span key={fuel.key}>
          {index > 0 ? ", " : ""}
          {formatTankFuel(ship.loaded[fuel.key] || 0, capacity)} {fuel.label}
        </span>
      ))}
      . Plans launch it first and only fuel what it still lacks.
    </p>
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
function VirtueTankTimeline({
  view,
  plan,
  clock,
  sleep,
  summary,
}: {
  view: VirtueTankPlanView;
  plan: PlanResponse["plan"];
  /** The schedule on the clock (a sleep window or a dubcap's start): drawn instead of the packer's. */
  clock?: PlanClock | null;
  sleep?: SleepWindow | null;
  summary?: ReactNode;
}) {
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
      {summary}
      <div className={styles.timelineStats}>
        <span>
          Model total: <strong>{formatDurationFromHours(plan.expectedHours)}</strong>
        </span>
        <span>
          Timeline makespan:{" "}
          <strong>{formatDurationFromHours((clock ? clock.schedule.makespanSeconds : pack.schedule.makespanSeconds) / 3600)}</strong>
        </span>
      </div>
      {clock ? <ClockLanes clock={clock} sleep={sleep ?? null} /> : <div className={styles.timelineLanes}>
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
      </div>}
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
type RankedYield = {
  itemId: string;
  quantity: number;
  /** How much of what the plan still needs from missions this row covers. */
  note?: string;
};

function formatYieldCount(quantity: number): string {
  if (quantity > 0 && quantity < 0.01) {
    return "<0.01";
  }
  return quantity.toLocaleString(undefined, { maximumFractionDigits: quantity < 1 ? 2 : quantity < 10 ? 1 : 0 });
}

function formatCoverage(share: number): string {
  const percent = share * 100;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

/**
 * Each mission row's yields the plan cares about, ranked by how much of the
 * item's shortfall the row covers: what the plan uses (goal copies,
 * ingredients of its crafts, consumed copies) less what's in the inventory
 * and what the plan crafts. That's what missions must bring, directly or by
 * consuming their drops, so a row that brings all of a small shortfall ranks
 * above a big pile of something inventory already covers. Drops the plan
 * consumes also bring what consuming them yields, at the share of the item's
 * mission drops the plan consumes.
 *
 * A tier whose only use in the plan is crafting the next tier of its family
 * (tiny gold only ever becomes enriched gold) counts as equivalents of the
 * tier it ends up as, so T1 and T2 drops compare: the chain's shortfall is
 * what the plan uses of its top tier less the whole chain's inventory in
 * top-tier equivalents (crafts inside the chain are conversions, not
 * supply). A tier with any other use keeps its own shortfall.
 */
function rankRelevantYields(plan: PlanResponse["plan"], inventory: Record<string, number> | null): Map<number, RankedYield[]> {
  const recipeMap = recipes as Record<string, { ingredients: Record<string, number> } | null>;
  const need = new Map<string, number>();
  const addNeed = (itemId: string, quantity: number) => {
    const key = itemIdToCanonicalKey(itemId);
    need.set(key, (need.get(key) || 0) + quantity);
  };
  for (const target of plan.targets?.length ? plan.targets : [{ targetItemId: plan.targetItemId, quantity: plan.quantity }]) {
    if (!("craftGoal" in target && target.craftGoal)) {
      addNeed(target.targetItemId, target.quantity);
    }
  }
  const crafted = new Map<string, number>();
  for (const craft of plan.crafts) {
    const craftKey = itemIdToCanonicalKey(craft.itemId);
    crafted.set(craftKey, (crafted.get(craftKey) || 0) + craft.count);
    for (const [ingredientKey, perCraft] of Object.entries(recipeMap[craftKey]?.ingredients || {})) {
      addNeed(ingredientKey, perCraft * craft.count);
    }
  }
  const missionSupply = new Map<string, number>();
  for (const mission of plan.missions) {
    for (const yieldRow of mission.expectedYields) {
      const key = itemIdToCanonicalKey(yieldRow.itemId);
      missionSupply.set(key, (missionSupply.get(key) || 0) + yieldRow.quantity);
    }
  }
  // What one consumed copy yields, and the share of an item's mission drops the plan consumes.
  const consumption = new Map<string, { count: number; share: number; perCopy: Array<{ key: string; quantity: number }> }>();
  for (const row of plan.consumptions || []) {
    if (row.count <= 0) {
      continue;
    }
    const key = itemIdToCanonicalKey(row.itemId);
    const supply = missionSupply.get(key) || 0;
    consumption.set(key, {
      count: row.count,
      share: supply > 0 ? Math.min(1, row.count / supply) : 0,
      perCopy: row.yields.map((entry) => ({ key: itemIdToCanonicalKey(entry.itemId), quantity: entry.quantity / row.count })),
    });
  }
  const have = (key: string) => Math.max(0, Math.floor(inventory?.[key] || 0));
  const CONSUMED = "__consumed";
  // Which crafts use each ingredient (and goal or consumption demand, as "").
  const usedBy = new Map<string, Set<string>>();
  const markUse = (ingredientKey: string, consumerKey: string) => {
    const consumers = usedBy.get(ingredientKey) || new Set<string>();
    consumers.add(consumerKey);
    usedBy.set(ingredientKey, consumers);
  };
  for (const target of plan.targets?.length ? plan.targets : [{ targetItemId: plan.targetItemId, quantity: plan.quantity }]) {
    if (!("craftGoal" in target && target.craftGoal)) {
      markUse(itemIdToCanonicalKey(target.targetItemId), "");
    }
  }
  for (const craft of plan.crafts) {
    const craftKey = itemIdToCanonicalKey(craft.itemId);
    for (const ingredientKey of Object.keys(recipeMap[craftKey]?.ingredients || {})) {
      markUse(ingredientKey, craftKey);
    }
  }
  for (const key of consumption.keys()) {
    markUse(key, CONSUMED);
  }
  // A drop the plan only consumes is worth what consuming it yields; anything
  // else it's consumed for also counts as a need for the item itself.
  const consumedOnly = (key: string) => {
    const consumers = usedBy.get(key);
    return Boolean(consumption.has(key) && consumers && consumers.size === 1);
  };
  for (const [key, consumed] of consumption) {
    if (!consumedOnly(key)) {
      addNeed(key, consumed.count);
    }
  }
  // The tier an item collapses into (its next tier, when that's its only use) and
  // how many of the chain's top tier one copy is worth.
  const chainTop = new Map<string, { top: string; perCopy: number }>();
  const collapse = (key: string): { top: string; perCopy: number } => {
    const known = chainTop.get(key);
    if (known) {
      return known;
    }
    const match = key.match(/^(.*)_(\d+)$/);
    const nextKey = match ? `${match[1]}_${Number(match[2]) + 1}` : "";
    const consumers = usedBy.get(key);
    const perNext = nextKey ? recipeMap[nextKey]?.ingredients[key] || 0 : 0;
    const result =
      consumers && consumers.size === 1 && consumers.has(nextKey) && perNext > 0
        ? (() => {
            const above = collapse(nextKey);
            return { top: above.top, perCopy: above.perCopy / perNext };
          })()
        : { top: key, perCopy: 1 };
    chainTop.set(key, result);
    return result;
  };
  // A chain's inventory in top-tier equivalents.
  const chainHave = new Map<string, number>();
  for (const key of new Set([...need.keys(), ...missionSupply.keys()])) {
    const { top, perCopy } = collapse(key);
    if (top !== key) {
      chainHave.set(top, (chainHave.get(top) || 0) + have(key) * perCopy);
    }
  }
  const isChainTop = (key: string) => chainHave.has(key);
  const shortfall = (key: string) =>
    isChainTop(key)
      ? Math.max(0, (need.get(key) || 0) - have(key) - (chainHave.get(key) || 0))
      : Math.max(0, (need.get(key) || 0) - have(key) - (crafted.get(key) || 0));
  const ranked = new Map<number, RankedYield[]>();
  plan.missions.forEach((mission, missionIndex) => {
    const quantities = new Map<string, number>();
    const add = (key: string, quantity: number) => quantities.set(key, (quantities.get(key) || 0) + quantity);
    for (const yieldRow of mission.expectedYields) {
      add(itemIdToCanonicalKey(yieldRow.itemId), yieldRow.quantity);
    }
    // Coverage of the item's shortfall, or of its chain's in top-tier equivalents.
    const directCoverage = (key: string, quantity: number) => {
      const { top, perCopy } = collapse(key);
      const missing = shortfall(top);
      return missing > 0 ? Math.min(1, (quantity * perCopy) / missing) : 0;
    };
    // What consuming the plan's share of these drops yields, for an item only consumed.
    const consumedYields = (key: string, quantity: number) => {
      const consumed = consumption.get(key)!;
      return consumed.perCopy.map((entry) => ({
        key: entry.key,
        quantity: quantity * consumed.share * entry.quantity,
        coverage: directCoverage(entry.key, quantity * consumed.share * entry.quantity),
      }));
    };
    const coverage = (key: string, quantity: number) =>
      consumedOnly(key)
        ? Math.min(1, consumedYields(key, quantity).reduce((sum, entry) => sum + entry.coverage, 0))
        : directCoverage(key, quantity);
    ranked.set(
      missionIndex,
      Array.from(quantities.entries())
        .filter(([, quantity]) => quantity > 0)
        .sort(([aKey, a], [bKey, b]) => coverage(bKey, b) - coverage(aKey, a) || b - a)
        .map(([key, quantity]) => {
          const { top, perCopy } = collapse(key);
          const missing = shortfall(top);
          const label = itemIdToLabel(itemKeyToId(top));
          const used = need.get(top) || 0;
          const percent = formatCoverage(coverage(key, quantity));
          let note: string;
          if (consumedOnly(key)) {
            // Valued by its main consumption yield (in that yield's chain-top equivalents).
            const main = consumedYields(key, quantity).sort((a, b) => b.coverage - a.coverage)[0];
            const mainChain = collapse(main.key);
            const mainLabel = itemIdToLabel(itemKeyToId(mainChain.top));
            const mainMissing = shortfall(mainChain.top);
            note =
              main.coverage > 0
                ? `Only consumed here, for its ${itemIdToLabel(itemKeyToId(main.key))}: ≈ ${formatYieldCount(main.quantity * mainChain.perCopy)} ${mainLabel}, covering ${formatCoverage(coverage(key, quantity))} of the ${formatYieldCount(mainMissing)} ${mainLabel} the plan still needs from missions.`
                : `Only consumed here, for its ${itemIdToLabel(itemKeyToId(main.key))}, which inventory and crafts already cover.`;
          } else if (top !== key) {
            // A lower tier that only goes toward `top` here.
            note =
              missing > 0
                ? `≈ ${formatYieldCount(quantity * perCopy)} ${label}: covers ${percent} of the ${formatYieldCount(missing)} ${label} the plan still needs from missions (lower tiers here only go toward it; ${formatYieldCount(used)} used − ${formatYieldCount(have(top) + (chainHave.get(top) || 0))} have, counting lower tiers).`
                : `None needed from missions: inventory covers the ${formatYieldCount(used)} ${label} this only goes toward.`;
          } else if (isChainTop(key)) {
            note =
              missing > 0
                ? `Covers ${percent} of the ${formatYieldCount(missing)} ${label} the plan still needs from missions (${formatYieldCount(used)} used − ${formatYieldCount(have(key) + (chainHave.get(key) || 0))} have, counting lower tiers).`
                : `None needed from missions: inventory covers the ${formatYieldCount(used)} ${label} the plan uses, counting lower tiers.`;
          } else {
            note =
              missing > 0
                ? `Covers ${percent} of the ${formatYieldCount(missing)} ${label} the plan still needs from missions (${formatYieldCount(used)} used − ${formatYieldCount(have(key))} have − ${formatYieldCount(crafted.get(key) || 0)} crafted).`
                : `None needed from missions: inventory and crafts cover the ${formatYieldCount(used)} ${label} the plan uses.`;
          }
          return { itemId: itemKeyToId(key), quantity, note };
        })
    );
  });
  return ranked;
}

/** "12/36", marked once every launch of the row has flown. */
function LaunchDone({ done, launches }: { done: number; launches: number }) {
  const complete = done >= launches;
  return (
    <span
      className={styles.launchDone}
      data-state={complete ? "complete" : done > 0 ? "partial" : "none"}
      title={`${done.toLocaleString()} of ${launches.toLocaleString()} launched since this plan was built`}
    >
      {complete && <span aria-hidden="true">✓ </span>}
      {done.toLocaleString()}/{launches.toLocaleString()}
    </span>
  );
}

/**
 * Hands each table row its share of the launches flown, in table order: a
 * mission row split across tanks fills its first tank first.
 */
function launchDoneAllocator(progress: PlanLaunchProgress | null, plan: PlanResponse["plan"]) {
  if (!progress) {
    return null;
  }
  const missionLeft = [...progress.missionDone];
  const prepLeft = new Map<string, number>();
  plan.progression.prepLaunches.forEach((prep, index) => {
    const shape = `${prep.ship}|${prep.durationType}`;
    prepLeft.set(shape, (prepLeft.get(shape) || 0) + (progress.prepDone[index] || 0));
  });
  let fuelingLeft = progress.fuelingDone ? 1 : 0;
  const take = (available: number, launches: number) => Math.max(0, Math.min(launches, available));
  return {
    mission(index: number, launches: number): number {
      const done = take(missionLeft[index] || 0, launches);
      missionLeft[index] = (missionLeft[index] || 0) - done;
      return done;
    },
    prep(ship: string, durationType: string, launches: number): number {
      const shape = `${ship}|${durationType}`;
      const done = take(prepLeft.get(shape) || 0, launches);
      prepLeft.set(shape, (prepLeft.get(shape) || 0) - done);
      return done;
    },
    fueling(launches: number): number {
      const done = take(fuelingLeft, launches);
      fuelingLeft -= done;
      return done;
    },
  };
}

function renderMissionTableRow(
  mission: PlanMissionRow,
  missionIndex: number,
  targetOverride: string | null,
  options: {
    key: string;
    launches?: number;
    splitAcrossTanks?: boolean;
    yields?: RankedYield[];
    done?: number;
    /** Of `launches`, the locked ones; the mission row's own count when absent. */
    lockedLaunches?: number;
  }
) {
  const targetLabel = targetOverride || afxIdToTargetFamilyName(mission.targetAfxId);
  const targetItemKey = targetOverride ? null : afxIdToItemKey(mission.targetAfxId);
  const targetIconUrl = targetItemKey ? itemKeyToIconUrl(targetItemKey) : null;
  const launches = options.launches ?? mission.launches;
  const lockedCount = mission.inAir ? 0 : Math.min(launches, options.lockedLaunches ?? mission.lockedLaunches ?? 0);
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
        {mission.dubcap && <span className={styles.dubcapBadge}>dubcap</span>}
        {mission.inAir && (mission.inAirDubcapMultiplier ?? 1) > 1 && (
          <span
            className={styles.dubcapBadge}
            title={`Launched in a dubcap: these bring back ×${mission.inAirDubcapMultiplier} drops, as their expected yields show`}
          >
            dubcap
          </span>
        )}
        {lockedCount > 0 && (
          <span
            className={styles.lockedBadge}
            title={`${pluralize(lockedCount, "locked launch", "locked launches")}${
              mission.dubcap ? ", in the dubcap" : ""
            }: the plan makes ${lockedCount === 1 ? "it" : "them"} whatever else it does`}
          >
            🔒{lockedCount < launches ? ` ${lockedCount.toLocaleString()}` : ""}
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
            {options.done != null ? <LaunchDone done={options.done} launches={launches} /> : launches.toLocaleString()}
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
        {(options.yields ?? mission.expectedYields).slice(0, 3).map((yieldRow) => {
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
              <span title={(yieldRow as RankedYield).note}>
                {itemIdToLabel(yieldRow.itemId)}: {(yieldRow.quantity * yieldScale).toFixed(2)}
                {mission.launches > 0 && (
                  // Per launch, so ships with different launch counts compare.
                  <em className={styles.perShipYield}> ({(yieldRow.quantity / mission.launches).toFixed(2)})</em>
                )}
              </span>
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
  inventory,
  progress,
}: {
  view: VirtueTankPlanView;
  plan: PlanResponse["plan"];
  targetOverrideByIndex: Map<number, string>;
  /** The profile's inventory, for ranking yields by what missions must still bring. */
  inventory: Record<string, number> | null;
  /** Launches flown since the plan was built, once checked. */
  progress: PlanLaunchProgress | null;
}) {
  const rankedYields = useMemo(() => rankRelevantYields(plan, inventory), [plan, inventory]);
  const allocator = launchDoneAllocator(progress, plan);
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
              yields: rankedYields.get(missionIndex),
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
                    yields: rankedYields.get(row.missionIndex),
                    done: allocator?.mission(row.missionIndex, row.launches),
                    lockedLaunches: row.lockedLaunches,
                  }
                );
              }
              const unit = row.unitView?.unit;
              const unitDone = !allocator || !unit
                ? null
                : unit.preFueled !== undefined
                  ? allocator.fueling(row.launches)
                  : allocator.prep(unit.ship, unit.durationType, row.launches);
              return (
                <tr key={`${tank.index}:${row.key}`}>
                  <td>
                    {unit?.preFueled ? (
                      <span
                        className={styles.prepBadge}
                        title="The ship you are partway through fueling: finish fueling it and launch it first"
                      >
                        Fueled
                      </span>
                    ) : (
                      <span
                        className={styles.prepBadge}
                        title="Ship-leveling launch with no target drops; see the Horizon progression plan"
                      >
                        Prep
                      </span>
                    )}
                    {unit ? titleCaseShip(unit.ship) : row.key}
                    <br />
                    <span className="muted">{unit ? durationTypeWithLevelLabel(unit.durationType, unit.level) : ""}</span>
                  </td>
                  <td>{row.unitView?.subtitle || "Ship prep"}</td>
                  <td>
                    {unitDone != null ? <LaunchDone done={unitDone} launches={row.launches} /> : row.launches.toLocaleString()}
                  </td>
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
              yields: rankedYields.get(missionIndex),
              done: allocator?.mission(missionIndex, mission.launches),
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
  const starShip = shipFromStarsItem(itemId);
  if (starShip) {
    return shipStarsGoalLabel(starShip);
  }
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
  return payload.liveDubcap
    ? { ...payload, liveDubcapEndsAtMs: Date.now() + payload.liveDubcap.secondsRemaining * 1000 }
    : payload;
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

/** A Locked launches row as edited: its count stays text while it's typed. */
type LockedLaunchRow = {
  id: string;
  ship: string;
  durationType: SendDurationType;
  /** null: any target, the planner's pick. */
  targetAfxId: number | null;
  launchesInput: string;
  dubcap: boolean;
};

let lockedLaunchRowSeq = 0;

function lockedLaunchesToRows(locks: LockedLaunch[]): LockedLaunchRow[] {
  return locks.map((lock) => {
    lockedLaunchRowSeq += 1;
    return {
      id: `locked-${lockedLaunchRowSeq}`,
      ship: lock.ship,
      durationType: lock.durationType,
      targetAfxId: lock.targetAfxId,
      launchesInput: String(lock.launches),
      dubcap: Boolean(lock.dubcap),
    };
  });
}

function lockedLaunchRowsToLocks(rows: LockedLaunchRow[]): LockedLaunch[] {
  return sanitizeLockedLaunches(
    rows.map((row) => ({
      ship: row.ship,
      durationType: row.durationType,
      targetAfxId: row.targetAfxId,
      launches: Number(row.launchesInput) || 1,
      dubcap: row.dubcap,
    }))
  );
}

const ANY_TARGET_VALUE = "any";

/**
 * A "?" after a control's name that shows what the control does: on click or
 * tap (an info-disclosure, which closes on a click elsewhere), and while a
 * mouse is over it.
 */
function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <details
      className={`info-disclosure ${styles.helpTip}`}
      open={pinned || hovered}
      onToggle={(event) => {
        // Closed from outside (a click elsewhere, Escape).
        if (!event.currentTarget.open) {
          setPinned(false);
          setHovered(false);
        }
      }}
      onPointerEnter={(event) => event.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={(event) => event.pointerType === "mouse" && setHovered(false)}
    >
      <summary
        className={styles.helpTipButton}
        aria-label={`About ${label}`}
        onClick={(event) => {
          event.preventDefault();
          setPinned((value) => !value);
        }}
      >
        ?
      </summary>
      <p className="muted">{children}</p>
    </details>
  );
}

/** The goals a partial plan leaves short, as its banners list them. */
function GoalShortfallList({ goals }: { goals: Array<{ itemId: string; requested: number; shortfall: number; craftGoal?: boolean }> }) {
  return (
    <ul className={styles.shiftCapShortfalls}>
      {goals.map((goal, index) => (
        <li key={`${goal.itemId}:${index}`}>
          {itemIdToLabel(goal.itemId)}: expected {formatGoalAmount(goal.requested - goal.shortfall, goal.craftGoal)} of{" "}
          {formatGoalAmount(goal.requested, goal.craftGoal)}
          {isShipStarsItem(goal.itemId) ? " launch points" : goal.craftGoal ? " additional crafts" : ""} · short by{" "}
          {formatGoalAmount(goal.shortfall, goal.craftGoal)}
        </li>
      ))}
    </ul>
  );
}

/** "Sun 2:00 PM": a time within the next week or so. */
/**
 * When the next dubcap probably starts: they almost always begin on a Sunday at
 * 9 AM Pacific (every one since mid-2023), every few weeks. The event feed only
 * lists one once it is running, so this is a guess the player can change.
 */
function nextLikelyDubcapStartMs(fromMs: number): number {
  try {
    const pacific = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
    });
    const from = new Date(fromMs);
    for (let day = 0; day <= 8; day += 1) {
      for (const utcHour of [16, 17]) {
        const ms = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + day, utcHour);
        if (ms <= fromMs) continue;
        const parts = pacific.formatToParts(new Date(ms));
        if (parts.find((part) => part.type === "weekday")?.value === "Sun" && Number(parts.find((part) => part.type === "hour")?.value) === 9) {
          return ms;
        }
      }
    }
  } catch {
    // No time zone data: fall through to a day out.
  }
  return Math.ceil((fromMs + 24 * 3_600_000) / 3_600_000) * 3_600_000;
}

function readSleepPreferences(): SleepPreferences {
  try {
    const parsed = JSON.parse(readFirstStoredString([LOCAL_PREF_KEYS.plannerSleep]) || "null") as Partial<SleepPreferences> | null;
    const minutes = (value: unknown, fallback: number) =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1440 ? value : fallback;
    return {
      on: parsed?.on === true,
      bedMinutes: minutes(parsed?.bedMinutes, DEFAULT_SLEEP.bedMinutes),
      wakeMinutes: minutes(parsed?.wakeMinutes, DEFAULT_SLEEP.wakeMinutes),
    };
  } catch {
    return DEFAULT_SLEEP;
  }
}

/** "23:00" for a time input. */
function toTimeInputValue(minutes: number): string {
  const whole = Math.round(((minutes % 1440) + 1440) % 1440);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function fromTimeInputValue(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(minutes) && minutes >= 0 && minutes < 1440 ? minutes : null;
}

/** "11 PM", "6:30 AM". */
function formatTimeOfDay(minutes: number): string {
  const date = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
  return date.toLocaleTimeString(undefined, minutes % 60 === 0 ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" });
}

function formatShortDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A datetime-local input's value (local time, to the minute). */
function toDateTimeLocalValue(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Advanced options' Locked launches: sends the plan has to make, at least
 * this many each (lib/locked-launches), as a list of rows like the goals'.
 * Ticking Dubcap on a row turns on Include one dubcap; with it off, ticked
 * rows plan as ordinary launches and keep their tick for when it's back on.
 */
function LockedLaunchesEditor({
  rows,
  onRowsChange,
  onlyLocked,
  onOnlyLockedChange,
  shipLevels,
  includeDubcap,
  onIncludeDubcap,
  open,
  onOpenChange,
}: {
  rows: LockedLaunchRow[];
  onRowsChange: (rows: LockedLaunchRow[]) => void;
  /** Send only these: no other launches (PlannerOptions.onlyLockedLaunches). */
  onlyLocked: boolean;
  onOnlyLockedChange: (onlyLocked: boolean) => void;
  shipLevels: ShipLevelInfo[] | null;
  includeDubcap: boolean;
  onIncludeDubcap: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ships = SEND_SHIPS.filter((ship) => {
    const level = shipLevels?.find((entry) => entry.ship === ship);
    return !shipLevels || shipLevels.length === 0 || Boolean(level?.unlocked);
  });
  const total = lockedLaunchRowsToLocks(rows).reduce((sum, lock) => sum + lock.launches, 0);
  const update = (id: string, change: Partial<LockedLaunchRow>) =>
    onRowsChange(rows.map((row) => (row.id === id ? { ...row, ...change } : row)));
  const addRow = () => {
    const [created] = lockedLaunchesToRows([
      { ship: ships[0] ?? "HENERPRISE", durationType: "EPIC", targetAfxId: null, launches: 1 },
    ]);
    onRowsChange([...rows, created]);
    onOpenChange(true);
  };
  const targetLabel = (row: LockedLaunchRow) =>
    row.targetAfxId === null ? "any" : SEND_TARGET_OPTIONS.find((option) => option.afxId === row.targetAfxId)?.label ?? "?";

  return (
    <div className={styles.shipSelectorWrap}>
      <div className={styles.selectorHeader}>
        <button
          type="button"
          className={styles.shipSelectorToggle}
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
        >
          <span className={styles.shipSelectorToggleLeft}>
            <span className={styles.shipSelectorChevron} data-open={open ? "1" : "0"} />
            <span>Locked launches</span>
          </span>
        </button>
        <span className={styles.selectorMeta}>
          <span className={styles.shipSelectorCount}>
            {total > 0 ? (
              <>
                {total.toLocaleString()} <em>{onlyLocked ? "locked · only these" : "locked"}</em>
              </>
            ) : (
              <em>none</em>
            )}
          </span>
        </span>
      </div>

      {!open && rows.length > 0 && (
        <div className={styles.shipChips} aria-label="Locked launches">
          {rows.map((row) => (
            <span key={row.id} className={styles.shipChip}>
              🔒 {Number(row.launchesInput) || 1}× {compactShipName(row.ship)}
              <span className={styles.shipChipDurations}>
                <span className={styles[`shipChip${row.durationType}`]}>{durationChipLabel(row.durationType)}</span>
              </span>
              <span className={styles.lockedChipTarget}>
                {targetLabel(row)}
                {row.dubcap && includeDubcap ? " · dubcap" : ""}
              </span>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className={styles.lockedPanel}>
          <p className={styles.consumptionHelpText}>
            {onlyLocked && rows.length > 0
              ? "The plan's only launches: it picks targets for the any-target rows. They fly first, once your ships in the air return; ticked ones fly in the dubcap."
              : "Launches the plan has to make, at least this many, whatever else it picks. They fly first, once your ships in the air return; ticked ones fly in the dubcap."}
          </p>
          {rows.length > 0 && (
            <ul className={styles.lockedList}>
              {rows.map((row) => {
                const untargetedOnly = SEND_UNTARGETED_ONLY_SHIPS.has(row.ship);
                const dubcapOff = row.dubcap && !includeDubcap;
                return (
                  <li key={row.id} className={styles.lockedRow}>
                    <span className={styles.lockedCount}>
                      <input
                        type="text"
                        inputMode="numeric"
                        aria-label="Launches"
                        value={row.launchesInput}
                        onChange={(event) => update(row.id, { launchesInput: event.target.value.replace(/[^\d]/g, "") })}
                        onBlur={() =>
                          update(row.id, {
                            launchesInput: String(
                              Math.max(1, Math.min(MAX_LOCKED_LAUNCHES_PER_ROW, Math.round(Number(row.launchesInput) || 1)))
                            ),
                          })
                        }
                      />
                      <span aria-hidden="true">×</span>
                    </span>
                    <select
                      className={styles.lockedShip}
                      aria-label="Ship"
                      value={row.ship}
                      onChange={(event) => {
                        const ship = event.target.value;
                        update(row.id, {
                          ship,
                          ...(SEND_UNTARGETED_ONLY_SHIPS.has(ship) ? { targetAfxId: null } : {}),
                        });
                      }}
                    >
                      {(ships.includes(row.ship) ? ships : [row.ship, ...ships]).map((ship) => (
                        <option key={ship} value={ship}>
                          {compactShipName(ship)}
                        </option>
                      ))}
                    </select>
                    <select
                      className={styles.lockedLength}
                      aria-label="Length"
                      value={row.durationType}
                      onChange={(event) => update(row.id, { durationType: event.target.value as SendDurationType })}
                    >
                      {SEND_DURATIONS.map((duration) => (
                        <option key={duration.value} value={duration.value}>
                          {duration.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className={styles.lockedTarget}
                      aria-label="Target"
                      value={untargetedOnly || row.targetAfxId === null ? ANY_TARGET_VALUE : String(row.targetAfxId)}
                      disabled={untargetedOnly}
                      title={untargetedOnly ? "This ship only flies untargeted." : undefined}
                      onChange={(event) =>
                        update(row.id, {
                          targetAfxId: event.target.value === ANY_TARGET_VALUE ? null : Number(event.target.value),
                        })
                      }
                    >
                      <option value={ANY_TARGET_VALUE}>{untargetedOnly ? "Untargeted" : "Any target"}</option>
                      {!untargetedOnly &&
                        SEND_TARGET_OPTIONS.map((option) => (
                          <option key={option.afxId} value={option.afxId}>
                            {option.label}
                          </option>
                        ))}
                    </select>
                    <label
                      className={styles.lockedDubcap}
                      data-off={dubcapOff ? "1" : "0"}
                      title={
                        dubcapOff
                          ? "Include one dubcap is off, so this flies as an ordinary launch. Tick to turn the dubcap back on."
                          : includeDubcap
                            ? "Fly these in the plan's dubcap"
                            : "Fly these in a dubcap: turns on Include one dubcap"
                      }
                    >
                      <input
                        type="checkbox"
                        checked={row.dubcap && includeDubcap}
                        onChange={(event) => {
                          if (!includeDubcap) {
                            update(row.id, { dubcap: true });
                            onIncludeDubcap();
                          } else {
                            update(row.id, { dubcap: event.target.checked });
                          }
                        }}
                      />
                      Dubcap
                    </label>
                    <button
                      type="button"
                      className={styles.lockedRemove}
                      aria-label="Remove this locked launch"
                      onClick={() => onRowsChange(rows.filter((entry) => entry.id !== row.id))}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            className={styles.lockedAdd}
            onClick={addRow}
            disabled={rows.length >= MAX_LOCKED_LAUNCH_ROWS}
            title={rows.length >= MAX_LOCKED_LAUNCH_ROWS ? `${MAX_LOCKED_LAUNCH_ROWS} rows max` : undefined}
          >
            + Lock a launch
          </button>
          {rows.length > 0 && (
            <div className={styles.checkWithHelp}>
              <label className={styles.customCheck} htmlFor="onlyLockedLaunches">
                <input
                  id="onlyLockedLaunches"
                  type="checkbox"
                  checked={onlyLocked}
                  onChange={(event) => onOnlyLockedChange(event.target.checked)}
                />
                <span aria-hidden="true" />
                <span>Send only these</span>
              </label>
              <HelpTip label="Send only these">
                The plan makes these launches and no others, and picks targets for the any-target rows to get your goals
                as far as these launches can. Goals they can&apos;t reach are left short. Count how many you can send
                yourself, e.g. what your fuel or the craft sale allows.
              </HelpTip>
            </div>
          )}
        </div>
      )}
    </div>
  );
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

type ShipProgressRow = {
  ship: string;
  unlockedByPlan: boolean;
  startLevel: number;
  endLevel: number;
  maxLevel: number;
  startLaunches: number;
  endLaunches: number;
  startPoints: number;
  endPoints: number;
  /** Where the end level starts and the next one begins, in launch points; null once maxed. */
  levelSpan: { from: number; to: number } | null;
};

/**
 * The ships this plan moves: launched by it while short of max stars, or
 * unlocked by it. Ships already maxed, or not launched, aren't news.
 */
function shipProgressRows(
  start: PlanResponse["profile"]["shipLevels"],
  end: PlanResponse["plan"]["progression"]["projectedShipLevels"]
): ShipProgressRow[] {
  const startByShip = new Map(start.map((ship) => [ship.ship, ship]));
  const rows: ShipProgressRow[] = [];
  for (const after of end) {
    const before = startByShip.get(after.ship);
    if (!before) {
      continue;
    }
    const unlockedByPlan = !before.unlocked && after.unlocked;
    const launched = after.launches > before.launches;
    if (!unlockedByPlan && !(launched && before.level < before.maxLevel)) {
      continue;
    }
    const thresholds = shipLevelPointThresholds(after.ship);
    const levelSpan =
      thresholds && after.level < after.maxLevel && after.level + 1 < thresholds.length
        ? { from: thresholds[after.level], to: thresholds[after.level + 1] }
        : null;
    rows.push({
      ship: after.ship,
      unlockedByPlan,
      startLevel: before.level,
      endLevel: after.level,
      maxLevel: after.maxLevel,
      startLaunches: before.launches,
      endLaunches: after.launches,
      startPoints: before.launchPoints,
      endPoints: after.launchPoints,
      levelSpan,
    });
  }
  return rows;
}

function formatLaunchPoints(points: number): string {
  return Number.isInteger(points) ? points.toLocaleString() : points.toFixed(1);
}

/** "8 short, 6 standard or 5 extended launches" for the points left to the next star. */
function launchesToPointsLabel(points: number): string {
  const counts = (["SHORT", "LONG", "EPIC"] as const).map((durationType) =>
    Math.ceil(points / durationLaunchPoints(durationType) - 1e-9)
  );
  return `${counts[0]} short, ${counts[1]} standard or ${counts[2]} extended launches`;
}

function ShipProgressPanel({
  start,
  end,
}: {
  start: PlanResponse["profile"]["shipLevels"];
  end: PlanResponse["plan"]["progression"]["projectedShipLevels"];
}) {
  const rows = shipProgressRows(start, end);
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Ship progress</h2>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          The ships this plan launches are already at max stars.
        </p>
      ) : (
        <div className="table-wrap">
          <table className={styles.shipProgressTable}>
            <thead>
              <tr>
                <th>Ship</th>
                <th>Stars</th>
                <th>Launches</th>
                <th>Points</th>
                <th>Next star</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const maxed = row.endLevel >= row.maxLevel;
                const span = row.levelSpan;
                const sameLevel = row.startLevel === row.endLevel;
                const pct = (points: number) =>
                  span ? Math.max(0, Math.min(100, ((points - span.from) / (span.to - span.from)) * 100)) : 100;
                const endPct = pct(row.endPoints);
                const startPct = sameLevel ? pct(row.startPoints) : 0;
                const pointsLeft = span ? Math.max(0, span.to - row.endPoints) : 0;
                return (
                  <tr key={row.ship}>
                    <td>
                      {titleCaseShip(row.ship)}
                      {row.unlockedByPlan && <span className={styles.shipProgressUnlocked}> Unlocked!</span>}
                    </td>
                    <td className={styles.shipProgressStars}>
                      {sameLevel ? `${row.endLevel}★` : `${row.startLevel}★ → ${row.endLevel}★`}
                      {maxed && <span className={styles.shipProgressMax}> max</span>}
                    </td>
                    <td
                      className={styles.shipProgressNumber}
                      title={`${row.startLaunches.toLocaleString()} → ${row.endLaunches.toLocaleString()} launches in all`}
                    >
                      +{(row.endLaunches - row.startLaunches).toLocaleString()}
                    </td>
                    <td className={styles.shipProgressNumber}>
                      {formatLaunchPoints(row.startPoints)} → {formatLaunchPoints(row.endPoints)}
                    </td>
                    <td>
                      {span ? (
                        <div
                          className={styles.shipProgressNext}
                          title={`${formatLaunchPoints(pointsLeft)} points: ${launchesToPointsLabel(pointsLeft)}`}
                        >
                          <span className={styles.shipProgressBar} aria-hidden="true">
                            <span className={styles.shipProgressBarGain} style={{ width: `${endPct}%` }} />
                            <span className={styles.shipProgressBarStart} style={{ width: `${startPct}%` }} />
                          </span>
                          <span>
                            {formatLaunchPoints(pointsLeft)} pts to {row.endLevel + 1}★
                          </span>
                        </div>
                      ) : (
                        <span className={styles.shipProgressMax}>All stars</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type LaunchProgressState = {
  /** The plan it was checked against; a new plan drops it. */
  plan: PlanResponse;
  status: "loading" | "ready" | "error";
  result?: PlanLaunchProgress;
  error?: string;
  checkedAtMs?: number;
};

/** "2× Henerprise extended → gold meteorite" for each kind of off-plan launch. */
function offPlanLaunchSummary(launches: LaunchRecord[]): string {
  const counts = new Map<string, number>();
  for (const launch of launches) {
    const label = `${titleCaseShip(launch.ship)} ${durationTypeLabel(launch.durationType).toLowerCase()} → ${
      launch.targetAfxId == null ? "untargeted" : afxIdToTargetFamilyName(launch.targetAfxId)
    }`;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => `${count}× ${label}`)
    .join(", ");
}

/**
 * Following the plan: which of its launches the backup shows flown since the
 * plan was built, and any launches that aren't in it.
 */
function PlanProgressStrip({
  state,
  unavailable,
  onCheck,
}: {
  state: LaunchProgressState | null;
  /** Why progress can't be checked, or null when it can. */
  unavailable: string | null;
  onCheck: () => void;
}) {
  const result = state?.status === "ready" ? state.result : undefined;
  const pct = result && result.planned > 0 ? Math.min(100, (result.done / result.planned) * 100) : 0;
  return (
    <div className={styles.planProgress} aria-live="polite">
      <button
        type="button"
        className={styles.planProgressButton}
        onClick={onCheck}
        disabled={unavailable != null || state?.status === "loading"}
        title={unavailable ?? "Read your backup and mark the launches you've flown since this plan was built"}
      >
        {state?.status === "loading" ? "Checking…" : result ? "Check again" : "Check progress"}
      </button>
      {result ? (
        <div className={styles.planProgressBody}>
          <div className={styles.planProgressHeadline}>
            <span className={styles.planProgressBar} aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span>
              <strong>
                {result.done.toLocaleString()} of {result.planned.toLocaleString()}
              </strong>{" "}
              planned launches flown
              {state?.checkedAtMs != null && (
                <span className="muted">
                  {" "}
                  · checked {new Date(state.checkedAtMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </span>
              )}
            </span>
          </div>
          {result.offPlan.length > 0 ? (
            <div className={styles.planProgressWarn}>
              {result.offPlan.length === 1 ? "1 launch isn't" : `${result.offPlan.length.toLocaleString()} launches aren't`} in this
              plan ({offPlanLaunchSummary(result.offPlan)}). Their drops and stars change the best route, so update the plan.
            </div>
          ) : result.planned > 0 && result.done >= result.planned ? (
            <div className={styles.planProgressDone}>Every planned launch has flown.</div>
          ) : null}
          {result.incomplete && (
            <div className="muted">
              Only your newest launches are kept, and this plan started before them; earlier launches may be missing.
            </div>
          )}
        </div>
      ) : state?.status === "error" ? (
        <div className="error">{state.error}</div>
      ) : (
        <span className="muted">{unavailable ?? "Mark the launches you've flown since this plan was built."}</span>
      )}
    </div>
  );
}

/**
 * Whether a newer deploy is live than the one this tab loaded, checked when
 * the tab comes back into view (a tab left open keeps its old planner).
 */
function useAppUpdated(): boolean {
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    if (APP_BUILD === "dev") {
      return;
    }
    let cancelled = false;
    const check = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      fetch("/api/build", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: { build?: unknown } | null) => {
          if (!cancelled && typeof payload?.build === "string" && payload.build !== "dev" && payload.build !== APP_BUILD) {
            setUpdated(true);
          }
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);
  return updated;
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
  const [virtueTankEdits, setVirtueTankEdits] = useState<VirtueTankEdits | null>(null);
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
  const [includeDubcap, setIncludeDubcap] = useState(false);
  const [lockedLaunchRows, setLockedLaunchRows] = useState<LockedLaunchRow[]>([]);
  const [lockedLaunchesOpen, setLockedLaunchesOpen] = useState(false);
  const [onlyLockedLaunches, setOnlyLockedLaunches] = useState(false);
  const [finishByOn, setFinishByOn] = useState(false);
  const [finishByMs, setFinishByMs] = useState<number | null>(null);
  // Only a ticked Finish by with a time limits the plan.
  const activeFinishByMs = finishByOn ? finishByMs : null;
  const [sleepPrefs, setSleepPrefs] = useState<SleepPreferences>(DEFAULT_SLEEP);
  const sleepWindow: SleepWindow | null =
    sleepPrefs.on && sleepLengthMinutes(sleepPrefs) > 0
      ? { bedMinutes: sleepPrefs.bedMinutes, wakeMinutes: sleepPrefs.wakeMinutes }
      : null;
  const [startMode, setStartMode] = useState<PlanStartMode>("now");
  const [startAtMs, setStartAtMs] = useState<number | null>(null);
  const [dubcapStartMs, setDubcapStartMs] = useState<number | null>(null);
  // The start only matters to the options that tie a plan to the clock; with all of them off it is now.
  const startRowShown = sleepPrefs.on || finishByOn || includeDubcap;
  const effectiveStartMode: PlanStartMode =
    !startRowShown || (startMode === "dubcap" && !includeDubcap) ? "now" : startMode;
  const [loading, setLoading] = useState(false);
  const appUpdated = useAppUpdated();
  const [error, setError] = useState<string | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<string | null>(null);
  const [plannerProgress, setPlannerProgress] = useState<PlannerProgressState | null>(null);
  const [planningStartedAtMs, setPlanningStartedAtMs] = useState<number | null>(null);
  const [response, setResponse] = useState<PlanResponse | null>(null);
  // When the plan's clock starts. A restored plan keeps its original stamp so
  // the projected completion does not silently slide forward with the page.
  const [planReceivedAtMs, setPlanReceivedAtMs] = useState<number | null>(null);
  // How far ahead of the solve its start was (a set start time), for solve snapshots.
  const [solvedStartDelaySeconds, setSolvedStartDelaySeconds] = useState<number | null>(null);
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
  // Where the plan's clock starts: its set start time, or when it was built.
  const planClockStartMs =
    planReceivedAtMs == null ? null : Math.max(planReceivedAtMs, lastSolveRequest?.startAtMs ?? 0);
  const planStartDelaySeconds =
    solvedStartDelaySeconds ??
    (planClockStartMs != null && planReceivedAtMs != null ? Math.max(0, (planClockStartMs - planReceivedAtMs) / 1000) : 0);
  const [launchProgress, setLaunchProgress] = useState<LaunchProgressState | null>(null);
  const [shipDurations, setShipDurations] = useState<ShipDurationSelection>(buildDefaultShipDurations);
  const [shipSelectorOpen, setShipSelectorOpen] = useState(false);
  const [consumptionDrawerOpen, setConsumptionDrawerOpen] = useState(false);
  const [selectedConsumptionItemIds, setSelectedConsumptionItemIds] = useState<string[]>(DEFAULT_CONSUMPTION_ITEM_IDS);
  const [lootData, setLootData] = useState<LootJson | null>(null);
  // Off: only goal artifacts show shiny odds in the craft plan.
  const [showAllShinyOdds, setShowAllShinyOdds] = useState(false);
  useEffect(() => {
    setShowAllShinyOdds(readStoredBoolean([LOCAL_PREF_KEYS.plannerShowAllShinyOdds]) ?? false);
  }, []);
  function updateShowAllShinyOdds(next: boolean): void {
    setShowAllShinyOdds(next);
    writeStoredBoolean([LOCAL_PREF_KEYS.plannerShowAllShinyOdds], next);
  }
  const lootDataRef = useRef<LootJson | null>(null);
  const skipNextScopedPreferenceSaveRef = useRef(false);
  const highs = useHighsWorker();
  const highsRef = useRef(highs);
  highsRef.current = highs;
  const responseRef = useRef<PlanResponse | null>(null);
  responseRef.current = response;
  const shiftCapSliderRef = useRef<HTMLInputElement | null>(null);
  const planFileInputRef = useRef<HTMLInputElement | null>(null);
  const trimmedEid = eid.trim();
  const [profileOverrides, setProfileOverrides] = useProfileOverrides(eid);
  // The backup's own values (before any customizing), for the customize dialog.
  const [fetchedProfileSummary, setFetchedProfileSummary] = useState<{ eid: string; summary: ProfileSummary } | null>(null);
  // The live dubcap the last profile read for this EID showed, while it lasts.
  const knownLiveDubcap =
    profileSnapshot?.eid === trimmedEid && profileSnapshot.liveDubcap && (profileSnapshot.liveDubcapEndsAtMs ?? 0) > Date.now()
      ? { ...profileSnapshot.liveDubcap, endsAtMs: profileSnapshot.liveDubcapEndsAtMs! }
      : null;
  const isDemoMode = trimmedEid.length === 0;
  const demoProfileSummary = useMemo(
    () => (isDemoMode ? summarizeProfile(createDemoProfile(inventorySource)) : null),
    [isDemoMode, inventorySource]
  );
  const profileSummaryForDialog =
    demoProfileSummary ?? (fetchedProfileSummary?.eid === trimmedEid ? fetchedProfileSummary.summary : null);
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
    lockedLaunches: lockedLaunchRowsToLocks(lockedLaunchRows),
    ...(onlyLockedLaunches ? { onlyLockedLaunches: true } : {}),
    ...(finishByMs != null ? { finishByMs } : {}),
    ...(finishByOn ? { finishByOn: true } : {}),
    ...(startMode !== "now" ? { startMode } : {}),
    ...(startAtMs != null ? { startAtMs } : {}),
    ...(dubcapStartMs != null ? { dubcapStartMs } : {}),
  });

  const applySourcePreferences = (preferences: PlannerSourcePreferences | null | undefined) => {
    const rows = preferences?.targetRows
      ? parseStoredTargetRows(JSON.stringify(preferences.targetRows), targetOptions, { allowShipStars: true })
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
    setLockedLaunchRows(lockedLaunchesToRows(sanitizeLockedLaunches(preferences?.lockedLaunches)));
    setOnlyLockedLaunches(preferences?.onlyLockedLaunches === true);
    const savedFinishBy = Number(preferences?.finishByMs);
    const finishByLive = Number.isFinite(savedFinishBy) && savedFinishBy > Date.now();
    setFinishByMs(finishByLive ? savedFinishBy : null);
    setFinishByOn(finishByLive && preferences?.finishByOn === true);
    const now = Date.now();
    const savedStartAt = Number(preferences?.startAtMs);
    const savedDubcapStart = Number(preferences?.dubcapStartMs);
    setStartAtMs(Number.isFinite(savedStartAt) && savedStartAt > now ? savedStartAt : null);
    setDubcapStartMs(Number.isFinite(savedDubcapStart) && savedDubcapStart > now ? savedDubcapStart : null);
    const savedMode = preferences?.startMode;
    setStartMode(
      savedMode === "dubcap" || (savedMode === "custom" && Number.isFinite(savedStartAt) && savedStartAt > now) ? savedMode : "now"
    );
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
  // Max-stars goals for the ships short of their top stars, from the newest
  // profile the page has; before any profile, every ship (the planner notes
  // and skips a goal its ship already meets). Rows already on a stars goal
  // keep their option so their label shows.
  const knownShips =
    demoProfileSummary?.ships ??
    (profileSnapshot?.eid === trimmedEid && profileSnapshot.shipLevels.length > 0
      ? profileSnapshot.shipLevels
      : fetchedProfileSummary?.eid === trimmedEid
        ? fetchedProfileSummary.summary.ships
        : null);
  const goalOptions = useMemo(() => {
    const ships = knownShips ?? getShipOrder().map((ship) => ({ ship, unlocked: true, level: 0, maxLevel: 1 }));
    const starOptions = shipStarsTargetOptions(ships);
    for (const row of targetRows) {
      const ship = shipFromStarsItem(row.itemId);
      if (ship && !starOptions.some((option) => option.itemId === row.itemId)) {
        starOptions.push(...shipStarsTargetOptions([{ ship, unlocked: true, level: 0, maxLevel: 1 }]));
      }
    }
    return [...targetOptions, ...starOptions];
  }, [knownShips, targetOptions, targetRows]);
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
  const virtueTankViewBase = useMemo(
    () =>
      response
        ? buildVirtueTankPlanView(response.plan, profileSnapshot?.plannedVirtueTank ?? profileSnapshot?.virtueTank)
        : null,
    [profileSnapshot, response]
  );
  // A dubcap still to come, pinned to the start time set for it.
  const dubcapAnchorMs =
    response?.plan.dubcap && !response.plan.dubcap.live && effectiveStartMode === "dubcap" && dubcapStartMs != null
      ? dubcapStartMs
      : null;
  const sleepBed = sleepWindow?.bedMinutes ?? null;
  const sleepWake = sleepWindow?.wakeMinutes ?? null;
  // The plan on the clock: launches only while the player is up, and a dubcap
  // at its expected start. Without either, the timelines below draw as before.
  const planClock = useMemo((): PlanClock | null => {
    if (!response || planClockStartMs == null || (sleepBed == null && dubcapAnchorMs == null)) {
      return null;
    }
    const plan = response.plan;
    const parts = plan.dubcap
      ? dubcapClockParts(plan, dubcapAnchorMs != null ? (dubcapAnchorMs - planClockStartMs) / 1000 : null)
      : virtueTankViewBase
        ? virtueClockParts(plan, virtueTankViewBase)
        : mainFarmClockParts(plan);
    if (!parts) {
      return null;
    }
    const input: ClockScheduleInput = {
      ...parts.input,
      startMs: planClockStartMs,
      sleep: sleepBed != null && sleepWake != null ? { bedMinutes: sleepBed, wakeMinutes: sleepWake } : null,
      awakeForSeconds: AWAKE_AT_START_SECONDS,
    };
    return { ...parts, input, schedule: scheduleAroundSleep(input) };
  }, [response, planClockStartMs, sleepBed, sleepWake, dubcapAnchorMs, virtueTankViewBase]);
  const virtueTankView = useMemo(() => {
    if (!virtueTankViewBase || !planClock || !response) {
      return virtueTankViewBase;
    }
    const starts = planClock.schedule.sends.flatMap((send) => {
      const tankIndex = planClock.display.get(send.key)?.tankIndex;
      return send.pseudo || tankIndex == null ? [] : [{ tankIndex, at: send.startSeconds }];
    });
    return buildVirtueTankPlanView(response.plan, profileSnapshot?.plannedVirtueTank ?? profileSnapshot?.virtueTank, starts);
  }, [virtueTankViewBase, planClock, profileSnapshot, response]);
  // A later start with fewer relaunches at night, worked out after the page draws.
  const [bestStart, setBestStart] = useState<{
    input: ClockScheduleInput;
    current: StartTimeOption;
    best: StartTimeOption;
  } | null>(null);
  useEffect(() => {
    setBestStart(null);
    if (!planClock || !planClock.input.sleep || planClock.input.event || planClock.schedule.sends.length > 600) {
      return;
    }
    const timer = window.setTimeout(() => {
      const result = bestStartTime(planClock.input);
      if (result) {
        setBestStart({ input: planClock.input, ...result });
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [planClock]);
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
  // On the clock schedule when there is one: it waits for mornings and a dubcap's start.
  const projectedCompletion = useMemo(() => {
    const totalSeconds = planClock ? planClock.schedule.makespanSeconds : timelineTotalSeconds;
    if (totalSeconds == null || planClockStartMs == null || totalSeconds <= 0) {
      return null;
    }
    return {
      totalSeconds,
      at: new Date(planClockStartMs + totalSeconds * 1000),
    };
  }, [planClock, timelineTotalSeconds, planClockStartMs]);
  const craftPlanDetailRows = useMemo(() => {
    if (!response) {
      return [] as CraftPlanDetailRow[];
    }

    const recipeMap = recipes as Record<string, { ingredients: Record<string, number>; xp?: number } | null>;
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
    const plannedCraftsByKey: Record<string, number> = {};
    response.plan.crafts.forEach((craft) => {
      plannedCraftCountByItemId.set(craft.itemId, Math.max(0, craft.count));
      plannedCraftsByKey[itemIdToCanonicalKey(craft.itemId)] = Math.max(0, craft.count);
    });
    // Every goal artifact shows its shiny odds; a shiny goal also marks the rarity it aims for.
    const goalItemKeys = new Set(planTargets.map((target) => itemIdToCanonicalKey(target.targetItemId)));
    const shinyGoalByItemKey = new Map(
      (response.plan.shinyGoals || []).map((goal) => [itemIdToCanonicalKey(goal.itemId), goal])
    );

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
        const craftXp = plannedCraftCount * Math.max(0, recipeMap[itemKey]?.xp || 0);
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
        const shinyGoal = shinyGoalByItemKey.get(itemKey);
        // A shiny goal shows on its odds pill instead.
        if (!shinyGoal && craftGoalTotal > 0) {
          const craftedBefore = profileSnapshot
            ? Math.max(0, Math.round(profileSnapshot.craftCounts[itemKey] || 0))
            : null;
          craftGoalLabel =
            craftedBefore == null
              ? `craft goal ${craftGoalTotal.toLocaleString()}`
              : `craft goal ${craftGoalTotal.toLocaleString()} · ${craftedBefore.toLocaleString()} → ${(craftedBefore + plannedCraftCount).toLocaleString()}`;
        }
        const shinyOdds =
          (goalItemKeys.has(itemKey) || (showAllShinyOdds && shinyRaritiesFor(itemKey).length > 0)) && profileSnapshot
            ? buildShinyOddsPills(
                shinyOddsForPlan({
                  itemKey,
                  craftedBefore: Math.max(0, Math.round(profileSnapshot.craftCounts[itemKey] || 0)),
                  craftingXp: profileSnapshot.craftingXp || 0,
                  plannedCrafts: plannedCraftsByKey,
                  missions: response.plan.missions,
                  loot: lootData,
                  zerogLevel: response.profile.epicResearchZerogLevel,
                }),
                shinyGoal,
                itemIdToLabel(itemId)
              )
            : null;
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
          shinyOdds,
          isGoal: goalItemKeys.has(itemKey),
          plannedCraftCount,
          have,
          requiredForChain,
          expectedMission,
          fromConsumption,
          consumedCount,
          craftXp,
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
  }, [lastSolveRequest?.targetCraftedOnly, lootData, profileSnapshot, response, showAllShinyOdds]);
  // Each row counts only its own crafts, so the rows add up without counting a craft twice.
  const craftPlanXp = useMemo(() => {
    const total = craftPlanDetailRows.reduce((sum, row) => sum + row.craftXp, 0);
    if (total <= 0) {
      return null;
    }
    if (!profileSnapshot) {
      return { total, levelLabel: null };
    }
    const before = getCraftingLevelProgress(profileSnapshot.craftingXp || 0).level;
    const after = getCraftingLevelProgress((profileSnapshot.craftingXp || 0) + total).level;
    return { total, levelLabel: before === after ? `crafting level ${after}` : `crafting level ${before} → ${after}` };
  }, [craftPlanDetailRows, profileSnapshot]);
  const relevantYieldsByMission = useMemo(
    () => (response ? rankRelevantYields(response.plan, profileSnapshot?.inventory ?? null) : new Map<number, RankedYield[]>()),
    [response, profileSnapshot]
  );
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
      if (mission.inAir || mission.dubcap) return;
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
          targetOptions,
          { allowShipStars: true }
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
      setVirtueTankEdits(parseStoredVirtueTankEdits(readFirstStoredString([LOCAL_PREF_KEYS.plannerVirtueTankEdits])));
      const savedFastMode = readStoredBoolean([LOCAL_PREF_KEYS.plannerFastMode]);
      setIncludeDubcap(readStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDubcap]) ?? false);
      setSleepPrefs(readSleepPreferences());
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

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    try {
      writeStoredString([LOCAL_PREF_KEYS.plannerVirtueTankEdits], virtueTankEdits ? JSON.stringify(virtueTankEdits) : "");
    } catch {
      // Ignore localStorage persistence errors.
    }
  }, [virtueTankEdits, prefsLoaded]);

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
    if (prefsLoaded) writeStoredBoolean([LOCAL_PREF_KEYS.plannerIncludeDubcap], includeDubcap);
  }, [includeDubcap, prefsLoaded]);
  useEffect(() => {
    if (prefsLoaded) writeStoredString([LOCAL_PREF_KEYS.plannerSleep], JSON.stringify(sleepPrefs));
  }, [sleepPrefs, prefsLoaded]);
  // Dubcap start with no time set (or one that has passed) starts from the likely next one.
  useEffect(() => {
    if (prefsLoaded && effectiveStartMode === "dubcap" && !knownLiveDubcap && dubcapStartMs == null) {
      setDubcapStartMs(nextLikelyDubcapStartMs(Date.now()));
    }
  }, [prefsLoaded, effectiveStartMode, knownLiveDubcap, dubcapStartMs]);

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
    lockedLaunchRows,
    onlyLockedLaunches,
    finishByMs,
    finishByOn,
    startMode,
    startAtMs,
    dubcapStartMs,
    inventorySource,
    prefsLoaded,
  ]);

  const currentNormalizedTargets = solveTargets.length > 0 ? solveTargets : [{ targetItemId, quantity }];
  const currentPrimaryTarget = currentNormalizedTargets[0];
  const currentAllowedShipDurations = shipSelectorSummary.allSelected
    ? undefined
    : shipSelectorSummary.allowed.map((entry) => ({ ...entry }));
  const currentLockedLaunches = lockedLaunchRowsToLocks(lockedLaunchRows);
  const currentSolveRequest: LastSolveInputs = {
    eid: trimmedEid,
    targetItemId: currentPrimaryTarget.targetItemId,
    quantity: currentPrimaryTarget.quantity,
    targets: currentNormalizedTargets,
    targetCraftedOnly,
    priorityTime: solvePriorityTime,
    fastMode,
    ...(includeDubcap ? { includeDubcap: true } : {}),
    allowedShipDurations: currentAllowedShipDurations,
    selectedConsumptionItemIds,
    ...(currentLockedLaunches.length > 0 ? { lockedLaunches: currentLockedLaunches } : {}),
    ...(currentLockedLaunches.length > 0 && onlyLockedLaunches ? { onlyLockedLaunches: true } : {}),
    ...(activeFinishByMs != null ? { finishByMs: activeFinishByMs } : {}),
    ...(effectiveStartMode === "custom" && startAtMs != null ? { startAtMs } : {}),
    // A dubcap's start only changes the solve through a finish time (which counts from it).
    ...(effectiveStartMode === "dubcap" && activeFinishByMs != null && dubcapStartMs != null && !knownLiveDubcap
      ? { dubcapStartMs }
      : {}),
    // Left undefined in main mode so JSON.stringify drops them and main-farm
    // requests compare the same as before.
    virtueShiftCap: inventorySource === "virtue" ? virtueShiftCap : undefined,
    virtueStartTank: inventorySource === "virtue" ? virtueStartTank : undefined,
    sourceFilters: { ...sourceFilters },
    // Left out when nothing is customized, so such requests compare the same as before.
    ...(profileOverrideCount(profileOverrides) > 0 ? { profileOverrides } : {}),
  };
  const planInputsChanged =
    !response || !lastSolveRequest || JSON.stringify(currentSolveRequest) !== JSON.stringify(lastSolveRequest);
  const plannerReady = highs.ready && lootData !== null;

  async function runBuildPlan(options: { fasterOption?: boolean } = {}) {
    if (!plannerReady) {
      setError("The local planner is still loading. Try again in a moment.");
      return;
    }
    if (activeFinishByMs != null && activeFinishByMs <= Date.now()) {
      setError("The finish time has passed. Pick a later one, or clear it.");
      return;
    }
    const plannedStartMs = currentSolveRequest.startAtMs ?? currentSolveRequest.dubcapStartMs;
    if (activeFinishByMs != null && plannedStartMs != null && activeFinishByMs <= plannedStartMs) {
      setError("The finish time is before the plan starts. Pick a later finish time or an earlier start.");
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
        setFetchedProfileSummary({ eid: trimmedEid, summary: summarizeProfile(profile) });
        if (snapshotRequest.profileOverrides) {
          profile = applyProfileOverrides(profile, snapshotRequest.profileOverrides);
        }
        // The card's hand edits override this backup's readings, however new it is.
        if (inventorySource === "virtue" && profile.virtueTank && virtueTankEdits?.eid === trimmedEid) {
          profile = { ...profile, plannedVirtueTank: applyVirtueTankEdits(profile.virtueTank, virtueTankEdits, trimmedEid) ?? undefined };
        }

        setPlannerProgress({
          phase: "init",
          message: "Profile loaded. Starting client-side solve...",
          elapsedMs: Math.max(0, Date.now() - startedAt),
          completed: null,
          total: null,
          etaMs: null,
        });

        // A later start: the plan sees ships in the air (and a live dubcap) as they will be then.
        const solveNowMs = Date.now();
        const startDelaySeconds =
          snapshotRequest.startAtMs != null ? Math.max(0, (snapshotRequest.startAtMs - solveNowMs) / 1000) : 0;
        const solveProfile = startDelaySeconds > 0 ? profileAfter(profile, startDelaySeconds) : profile;
        // The finish time counts from the start: a set time, or a dubcap still to come (a live one starts now).
        const finishFromMs =
          snapshotRequest.startAtMs != null
            ? Math.max(solveNowMs, snapshotRequest.startAtMs)
            : snapshotRequest.dubcapStartMs != null && !profile.liveDubcap
              ? Math.max(solveNowMs, snapshotRequest.dubcapStartMs)
              : solveNowMs;
        const result = await planForTarget(
          solveProfile as Parameters<typeof planForTarget>[0],
          primaryTarget.targetItemId,
          normalizedQuantity,
          snapshotRequest.priorityTime,
          {
            objectiveMode: inventorySource === "virtue" ? "virtueFuel" : "ge",
            virtueTank:
              inventorySource === "virtue"
                ? buildVirtueTankPlannerOptions(profile.plannedVirtueTank ?? profile.virtueTank, virtueShiftCap, virtueStartTank)
                : undefined,
            fastMode,
            includeDubcap: snapshotRequest.includeDubcap,
            missionDropRarities: {
              rare: includeDropRare,
              epic: includeDropEpic,
              legendary: includeDropLegendary,
              fragments: includeDropFragments,
            },
            targetCraftedOnly,
            targets: normalizedTargets,
            allowedShipDurations: allowedShipDurationsForSolve,
            lockedLaunches: snapshotRequest.lockedLaunches,
            onlyLockedLaunches: snapshotRequest.onlyLockedLaunches,
            finishWithinSeconds:
              snapshotRequest.finishByMs != null ? Math.max(0, (snapshotRequest.finishByMs - finishFromMs) / 1000) : undefined,
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
        setSolvedStartDelaySeconds(startDelaySeconds > 0 ? startDelaySeconds : null);
        setProfileSnapshot(profile);
        setLastSolveRequest(snapshotRequest);
        if (options.fasterOption && snapshotRequest.virtueShiftCap != null) {
          setFasterOptionPlanned(snapshotRequest.virtueShiftCap);
        }
        if (inventorySource === "virtue" && !isDemoMode) {
          setVirtueTankPreview({ eid: trimmedEid, status: "ready", virtueTank: profile.virtueTank ?? null, error: null });
        }
        writePersistedPlannerSession(planResponse, profile, snapshotRequest);
        if (!isDemoMode) {
          writeSavedPlannerPlanLaunches(snapshotRequest.sourceFilters.inventorySource, {
            savedAt: new Date().toISOString(),
            eid: snapshotRequest.eid,
            plan: { ...result, fueling: plannerPlanFueling(result) },
          });
        }
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
        case "goalMode":
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

  const planProgress = launchProgress && launchProgress.plan === response ? launchProgress : null;
  const planProgressResult = planProgress?.status === "ready" ? planProgress.result ?? null : null;
  const planProgressUnavailable = !response || !profileSnapshot || !lastSolveRequest
    ? "Build a plan first."
    : isDemoMode || profileSnapshot.eid === "DEMO"
      ? "Enter your EID to follow a plan."
      : profileSnapshot.eid !== trimmedEid
        ? "This plan is for a different EID."
        : !profileSnapshot.recentLaunches
          ? "This plan was built before progress tracking. Update the plan once to start following it."
          : null;

  const checkLaunchProgress = async (): Promise<void> => {
    if (planProgressUnavailable || !response || !profileSnapshot?.recentLaunches || !lastSolveRequest) {
      return;
    }
    const plan = response;
    const baseline = profileSnapshot.recentLaunches;
    setLaunchProgress({ plan, status: "loading" });
    try {
      const current = await fetchProfileSnapshot(trimmedEid, lastSolveRequest.sourceFilters);
      const result = planLaunchProgress({
        missions: plan.plan.missions,
        prepLaunches: plan.plan.progression.prepLaunches,
        fueling: plannerPlanFueling(plan.plan),
        virtue: lastSolveRequest.sourceFilters.inventorySource === "virtue",
        baseline,
        current: current.recentLaunches ?? [],
      });
      setLaunchProgress({ plan, status: "ready", result, checkedAtMs: Date.now() });
    } catch (progressError) {
      setLaunchProgress({
        plan,
        status: "error",
        error: `Couldn't check progress: ${progressError instanceof Error ? progressError.message : String(progressError)}`,
      });
    }
  };

  const loadPlanFile = async (file: File | undefined): Promise<void> => {
    if (!file) {
      return;
    }
    const problem = storePlanFile(await file.text(), trimmedEid);
    if (problem) {
      setError(problem);
      return;
    }
    window.location.reload();
  };

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
    // The snapshot script plans from `virtueTank`, so it gets the tank as the plan saw it.
    const { plannedVirtueTank, ...exportedProfile } = profileSnapshot;
    const sanitizedProfile: ProfileSnapshot = {
      ...exportedProfile,
      ...(plannedVirtueTank ? { virtueTank: plannedVirtueTank } : {}),
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
        includeDubcap: lastSolveRequest.includeDubcap,
        allowedShipDurations: lastSolveRequest.allowedShipDurations,
        selectedConsumptionItemIds: lastSolveRequest.selectedConsumptionItemIds,
        ...(lastSolveRequest.lockedLaunches ? { lockedLaunches: lastSolveRequest.lockedLaunches } : {}),
        ...(lastSolveRequest.onlyLockedLaunches ? { onlyLockedLaunches: true } : {}),
        ...(lastSolveRequest.finishByMs != null ? { finishByMs: lastSolveRequest.finishByMs } : {}),
        ...(response.plan.budget?.finishWithinSeconds !== undefined
          ? { finishWithinSeconds: response.plan.budget.finishWithinSeconds }
          : {}),
        ...(lastSolveRequest.startAtMs != null ? { startAtMs: lastSolveRequest.startAtMs } : {}),
        ...(lastSolveRequest.dubcapStartMs != null ? { dubcapStartMs: lastSolveRequest.dubcapStartMs } : {}),
        ...(planStartDelaySeconds > 0 ? { startDelaySeconds: planStartDelaySeconds } : {}),
        virtueShiftCap: lastSolveRequest.virtueShiftCap,
        virtueStartTank: lastSolveRequest.virtueStartTank,
      },
      sourceFilters: lastSolveRequest.sourceFilters,
      ...(lastSolveRequest.profileOverrides ? { profileOverrides: lastSolveRequest.profileOverrides } : {}),
      profile: sanitizedProfile,
      advancedCompare: {
        availableCombos,
        selectedCombos,
      },
      output: {
        plannedAt: planReceivedAtMs == null ? null : new Date(planReceivedAtMs).toISOString(),
        profile: { ...response.profile, eid: sanitizedProfile.eid },
        plan: response.plan,
      },
    };
    const capturedDate = payload.capturedAt.slice(0, 19).replaceAll(":", "-").replace("T", "_");
    const fileName = `mission-craft-solve-${capturedDate}.json`;
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
          includeDubcap: Boolean(response.plan.dubcap),
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
          includeDubcap: Boolean(response.plan.dubcap),
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
  const cardVirtueTankEdited = applyVirtueTankEdits(cardVirtueTank, virtueTankEdits, virtueTankForCard.eid) ?? null;
  // Edits can fill the tank past its capacity (VIRTUE_TANK_EDIT_MAX_TANKS), or outlive the backup
  // they were made on while an unedited egg grows.
  const cardVirtueTankOverfull =
    cardVirtueTankEdited && cardVirtueTankEdited !== cardVirtueTank
      ? VIRTUE_TANK_READOUT_ORDER.reduce((sum, egg) => sum + Math.max(0, cardVirtueTankEdited.fuels[egg] || 0), 0) -
          cardVirtueTankEdited.capacity >
        virtueFuelTolerance(cardVirtueTankEdited.capacity)
      : false;
  const handleVirtueTankEdit = (egg: VirtueTankEggKey, amount: number) => {
    const backup = cardVirtueTank;
    if (!backup) {
      return;
    }
    const eidKey = virtueTankForCard.eid;
    setVirtueTankEdits((current) => {
      const fuels = current?.eid === eidKey ? { ...current.fuels } : {};
      if (Math.abs(amount - (backup.fuels[egg] || 0)) <= VIRTUE_FUEL_NOISE) {
        delete fuels[egg];
      } else {
        fuels[egg] = amount;
      }
      return Object.keys(fuels).length > 0 ? { eid: eidKey, fuels } : null;
    });
  };
  const planVirtueTanks = response?.plan.virtueTanks ?? null;
  const planGoalShortfalls = response?.plan.targetBreakdowns.filter((goal) => goal.shortfall > 1e-6) ?? [];
  const planBudget = response?.plan.budget ?? null;
  const planHasGoalShortfalls = (planVirtueTanks != null || planBudget != null) && planGoalShortfalls.length > 0;
  // Advisory shifts for completing all goals. Older saved plans may instead
  // carry a plan whose packing exceeded the selected cap.
  const planOverCapByPacking =
    planVirtueTanks != null && !planVirtueTanks.overCap && planVirtueTanks.pack.totalShifts > planVirtueTanks.shiftCap;
  const planNeededShifts = planVirtueTanks?.neededShifts ?? (
    planVirtueTanks?.overCap
      ? planVirtueTanks.plannedShiftCap
      : planOverCapByPacking ? planVirtueTanks!.pack.totalShifts : null
  );
  // The all-goals marker sits over the slider while the cap is below it.
  const shiftCapNeedIndex = (() => {
    if (inventorySource !== "virtue" || planNeededShifts == null || planNeededShifts <= virtueShiftCap) {
      return null;
    }
    const detent = shiftCapDetentFor(planNeededShifts);
    return detent == null ? VIRTUE_SHIFT_CAP_DETENTS.length - 1 : VIRTUE_SHIFT_CAP_DETENTS.indexOf(detent);
  })();
  const planNeededShiftsDetent = planNeededShifts != null ? shiftCapDetentFor(planNeededShifts) : null;
  // A plan with a budget explains its shortfalls in its own banner.
  const virtueBannerShown = Boolean(
    virtueTankView && planVirtueTanks && !planBudget && (planHasGoalShortfalls || planNeededShifts != null)
  );
  const clockSummary = planClock ? (
    <ClockSummary
      clock={planClock}
      sleep={planClock.input.sleep}
      finishByMs={lastSolveRequest?.finishByMs ?? null}
      dubcapAnchorMs={dubcapAnchorMs}
      bestStart={bestStart && bestStart.input === planClock.input ? bestStart : null}
      onUseStart={(ms) => {
        setStartMode("custom");
        setStartAtMs(Math.ceil(ms / 60_000) * 60_000);
      }}
    />
  ) : null;
  const budgetBanner = (() => {
    if (!planBudget || (!planHasGoalShortfalls && !planBudget.overFinishTime)) {
      return null;
    }
    const startMs = planClockStartMs ?? Date.now();
    const finishBy =
      lastSolveRequest?.finishByMs != null
        ? formatShortDateTime(lastSolveRequest.finishByMs)
        : planBudget.finishWithinSeconds !== undefined
          ? formatShortDateTime(startMs + planBudget.finishWithinSeconds * 1000)
          : null;
    const within = [
      ...(planBudget.onlyLockedLaunches ? ["the locked launches"] : []),
      ...(finishBy ? [`launches back by ${finishBy}`] : []),
    ].join(" and ");
    const inAirPastFinish =
      planBudget.finishWithinSeconds !== undefined && (planSchedule?.inAirSeconds ?? 0) > planBudget.finishWithinSeconds;
    const overrun = !planBudget.overFinishTime || !planSchedule
      ? ""
      : inAirPastFinish
        ? ` Ships already in the air land after it, at ${formatShortDateTime(startMs + planSchedule.inAirSeconds * 1000)}.`
        : ` No plan turned up that ends by then: this one ends ${formatShortDateTime(startMs + planSchedule.totalSeconds * 1000)}.`;
    return planHasGoalShortfalls
      ? { headline: `Not every goal fits ${within}.`, detail: `Planned as far toward them as possible.${overrun}` }
      : { headline: "This plan runs past the finish time.", detail: overrun.trim() };
  })();
  // Only a finished search establishes a minimum; otherwise it is a suggestion.
  // Older over-cap plans don't say; they read as proven, as they always have.
  const planNeededShiftsProven = planVirtueTanks?.overCap
    ? planVirtueTanks.neededShiftsProven !== false
    : planVirtueTanks?.neededShiftsProven === true;
  const shiftCapBanner =
    virtueBannerShown && planVirtueTanks
      ? shiftCapBannerCopy(planVirtueTanks, planNeededShifts, planNeededShiftsProven, planHasGoalShortfalls)
      : null;

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
      !planHasGoalShortfalls &&
      planNeededShifts == null &&
      planFasterOption &&
      planFasterOption.shifts > planVirtueTanks.shiftCap
  );
  // Notes the banners already say are left out while they show.
  const plannerNotes = (response?.plan.notes ?? []).filter(
    (note) =>
      !(virtueBannerShown || virtueSlowPlanBannerShown) ||
      !VIRTUE_BANNER_NOTE_PATTERNS.some((pattern) => pattern.test(note))
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
              <div className={`${styles.helpText} ${styles.eidHelpRow}`}>
                <span>Enter your EID for personalized plans, or leave blank to run a demo profile.</span>
                <ProfileCustomizer
                  eid={eid}
                  overrides={profileOverrides}
                  onChange={setProfileOverrides}
                  summary={profileSummaryForDialog}
                  pendingNote={
                    response &&
                    JSON.stringify(lastSolveRequest?.profileOverrides ?? {}) !==
                      JSON.stringify(profileOverrideCount(profileOverrides) > 0 ? profileOverrides : {})
                      ? "rebuild to apply"
                      : null
                  }
                />
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

            <LockedLaunchesEditor
              rows={lockedLaunchRows}
              onRowsChange={setLockedLaunchRows}
              onlyLocked={onlyLockedLaunches}
              onOnlyLockedChange={setOnlyLockedLaunches}
              shipLevels={profileSnapshot?.shipLevels ?? null}
              includeDubcap={includeDubcap}
              onIncludeDubcap={() => setIncludeDubcap(true)}
              open={lockedLaunchesOpen}
              onOpenChange={setLockedLaunchesOpen}
            />
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
                options={goalOptions}
                craftCounts={profileSnapshot ? profileSnapshot.craftCounts : null}
                craftingXp={profileSnapshot ? profileSnapshot.craftingXp : null}
                allowShinyGoals
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
                      build-up phase to match the Initial Tank we&apos;ll recommend below.
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
                {cardVirtueTankOverfull && cardVirtueTankEdited && (
                  <VirtueNotice tone="info">
                    Your edited tank holds more than its {formatTankFuel(cardVirtueTankEdited.capacity)}. The plan&apos;s
                    first tank uses all of it with no shift counted, as if you top it up on a later trip; refuels
                    still fill to {formatTankFuel(cardVirtueTankEdited.capacity)}.
                  </VirtueNotice>
                )}
                {cardVirtueTank && cardVirtueTankEdited ? (
                  <VirtueTankReadout
                    tank={cardVirtueTankEdited}
                    backup={cardVirtueTank}
                    onEdit={effectiveVirtueStartTank === "current" ? handleVirtueTankEdit : undefined}
                    onReset={() => setVirtueTankEdits(null)}
                  />
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
                      <span className={styles.labelWithHelp}>
                        <label className={styles.fieldLabel} htmlFor="virtueShiftCap">Shift cap</label>
                        <HelpTip label="Shift cap">
                          {virtueShiftCap === 0 ? (
                            <>No refuels: the plan uses the initial tank and shows any goals it can&apos;t reach.</>
                          ) : (
                            <>
                              The plan stays within this cap and shows any goal shortfalls. Room for up to{" "}
                              {pluralize(Math.floor(virtueShiftCap / 2), "refuel loop")}. A loop costs 1 shift per egg
                              refilled + 1 back to Humility, e.g.{" "}
                              <span className={styles.shiftCapRoute}>C → R → K → H</span> = 4.
                            </>
                          )}
                        </HelpTip>
                      </span>
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
                        aria-describedby={virtueShiftCap > 0 && cardVirtueTank ? "virtueShiftCapHint" : undefined}
                      />
                      {shiftCapNeedIndex != null && planNeededShifts != null && (
                        <div
                          className={styles.shiftCapNeed}
                          data-edge={shiftCapNeedIndex === VIRTUE_SHIFT_CAP_DETENTS.length - 1 ? "end" : undefined}
                          style={{
                            left: `calc(9px + (100% - 18px) * ${shiftCapNeedIndex / (VIRTUE_SHIFT_CAP_DETENTS.length - 1)})`,
                          }}
                        >
                          {/* A proven minimum, or a found plan that fewer shifts may also manage. */}
                          <span>
                            all goals: {planNeededShiftsProven ? "" : "≤"}
                            {planNeededShifts}
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
                    {virtueShiftCap > 0 && cardVirtueTank && (
                      <div className={styles.shiftCapHint} id="virtueShiftCapHint">
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
                      </div>
                    )}
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
              <div className={styles.finishByBlock}>
                <div className={styles.checkWithHelp}>
                  <label className={styles.customCheck} htmlFor="finishByOn">
                    <input
                      id="finishByOn"
                      type="checkbox"
                      checked={finishByOn}
                      onChange={(event) => {
                        const on = event.target.checked;
                        setFinishByOn(on);
                        // A fresh tick starts a day out, on the hour.
                        if (on && (finishByMs == null || finishByMs <= Date.now())) {
                          setFinishByMs(Math.ceil((Date.now() + 24 * 3_600_000) / 3_600_000) * 3_600_000);
                        }
                      }}
                    />
                    <span aria-hidden="true" />
                    <span>Finish by</span>
                  </label>
                  <HelpTip label="Finish by">
                    The plan only makes launches that are back by this time, counting from when you build it, with
                    ships already in the air holding their slots until they land. Goals that don&apos;t fit are left
                    short, as far along as the time gets them.
                  </HelpTip>
                </div>
                {finishByOn && (
                  <div className={styles.finishByRow}>
                    <input
                      id="finishBy"
                      type="datetime-local"
                      className={styles.textInput}
                      aria-label="Finish by"
                      value={finishByMs != null ? toDateTimeLocalValue(finishByMs) : ""}
                      min={toDateTimeLocalValue(Date.now())}
                      onChange={(event) => {
                        const ms = event.target.value ? new Date(event.target.value).getTime() : NaN;
                        setFinishByMs(Number.isFinite(ms) ? ms : null);
                      }}
                      aria-describedby="finishByHint"
                    />
                    <span className={styles.finishByHint} id="finishByHint" data-past={finishByMs != null && finishByMs <= Date.now() ? "1" : undefined}>
                      {finishByMs == null
                        ? "Pick a time"
                        : finishByMs <= Date.now()
                          ? "Already passed"
                          : `in ${formatDurationFromHours((finishByMs - Date.now()) / 3_600_000)}`}
                    </span>
                  </div>
                )}
              </div>
              <div className={styles.checkWithHelp}>
                <label className={styles.customCheck} htmlFor="includeDubcap">
                  <input
                    id="includeDubcap"
                    type="checkbox"
                    checked={includeDubcap}
                    onChange={(event) => setIncludeDubcap(event.target.checked)}
                    aria-describedby={knownLiveDubcap ? "dubcapHint" : undefined}
                  />
                  <span aria-hidden="true" />
                  <span>Include one dubcap</span>
                </label>
                <HelpTip label="Include one dubcap">
                  Uses the dubcap running when you build the plan, if there is one. Otherwise one fresh 48-hour window
                  with double drops, once prep and current missions return; calendar waiting is excluded.
                </HelpTip>
              </div>
              {knownLiveDubcap && (
                <p className={styles.dubcapHint} id="dubcapHint">
                  A {knownLiveDubcap.multiplier === 2 ? "double" : `${knownLiveDubcap.multiplier}×`} capacity event
                  {knownLiveDubcap.ultra ? " (Ultra)" : ""} is running until{" "}
                  {new Date(knownLiveDubcap.endsAtMs).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}.
                  Plans launch into the time left as each slot frees up.
                </p>
              )}
              <div className={styles.finishByBlock}>
                <div className={styles.checkWithHelp}>
                  <label className={styles.customCheck} htmlFor="sleepOn">
                    <input
                      id="sleepOn"
                      type="checkbox"
                      checked={sleepPrefs.on}
                      onChange={(event) => {
                        const on = event.target.checked;
                        setSleepPrefs((prefs) => ({ ...prefs, on }));
                      }}
                    />
                    <span aria-hidden="true" />
                    <span>Avoid sends while I sleep</span>
                  </label>
                  <HelpTip label="Avoid sends while I sleep">
                    Puts the plan on your clock. A slot that frees up while you&apos;re asleep waits for the morning, and
                    where the plan leaves the order open, launches go in the order that brings ships back while you&apos;re
                    up. The launches themselves stay the same. Saved for every plan.
                  </HelpTip>
                </div>
                {sleepPrefs.on && (
                  <div className={styles.finishByRow}>
                    <input
                      type="time"
                      className={`${styles.textInput} ${styles.sleepTime}`}
                      aria-label="Bedtime"
                      value={toTimeInputValue(sleepPrefs.bedMinutes)}
                      onChange={(event) => {
                        const minutes = fromTimeInputValue(event.target.value);
                        if (minutes != null) setSleepPrefs((prefs) => ({ ...prefs, bedMinutes: minutes }));
                      }}
                    />
                    <span className={styles.finishByHint}>to</span>
                    <input
                      type="time"
                      className={`${styles.textInput} ${styles.sleepTime}`}
                      aria-label="Wake-up time"
                      value={toTimeInputValue(sleepPrefs.wakeMinutes)}
                      onChange={(event) => {
                        const minutes = fromTimeInputValue(event.target.value);
                        if (minutes != null) setSleepPrefs((prefs) => ({ ...prefs, wakeMinutes: minutes }));
                      }}
                    />
                    <span className={styles.finishByHint}>
                      {sleepLengthMinutes(sleepPrefs) > 0
                        ? `${formatDurationFromHours(sleepLengthMinutes(sleepPrefs) / 60)} asleep`
                        : "Pick two times"}
                    </span>
                  </div>
                )}
              </div>
              {startRowShown && (
                <div className={styles.finishByBlock}>
                  <div className={styles.startRow}>
                    <span className={styles.labelWithHelp}>
                      <span className={styles.fieldLabel}>Start</span>
                      <HelpTip label="Start">
                        When you send the plan&apos;s first launches. Ships already in the air land when they land. Dubcap
                        start puts a dubcap that hasn&apos;t begun at its start time, with prep before it; while one is
                        running, the plan starts now. A set time plans as if you built it then.
                      </HelpTip>
                    </span>
                    <fieldset className={styles.virtueOptSegment}>
                      <legend>Start</legend>
                      <label htmlFor="planStartNow">
                        <input
                          id="planStartNow"
                          type="radio"
                          name="planStart"
                          checked={effectiveStartMode === "now"}
                          onChange={() => setStartMode("now")}
                        />
                        Now
                      </label>
                      {includeDubcap && (
                        <label htmlFor="planStartDubcap">
                          <input
                            id="planStartDubcap"
                            type="radio"
                            name="planStart"
                            checked={effectiveStartMode === "dubcap"}
                            onChange={() => {
                              setStartMode("dubcap");
                              if (dubcapStartMs == null || dubcapStartMs <= Date.now()) {
                                setDubcapStartMs(nextLikelyDubcapStartMs(Date.now()));
                              }
                            }}
                          />
                          Dubcap start
                        </label>
                      )}
                      <label htmlFor="planStartAt">
                        <input
                          id="planStartAt"
                          type="radio"
                          name="planStart"
                          checked={effectiveStartMode === "custom"}
                          onChange={() => {
                            setStartMode("custom");
                            if (startAtMs == null || startAtMs <= Date.now()) {
                              setStartAtMs(Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000);
                            }
                          }}
                        />
                        Set time
                      </label>
                    </fieldset>
                  </div>
                  {effectiveStartMode === "custom" && (
                    <div className={styles.finishByRow}>
                      <input
                        type="datetime-local"
                        className={styles.textInput}
                        aria-label="Start time"
                        value={startAtMs != null ? toDateTimeLocalValue(startAtMs) : ""}
                        min={toDateTimeLocalValue(Date.now())}
                        onChange={(event) => {
                          const ms = event.target.value ? new Date(event.target.value).getTime() : NaN;
                          setStartAtMs(Number.isFinite(ms) ? ms : null);
                        }}
                      />
                      <span className={styles.finishByHint} data-past={startAtMs != null && startAtMs <= Date.now() ? "1" : undefined}>
                        {startAtMs == null
                          ? "Pick a time"
                          : startAtMs <= Date.now()
                            ? "Passed: plans start now"
                            : `in ${formatDurationFromHours((startAtMs - Date.now()) / 3_600_000)}`}
                      </span>
                    </div>
                  )}
                  {effectiveStartMode === "dubcap" &&
                    (knownLiveDubcap ? (
                      <p className={styles.dubcapHint}>A dubcap is running now, so the plan starts now.</p>
                    ) : (
                      <div className={styles.finishByRow}>
                        <input
                          type="datetime-local"
                          className={styles.textInput}
                          aria-label="Dubcap start"
                          value={dubcapStartMs != null ? toDateTimeLocalValue(dubcapStartMs) : ""}
                          min={toDateTimeLocalValue(Date.now())}
                          onChange={(event) => {
                            const ms = event.target.value ? new Date(event.target.value).getTime() : NaN;
                            setDubcapStartMs(Number.isFinite(ms) ? ms : null);
                          }}
                        />
                        <span className={styles.finishByHint} data-past={dubcapStartMs != null && dubcapStartMs <= Date.now() ? "1" : undefined}>
                          {dubcapStartMs == null
                            ? "Pick a time"
                            : dubcapStartMs <= Date.now()
                              ? "Passed"
                              : "Usually Sun 9 AM Pacific"}
                        </span>
                      </div>
                    ))}
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
              <div className={styles.planFileActions}>
                <button
                  type="button"
                  onClick={downloadSolveSnapshot}
                  disabled={!response || !profileSnapshot || !lastSolveRequest}
                  title="Save this plan, its goals and settings to a file, to open on another device or keep as a backup"
                >
                  Save plan file
                </button>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => planFileInputRef.current?.click()}
                  title="Open a saved plan file: its goals, settings and plan replace the ones here"
                >
                  Load plan file
                </button>
                <input
                  ref={planFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    void loadPlanFile(file);
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {appUpdated && (
          <div className={styles.demoNotice} role="status">
            <div>
              A newer version of this planner is live. This tab is still running the one it loaded, so reload before
              building a plan.
            </div>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        )}

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
      {/* Mounted empty before any plan, so the banner is announced when it appears. */}
      <div role="status">
        {budgetBanner && (
          <div className={styles.shiftCapBanner} data-tone="warn">
            {VIRTUE_WARN_ICON}
            <div className={styles.shiftCapBannerText}>
              <strong>{budgetBanner.headline}</strong> {budgetBanner.detail}
              {planHasGoalShortfalls && <GoalShortfallList goals={planGoalShortfalls} />}
            </div>
          </div>
        )}
      </div>
      {/* Mounted empty in virtue mode, before any plan, so the banner is announced when it appears. */}
      {(inventorySource === "virtue" || virtueTankView) && (
        <div role="status">
          {shiftCapBanner && (
            <div className={styles.shiftCapBanner} data-tone="warn">
              {VIRTUE_WARN_ICON}
              <div className={styles.shiftCapBannerText}>
                <strong>{shiftCapBanner.headline}</strong> {shiftCapBanner.detail}
                {planHasGoalShortfalls && <GoalShortfallList goals={planGoalShortfalls} />}
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
          {lastSolveRequest?.profileOverrides && (
            <p className={`muted ${styles.customizedPlanNote}`}>
              Planned with a customized profile ({profileOverrideCount(lastSolveRequest.profileOverrides)}{" "}
              {profileOverrideCount(lastSolveRequest.profileOverrides) === 1 ? "change" : "changes"}).
            </p>
          )}
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
                <div className="muted">{planHasGoalShortfalls ? "Partial plan completion" : "Projected completion"}</div>
                <div className="kpi">{formatPlanCompletion(projectedCompletion.at)}</div>
                <div
                  className={`muted ${styles.tooltipValue}`}
                  title={
                    planClock?.input.sleep
                      ? `Sends only while you're up, starting ${new Date(planClockStartMs ?? Date.now()).toLocaleString()}; slots that free up overnight wait for the morning. Total ${formatDurationFromHours(projectedCompletion.totalSeconds / 3600)}.`
                      : `Assumes you start launching ${planStartDelaySeconds > 0 ? "at the start time" : "now"} and keep all three mission slots busy. Total ${formatDurationFromHours(projectedCompletion.totalSeconds / 3600)} from ${new Date(planClockStartMs ?? Date.now()).toLocaleString()}.`
                  }
                >
                  {formatDurationFromHours(projectedCompletion.totalSeconds / 3600)} from{" "}
                  {planStartDelaySeconds > 0 && planClockStartMs != null ? formatShortDateTime(planClockStartMs) : "now"}
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
            <div className={styles.craftPlanHeader}>
              <h2 style={{ marginTop: 0 }}>Craft plan</h2>
              <label
                className={styles.craftPlanOption}
                title="Show the chance of each shiny rarity by the end of the plan on every artifact the plan crafts or drops, not just your goals."
              >
                <input
                  type="checkbox"
                  checked={showAllShinyOdds}
                  onChange={(event) => updateShowAllShinyOdds(event.target.checked)}
                />
                Shiny odds for all artifacts
              </label>
            </div>
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
                      <th>
                        <span
                          className={styles.tooltipValue}
                          title="+ stones and fragments you get by consuming artifacts; − artifacts the plan consumes."
                        >
                          Consumption
                        </span>
                      </th>
                      <th>
                        <span
                          className={`${styles.stackedTableHeader} ${styles.tooltipValue}`}
                          title="Crafting XP from each row's own planned crafts. Crafts of its ingredients count on their own rows."
                        >
                          Craft<br />XP
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {craftPlanDetailRows.map((craft) => {
                      const iconUrl = itemIdToIconUrl(craft.itemId);
                      return (
                        <tr key={craft.itemId} className={craft.isGoal ? styles.craftGoalRow : undefined}>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              {craft.isGoal && <span className={styles.srOnly}>Goal:</span>}
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
                                {craft.shinyOdds && (
                                  <div className={styles.shinyOdds} aria-label="Shiny odds by the end of the plan">
                                    {craft.shinyOdds.map((pill) => (
                                      <span
                                        key={pill.rarity}
                                        className={styles.shinyOddsPill}
                                        data-rarity={pill.rarity}
                                        data-goal={pill.goalChance != null ? "1" : "0"}
                                        data-none={pill.chance <= 0 ? "1" : "0"}
                                        title={pill.title}
                                      >
                                        {SHINY_RARITY_LABELS[pill.rarity]} {formatOddsPercent(pill.chance)}
                                        {pill.goalChance != null && (
                                          <span className={styles.shinyOddsGoal}>goal {Math.round(pill.goalChance * 100)}%</span>
                                        )}
                                      </span>
                                    ))}
                                  </div>
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
                            <CraftConsumptionCell craft={craft} />
                          </td>
                          <td>
                            {craft.craftXp > 0 ? (
                              <span
                                className={styles.tooltipValue}
                                title={`${craft.plannedCraftCount.toLocaleString()} ${
                                  craft.plannedCraftCount === 1 ? "craft" : "crafts"
                                } × ${(craft.craftXp / craft.plannedCraftCount).toLocaleString()} XP`}
                              >
                                {craft.craftXp.toLocaleString()}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {craftPlanXp && (
                    <tfoot>
                      <tr className={styles.craftTotalRow}>
                        <td>Total</td>
                        <td colSpan={5} />
                        <td>
                          <div>{craftPlanXp.total.toLocaleString()}</div>
                          {craftPlanXp.levelLabel && <div className={`muted ${styles.craftTotalLevel}`}>{craftPlanXp.levelLabel}</div>}
                        </td>
                      </tr>
                    </tfoot>
                  )}
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
            <VirtueFuelTanksPanel view={virtueTankView} planStartMs={planClockStartMs ?? Date.now()} />
          )}

          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Mission plan</h2>
            {!isDemoMode && profileSnapshot?.eid !== "DEMO" && (
              <PlanProgressStrip
                state={planProgress}
                unavailable={planProgressUnavailable}
                onCheck={() => void checkLaunchProgress()}
              />
            )}
            {virtueTankView && (
              <VirtueTankTimeline
                view={virtueTankView}
                plan={response.plan}
                clock={planClock}
                sleep={planClock?.input.sleep ?? null}
                summary={clockSummary}
              />
            )}
            {missionTimeline && (
              <div className={styles.timelinePanel}>
                <p className={`muted ${styles.timelineIntro}`}>
                  {planClock
                    ? `3-slot launch schedule on your clock${planClock.input.sleep ? "; shaded bands are nights" : ""}.${response.plan.dubcap ? " Prep, then the dubcap window, then ordinary missions once the event's ships return." : ""}`
                    : response.plan.dubcap
                      ? "3-slot launch schedule: prep, then the dubcap window, then ordinary missions once the event's ships return."
                      : "Heuristic 3-slot timeline view of recommended launches. Exact ordering can vary, but total workload matches the plan."}
                </p>
                {clockSummary}
                <div className={styles.timelineStats}>
                  <span>
                    Model total: <strong>{formatDurationFromHours(response.plan.expectedHours)}</strong>
                  </span>
                  <span>
                    Timeline makespan:{" "}
                    <strong>
                      {formatDurationFromHours((planClock ? planClock.schedule.makespanSeconds : missionTimeline.totalSeconds) / 3600)}
                    </strong>
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

                {planClock ? <ClockLanes clock={planClock} sleep={planClock.input.sleep} /> : <div className={styles.timelineLanes}>
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
                </div>}

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
            {response.plan.dubcap && (
              <DubcapTimeline
                event={response.plan.dubcap}
                tankLabels={response.plan.virtueTanks?.pack.tanks.map((tank) => tank.label)}
                clockPlan={planClock}
              />
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
                      <th scope="col">
                        Top relevant yields <em className={styles.perShipYield}>(per ship)</em>
                      </th>
                    </tr>
                  </thead>
                  <VirtueTankMissionRows
                    view={virtueTankView}
                    plan={response.plan}
                    targetOverrideByIndex={missionPrepTargetOverrideByIndex}
                    inventory={profileSnapshot?.inventory ?? null}
                    progress={planProgressResult}
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
                      <th>
                        Top relevant yields <em className={styles.perShipYield}>(per ship)</em>
                      </th>
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
                          {
                            key: `${missionIndex}:${mission.ship}:${mission.durationType}:${mission.missionId}:${mission.targetAfxId}`,
                            yields: relevantYieldsByMission.get(missionIndex),
                            done: mission.inAir ? undefined : planProgressResult?.missionDone[missionIndex],
                          }
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
                        <td>
                          {prep.launches.toLocaleString()}
                          {(planProgressResult?.prepDone[index] ?? 0) > 0 && (
                            <span className={styles.splitNote}>
                              {planProgressResult!.prepDone[index].toLocaleString()} flown
                            </span>
                          )}
                        </td>
                        <td>{formatDurationFromHours((prep.durationSeconds * prep.launches) / 3600)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <ShipProgressPanel
            start={response.profile.shipLevels}
            end={response.plan.progression.projectedShipLevels}
          />

          <details className={`panel ${styles.plannerNotes}`}>
            <summary>
              <h2>Planner notes</h2>
              <span className={styles.plannerNotesCount}>
                {plannerNotes.length.toLocaleString()} {plannerNotes.length === 1 ? "note" : "notes"}
                {response.plan.unmetItems.length > 0 &&
                  ` · ${response.plan.unmetItems.length.toLocaleString()} unmet ${response.plan.unmetItems.length === 1 ? "item" : "items"}`}
              </span>
            </summary>
            <ul style={{ margin: 0 }}>
              {plannerNotes.map((note, index) => (
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
          </details>

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
                  title="Download the solve: its inputs (settings and profile state, replayable) and the plan they produced"
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
                            <td><span className={planHasGoalShortfalls ? "error" : "good"}>{planHasGoalShortfalls ? "partial" : "yes"}</span></td>
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
