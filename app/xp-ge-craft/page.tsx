"use client";

import Link from "next/link";
import Image from "next/image";
import React, { JSX, useEffect, useState } from "react";

import { getArtifactDisplayData, getArtifactDisplayLabel } from "../../lib/artifact-display";
import {
  LOCAL_PREF_KEYS,
  readFirstStoredString,
  readStoredBoolean,
  writeStoredBoolean,
  writeStoredString,
} from "../../lib/local-preferences";
import useHighsClient from "../../lib/use-highs-client";
import { Highs, Solution, optimizeCrafts } from "../../lib/xp-ge-optimize";
import { XP_GE_CRAFT_COPY } from "../../lib/xp-ge-craft-copy";
import styles from "./page.module.css";

type SortKey = "xpPerGe" | "xp" | "familyTier" | "name";
type InventoryResponse = {
  inventory?: Record<string, number>;
  craftCounts?: Record<string, number>;
  error?: string;
  details?: string;
};

type ModeComparisonRow = {
  key: string;
  artifact: string;
  modeLabel: string;
  count: number;
  xp: number;
  cost: number;
  xpPerGe: number;
};

const SHARED_EID_KEYS = [LOCAL_PREF_KEYS.sharedEid, LOCAL_PREF_KEYS.legacyEid] as const;
const SHARED_INCLUDE_SLOTTED_KEYS = [LOCAL_PREF_KEYS.sharedIncludeSlotted, LOCAL_PREF_KEYS.legacyIncludeSlotted] as const;

async function getOptimalCrafts(highs: Highs, eid: string, includeSlotted: boolean): Promise<Solution> {
  const response = await fetch(
    `/api/inventory?eid=${encodeURIComponent(eid)}&includeSlotted=${includeSlotted ? "true" : "false"}`
  );
  let data: InventoryResponse | null = null;
  try {
    data = (await response.json()) as InventoryResponse;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = data?.details || data?.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  if (!data?.inventory) {
    throw new Error("No inventory data returned from the server.");
  }
  return optimizeCrafts(highs, data.inventory, data.craftCounts || {});
}

function getSortedArtifacts(solution: Solution, sortKey: SortKey): string[] {
  const keys = Object.keys(solution.crafts);

  const compareByName = (a: string, b: string): number => getArtifactDisplayLabel(a).localeCompare(getArtifactDisplayLabel(b));
  const familyKey = (artifact: string): string => artifact.replace(/_\d+$/, "");
  const tierNumber = (artifact: string): number => {
    const display = getArtifactDisplayData(artifact);
    if (display && Number.isFinite(display.tierNumber)) {
      return display.tierNumber;
    }
    const match = artifact.match(/_(\d+)$/);
    if (!match) {
      return Number.MAX_SAFE_INTEGER;
    }
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  };
  const compareByFamilyTier = (a: string, b: string): number => {
    const familyCompare = familyKey(a).localeCompare(familyKey(b));
    if (familyCompare !== 0) {
      return familyCompare;
    }
    const tierCompare = tierNumber(a) - tierNumber(b);
    if (tierCompare !== 0) {
      return tierCompare;
    }
    return compareByName(a, b);
  };

  switch (sortKey) {
    case "name":
      return keys.sort(compareByName);
    case "xp":
      return keys.sort((a, b) => solution.crafts[b].xp - solution.crafts[a].xp || compareByName(a, b));
    case "xpPerGe":
      return keys.sort((a, b) => solution.crafts[b].xpPerGe - solution.crafts[a].xpPerGe || compareByName(a, b));
    case "familyTier":
      return keys.sort(compareByFamilyTier);
    default:
      return keys.sort();
  }
}

function getModeComparisonRows(solution: Solution, sortKey: SortKey): ModeComparisonRow[] {
  const rows: ModeComparisonRow[] = [];
  for (const artifact of getSortedArtifacts(solution, sortKey)) {
    const craft = solution.crafts[artifact];
    rows.push({
      key: `${artifact}:direct`,
      artifact,
      modeLabel: "direct craft",
      count: craft.modeComparison.direct.count,
      xp: craft.modeComparison.direct.xp,
      cost: craft.modeComparison.direct.cost,
      xpPerGe: craft.modeComparison.direct.xpPerGe,
    });
    if (craft.modeComparison.auto) {
      const autoExtraCount = Math.max(0, craft.modeComparison.auto.count - craft.modeComparison.direct.count);
      if (autoExtraCount > 0) {
        const autoExtraXp = autoExtraCount * craft.xpPerCraft;
        const autoExtraCost = Math.max(0, craft.modeComparison.auto.cost - craft.modeComparison.direct.cost);
        rows.push({
          key: `${artifact}:auto`,
          artifact,
          modeLabel: "auto-craftable beyond direct",
          count: autoExtraCount,
          xp: autoExtraXp,
          cost: autoExtraCost,
          xpPerGe: autoExtraCost > 0 ? autoExtraXp / autoExtraCost : 0,
        });
      }
    }
  }

  switch (sortKey) {
    case "xp":
      return rows.sort(
        (a, b) =>
          b.xp - a.xp ||
          getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)) ||
          a.modeLabel.localeCompare(b.modeLabel)
      );
    case "xpPerGe":
      return rows.sort(
        (a, b) =>
          b.xpPerGe - a.xpPerGe ||
          getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)) ||
          a.modeLabel.localeCompare(b.modeLabel)
      );
    case "name":
    default:
      return rows.sort(
        (a, b) =>
          getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)) ||
          a.modeLabel.localeCompare(b.modeLabel)
      );
    case "familyTier":
      return rows.sort((a, b) => {
        const familyA = a.artifact.replace(/_\d+$/, "");
        const familyB = b.artifact.replace(/_\d+$/, "");
        const familyCompare = familyA.localeCompare(familyB);
        if (familyCompare !== 0) {
          return familyCompare;
        }

        const tierA = getArtifactDisplayData(a.artifact)?.tierNumber ?? Number(a.artifact.match(/_(\d+)$/)?.[1] || Number.MAX_SAFE_INTEGER);
        const tierB = getArtifactDisplayData(b.artifact)?.tierNumber ?? Number(b.artifact.match(/_(\d+)$/)?.[1] || Number.MAX_SAFE_INTEGER);
        if (tierA !== tierB) {
          return tierA - tierB;
        }

        return (
          getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)) ||
          a.modeLabel.localeCompare(b.modeLabel)
        );
      });
  }
}

function ArtifactCell({ artifact, modeLabel }: { artifact: string; modeLabel?: string }): JSX.Element {
  const displayData = getArtifactDisplayData(artifact);
  if (!displayData) {
    return <span>{artifact}</span>;
  }
  return (
    <span className={styles.artifactCell}>
      <span className={styles.artifactIconWrap}>
        <img src={displayData.smallIconUrl} alt={displayData.name} className={styles.artifactIconThumb} loading="lazy" />
        <span className={styles.artifactIconPreview}>
          <img src={displayData.largeIconUrl} alt={displayData.name} className={styles.artifactIconLarge} loading="lazy" />
        </span>
      </span>
      <span className={styles.artifactText}>
        <span>{displayData.name} (T{displayData.tierNumber})</span>
        {modeLabel && <span className={styles.artifactMode}>({modeLabel})</span>}
      </span>
    </span>
  );
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function getXpTooltip(xpPerCraft: number, count: number): string {
  return `XP per craft: ${xpPerCraft.toLocaleString()}\nCrafts: ${count.toLocaleString()}`;
}

function getCostTooltip(artifact: string, craft: Solution["crafts"][string]): string {
  const costDetails = craft.costDetails;
  const plannedCrafts = Math.max(0, Math.round(craft.count));
  const craftLabel = plannedCrafts === 1 ? "craft" : "crafts";
  const lines = [
    `Artifact: ${getArtifactDisplayLabel(artifact)}`,
    `Crafts: ${craft.count.toLocaleString()}`,
    `Base GE cost: ${costDetails.baseCost.toLocaleString()}`,
    `Craft history: ${costDetails.craftCount.toLocaleString()}`,
    `Current discount: ${formatPercent(costDetails.discountPercent)}`,
    `Next craft cost: ${costDetails.discountedCost.toLocaleString()} GE`,
    `Direct GE cost in table (${plannedCrafts.toLocaleString()} ${craftLabel}): ${costDetails.totalDirectCost.toLocaleString()} GE`,
    `Standalone direct craftability: ${craft.modeComparison.direct.count.toLocaleString()} crafts (${craft.modeComparison.direct.cost.toLocaleString()} GE total)`,
  ];
  if (craft.modeComparison.auto) {
    lines.push(
      `Standalone auto-craft craftability: ${craft.modeComparison.auto.count.toLocaleString()} crafts (${craft.modeComparison.auto.cost.toLocaleString()} GE total)`
    );
  }
  if (costDetails.ingredients.length > 0) {
    lines.push("Ingredient direct costs for one parent craft (sequential discounts):");
    for (const ingredient of costDetails.ingredients) {
      lines.push(
        `- ${ingredient.name} x${ingredient.quantity}: starts at ${ingredient.discountedCost.toLocaleString()} GE (${formatPercent(
          ingredient.discountPercent
        )} discount, ${ingredient.craftCount.toLocaleString()} crafts) -> total ${ingredient.totalCost.toLocaleString()} GE`
      );
    }
  }
  if (costDetails.recursiveCost > 0) {
    lines.push(
      `Recursive cost per craft from scratch (with sequential ingredient discounts): ${costDetails.recursiveCost.toLocaleString()} GE`
    );
  }
  return lines.join("\n");
}

export default function XpGeCraftPage(): JSX.Element {
  const highs = useHighsClient();
  const [eid, setEID] = useState<string>("");
  const [includeSlotted, setIncludeSlotted] = useState<boolean>(true);
  const [solution, setSolution] = useState<Solution | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("xpPerGe");
  const [hideUncraftable, setHideUncraftable] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [prefsLoaded, setPrefsLoaded] = useState<boolean>(false);

  useEffect(() => {
    const savedEid = readFirstStoredString(SHARED_EID_KEYS);
    if (savedEid) {
      setEID(savedEid);
    }
    const savedIncludeSlotted = readStoredBoolean(SHARED_INCLUDE_SLOTTED_KEYS);
    if (savedIncludeSlotted != null) {
      setIncludeSlotted(savedIncludeSlotted);
    }
    setPrefsLoaded(true);
  }, []);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredString(SHARED_EID_KEYS, eid.trim());
  }, [eid, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredBoolean(SHARED_INCLUDE_SLOTTED_KEYS, includeSlotted);
  }, [includeSlotted, prefsLoaded]);

  async function runOptimize(): Promise<void> {
    if (!highs) {
      setError("Solver is still loading. Please try again in a moment.");
      return;
    }
    if (!eid.trim()) {
      setError("Please enter your Egg Inc. ID before calculating.");
      return;
    }

    setError(null);
    setSolution(null);
    setIsLoading(true);
    try {
      const result = await getOptimalCrafts(highs, eid, includeSlotted);
      setSolution(result);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unable to load inventory.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  const sortedArtifacts = solution ? getSortedArtifacts(solution, sortKey) : [];
  const visibleArtifacts =
    solution && hideUncraftable ? sortedArtifacts.filter((artifact) => solution.crafts[artifact].count > 0) : sortedArtifacts;
  const sortedModeRows = solution ? getModeComparisonRows(solution, sortKey) : [];
  const visibleModeRows = hideUncraftable ? sortedModeRows.filter((row) => row.count > 0) : sortedModeRows;

  return (
    <main className="page">
      <div className="panel brand-panel">
        <div className="brand-header" data-compact="1">
          <Link href="/" className="brand-mark-shell brand-mark-link" aria-label="Back to menu">
            <Image src="/media/hamster_egg_poly.png" alt="" width={1024} height={1536} className="brand-mark" priority />
          </Link>
          <div className="brand-copy">
            <h1 className="brand-title">{XP_GE_CRAFT_COPY.title}</h1>
            <p className="muted brand-subtitle">{XP_GE_CRAFT_COPY.subtitle}</p>
            <details className="info-disclosure">
              <summary className="subtle-info-link">More info</summary>
              <p className="muted">{XP_GE_CRAFT_COPY.longDescription}</p>
            </details>
          </div>
        </div>

        <div className={styles.inputSection}>
          <label htmlFor="eidInput">EID</label>
          <input
            id="eidInput"
            type="text"
            value={eid}
            onChange={(event) => setEID(event.target.value)}
            onPaste={(event) => {
              event.preventDefault();
              setEID(event.clipboardData.getData("text"));
            }}
            placeholder="EI123..."
          />
          <button onClick={runOptimize} disabled={isLoading}>
            {isLoading ? "Calculating..." : "Calculate"}
          </button>
          <label className={styles.inputCheckbox}>
            <input
              type="checkbox"
              checked={includeSlotted}
              onChange={(event) => setIncludeSlotted(event.target.checked)}
            />
            Include slotted stones as ingredients
          </label>
        </div>

        {error && (
          <div className={styles.errorBox}>
            {error} <Link href="/xp-ge-craft/diagnostics">Open diagnostics</Link>.
          </div>
        )}

        {solution && (
          <>
            <div className={styles.summary}>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Total XP</div>
                <div className={styles.summaryValue}>{solution.totalXp.toLocaleString()}</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Total GE Cost</div>
                <div className={styles.summaryValue}>{solution.totalCost.toLocaleString()}</div>
              </div>
            </div>

            <div className={styles.sortSection}>
              <span>Sort rows by:</span>
              <button
                className={`${styles.sortButton} ${sortKey === "xpPerGe" ? styles.activeButton : ""}`}
                onClick={() => setSortKey("xpPerGe")}
              >
                XP / GE
              </button>
              <button
                className={`${styles.sortButton} ${sortKey === "xp" ? styles.activeButton : ""}`}
                onClick={() => setSortKey("xp")}
              >
                Total XP
              </button>
              <button
                className={`${styles.sortButton} ${sortKey === "familyTier" ? styles.activeButton : ""}`}
                onClick={() => setSortKey("familyTier")}
              >
                Family+tier
              </button>
              <button
                className={`${styles.sortButton} ${sortKey === "name" ? styles.activeButton : ""}`}
                onClick={() => setSortKey("name")}
              >
                Name
              </button>
              <label className={styles.sortCheckbox}>
                <input type="checkbox" checked={hideUncraftable} onChange={(event) => setHideUncraftable(event.target.checked)} />
                Don&apos;t show uncraftable
              </label>
            </div>

            <div className={styles.tableSection}>
              <h3>Standalone Craft Options (Direct vs Auto-Crafting)</h3>
              <table className={styles.resultsTable}>
                <thead>
                  <tr>
                    <th>Artifact</th>
                    <th className={styles.num}>Craftable Count</th>
                    <th className={styles.num}>Total XP</th>
                    <th className={styles.num}>GE Cost</th>
                    <th className={styles.num}>XP / GE</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleModeRows.map((row) => (
                    <tr key={row.key}>
                      <td>
                        <ArtifactCell artifact={row.artifact} modeLabel={row.modeLabel} />
                      </td>
                      <td className={styles.num}>{row.count.toLocaleString()}</td>
                      <td className={styles.num}>
                        <span className={styles.valueTooltip} title={getXpTooltip(solution.crafts[row.artifact].xpPerCraft, row.count)}>
                          {row.xp.toLocaleString()}
                        </span>
                      </td>
                      <td className={styles.num}>
                        <span className={styles.valueTooltip} title={getCostTooltip(row.artifact, solution.crafts[row.artifact])}>
                          {row.cost.toLocaleString()}
                        </span>
                      </td>
                      <td className={styles.num}>{row.xpPerGe.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.tableSection}>
              <h3>Max-XP LP Plan (Reference)</h3>
              <table className={styles.resultsTable}>
                <thead>
                  <tr>
                    <th>Artifact</th>
                    <th className={styles.num}>Count</th>
                    <th className={styles.num}>XP</th>
                    <th className={styles.num}>GE Cost</th>
                    <th className={styles.num}>XP / GE</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleArtifacts.map((artifact) => (
                    <tr key={artifact}>
                      <td>
                        <ArtifactCell artifact={artifact} />
                      </td>
                      <td className={styles.num}>{solution.crafts[artifact].count.toLocaleString()}</td>
                      <td className={styles.num}>
                        <span
                          className={styles.valueTooltip}
                          title={getXpTooltip(solution.crafts[artifact].xpPerCraft, solution.crafts[artifact].count)}
                        >
                          {solution.crafts[artifact].xp.toLocaleString()}
                        </span>
                      </td>
                      <td className={styles.num}>
                        <span className={styles.valueTooltip} title={getCostTooltip(artifact, solution.crafts[artifact])}>
                          {solution.crafts[artifact].cost.toLocaleString()}
                        </span>
                      </td>
                      <td className={styles.num}>{solution.crafts[artifact].xpPerGe.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className={styles.footnote}>
              Counts and costs include intermediate crafts needed for higher tiers, and GE cost uses your personal craft-history
              discount progression. Standalone rows are per-item simulations from your current state and are not additive across
              different artifacts.
            </p>
          </>
        )}

        {!solution && (
          <p className={styles.footnote}>
            Enter your Egg Inc. ID and calculate to see optimized craft counts, expected XP, and discounted GE cost based on your
            current inventory and craft history.
          </p>
        )}

        <div className={styles.pageLinks}>
          <Link href="/xp-ge-craft/diagnostics" className="subtle-link">
            Diagnostics
          </Link>
          <Link href="/" className="subtle-link">
            Back to menu
          </Link>
        </div>
      </div>
    </main>
  );
}
