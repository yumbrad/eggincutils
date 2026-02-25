"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";

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

type MissionTimeline = {
  lanes: TimelineLaneBlock[][];
  segments: TimelineSegment[];
  totalSeconds: number;
  modelTotalSlotSeconds: number;
  missionSlotSeconds: number;
  hiddenPrepSlotSeconds: number;
};

const DURATION_TYPES: DurationType[] = ["TUTORIAL", "SHORT", "LONG", "EPIC"];

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

function timelineColor(seed: string, phase: "mission" | "prep"): string {
  if (phase === "prep") {
    return "color-mix(in oklab, #b9a1f1, var(--panel) 18%)";
  }
  const hue = hashString(seed) % 360;
  return `hsla(${hue}, 70%, 56%, 0.58)`;
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
  const missionSegments: TimelineSegment[] = plan.missions
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
        color: timelineColor(`${mission.ship}|${mission.durationType}|${mission.targetAfxId}`, "mission"),
        phase: "mission",
      };
    })
    .filter((segment): segment is TimelineSegment => segment !== null)
    .sort((a, b) => b.durationSeconds - a.durationSeconds || b.launches - a.launches || a.label.localeCompare(b.label));

  const missionSlotSeconds = missionSegments.reduce((sum, segment) => sum + segment.totalSlotSeconds, 0);
  const modelTotalSlotSeconds = Math.max(0, Math.round(plan.expectedHours * 3 * 3600));
  let hiddenPrepSlotSeconds = Math.max(0, modelTotalSlotSeconds - missionSlotSeconds);
  if (hiddenPrepSlotSeconds < 60) {
    hiddenPrepSlotSeconds = 0;
  }

  const segments = [...missionSegments];
  if (hiddenPrepSlotSeconds > 0) {
    segments.unshift({
      id: "prep-only",
      label: "Progression-only prep",
      subtitle: "No required-item drop coverage",
      launches: 0,
      durationSeconds: 0,
      totalSlotSeconds: hiddenPrepSlotSeconds,
      color: timelineColor("prep-only", "prep"),
      phase: "prep",
    });
  }

  if (segments.length === 0) {
    return null;
  }

  const lanes: TimelineLaneBlock[][] = [[], [], []];
  const laneLoads = [0, 0, 0];

  for (const segment of segments) {
    if (segment.phase === "mission") {
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

function titleCaseShip(ship: string): string {
  return ship
    .toLowerCase()
    .split("_")
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function itemIdToLabel(itemId: string): string {
  return itemKeyToDisplayName(itemIdToKey(itemId));
}

function itemIdToIconUrl(itemId: string): string | null {
  return itemKeyToIconUrl(itemIdToKey(itemId));
}

function profileUrl(eid: string, includeSlotted: boolean): string {
  const params = new URLSearchParams({
    eid,
    includeSlotted: includeSlotted ? "1" : "0",
  });
  return `/api/profile?${params.toString()}`;
}

async function fetchProfileSnapshot(eid: string, includeSlotted: boolean): Promise<ProfileSnapshot> {
  const response = await fetch(profileUrl(eid, includeSlotted));
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

export default function MissionCraftPlannerPage() {
  const [eid, setEid] = useState("");
  const [targetItemId, setTargetItemId] = useState("soul-stone-2");
  const [quantity, setQuantity] = useState(1);
  const [priorityTimePct, setPriorityTimePct] = useState(50);
  const [includeSlotted, setIncludeSlotted] = useState(true);
  const [fastMode, setFastMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<string | null>(null);
  const [response, setResponse] = useState<PlanResponse | null>(null);
  const [profileSnapshot, setProfileSnapshot] = useState<ProfileSnapshot | null>(null);

  const targetOptions = useMemo(() => {
    const display = artifactDisplay as Record<string, { id: string; name: string; tierName: string }>;
    const recipeMap = recipes as Record<string, unknown>;

    return Object.keys(recipeMap)
      .map((itemKey) => {
        const displayInfo = display[itemKey];
        const itemId = displayInfo?.id || itemKeyToId(itemKey);
        const label = itemKeyToDisplayName(itemKey);
        return { itemId, label };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, []);

  const missionTimeline = useMemo(() => (response ? buildMissionTimeline(response.plan) : null), [response]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResponse(null);
    setProfileSnapshot(null);
    setRefreshSummary(null);
    setLoading(true);

    try {
      const planResp = await fetch("/api/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          eid,
          targetItemId,
          quantity,
          priorityTime: priorityTimePct / 100,
          includeSlotted,
          fastMode,
        }),
      });

      const data = (await planResp.json()) as PlanResponse & { error?: string; details?: unknown };
      if (!planResp.ok) {
        const detailText =
          typeof data.details === "string"
            ? data.details
            : Array.isArray(data.details)
              ? data.details.join("; ")
              : "";
        throw new Error(detailText || data.error || "planning request failed");
      }
      setResponse(data);
      const snapshot = await fetchProfileSnapshot(eid, includeSlotted);
      setProfileSnapshot(snapshot);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "unknown planner error");
    } finally {
      setLoading(false);
    }
  }

  async function onRefreshFromLive() {
    if (!response) {
      return;
    }

    setError(null);
    setRefreshSummary(null);
    setRefreshing(true);

    try {
      const liveProfile = await fetchProfileSnapshot(eid, includeSlotted);
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
          quantity,
          priorityTime: priorityTimePct / 100,
          fastMode,
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

      <form className="panel" onSubmit={onSubmit}>
        <div className="row">
          <div className="field" style={{ minWidth: 320, flex: 2 }}>
            <label htmlFor="eid">EID</label>
            <input
              id="eid"
              type="text"
              value={eid}
              onChange={(event) => setEid(event.target.value)}
              placeholder="EI123..."
              autoComplete="off"
              required
            />
          </div>

          <div className="field" style={{ minWidth: 260, flex: 2 }}>
            <label htmlFor="targetItem">Target artifact/stone</label>
            <select id="targetItem" value={targetItemId} onChange={(event) => setTargetItemId(event.target.value)}>
              {targetOptions.map((option) => (
                <option key={option.itemId} value={option.itemId}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ minWidth: 120 }}>
            <label htmlFor="quantity">Quantity</label>
            <input
              id="quantity"
              type="number"
              min={1}
              max={9999}
              value={quantity}
              onChange={(event) => setQuantity(Math.max(1, Math.round(Number(event.target.value) || 1)))}
            />
          </div>
        </div>

        <div className="row" style={{ marginTop: 10, alignItems: "end" }}>
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

          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor="includeSlotted">Inventory handling</label>
            <select
              id="includeSlotted"
              value={includeSlotted ? "yes" : "no"}
              onChange={(event) => setIncludeSlotted(event.target.value === "yes")}
            >
              <option value="yes">Include slotted stones</option>
              <option value="no">Ignore slotted stones</option>
            </select>
          </div>

          <label
            className="field"
            style={{ minWidth: 220, gap: 6, flexDirection: "row", alignItems: "center", marginBottom: 6 }}
            htmlFor="fastMode"
          >
            <input
              id="fastMode"
              type="checkbox"
              checked={fastMode}
              onChange={(event) => setFastMode(event.target.checked)}
              style={{ width: 16, height: 16, margin: 0 }}
            />
            <span className="muted" style={{ fontSize: 13 }}>
              Faster, less optimal solve
            </span>
          </label>

          <button type="submit" disabled={loading}>
            {loading ? "Planning..." : "Build plan"}
          </button>
          <button type="button" disabled={loading || refreshing || !response} onClick={onRefreshFromLive}>
            {refreshing ? "Refreshing..." : "Refresh from live profile"}
          </button>
        </div>
      </form>

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
              <div className="kpi">{formatDurationFromHours(response.plan.expectedHours)}</div>
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
            <p className="muted" style={{ marginTop: 0 }}>
              Requested {response.plan.targetBreakdown.requested.toFixed(0)} = Inventory{" "}
              {response.plan.targetBreakdown.fromInventory.toFixed(2)} + Craft {response.plan.targetBreakdown.fromCraft.toFixed(2)} +
              Mission expected {response.plan.targetBreakdown.fromMissionsExpected.toFixed(2)}
              {response.plan.targetBreakdown.shortfall > 1e-6
                ? ` + Shortfall ${response.plan.targetBreakdown.shortfall.toFixed(2)}`
                : ""}
            </p>
            {response.plan.crafts.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No crafting needed.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {response.plan.crafts.map((craft) => {
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
                                <div className="muted" style={{ fontSize: 12 }}>{craft.itemId}</div>
                              </div>
                            </div>
                          </td>
                          <td>{craft.count.toLocaleString()}</td>
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
                    Mission-row workload: <strong>{formatDurationFromHours(missionTimeline.missionSlotSeconds / 3 / 3600)}</strong>
                  </span>
                  {missionTimeline.hiddenPrepSlotSeconds > 0 && (
                    <span>
                      Progression-only prep: <strong>{formatDurationFromHours(missionTimeline.hiddenPrepSlotSeconds / 3 / 3600)}</strong>
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
                              style={{
                                left: `${leftPct}%`,
                                width: `${widthPct}%`,
                                background: block.color,
                              }}
                              title={titleLines.join("\n")}
                            >
                              <span className={styles.timelineBlockLabel}>
                                {block.launches > 0 ? `${block.label} ×${block.launches}` : block.label}
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
                      <th>Ship / Mission</th>
                      <th>Target</th>
                      <th>Launches</th>
                      <th>Duration</th>
                      <th>Top expected yields</th>
                    </tr>
                  </thead>
                  <tbody>
                    {response.plan.missions.map((mission) => {
                      const targetItemKey = afxIdToItemKey(mission.targetAfxId);
                      const targetIconUrl = targetItemKey ? itemKeyToIconUrl(targetItemKey) : null;
                      return (
                        <tr key={`${mission.missionId}:${mission.targetAfxId}`}>
                          <td>
                            {titleCaseShip(mission.ship)}<br />
                            <span className="muted">{mission.missionId}</span>
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
                                <div>{afxIdToTargetFamilyName(mission.targetAfxId)}</div>
                                {mission.targetAfxId !== 10000 && (
                                  <div className="muted" style={{ fontSize: 12 }}>
                                    target id: {mission.targetAfxId}
                                  </div>
                                )}
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
            <h2 style={{ marginTop: 0 }}>Ship progression snapshot</h2>
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
