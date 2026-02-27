import fs from "fs/promises";
import path from "path";
import { execFileSync } from "node:child_process";

import { playerProfileSchema } from "../lib/api-schemas";
import { itemKeyToDisplayName } from "../lib/item-utils";
import { loadLootData } from "../lib/loot-data";
import { planForTarget, type PlannerBenchmarkSample } from "../lib/planner";
import type { PlayerProfile } from "../lib/profile";

type SnapshotFile = {
  schemaVersion: 1;
  capturedAt: string;
  includeSlotted: boolean;
  profile: PlayerProfile;
};

type SolveMode = {
  label: string;
  fastMode: boolean;
};

type PriorityPreset = {
  label: string;
  priorityTime: number;
};

type BenchmarkTarget = {
  itemId: string;
  label: string;
};

type BenchmarkResultRow = {
  target: BenchmarkTarget;
  solveMode: SolveMode;
  priority: PriorityPreset;
  wallMs: number;
  expectedHours: number;
  geCost: number;
  path: "primary" | "fallback";
};

type BenchmarkSerializableRow = {
  targetItemId: string;
  targetLabel: string;
  solveModeLabel: string;
  fastMode: boolean;
  priorityLabel: string;
  priorityTime: number;
  wallMs: number;
  expectedHours: number;
  geCost: number;
  path: "primary" | "fallback";
};

const DEFAULT_QUANTITY = 1;
const REPO_ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(
  REPO_ROOT,
  "benchmarks",
  "mission-craft-planner",
  "profile-snapshot-benchmark.json"
);
const REPORT_DIR = path.join(REPO_ROOT, "benchmarks", "mission-craft-planner", "reports");

function toRepoRelativePath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

const TARGETS: BenchmarkTarget[] = [
  {
    itemId: "book-of-basan-4",
    label: itemKeyToDisplayName("book_of_basan_4"),
  },
  {
    itemId: "titanium-actuator-4",
    label: itemKeyToDisplayName("titanium_actuator_4"),
  },
  {
    itemId: "light-of-eggendil-4",
    label: itemKeyToDisplayName("light_of_eggendil_4"),
  },
];

const SOLVE_MODES: SolveMode[] = [
  {
    label: "Normal",
    fastMode: false,
  },
  {
    label: "Faster, less optimal solve",
    fastMode: true,
  },
];

const PRIORITIES: PriorityPreset[] = [
  {
    label: "100% Time",
    priorityTime: 1,
  },
  {
    label: "50/50",
    priorityTime: 0.5,
  },
  {
    label: "100% GE",
    priorityTime: 0,
  },
];

function runGit(args: string[]): string {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

function slugifyBranch(branch: string): string {
  return branch
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function formatWallMs(ms: number): string {
  const rounded = Math.max(0, Math.round(ms));
  return `${rounded.toLocaleString()} ms (${(rounded / 1000).toFixed(2)}s)`;
}

function formatMissionHours(hours: number): string {
  const safeHours = Math.max(0, hours);
  const totalMinutes = Math.round(safeHours * 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hoursPart = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutesPart = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hoursPart > 0) {
    parts.push(`${hoursPart}h`);
  }
  if (minutesPart > 0 || parts.length === 0) {
    parts.push(`${minutesPart}m`);
  }
  return `${parts.join(" ")} (${safeHours.toFixed(2)}h)`;
}

function formatPriority(value: number): string {
  return `${Math.round(value * 100)}% time / ${Math.round((1 - value) * 100)}% GE`;
}

function serializeRows(results: BenchmarkResultRow[]): BenchmarkSerializableRow[] {
  return results.map((row) => ({
    targetItemId: row.target.itemId,
    targetLabel: row.target.label,
    solveModeLabel: row.solveMode.label,
    fastMode: row.solveMode.fastMode,
    priorityLabel: row.priority.label,
    priorityTime: row.priority.priorityTime,
    wallMs: row.wallMs,
    expectedHours: row.expectedHours,
    geCost: row.geCost,
    path: row.path,
  }));
}

function escapeCsvCell(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }
  return value;
}

function buildCsv(rows: BenchmarkSerializableRow[]): string {
  const header = [
    "target_item_id",
    "target_label",
    "solve_mode",
    "fast_mode",
    "priority_label",
    "priority_time",
    "wall_ms",
    "expected_hours",
    "ge_cost",
    "solve_path",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.targetItemId,
        row.targetLabel,
        row.solveModeLabel,
        String(row.fastMode),
        row.priorityLabel,
        String(row.priorityTime),
        String(Math.round(row.wallMs)),
        row.expectedHours.toFixed(6),
        row.geCost.toFixed(6),
        row.path,
      ]
        .map(escapeCsvCell)
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

async function loadSnapshotProfile(): Promise<{ snapshot: SnapshotFile; profile: PlayerProfile }> {
  const raw = await fs.readFile(SNAPSHOT_PATH, "utf8");
  const parsed = JSON.parse(raw) as SnapshotFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid snapshot payload at ${SNAPSHOT_PATH}`);
  }
  const profile = playerProfileSchema.parse(parsed.profile);
  return {
    snapshot: parsed,
    profile,
  };
}

function buildMarkdownReport(options: {
  branch: string;
  commitShort: string;
  generatedAt: string;
  snapshot: SnapshotFile;
  snapshotPath: string;
  results: BenchmarkResultRow[];
}): string {
  const { branch, commitShort, generatedAt, snapshot, snapshotPath, results } = options;
  const lines: string[] = [];
  lines.push("# Mission Craft Planner Benchmark");
  lines.push("");
  lines.push(`- Branch: \`${branch}\``);
  lines.push(`- Commit: \`${commitShort}\``);
  lines.push(`- Generated at: \`${generatedAt}\``);
  lines.push(`- Profile snapshot: \`${snapshotPath}\``);
  lines.push(`- Snapshot captured at: \`${snapshot.capturedAt}\``);
  lines.push("- Quantity per target: `1`");
  lines.push("- Loot load overhead: excluded (prewarmed and subtracted in planner benchmark hook)");
  lines.push("");
  lines.push("| Target | Solve mode | Priority | Solve wall clock | Plan mission time | Plan GE cost | Solve path |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | --- |");
  for (const row of results) {
    lines.push(
      `| ${row.target.label} | ${row.solveMode.label} | ${row.priority.label} | ${formatWallMs(row.wallMs)} | ${formatMissionHours(
        row.expectedHours
      )} | ${Math.round(row.geCost).toLocaleString()} | ${row.path} |`
    );
  }
  lines.push("");

  const byMode = new Map<string, BenchmarkResultRow[]>();
  for (const row of results) {
    const key = row.solveMode.label;
    const rows = byMode.get(key) || [];
    rows.push(row);
    byMode.set(key, rows);
  }
  lines.push("## Aggregate Solve Time");
  lines.push("");
  lines.push("| Solve mode | Total wall clock |");
  lines.push("| --- | ---: |");
  for (const [modeLabel, rows] of byMode.entries()) {
    const totalMs = rows.reduce((sum, row) => sum + row.wallMs, 0);
    lines.push(`| ${modeLabel} | ${formatWallMs(totalMs)} |`);
  }
  lines.push("");
  lines.push("## Priority Presets");
  lines.push("");
  for (const preset of PRIORITIES) {
    lines.push(`- ${preset.label}: ${formatPriority(preset.priorityTime)}`);
  }

  return `${lines.join("\n")}\n`;
}

async function runBenchmarkMatrix(profile: PlayerProfile): Promise<BenchmarkResultRow[]> {
  const totalRuns = TARGETS.length * SOLVE_MODES.length * PRIORITIES.length;
  let runIndex = 0;
  const rows: BenchmarkResultRow[] = [];

  for (const target of TARGETS) {
    for (const solveMode of SOLVE_MODES) {
      for (const priority of PRIORITIES) {
        runIndex += 1;
        const runLabel = `[${runIndex}/${totalRuns}] ${target.label} | ${solveMode.label} | ${priority.label}`;
        console.log(`${runLabel} -> starting`);

        const benchmarkCapture: { sample: PlannerBenchmarkSample | null } = { sample: null };
        const processStart = Date.now();
        const plan = await planForTarget(profile, target.itemId, DEFAULT_QUANTITY, priority.priorityTime, {
          fastMode: solveMode.fastMode,
          onBenchmarkSample: (sample) => {
            benchmarkCapture.sample = sample;
          },
        });

        const fallbackWall = Math.max(0, Date.now() - processStart);
        const wallMs = benchmarkCapture.sample ? benchmarkCapture.sample.wallMs : fallbackWall;
        const path = benchmarkCapture.sample ? benchmarkCapture.sample.path : "primary";

        rows.push({
          target,
          solveMode,
          priority,
          wallMs,
          expectedHours: plan.expectedHours,
          geCost: plan.geCost,
          path,
        });

        console.log(
          `${runLabel} -> done in ${formatWallMs(wallMs)} | mission ${formatMissionHours(plan.expectedHours)} | GE ${Math.round(
            plan.geCost
          ).toLocaleString()}`
        );
      }
    }
  }

  return rows;
}

async function main(): Promise<void> {
  const { snapshot, profile } = await loadSnapshotProfile();
  console.log(`Loaded benchmark snapshot captured at ${snapshot.capturedAt}.`);

  console.log("Prewarming mission loot data cache (excluded from benchmark timing)...");
  await loadLootData();
  console.log("Loot cache ready.");

  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const commitShort = runGit(["rev-parse", "--short=5", "HEAD"]);
  const safeBranch = slugifyBranch(branch) || "detached-head";
  const reportBasePath = path.join(REPORT_DIR, `benchmark-${safeBranch}-${commitShort}`);
  const reportPath = `${reportBasePath}.md`;
  const reportJsonPath = `${reportBasePath}.json`;
  const reportCsvPath = `${reportBasePath}.csv`;

  const results = await runBenchmarkMatrix(profile);
  const serializedRows = serializeRows(results);

  const report = buildMarkdownReport({
    branch,
    commitShort,
    generatedAt: new Date().toISOString(),
    snapshot,
    snapshotPath: toRepoRelativePath(SNAPSHOT_PATH),
    results,
  });
  const jsonReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    branch,
    commitShort,
    quantityPerTarget: DEFAULT_QUANTITY,
    profileSnapshotPath: toRepoRelativePath(SNAPSHOT_PATH),
    profileSnapshotCapturedAt: snapshot.capturedAt,
    lootLoadOverheadExcluded: true,
    rows: serializedRows,
  };
  const csvReport = buildCsv(serializedRows);

  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(reportJsonPath, `${JSON.stringify(jsonReport, null, 2)}\n`, "utf8");
  await fs.writeFile(reportCsvPath, csvReport, "utf8");

  console.log(`Benchmark complete. Reports: ${reportPath}, ${reportJsonPath}, ${reportCsvPath}`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Benchmark failed: ${message}`);
  process.exit(1);
});
