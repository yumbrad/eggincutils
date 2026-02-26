import fs from "fs/promises";
import path from "path";

type ParsedRow = {
  targetItemId: string | null;
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

type ParsedMetadata = {
  branch: string | null;
  commitShort: string | null;
  generatedAt: string | null;
  profileSnapshotPath: string | null;
  profileSnapshotCapturedAt: string | null;
  quantityPerTarget: number | null;
  lootLoadOverheadExcluded: boolean;
};

const REPORTS_DIR = path.join(process.cwd(), "benchmarks", "mission-craft-planner", "reports");
const TARGET_LABEL_TO_ITEM_ID: Array<{ pattern: RegExp; itemId: string }> = [
  { pattern: /book of basan/i, itemId: "book-of-basan-4" },
  { pattern: /titanium actuator/i, itemId: "titanium-actuator-4" },
  { pattern: /light of eggendil/i, itemId: "light-of-eggendil-4" },
];

function parseQuotedMarkdownValue(line: string): string | null {
  const match = line.match(/`([^`]+)`/);
  return match ? match[1] : null;
}

function parseTargetItemId(targetLabel: string): string | null {
  for (const candidate of TARGET_LABEL_TO_ITEM_ID) {
    if (candidate.pattern.test(targetLabel)) {
      return candidate.itemId;
    }
  }
  return null;
}

function parsePriorityTime(priorityLabel: string): number {
  if (priorityLabel === "100% Time") {
    return 1;
  }
  if (priorityLabel === "50/50") {
    return 0.5;
  }
  if (priorityLabel === "100% GE") {
    return 0;
  }
  return 0.5;
}

function parseWallMs(text: string): number {
  const match = text.match(/([\d,]+)\s*ms/i);
  if (!match) {
    throw new Error(`unable to parse wall clock field '${text}'`);
  }
  return Number(match[1].replaceAll(",", ""));
}

function parseExpectedHours(text: string): number {
  const match = text.match(/\(([\d.]+)h\)/i);
  if (!match) {
    throw new Error(`unable to parse mission hours field '${text}'`);
  }
  return Number(match[1]);
}

function parseGeCost(text: string): number {
  const normalized = text.replaceAll(",", "").trim();
  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    throw new Error(`unable to parse GE cost field '${text}'`);
  }
  return value;
}

function parseTableRow(line: string): ParsedRow {
  const cells = line
    .split("|")
    .map((part) => part.trim())
    .filter((_, index, array) => !(index === 0 || index === array.length - 1));
  if (cells.length !== 7) {
    throw new Error(`unexpected table row shape '${line}'`);
  }

  const targetLabel = cells[0];
  const solveModeLabel = cells[1];
  const priorityLabel = cells[2];
  const wallMs = parseWallMs(cells[3]);
  const expectedHours = parseExpectedHours(cells[4]);
  const geCost = parseGeCost(cells[5]);
  const pathValue = cells[6] === "fallback" ? "fallback" : "primary";

  return {
    targetItemId: parseTargetItemId(targetLabel),
    targetLabel,
    solveModeLabel,
    fastMode: /faster, less optimal solve/i.test(solveModeLabel),
    priorityLabel,
    priorityTime: parsePriorityTime(priorityLabel),
    wallMs,
    expectedHours,
    geCost,
    path: pathValue,
  };
}

function escapeCsvCell(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }
  return value;
}

function buildCsv(rows: ParsedRow[]): string {
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
        row.targetItemId || "",
        row.targetLabel,
        row.solveModeLabel,
        String(row.fastMode),
        row.priorityLabel,
        String(row.priorityTime),
        String(row.wallMs),
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

async function findLatestMarkdownReport(): Promise<string> {
  const entries = await fs.readdir(REPORTS_DIR);
  const markdownFiles = entries
    .filter((entry) => entry.endsWith(".md") && entry.startsWith("benchmark-"))
    .map((entry) => path.join(REPORTS_DIR, entry));
  if (markdownFiles.length === 0) {
    throw new Error(`no benchmark markdown reports found in ${REPORTS_DIR}`);
  }
  const stats = await Promise.all(markdownFiles.map(async (filePath) => ({ filePath, stat: await fs.stat(filePath) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats[0].filePath;
}

function parseMetadata(lines: string[]): ParsedMetadata {
  const metadata: ParsedMetadata = {
    branch: null,
    commitShort: null,
    generatedAt: null,
    profileSnapshotPath: null,
    profileSnapshotCapturedAt: null,
    quantityPerTarget: null,
    lootLoadOverheadExcluded: false,
  };

  for (const line of lines) {
    if (line.startsWith("- Branch:")) {
      metadata.branch = parseQuotedMarkdownValue(line);
    } else if (line.startsWith("- Commit:")) {
      metadata.commitShort = parseQuotedMarkdownValue(line);
    } else if (line.startsWith("- Generated at:")) {
      metadata.generatedAt = parseQuotedMarkdownValue(line);
    } else if (line.startsWith("- Profile snapshot:")) {
      metadata.profileSnapshotPath = parseQuotedMarkdownValue(line);
    } else if (line.startsWith("- Snapshot captured at:")) {
      metadata.profileSnapshotCapturedAt = parseQuotedMarkdownValue(line);
    } else if (line.startsWith("- Quantity per target:")) {
      const value = parseQuotedMarkdownValue(line);
      metadata.quantityPerTarget = value != null ? Number(value) : null;
    } else if (line.startsWith("- Loot load overhead:")) {
      metadata.lootLoadOverheadExcluded = /excluded/i.test(line);
    }
  }

  return metadata;
}

function parseRows(lines: string[]): ParsedRow[] {
  const tableHeader = "| Target | Solve mode | Priority | Solve wall clock | Plan mission time | Plan GE cost | Solve path |";
  const tableStartIndex = lines.findIndex((line) => line.trim() === tableHeader);
  if (tableStartIndex < 0) {
    throw new Error("unable to locate benchmark result table");
  }

  const rows: ParsedRow[] = [];
  for (let index = tableStartIndex + 2; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("|")) {
      break;
    }
    if (line.startsWith("| ---")) {
      continue;
    }
    rows.push(parseTableRow(line));
  }
  if (rows.length === 0) {
    throw new Error("no benchmark rows parsed from markdown report");
  }
  return rows;
}

async function main(): Promise<void> {
  const explicitReportPathArg = process.argv[2];
  const markdownPath = explicitReportPathArg
    ? path.resolve(process.cwd(), explicitReportPathArg)
    : await findLatestMarkdownReport();

  const markdown = await fs.readFile(markdownPath, "utf8");
  const lines = markdown.split(/\r?\n/);
  const metadata = parseMetadata(lines);
  const rows = parseRows(lines);

  const basePath = markdownPath.replace(/\.md$/i, "");
  const jsonPath = `${basePath}.json`;
  const csvPath = `${basePath}.csv`;

  const payload = {
    schemaVersion: 1,
    sourceMarkdownPath: markdownPath,
    convertedAt: new Date().toISOString(),
    ...metadata,
    rows,
  };

  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(csvPath, buildCsv(rows), "utf8");

  console.log(`Converted benchmark markdown report.`);
  console.log(`Source: ${markdownPath}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV: ${csvPath}`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Conversion failed: ${message}`);
  process.exit(1);
});
