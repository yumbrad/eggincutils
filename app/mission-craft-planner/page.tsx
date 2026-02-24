"use client";

import { FormEvent, useMemo, useState } from "react";

import artifactDisplay from "../../data/artifact-display.json";
import recipes from "../../data/recipes.json";
import {
  afxIdToDisplayName,
  afxIdToItemKey,
  itemIdToKey,
  itemKeyToDisplayName,
  itemKeyToIconUrl,
  itemKeyToId,
} from "../../lib/item-utils";

type ShipLevelInfo = {
  ship: string;
  unlocked: boolean;
  launches: number;
  launchPoints: number;
  level: number;
  maxLevel: number;
};

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
    notes: string[];
  };
};

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

export default function MissionCraftPlannerPage() {
  const [eid, setEid] = useState("");
  const [targetItemId, setTargetItemId] = useState("soul-stone-2");
  const [quantity, setQuantity] = useState(1);
  const [priorityTimePct, setPriorityTimePct] = useState(50);
  const [includeSlotted, setIncludeSlotted] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<PlanResponse | null>(null);

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

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResponse(null);
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "unknown planner error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <div className="panel" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: "0 0 6px" }}>Mission + Craft Planner</h1>
        <p className="muted" style={{ margin: 0 }}>
          Uses your EID profile, Menno drop data, recipe recursion, and a GE vs time preference slider.
        </p>
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

          <button type="submit" disabled={loading}>
            {loading ? "Planning..." : "Build plan"}
          </button>
        </div>
      </form>

      {error && (
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="error">{error}</div>
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
                                <div>{afxIdToDisplayName(mission.targetAfxId)}</div>
                                {mission.targetAfxId !== 10000 && (
                                  <div className="muted" style={{ fontSize: 12 }}>{mission.targetAfxId}</div>
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
                  {response.profile.shipLevels.map((ship) => (
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
