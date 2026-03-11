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
import {
  buildMaxXpExecutionPlan,
  Highs,
  MaxXpExecutionPlanNode,
  Solution,
  optimizeCrafts,
  simulateGeEfficiencyPlan,
  type SequentialMode,
} from "../../lib/xp-ge-optimize";
import { XP_GE_CRAFT_COPY } from "../../lib/xp-ge-craft-copy";
import styles from "./page.module.css";

type SortKey = "xpPerGe" | "xp" | "tierXpPerGe" | "familyTier" | "name";
type InventoryResponse = {
  inventory?: Record<string, number>;
  craftCounts?: Record<string, number>;
  error?: string;
  details?: string;
};

type ModeComparisonRow = {
  key: string;
  artifact: string;
  mode: SequentialMode;
  modeLabel: string;
  count: number;
  xp: number;
  cost: number;
  xpPerGe: number;
};

type ExecutionPlanRow = {
  key: string;
  artifact: string;
  mode: "click" | "auto";
  count: number;
  xp: number;
  cost: number;
  depth: number;
  prefix: string;
};

type EfficiencyStatusKind = "full" | "partial" | "blocked" | "belowThreshold";

type EfficiencyStatus = {
  kind: EfficiencyStatusKind;
  realizedCount: number;
  label: string;
  title: string;
};

type InventoryMatrixFamily = {
  key: string;
  label: string;
};

type InventoryMatrixRow = {
  label: string;
  counts: number[];
};

type OptimizePayload = {
  solution: Solution;
  inventory: Record<string, number>;
  craftCounts: Record<string, number>;
};

const SHARED_EID_KEYS = [LOCAL_PREF_KEYS.sharedEid, LOCAL_PREF_KEYS.legacyEid] as const;
const SHARED_INCLUDE_SLOTTED_KEYS = [LOCAL_PREF_KEYS.sharedIncludeSlotted, LOCAL_PREF_KEYS.legacyIncludeSlotted] as const;
const SHARED_CRAFTING_SALE_KEYS = [LOCAL_PREF_KEYS.sharedCraftingSale] as const;
const INVENTORY_MATRIX_FAMILIES: InventoryMatrixFamily[] = [
  { key: "tachyon_deflector", label: "Deflector" },
  { key: "dilithium_monocle", label: "Monocle" },
  { key: "quantum_metronome", label: "Metronome" },
  { key: "carved_rainstick", label: "Rainstick" },
  { key: "beak_of_midas", label: "Beak" },
  { key: "ornate_gusset", label: "Gusset" },
  { key: "neodymium_medallion", label: "Medallion" },
  { key: "lunar_totem", label: "Totem" },
  { key: "mercurys_lens", label: "Lens" },
  { key: "interstellar_compass", label: "Compass" },
  { key: "puzzle_cube", label: "Cube" },
  { key: "aurelian_brooch", label: "Brooch" },
  { key: "the_chalice", label: "Chalice" },
  { key: "titanium_actuator", label: "Actuator" },
  { key: "demeters_necklace", label: "Necklace" },
  { key: "tungsten_ankh", label: "Ankh" },
  { key: "vial_martian_dust", label: "Vial" },
  { key: "book_of_basan", label: "Book" },
  { key: "ship_in_a_bottle", label: "Ship" },
  { key: "phoenix_feather", label: "Feather" },
  { key: "light_of_eggendil", label: "LoE" },
  { key: "clarity_stone", label: "Clarity stone" },
  { key: "dilithium_stone", label: "Dilithium stone" },
  { key: "life_stone", label: "Life stone" },
  { key: "lunar_stone", label: "Lunar stone" },
  { key: "prophecy_stone", label: "Prophecy stone" },
  { key: "quantum_stone", label: "Quantum stone" },
  { key: "shell_stone", label: "Shell stone" },
  { key: "soul_stone", label: "Soul stone" },
  { key: "tachyon_stone", label: "Tachyon stone" },
  { key: "terra_stone", label: "Terra stone" },
  { key: "gold_meteorite", label: "Gold" },
  { key: "solar_titanium", label: "Titanium" },
  { key: "tau_ceti_geode", label: "Geode" },
];

async function getOptimalCrafts(
  highs: Highs,
  eid: string,
  includeSlotted: boolean,
  saleEnabled: boolean
): Promise<OptimizePayload> {
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
  const inventory = data.inventory;
  const craftCounts = data.craftCounts || {};
  return {
    solution: optimizeCrafts(highs, inventory, craftCounts, saleEnabled),
    inventory,
    craftCounts,
  };
}

function getModeRowKey(artifact: string, mode: SequentialMode): string {
  return `${artifact}:${mode}`;
}

function getSortedArtifacts(solution: Solution, sortKey: SortKey): string[] {
  const keys = Object.keys(solution.crafts);

  const compareByName = (a: string, b: string): number => getArtifactDisplayLabel(a).localeCompare(getArtifactDisplayLabel(b));
  const familyKey = (artifact: string): string => artifact.replace(/_\d+$/, "");
  const getTierNumber = (artifact: string): number => {
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
    const tierCompare = getTierNumber(a) - getTierNumber(b);
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
    case "tierXpPerGe":
      return keys.sort(
        (a, b) =>
          getTierNumber(b) - getTierNumber(a) ||
          solution.crafts[b].xpPerGe - solution.crafts[a].xpPerGe ||
          compareByName(a, b)
      );
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
      key: getModeRowKey(artifact, "direct"),
      artifact,
      mode: "direct",
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
          key: getModeRowKey(artifact, "auto"),
          artifact,
          mode: "auto",
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
    case "tierXpPerGe":
      return rows.sort((a, b) => {
        const tierA = getArtifactDisplayData(a.artifact)?.tierNumber ?? Number(a.artifact.match(/_(\d+)$/)?.[1] || Number.MAX_SAFE_INTEGER);
        const tierB = getArtifactDisplayData(b.artifact)?.tierNumber ?? Number(b.artifact.match(/_(\d+)$/)?.[1] || Number.MAX_SAFE_INTEGER);
        if (tierA !== tierB) {
          return tierB - tierA;
        }
        return (
          b.xpPerGe - a.xpPerGe ||
          getArtifactDisplayLabel(a.artifact).localeCompare(getArtifactDisplayLabel(b.artifact)) ||
          a.modeLabel.localeCompare(b.modeLabel)
        );
      });
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

function getExecutionPlanRows(nodes: MaxXpExecutionPlanNode[]): ExecutionPlanRow[] {
  const rows: ExecutionPlanRow[] = [];

  const walk = (
    node: MaxXpExecutionPlanNode,
    key: string,
    depth: number,
    ancestorHasNext: boolean[],
    isRoot: boolean,
    isLast: boolean
  ): void => {
    const prefix = isRoot
      ? ""
      : `${ancestorHasNext.map((hasNext) => (hasNext ? "|  " : "   ")).join("")}|_ `;
    rows.push({
      key,
      artifact: node.artifact,
      mode: node.mode,
      count: node.count,
      xp: node.xp,
      cost: node.cost,
      depth,
      prefix,
    });

    node.children.forEach((child, index) => {
      walk(child, `${key}.${index}`, depth + 1, [...ancestorHasNext, !isLast], false, index === node.children.length - 1);
    });
  };

  nodes.forEach((node, index) => {
    walk(node, `execution-${index}`, 0, [], true, index === nodes.length - 1);
  });

  return rows;
}

function getGeEfficiencyStatusMap(
  planRows: ModeComparisonRow[],
  geEfficiencyPlan: ReturnType<typeof simulateGeEfficiencyPlan> | null,
  minXpPerGe: number
): Record<string, EfficiencyStatus> {
  if (!geEfficiencyPlan) {
    return {};
  }

  const statusByRowKey = {} as Record<string, EfficiencyStatus>;
  const realizedCountsByRowKey = new Map<string, number>();
  for (const row of geEfficiencyPlan.rows) {
    realizedCountsByRowKey.set(getModeRowKey(row.artifact, row.mode), row.craftedCount);
  }

  for (const row of planRows) {
    if (row.xpPerGe + Number.EPSILON < minXpPerGe) {
      statusByRowKey[row.key] = {
        kind: "belowThreshold",
        realizedCount: 0,
        label: "Below threshold",
        title: "Below the current minimum XP/GE threshold, so this row is not considered in the Max GE Efficiency Plan.",
      };
      continue;
    }

    const realizedCount = realizedCountsByRowKey.get(row.key) ?? 0;
    if (realizedCount >= row.count) {
      statusByRowKey[row.key] = {
        kind: "full",
        realizedCount,
        label: "Fully included",
        title: `Fully included in the Max GE Efficiency Plan (${realizedCount.toLocaleString()} of ${row.count.toLocaleString()} crafts).`,
      };
      continue;
    }

    if (realizedCount > 0) {
      statusByRowKey[row.key] = {
        kind: "partial",
        realizedCount,
        label: "Partially included",
        title: `Partially included in the Max GE Efficiency Plan (${realizedCount.toLocaleString()} of ${row.count.toLocaleString()} crafts).`,
      };
      continue;
    }

    statusByRowKey[row.key] = {
      kind: "blocked",
      realizedCount: 0,
      label: "Blocked",
      title: "No longer craftable by the time this row is reached in the Max GE Efficiency Plan because earlier rows consumed what it needs.",
    };
  }

  return statusByRowKey;
}

function getModeRowCountLabel(row: ModeComparisonRow, status: EfficiencyStatus | undefined): string {
  if (!status || status.kind === "full" || status.kind === "belowThreshold") {
    return row.count.toLocaleString();
  }
  return `${row.count.toLocaleString()} -> ${status.realizedCount.toLocaleString()}`;
}

function getInventoryMatrixRows(inventory: Record<string, number> | null | undefined): InventoryMatrixRow[] {
  if (!inventory) {
    return [];
  }

  const rows: InventoryMatrixRow[] = [];
  for (const family of INVENTORY_MATRIX_FAMILIES) {
    const counts = [1, 2, 3, 4].map((tier) => Math.max(0, Math.round(inventory[`${family.key}_${tier}`] || 0)));
    if (counts.every((count) => count === 0)) {
      continue;
    }
    rows.push({
      label: family.label,
      counts,
    });
  }
  return rows;
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

function StatusDot({ status }: { status: EfficiencyStatus }): JSX.Element {
  const className =
    status.kind === "full"
      ? styles.statusFull
      : status.kind === "partial"
        ? styles.statusPartial
        : status.kind === "blocked"
          ? styles.statusBlocked
          : styles.statusBelowThreshold;
  return <span className={`${styles.statusDot} ${className}`} title={status.title} aria-label={status.label} />;
}

function RemainingInventoryDisclosure({
  label,
  planLabel,
  inventory,
}: {
  label: string;
  planLabel: string;
  inventory: Record<string, number> | null | undefined;
}): JSX.Element {
  const rows = getInventoryMatrixRows(inventory);
  return (
    <details className={`${styles.inventoryDisclosure} inventory-disclosure`}>
      <summary className={styles.inventoryDisclosureSummary}>{label}</summary>
      <div className={`${styles.inventoryDisclosurePanel} inventoryDisclosurePanel`}>
        <div className={styles.inventoryDisclosureTitle}>{planLabel}</div>
        {rows.length > 0 ? (
          <div className={styles.inventoryTableWrap}>
            <table className={styles.inventoryTable}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className={styles.num}>T1</th>
                  <th className={styles.num}>T2</th>
                  <th className={styles.num}>T3</th>
                  <th className={styles.num}>T4</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    {row.counts.map((count, index) => (
                      <td key={`${row.label}-${index}`} className={styles.num}>
                        {count > 0 ? count.toLocaleString() : "-"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.summaryMeta}>Nothing left in tracked inventory.</div>
        )}
      </div>
    </details>
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
  if (costDetails.saleApplied) {
    lines.push("30% crafting sale applied to all GE costs shown here.");
  }
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
  const [craftingSale, setCraftingSale] = useState<boolean>(false);
  const [solution, setSolution] = useState<Solution | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("xpPerGe");
  const [hideUncraftable, setHideUncraftable] = useState<boolean>(true);
  const [minEfficiencyXpPerGe, setMinEfficiencyXpPerGe] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [prefsLoaded, setPrefsLoaded] = useState<boolean>(false);
  const [planSourceInventory, setPlanSourceInventory] = useState<Record<string, number> | null>(null);
  const [planSourceCraftCounts, setPlanSourceCraftCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const savedEid = readFirstStoredString(SHARED_EID_KEYS);
    if (savedEid) {
      setEID(savedEid);
    }
    const savedIncludeSlotted = readStoredBoolean(SHARED_INCLUDE_SLOTTED_KEYS);
    if (savedIncludeSlotted != null) {
      setIncludeSlotted(savedIncludeSlotted);
    }
    const savedCraftingSale = readStoredBoolean(SHARED_CRAFTING_SALE_KEYS);
    if (savedCraftingSale != null) {
      setCraftingSale(savedCraftingSale);
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

  useEffect(() => {
    if (!prefsLoaded) {
      return;
    }
    writeStoredBoolean(SHARED_CRAFTING_SALE_KEYS, craftingSale);
  }, [craftingSale, prefsLoaded]);

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
    setPlanSourceInventory(null);
    setPlanSourceCraftCounts({});
    setIsLoading(true);
    try {
      const result = await getOptimalCrafts(highs, eid, includeSlotted, craftingSale);
      setSolution(result.solution);
      setPlanSourceInventory(result.inventory);
      setPlanSourceCraftCounts(result.craftCounts);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Unable to load inventory.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  const sortedArtifacts = solution ? getSortedArtifacts(solution, sortKey) : [];
  const sortedModeRows = solution ? getModeComparisonRows(solution, sortKey) : [];
  const visibleModeRows = hideUncraftable ? sortedModeRows.filter((row) => row.count > 0) : sortedModeRows;
  const xpPerGeModeRows = solution ? getModeComparisonRows(solution, "xpPerGe") : [];
  const efficiencySliderMax = xpPerGeModeRows.length > 0 ? Math.max(0, xpPerGeModeRows[0].xpPerGe) : 0;
  const efficiencySliderStep = efficiencySliderMax > 100 ? 1 : efficiencySliderMax > 10 ? 0.1 : 0.01;

  useEffect(() => {
    setMinEfficiencyXpPerGe((previous) => Math.min(previous, efficiencySliderMax));
  }, [efficiencySliderMax]);

  const geEfficiencyPlan =
    solution && planSourceInventory
      ? simulateGeEfficiencyPlan(
          planSourceInventory,
          planSourceCraftCounts,
          xpPerGeModeRows.map((row) => ({
            artifact: row.artifact,
            mode: row.mode,
            referenceXpPerGe: row.xpPerGe,
          })),
          minEfficiencyXpPerGe,
          craftingSale
        )
      : null;
  const geEfficiencyOverallXpPerGe =
    geEfficiencyPlan && geEfficiencyPlan.totalCost > 0 ? geEfficiencyPlan.totalXp / geEfficiencyPlan.totalCost : 0;
  const geEfficiencyStatusByRowKey = getGeEfficiencyStatusMap(xpPerGeModeRows, geEfficiencyPlan, minEfficiencyXpPerGe);
  let maxXpExecutionPlan = null as ReturnType<typeof buildMaxXpExecutionPlan> | null;
  let maxXpExecutionPlanError = null as string | null;
  if (solution && planSourceInventory) {
    try {
      maxXpExecutionPlan = buildMaxXpExecutionPlan(
        solution,
        planSourceInventory,
        planSourceCraftCounts,
        sortedArtifacts,
        craftingSale
      );
    } catch (caughtError) {
      maxXpExecutionPlanError =
        caughtError instanceof Error ? caughtError.message : "Unable to derive the Max-XP click order from this plan.";
    }
  }
  const maxXpExecutionRows = maxXpExecutionPlan ? getExecutionPlanRows(maxXpExecutionPlan.steps) : [];

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
          <label className={styles.inputCheckbox}>
            <input
              type="checkbox"
              checked={craftingSale}
              onChange={(event) => setCraftingSale(event.target.checked)}
            />
            30% off crafting sale
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
              <div className={styles.summaryGroup}>
                <div
                  className={styles.summaryGroupLabel}
                  title="Global LP integer plan that maximizes total XP from your current inventory under full ingredient-consumption constraints. Total GE cost sums all craft rows in that LP plan, including intermediate rows."
                >
                  Max XP Plan
                </div>
                <div className={styles.summaryGroupCards}>
                  <div className={styles.summaryCard}>
                    <div className={styles.summaryLabel}>Total XP</div>
                    <div className={styles.summaryValue}>{solution.totalXp.toLocaleString()}</div>
                  </div>
                  <div className={styles.summaryCard}>
                    <div className={styles.summaryLabel}>Total GE Cost</div>
                    <div className={styles.summaryValue}>{solution.totalCost.toLocaleString()}</div>
                  </div>
                </div>
                <div className={styles.summaryMetaRow}>
                  <span className={styles.summaryMeta}>Follow the second table below.</span>
                  <RemainingInventoryDisclosure
                    label="Remaining inventory"
                    planLabel="Remaining inventory after Max XP Plan"
                    inventory={maxXpExecutionPlan?.remainingInventory}
                  />
                </div>
              </div>

              <div className={styles.summaryGroup}>
                <div
                  className={styles.summaryGroupLabel}
                  title="Sequential accumulator: walk the XP/GE-ranked standalone rows top-down and craft each row as much as still possible from remaining inventory, stopping at the first row below your minimum XP/GE threshold."
                >
                  Max GE Efficiency Plan
                </div>
                <div className={styles.efficiencyControl}>
                  <div className={styles.efficiencyControlHeader}>
                    <label htmlFor="minEfficiencyXpPerGe">
                      Min XP / GE: <strong>{minEfficiencyXpPerGe.toFixed(2)}</strong>
                    </label>
                    <span>Overall XP/GE: {geEfficiencyOverallXpPerGe.toFixed(2)}</span>
                  </div>
                  <input
                    id="minEfficiencyXpPerGe"
                    type="range"
                    min={0}
                    max={efficiencySliderMax}
                    step={efficiencySliderStep}
                    value={Math.min(minEfficiencyXpPerGe, efficiencySliderMax)}
                    onChange={(event) => setMinEfficiencyXpPerGe(Number(event.target.value))}
                    disabled={xpPerGeModeRows.length === 0}
                  />
                </div>
                <div className={styles.summaryGroupCards}>
                  <div className={styles.summaryCard}>
                    <div className={styles.summaryLabel}>Accumulated XP</div>
                    <div className={styles.summaryValue}>{Math.round(geEfficiencyPlan?.totalXp || 0).toLocaleString()}</div>
                  </div>
                  <div className={styles.summaryCard}>
                    <div className={styles.summaryLabel}>Accumulated GE Cost</div>
                    <div className={styles.summaryValue}>{Math.round(geEfficiencyPlan?.totalCost || 0).toLocaleString()}</div>
                  </div>
                </div>
                <div className={styles.summaryMetaRow}>
                  <span className={styles.summaryMeta}>Follow the first table below, sorted by XP / GE.</span>
                  <RemainingInventoryDisclosure
                    label="Remaining inventory"
                    planLabel="Remaining inventory after Max GE Efficiency Plan"
                    inventory={geEfficiencyPlan?.finalInventory}
                  />
                </div>
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
                className={`${styles.sortButton} ${sortKey === "tierXpPerGe" ? styles.activeButton : ""}`}
                onClick={() => setSortKey("tierXpPerGe")}
              >
                Tier
              </button>
              <button
                className={`${styles.sortButton} ${sortKey === "familyTier" ? styles.activeButton : ""}`}
                onClick={() => setSortKey("familyTier")}
              >
                Family
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
              <div className={styles.summaryMeta}>
                Standalone craft menu from your current inventory. Status shows whether each row would be fully used, partly used,
                blocked, or skipped in the Max GE Efficiency Plan. Sorting changes the display only; crafting out of order can
                change the plan. <span className={styles.inlineWarningLabel}>Warning:</span> auto-crafted artifacts cannot be shiny,
                so you may want to manually craft high-value targets instead of following the plan blindly.
              </div>
              <div className={styles.statusLegend}>
                <span className={styles.statusLegendItem}>
                  <StatusDot
                    status={{
                      kind: "full",
                      realizedCount: 0,
                      label: "Fully included",
                      title: "Fully included in the Max GE Efficiency Plan.",
                    }}
                  />{" "}
                  Full
                </span>
                <span className={styles.statusLegendItem}>
                  <StatusDot
                    status={{
                      kind: "partial",
                      realizedCount: 0,
                      label: "Partially included",
                      title: "Partially included in the Max GE Efficiency Plan.",
                    }}
                  />{" "}
                  Part
                </span>
                <span className={styles.statusLegendItem}>
                  <StatusDot
                    status={{
                      kind: "blocked",
                      realizedCount: 0,
                      label: "Blocked",
                      title: "No longer craftable by the time the plan reaches this row.",
                    }}
                  />{" "}
                  Blocked
                </span>
                <span className={styles.statusLegendItem}>
                  <StatusDot
                    status={{
                      kind: "belowThreshold",
                      realizedCount: 0,
                      label: "Below threshold",
                      title: "Below the current minimum XP/GE threshold.",
                    }}
                  />{" "}
                  Below threshold
                </span>
              </div>
              <table className={styles.resultsTable}>
                <thead>
                  <tr>
                    <th>Artifact</th>
                    <th
                      className={styles.num}
                      title="Standalone craftable count from your current inventory. Yellow and red rows show standalone -> realized count in the current Max GE Efficiency Plan."
                    >
                      Count
                    </th>
                    <th className={styles.num}>Total XP</th>
                    <th className={styles.num}>GE Cost</th>
                    <th className={styles.num}>XP / GE</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleModeRows.map((row) => {
                    const status = geEfficiencyStatusByRowKey[row.key];
                    return (
                    <tr key={row.key}>
                      <td>
                        <span className={styles.statusArtifactCell}>
                          {status && <StatusDot status={status} />}
                          <ArtifactCell artifact={row.artifact} modeLabel={row.modeLabel} />
                        </span>
                      </td>
                      <td className={styles.num}>{getModeRowCountLabel(row, status)}</td>
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
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className={styles.tableSection}>
              <h3>Max-XP Craft Order</h3>
              {maxXpExecutionPlan ? (
                <>
                  <div className={styles.summaryMeta}>
                    Craft the unindented rows in order. Indented rows show the artifacts the game will auto-craft underneath those
                    crafts after using any inventory the LP plan leaves available for ingredient consumption first.{" "}
                    <span className={styles.inlineWarningLabel}>Warning:</span> auto-crafted artifacts cannot be shiny, so you may
                    want to manually craft high-value targets instead of following this order blindly.
                  </div>
                  <table className={styles.resultsTable}>
                    <thead>
                      <tr>
                        <th>Craft</th>
                        <th className={styles.num}>Count</th>
                        <th className={styles.num}>XP</th>
                        <th
                          className={styles.num}
                          title="Direct craft spend for the rows shown here. Summing the whole tree matches the Max XP Plan total above."
                        >
                          Direct GE Cost
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {maxXpExecutionRows.map((row) => (
                        <tr key={row.key} data-depth={row.depth} className={row.mode === "click" ? styles.executionRootRow : ""}>
                          <td>
                            <span className={styles.executionArtifactCell}>
                              {row.prefix && <span className={styles.executionPrefix}>{row.prefix}</span>}
                              <ArtifactCell artifact={row.artifact} />
                            </span>
                          </td>
                          <td className={styles.num}>{row.count.toLocaleString()}</td>
                          <td className={styles.num}>{row.xp.toLocaleString()}</td>
                          <td className={styles.num}>{row.cost.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className={styles.summaryMeta}>
                    {maxXpExecutionPlan.totalTopLevelCrafts.toLocaleString()} total manual crafts across{" "}
                    {maxXpExecutionPlan.totalTopLevelRows.toLocaleString()} top-level entries.
                  </div>
                </>
              ) : (
                <div className={styles.summaryMeta}>{maxXpExecutionPlanError || "No Max-XP click order available."}</div>
              )}
            </div>
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
