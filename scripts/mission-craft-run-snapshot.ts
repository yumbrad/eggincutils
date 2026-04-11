import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { playerProfileSchema } from "../lib/api-schemas";
import { afxIdToDisplayName, itemIdToKey, itemKeyToDisplayName } from "../lib/item-utils";
import {
  computeMonolithicPaths,
  missionDurationLabel,
  planForTarget,
  type MonolithicPathResult,
  type PlannerProgressEvent,
  type PlannerResult,
} from "../lib/planner";

const durationTypeSchema = z.enum(["TUTORIAL", "SHORT", "LONG", "EPIC"]);

const solveInputSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("mission-craft-planner-solve-input"),
  capturedAt: z.string().min(1),
  request: z.object({
    targetItemId: z.string().min(1),
    quantity: z.number().int().min(1),
    priorityTime: z.number().finite().min(0).max(1),
    fastMode: z.boolean(),
    allowedShipDurations: z
      .array(z.object({ ship: z.string().min(1), durationType: z.enum(["SHORT", "LONG", "EPIC"]) }))
      .optional(),
  }),
  sourceFilters: z.object({
    inventorySource: z.enum(["main", "virtue"]).optional().default("main"),
    includeSlotted: z.boolean(),
    includeInventoryRare: z.boolean(),
    includeInventoryEpic: z.boolean(),
    includeInventoryLegendary: z.boolean(),
    includeDropRare: z.boolean(),
    includeDropEpic: z.boolean(),
    includeDropLegendary: z.boolean(),
  }),
  profile: playerProfileSchema,
  advancedCompare: z.object({
    availableCombos: z.array(
      z.object({
        ship: z.string().min(1),
        durationType: durationTypeSchema,
        targetAfxId: z.number().int(),
      })
    ),
    selectedCombos: z.array(
      z.object({
        ship: z.string().min(1),
        durationType: durationTypeSchema,
        targetAfxId: z.number().int(),
      })
    ),
  }),
});

type SolveInputSnapshotFile = z.infer<typeof solveInputSnapshotSchema>;

type CliOptions = {
  snapshotPath: string;
  compare: boolean;
  json: boolean;
  outPath: string | null;
  progress: boolean;
};

type ParsedSolveStage = {
  label: string;
  attempts: number;
  totalMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  constraintRows: number;
  integerVars: number;
  binaryVars: number;
  actionCount: number;
  raw: string;
};

type ParsedSelectedModelSize = {
  solveType: "LP" | "MILP";
  constraintRows: number;
  integerVars: number;
  binaryVars: number;
  actionCount: number;
  raw: string;
};

type ParsedLaunchRefinement = {
  beforeLaunches: number;
  afterLaunches: number;
  keptBaseline: boolean;
  raw: string;
};

type ParsedNoteDiagnostics = {
  solverStages: ParsedSolveStage[];
  selectedModelSize: ParsedSelectedModelSize | null;
  launchCountRefinement: ParsedLaunchRefinement | null;
};

type CompareDiagnostics = {
  requested: boolean;
  executed: boolean;
  reason?: string;
  comboSource?: "selected" | "available";
  combosRequested: Array<{ ship: string; durationType: string; targetAfxId: number; target: string }>;
  feasibleCount: number;
  infeasibleCount: number;
  bestTimePath: {
    ship: string;
    durationType: string;
    targetAfxId: number;
    target: string;
    expectedHours: number;
    geCost: number;
    totalLaunches: number;
  } | null;
  bestGePath: {
    ship: string;
    durationType: string;
    targetAfxId: number;
    target: string;
    expectedHours: number;
    geCost: number;
    totalLaunches: number;
  } | null;
  noSlowerCheaperCount: number;
  noCostFasterCount: number;
  sameTimeCheaperCount: number;
  sameCostFasterCount: number;
  results: MonolithicPathResult[];
};

type RunDiagnostics = {
  schemaVersion: 1;
  kind: "mission-craft-planner-snapshot-run";
  generatedAt: string;
  environment: {
    cwd: string;
    node: string;
    platform: string;
    arch: string;
    hostname: string;
    pid: number;
    gitBranch: string | null;
    gitCommit: string | null;
  };
  snapshot: {
    path: string;
    fileSizeBytes: number;
    sha256: string;
    capturedAt: string;
    request: SolveInputSnapshotFile["request"];
    sourceFilters: SolveInputSnapshotFile["sourceFilters"];
    profileDigest: {
      eid: string;
      inventoryItemCount: number;
      inventoryTotalQuantity: number;
      craftCountEntryCount: number;
      totalCraftCountHistory: number;
      shipCount: number;
      unlockedShipCount: number;
      missionOptionCount: number;
    };
    advancedCompareDigest: {
      availableCount: number;
      selectedCount: number;
    };
  };
  execution: {
    wallMs: number;
    progressEventCount: number;
    progressPhaseCounts: Record<string, number>;
    progressEvents: Array<
      PlannerProgressEvent & {
        index: number;
      }
    >;
  };
  planSummary: {
    expectedHours: number;
    expectedMissionTimeLabel: string;
    geCost: number;
    weightedScore: number;
    totalSlotSeconds: number;
    totalSlotTimeLabel: string;
    missionRows: number;
    craftRows: number;
    unmetRows: number;
    unmetQuantity: number;
    totalLaunches: number;
    totalCraftCount: number;
    targetBreakdown: PlannerResult["targetBreakdown"];
    topMissionRows: Array<{
      ship: string;
      durationType: string;
      level: number;
      targetAfxId: number;
      target: string;
      launches: number;
      durationSeconds: number;
      slotTimeLabel: string;
      topExpectedYields: Array<{ itemId: string; name: string; quantity: number }>;
    }>;
    topCraftRows: Array<{ itemId: string; name: string; count: number }>;
    notes: string[];
    parsedNotes: ParsedNoteDiagnostics;
  };
  compare: CompareDiagnostics;
  plan: PlannerResult;
};

function usage(): string {
  return [
    "Usage:",
    "  npm run mission-craft:run-snapshot -- <snapshot.json> [--compare] [--json] [--out <file>] [--progress|--no-progress]",
    "",
    "Flags:",
    "  --compare      Also run monolithic combo compare using snapshot combos.",
    "  --json         Print full diagnostics JSON to stdout.",
    "  --out <file>   Write full diagnostics JSON to file.",
    "  --progress     Force live progress output.",
    "  --no-progress  Disable live progress output.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  let snapshotPath = "";
  let compare = false;
  let json = false;
  let outPath: string | null = null;
  let progress = Boolean(process.stdout.isTTY);

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (token === "--compare") {
      compare = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--progress") {
      progress = true;
      continue;
    }
    if (token === "--no-progress") {
      progress = false;
      continue;
    }
    if (token === "--out") {
      const value = args.shift();
      if (!value) {
        throw new Error("--out requires a file path");
      }
      outPath = value;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`unknown flag: ${token}`);
    }
    if (!snapshotPath) {
      snapshotPath = token;
      continue;
    }
    throw new Error(`unexpected argument: ${token}`);
  }

  if (!snapshotPath) {
    throw new Error("snapshot path is required");
  }

  return {
    snapshotPath,
    compare,
    json,
    outPath,
    progress,
  };
}

function parseIntWithCommas(value: string): number {
  return Number.parseInt(value.replaceAll(",", "").trim(), 10);
}

function parseDurationToMs(label: string): number | null {
  const match = label.trim().match(/^([\d.]+)\s*(ms|s|m|h|d)$/i);
  if (!match) {
    return null;
  }
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) {
    return null;
  }
  const unit = match[2].toLowerCase();
  if (unit === "ms") return value;
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60_000;
  if (unit === "h") return value * 3_600_000;
  if (unit === "d") return value * 86_400_000;
  return null;
}

function parseMetricTriplet(raw: string): { totalMs: number | null; avgMs: number | null; maxMs: number | null } {
  const totalMatch = raw.match(/([\d.]+\s*(?:ms|s|m|h|d))\s+total/i);
  const avgMatch = raw.match(/avg\s+([\d.]+\s*(?:ms|s|m|h|d))/i);
  const maxMatch = raw.match(/max\s+([\d.]+\s*(?:ms|s|m|h|d))/i);
  return {
    totalMs: totalMatch ? parseDurationToMs(totalMatch[1]) : null,
    avgMs: avgMatch ? parseDurationToMs(avgMatch[1]) : null,
    maxMs: maxMatch ? parseDurationToMs(maxMatch[1]) : null,
  };
}

function parseSolverDiagnosticsLine(line: string): ParsedSolveStage[] {
  const prefix = "Solver diagnostics: ";
  if (!line.startsWith(prefix)) {
    return [];
  }
  const rest = line.slice(prefix.length).trim();
  const chunks = rest
    .split(/\.\s+/)
    .map((part) => part.trim())
    .map((part) => (part.endsWith(".") ? part.slice(0, -1) : part))
    .filter((part) => part.length > 0);

  const parsed: ParsedSolveStage[] = [];
  const stageRegex =
    /^(.+?):\s+([\d,]+)\s+solves?\s+\(([^)]*)\),\s+peak model\s+([\d,]+)\s+rows\s*\/\s*([\d,]+)\s+integer vars\s+\(([\d,]+)\s+binary\),\s+([\d,]+)\s+actions$/i;
  for (const chunk of chunks) {
    const match = chunk.match(stageRegex);
    if (!match) {
      continue;
    }
    const metrics = parseMetricTriplet(match[3]);
    parsed.push({
      label: match[1].trim(),
      attempts: parseIntWithCommas(match[2]),
      totalMs: metrics.totalMs,
      avgMs: metrics.avgMs,
      maxMs: metrics.maxMs,
      constraintRows: parseIntWithCommas(match[4]),
      integerVars: parseIntWithCommas(match[5]),
      binaryVars: parseIntWithCommas(match[6]),
      actionCount: parseIntWithCommas(match[7]),
      raw: chunk,
    });
  }
  return parsed;
}

function parseSelectedModelSizeLine(line: string): ParsedSelectedModelSize | null {
  const modelRegex =
    /^Selected\s+(LP|MILP)\s+model size:\s+([\d,]+)\s+rows,\s+([\d,]+)\s+integer vars\s+\(([\d,]+)\s+binary\),\s+([\d,]+)\s+mission actions\.$/i;
  const match = line.match(modelRegex);
  if (!match) {
    return null;
  }
  return {
    solveType: match[1].toUpperCase() as "LP" | "MILP",
    constraintRows: parseIntWithCommas(match[2]),
    integerVars: parseIntWithCommas(match[3]),
    binaryVars: parseIntWithCommas(match[4]),
    actionCount: parseIntWithCommas(match[5]),
    raw: line,
  };
}

function parseLaunchRefinementLine(line: string): ParsedLaunchRefinement | null {
  const regex =
    /^Selected candidate launch-count refinement:\s+before\s+([\d,]+)\s+launches,\s+after\s+([\d,]+)\s+launches\s+\(([^)]+)\)\.$/i;
  const match = line.match(regex);
  if (!match) {
    return null;
  }
  const status = match[3].toLowerCase();
  return {
    beforeLaunches: parseIntWithCommas(match[1]),
    afterLaunches: parseIntWithCommas(match[2]),
    keptBaseline: status.includes("baseline kept"),
    raw: line,
  };
}

function extractParsedNoteDiagnostics(notes: string[]): ParsedNoteDiagnostics {
  const solverStages = notes.flatMap((line) => parseSolverDiagnosticsLine(line));
  const selectedModelSize = notes.map(parseSelectedModelSizeLine).find((value) => value !== null) || null;
  const launchCountRefinement = notes.map(parseLaunchRefinementLine).find((value) => value !== null) || null;
  return {
    solverStages,
    selectedModelSize,
    launchCountRefinement,
  };
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "n/a";
  }
  const rounded = Math.max(0, Math.round(ms));
  if (rounded < 1000) {
    return `${rounded}ms`;
  }
  return `${(rounded / 1000).toFixed(2)}s`;
}

function formatHours(hours: number): string {
  const safeHours = Math.max(0, hours);
  return `${missionDurationLabel(Math.round(safeHours * 3600))} (${safeHours.toFixed(2)}h)`;
}

function formatPriority(priorityTime: number): string {
  const timePct = Math.round(priorityTime * 100);
  const gePct = Math.round((1 - priorityTime) * 100);
  return `${timePct}% time / ${gePct}% GE`;
}

function safeGit(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function summarizeProfile(snapshot: SolveInputSnapshotFile): RunDiagnostics["snapshot"]["profileDigest"] {
  const inventoryValues = Object.values(snapshot.profile.inventory);
  const craftCountValues = Object.values(snapshot.profile.craftCounts);
  const unlockedShipCount = snapshot.profile.shipLevels.filter((ship) => ship.unlocked).length;
  return {
    eid: snapshot.profile.eid,
    inventoryItemCount: inventoryValues.length,
    inventoryTotalQuantity: inventoryValues.reduce((sum, qty) => sum + qty, 0),
    craftCountEntryCount: craftCountValues.length,
    totalCraftCountHistory: craftCountValues.reduce((sum, qty) => sum + qty, 0),
    shipCount: snapshot.profile.shipLevels.length,
    unlockedShipCount,
    missionOptionCount: snapshot.profile.missionOptions.length,
  };
}

function summarizePlan(plan: PlannerResult): RunDiagnostics["planSummary"] {
  const totalLaunches = plan.missions.reduce((sum, row) => sum + Math.max(0, Math.round(row.launches)), 0);
  const totalCraftCount = plan.crafts.reduce((sum, row) => sum + Math.max(0, Math.round(row.count)), 0);
  const unmetQuantity = plan.unmetItems.reduce((sum, row) => sum + Math.max(0, row.quantity), 0);
  const topMissionRows = [...plan.missions]
    .sort((a, b) => {
      const slotA = a.launches * a.durationSeconds;
      const slotB = b.launches * b.durationSeconds;
      if (slotB !== slotA) {
        return slotB - slotA;
      }
      return b.launches - a.launches;
    })
    .slice(0, 10)
    .map((row) => ({
      ship: row.ship,
      durationType: row.durationType,
      level: row.level,
      targetAfxId: row.targetAfxId,
      target: afxIdToDisplayName(row.targetAfxId),
      launches: row.launches,
      durationSeconds: row.durationSeconds,
      slotTimeLabel: missionDurationLabel(row.launches * row.durationSeconds),
      topExpectedYields: [...row.expectedYields]
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 3)
        .map((yieldRow) => ({
          itemId: yieldRow.itemId,
          name: itemKeyToDisplayName(itemIdToKey(yieldRow.itemId)),
          quantity: yieldRow.quantity,
        })),
    }));
  const topCraftRows = [...plan.crafts]
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)
    .map((row) => ({
      itemId: row.itemId,
      name: itemKeyToDisplayName(itemIdToKey(row.itemId)),
      count: row.count,
    }));

  return {
    expectedHours: plan.expectedHours,
    expectedMissionTimeLabel: formatHours(plan.expectedHours),
    geCost: plan.geCost,
    weightedScore: plan.weightedScore,
    totalSlotSeconds: plan.totalSlotSeconds,
    totalSlotTimeLabel: missionDurationLabel(plan.totalSlotSeconds),
    missionRows: plan.missions.length,
    craftRows: plan.crafts.length,
    unmetRows: plan.unmetItems.length,
    unmetQuantity,
    totalLaunches,
    totalCraftCount,
    targetBreakdown: plan.targetBreakdown,
    topMissionRows,
    topCraftRows,
    notes: plan.notes,
    parsedNotes: extractParsedNoteDiagnostics(plan.notes),
  };
}

function summarizeProgressEvents(
  events: PlannerProgressEvent[]
): Pick<RunDiagnostics["execution"], "progressEventCount" | "progressPhaseCounts" | "progressEvents"> {
  const phaseCounts: Record<string, number> = {};
  const eventRows = events.map((event, index) => {
    phaseCounts[event.phase] = (phaseCounts[event.phase] || 0) + 1;
    return {
      ...event,
      index: index + 1,
    };
  });
  return {
    progressEventCount: events.length,
    progressPhaseCounts: phaseCounts,
    progressEvents: eventRows,
  };
}

function mapPathSummary(pathResult: MonolithicPathResult) {
  return {
    ship: pathResult.ship,
    durationType: pathResult.durationType,
    targetAfxId: pathResult.targetAfxId,
    target: afxIdToDisplayName(pathResult.targetAfxId),
    expectedHours: pathResult.expectedHours,
    geCost: pathResult.geCost,
    totalLaunches: pathResult.totalLaunches,
  };
}

async function runCompareDiagnostics(options: {
  snapshot: SolveInputSnapshotFile;
  plan: PlannerResult;
}): Promise<CompareDiagnostics> {
  const { snapshot, plan } = options;
  const selected = snapshot.advancedCompare.selectedCombos;
  const available = snapshot.advancedCompare.availableCombos;
  const combos = selected.length > 0 ? selected : available;
  const comboSource = selected.length > 0 ? "selected" : "available";
  if (combos.length === 0) {
    return {
      requested: true,
      executed: false,
      reason: "snapshot has no compare combos (selected or available)",
      combosRequested: [],
      feasibleCount: 0,
      infeasibleCount: 0,
      bestTimePath: null,
      bestGePath: null,
      noSlowerCheaperCount: 0,
      noCostFasterCount: 0,
      sameTimeCheaperCount: 0,
      sameCostFasterCount: 0,
      results: [],
    };
  }

  const results = await computeMonolithicPaths({
    profile: snapshot.profile,
    targetItemId: snapshot.request.targetItemId,
    quantity: snapshot.request.quantity,
    priorityTime: snapshot.request.priorityTime,
    selectedCombos: combos,
    missionDropRarities: {
      rare: snapshot.sourceFilters.includeDropRare,
      epic: snapshot.sourceFilters.includeDropEpic,
      legendary: snapshot.sourceFilters.includeDropLegendary,
    },
  });

  const feasible = results.filter((row) => row.feasible);
  const infeasible = results.length - feasible.length;

  const byTimeThenGe = [...feasible].sort((a, b) => {
    const diffHours = a.expectedHours - b.expectedHours;
    if (Math.abs(diffHours) > 1e-9) return diffHours;
    const diffGe = a.geCost - b.geCost;
    if (Math.abs(diffGe) > 1e-9) return diffGe;
    return a.totalLaunches - b.totalLaunches;
  });
  const byGeThenTime = [...feasible].sort((a, b) => {
    const diffGe = a.geCost - b.geCost;
    if (Math.abs(diffGe) > 1e-9) return diffGe;
    const diffHours = a.expectedHours - b.expectedHours;
    if (Math.abs(diffHours) > 1e-9) return diffHours;
    return a.totalLaunches - b.totalLaunches;
  });

  const bestTimePath = byTimeThenGe.length > 0 ? mapPathSummary(byTimeThenGe[0]) : null;
  const bestGePath = byGeThenTime.length > 0 ? mapPathSummary(byGeThenTime[0]) : null;

  const tieHoursTolerance = 1 / 3600;
  const geTolerance = 1e-6;
  const noSlowerCheaperCount = feasible.filter(
    (row) => row.expectedHours <= plan.expectedHours + tieHoursTolerance && row.geCost < plan.geCost - geTolerance
  ).length;
  const noCostFasterCount = feasible.filter(
    (row) => row.geCost <= plan.geCost + geTolerance && row.expectedHours < plan.expectedHours - tieHoursTolerance
  ).length;
  const sameTimeCheaperCount = feasible.filter(
    (row) => Math.abs(row.expectedHours - plan.expectedHours) <= tieHoursTolerance && row.geCost < plan.geCost - geTolerance
  ).length;
  const sameCostFasterCount = feasible.filter(
    (row) => Math.abs(row.geCost - plan.geCost) <= geTolerance && row.expectedHours < plan.expectedHours - tieHoursTolerance
  ).length;

  return {
    requested: true,
    executed: true,
    comboSource,
    combosRequested: combos.map((combo) => ({
      ship: combo.ship,
      durationType: combo.durationType,
      targetAfxId: combo.targetAfxId,
      target: afxIdToDisplayName(combo.targetAfxId),
    })),
    feasibleCount: feasible.length,
    infeasibleCount: infeasible,
    bestTimePath,
    bestGePath,
    noSlowerCheaperCount,
    noCostFasterCount,
    sameTimeCheaperCount,
    sameCostFasterCount,
    results,
  };
}

async function loadSnapshot(snapshotPathArg: string): Promise<{
  absolutePath: string;
  snapshot: SolveInputSnapshotFile;
  fileSizeBytes: number;
  sha256: string;
}> {
  const absolutePath = path.resolve(snapshotPathArg);
  const rawBuffer = await fs.readFile(absolutePath);
  const fileSizeBytes = rawBuffer.byteLength;
  const sha256 = crypto.createHash("sha256").update(rawBuffer).digest("hex");
  const payload = JSON.parse(rawBuffer.toString("utf8")) as unknown;
  const parsed = solveInputSnapshotSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid snapshot file format (${details})`);
  }
  return {
    absolutePath,
    snapshot: parsed.data,
    fileSizeBytes,
    sha256,
  };
}

function printPlanSummary(diag: RunDiagnostics): void {
  const { snapshot, execution, planSummary, compare } = diag;
  console.log(`Snapshot: ${snapshot.path}`);
  console.log(`Captured: ${snapshot.capturedAt}`);
  console.log(
    `Request: ${itemKeyToDisplayName(itemIdToKey(snapshot.request.targetItemId))} x${snapshot.request.quantity.toLocaleString()} | ${formatPriority(
      snapshot.request.priorityTime
    )} | fastMode=${String(snapshot.request.fastMode)}`
  );
  console.log(
    `Filters: inventorySource=${snapshot.sourceFilters.inventorySource} slotted=${String(
      snapshot.sourceFilters.includeSlotted
    )} inv R/E/L=${String(
      snapshot.sourceFilters.includeInventoryRare
    )}/${String(snapshot.sourceFilters.includeInventoryEpic)}/${String(
      snapshot.sourceFilters.includeInventoryLegendary
    )} drop R/E/L=${String(snapshot.sourceFilters.includeDropRare)}/${String(
      snapshot.sourceFilters.includeDropEpic
    )}/${String(snapshot.sourceFilters.includeDropLegendary)}`
  );
  console.log(
    `Profile: inventory=${snapshot.profileDigest.inventoryItemCount.toLocaleString()} entries (${Math.round(
      snapshot.profileDigest.inventoryTotalQuantity
    ).toLocaleString()} total qty), ships=${snapshot.profileDigest.shipCount.toLocaleString()} (${snapshot.profileDigest.unlockedShipCount.toLocaleString()} unlocked), mission options=${snapshot.profileDigest.missionOptionCount.toLocaleString()}`
  );
  console.log(
    `Solve: wall=${formatMs(execution.wallMs)} | expected mission=${planSummary.expectedMissionTimeLabel} | GE=${Math.round(
      planSummary.geCost
    ).toLocaleString()} | launches=${planSummary.totalLaunches.toLocaleString()} | crafts=${planSummary.totalCraftCount.toLocaleString()}`
  );
  console.log(
    `Target breakdown: requested=${planSummary.targetBreakdown.requested.toLocaleString()} inventory=${planSummary.targetBreakdown.fromInventory.toLocaleString()} craft=${planSummary.targetBreakdown.fromCraft.toLocaleString()} missions=${planSummary.targetBreakdown.fromMissionsExpected.toFixed(
      2
    )} shortfall=${planSummary.targetBreakdown.shortfall.toFixed(6)}`
  );
  console.log(
    `Unmet: rows=${planSummary.unmetRows.toLocaleString()} qty=${planSummary.unmetQuantity.toFixed(6)} | Notes=${planSummary.notes.length.toLocaleString()}`
  );

  if (planSummary.parsedNotes.solverStages.length > 0) {
    console.log("Solver stages:");
    for (const stage of planSummary.parsedNotes.solverStages) {
      console.log(
        `  - ${stage.label}: solves=${stage.attempts.toLocaleString()} total=${stage.totalMs == null ? "n/a" : formatMs(
          stage.totalMs
        )} avg=${stage.avgMs == null ? "n/a" : formatMs(stage.avgMs)} max=${
          stage.maxMs == null ? "n/a" : formatMs(stage.maxMs)
        } rows=${stage.constraintRows.toLocaleString()} integer=${stage.integerVars.toLocaleString()} binary=${stage.binaryVars.toLocaleString()} actions=${stage.actionCount.toLocaleString()}`
      );
    }
  }
  if (planSummary.parsedNotes.selectedModelSize) {
    const selected = planSummary.parsedNotes.selectedModelSize;
    console.log(
      `Selected model: ${selected.solveType} rows=${selected.constraintRows.toLocaleString()} integer=${selected.integerVars.toLocaleString()} binary=${selected.binaryVars.toLocaleString()} actions=${selected.actionCount.toLocaleString()}`
    );
  }
  if (planSummary.parsedNotes.launchCountRefinement) {
    const launchRefinement = planSummary.parsedNotes.launchCountRefinement;
    console.log(
      `Launch-count refinement: before=${launchRefinement.beforeLaunches.toLocaleString()} after=${launchRefinement.afterLaunches.toLocaleString()} baselineKept=${String(
        launchRefinement.keptBaseline
      )}`
    );
  }
  if (compare.requested) {
    if (!compare.executed) {
      console.log(`Compare: skipped (${compare.reason || "no reason"})`);
    } else {
      console.log(
        `Compare: combos=${compare.combosRequested.length.toLocaleString()} (${compare.comboSource}), feasible=${compare.feasibleCount.toLocaleString()}, infeasible=${compare.infeasibleCount.toLocaleString()}`
      );
      if (compare.bestTimePath) {
        console.log(
          `  best-time: ${compare.bestTimePath.ship} ${compare.bestTimePath.durationType} ${compare.bestTimePath.target} | ${formatHours(
            compare.bestTimePath.expectedHours
          )} | GE ${Math.round(compare.bestTimePath.geCost).toLocaleString()} | launches ${compare.bestTimePath.totalLaunches.toLocaleString()}`
        );
      }
      if (compare.bestGePath) {
        console.log(
          `  best-GE: ${compare.bestGePath.ship} ${compare.bestGePath.durationType} ${compare.bestGePath.target} | ${formatHours(
            compare.bestGePath.expectedHours
          )} | GE ${Math.round(compare.bestGePath.geCost).toLocaleString()} | launches ${compare.bestGePath.totalLaunches.toLocaleString()}`
        );
      }
      console.log(
        `  mixed-vs-monolithic opportunities: no-slower-cheaper=${compare.noSlowerCheaperCount.toLocaleString()} no-cost-faster=${compare.noCostFasterCount.toLocaleString()} same-time-cheaper=${compare.sameTimeCheaperCount.toLocaleString()} same-cost-faster=${compare.sameCostFasterCount.toLocaleString()}`
      );
    }
  }
}

async function run(options: CliOptions): Promise<RunDiagnostics> {
  const loaded = await loadSnapshot(options.snapshotPath);
  const progressEvents: PlannerProgressEvent[] = [];

  const planStartedAt = Date.now();
  const plan = await planForTarget(
    loaded.snapshot.profile,
    loaded.snapshot.request.targetItemId,
    loaded.snapshot.request.quantity,
    loaded.snapshot.request.priorityTime,
    {
      fastMode: loaded.snapshot.request.fastMode,
      missionDropRarities: {
        rare: loaded.snapshot.sourceFilters.includeDropRare,
        epic: loaded.snapshot.sourceFilters.includeDropEpic,
        legendary: loaded.snapshot.sourceFilters.includeDropLegendary,
      },
      allowedShipDurations: loaded.snapshot.request.allowedShipDurations,
      onProgress: (event) => {
        progressEvents.push(event);
        if (options.progress) {
          const completed = event.completed != null && event.total != null ? ` (${event.completed}/${event.total})` : "";
          console.log(`[${formatMs(event.elapsedMs)}] [${event.phase}] ${event.message}${completed}`);
        }
      },
    }
  );
  const wallMs = Math.max(0, Date.now() - planStartedAt);

  const compare = options.compare
    ? await runCompareDiagnostics({
        snapshot: loaded.snapshot,
        plan,
      })
    : {
        requested: false,
        executed: false,
        reason: "not requested",
        combosRequested: [],
        feasibleCount: 0,
        infeasibleCount: 0,
        bestTimePath: null,
        bestGePath: null,
        noSlowerCheaperCount: 0,
        noCostFasterCount: 0,
        sameTimeCheaperCount: 0,
        sameCostFasterCount: 0,
        results: [],
      };

  const progressSummary = summarizeProgressEvents(progressEvents);
  return {
    schemaVersion: 1,
    kind: "mission-craft-planner-snapshot-run",
    generatedAt: new Date().toISOString(),
    environment: {
      cwd: process.cwd(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      pid: process.pid,
      gitBranch: safeGit(["rev-parse", "--abbrev-ref", "HEAD"]),
      gitCommit: safeGit(["rev-parse", "--short=12", "HEAD"]),
    },
    snapshot: {
      path: loaded.absolutePath,
      fileSizeBytes: loaded.fileSizeBytes,
      sha256: loaded.sha256,
      capturedAt: loaded.snapshot.capturedAt,
      request: loaded.snapshot.request,
      sourceFilters: loaded.snapshot.sourceFilters,
      profileDigest: summarizeProfile(loaded.snapshot),
      advancedCompareDigest: {
        availableCount: loaded.snapshot.advancedCompare.availableCombos.length,
        selectedCount: loaded.snapshot.advancedCompare.selectedCombos.length,
      },
    },
    execution: {
      wallMs,
      ...progressSummary,
    },
    planSummary: summarizePlan(plan),
    compare,
    plan,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const diagnostics = await run(options);
  printPlanSummary(diagnostics);

  if (options.outPath) {
    const outAbsolutePath = path.resolve(options.outPath);
    await fs.mkdir(path.dirname(outAbsolutePath), { recursive: true });
    await fs.writeFile(outAbsolutePath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
    console.log(`Diagnostics written: ${outAbsolutePath}`);
  }

  if (options.json) {
    console.log(JSON.stringify(diagnostics, null, 2));
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`Snapshot run failed: ${message}`);
  if (stack) {
    console.error(stack);
  }
  process.exit(1);
});
