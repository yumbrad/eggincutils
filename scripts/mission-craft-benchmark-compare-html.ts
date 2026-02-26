import fs from "fs/promises";
import path from "path";

type MetricId = "wallMs" | "expectedHours" | "geCost";

type SerializableRow = {
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

type BenchmarkJson = {
  schemaVersion: number;
  generatedAt: string;
  branch: string;
  commitShort: string;
  rows: SerializableRow[];
};

type Scenario = {
  key: string;
  targetLabel: string;
  solveModeLabel: string;
  priorityLabel: string;
  priorityTime: number;
  rowsByBranch: Record<string, SerializableRow>;
};

type NormalFastPair = {
  key: string;
  targetLabel: string;
  priorityLabel: string;
  rowsByBranch: Record<
    string,
    {
      normal: SerializableRow;
      fast: SerializableRow;
    }
  >;
};

type MetricDef = {
  id: MetricId;
  label: string;
  shortLabel: string;
  format: (value: number) => string;
};

const REPORTS_DIR = path.join(process.cwd(), "benchmarks", "mission-craft-planner", "reports");
const BASELINE_BRANCH = "main";
const BRANCH_ORDER = [BASELINE_BRANCH, "gemini-3-optimized", "claude-optimized", "codex-53-xhigh-optimized"] as const;
const BRANCH_LABELS: Record<string, string> = {
  main: "main (baseline)",
  "gemini-3-optimized": "gemini-3-optimized",
  "claude-optimized": "claude-optimized",
  "codex-53-xhigh-optimized": "codex-53-xhigh-optimized",
};
const BRANCH_COLORS: Record<string, string> = {
  main: "#475569",
  "gemini-3-optimized": "#1d4ed8",
  "claude-optimized": "#047857",
  "codex-53-xhigh-optimized": "#9333ea",
};

const METRICS: MetricDef[] = [
  {
    id: "wallMs",
    label: "Solver wall clock time",
    shortLabel: "Solve time",
    format: (value) => `${Math.round(value).toLocaleString()} ms`,
  },
  {
    id: "expectedHours",
    label: "Planned mission time",
    shortLabel: "Mission time",
    format: (value) => `${value.toFixed(2)} h`,
  },
  {
    id: "geCost",
    label: "Planned GE cost",
    shortLabel: "GE cost",
    format: (value) => `${Math.round(value).toLocaleString()} GE`,
  },
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function lerp(start: number, end: number, t: number): number {
  return Math.round(start + (end - start) * t);
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function formatDeltaPercent(deltaPercent: number): string {
  if (!Number.isFinite(deltaPercent)) {
    return deltaPercent > 0 ? "+inf%" : "-inf%";
  }
  const signed = deltaPercent > 0 ? `+${deltaPercent.toFixed(1)}%` : `${deltaPercent.toFixed(1)}%`;
  return signed;
}

function computeDeltaPercent(baseline: number, candidate: number): number {
  if (baseline === 0) {
    if (candidate === 0) {
      return 0;
    }
    return Number.POSITIVE_INFINITY;
  }
  return ((candidate - baseline) / baseline) * 100;
}

function colorForDelta(deltaPercent: number): { background: string; text: string } {
  if (!Number.isFinite(deltaPercent)) {
    return {
      background: "#7f1d1d",
      text: "#fef2f2",
    };
  }

  const magnitude = Math.abs(deltaPercent);
  if (magnitude < 2) {
    return {
      background: "#f8fafc",
      text: "#334155",
    };
  }

  const clamped = Math.min(50, magnitude);
  const t = (clamped - 2) / 48;

  if (deltaPercent < 0) {
    const r = lerp(220, 20, t);
    const g = lerp(252, 83, t);
    const b = lerp(231, 45, t);
    return {
      background: rgbToHex(r, g, b),
      text: t > 0.62 ? "#f0fdf4" : "#14532d",
    };
  }

  const r = lerp(254, 153, t);
  const g = lerp(226, 27, t);
  const b = lerp(226, 27, t);
  return {
    background: rgbToHex(r, g, b),
    text: t > 0.55 ? "#fef2f2" : "#7f1d1d",
  };
}

function slugToPrefix(branch: string): string {
  return `benchmark-${branch}-`;
}

function scenarioKey(row: SerializableRow): string {
  return `${row.targetItemId}|${row.fastMode ? "fast" : "normal"}|${row.priorityTime}`;
}

function normalFastKey(row: SerializableRow): string {
  return `${row.targetItemId}|${row.priorityTime}`;
}

async function findLatestReportJsonPath(branch: string): Promise<string> {
  const files = await fs.readdir(REPORTS_DIR);
  const prefix = slugToPrefix(branch);
  const matching = files.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"));
  if (matching.length === 0) {
    throw new Error(`No JSON reports found for branch '${branch}' in ${REPORTS_DIR}`);
  }
  const withStats = await Promise.all(
    matching.map(async (entry) => {
      const fullPath = path.join(REPORTS_DIR, entry);
      const stat = await fs.stat(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0].fullPath;
}

async function loadBenchmarkJson(reportPath: string): Promise<BenchmarkJson> {
  const raw = await fs.readFile(reportPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<BenchmarkJson>;
  if (!parsed || !Array.isArray(parsed.rows)) {
    throw new Error(`Invalid benchmark report payload: ${reportPath}`);
  }
  if (!parsed.branch || !parsed.commitShort) {
    throw new Error(`Missing branch metadata in report: ${reportPath}`);
  }
  return {
    schemaVersion: parsed.schemaVersion ?? 0,
    generatedAt: parsed.generatedAt ?? "",
    branch: parsed.branch,
    commitShort: parsed.commitShort,
    rows: parsed.rows as SerializableRow[],
  };
}

function metricValue(row: SerializableRow, metricId: MetricId): number {
  if (metricId === "wallMs") {
    return row.wallMs;
  }
  if (metricId === "expectedHours") {
    return row.expectedHours;
  }
  return row.geCost;
}

function branchLabel(branch: string): string {
  return BRANCH_LABELS[branch] ?? branch;
}

function buildScenarioList(reportsByBranch: Map<string, BenchmarkJson>): Scenario[] {
  const baselineReport = reportsByBranch.get(BASELINE_BRANCH);
  if (!baselineReport) {
    throw new Error(`Missing baseline report for branch '${BASELINE_BRANCH}'`);
  }

  const rowMapsByBranch = new Map<string, Map<string, SerializableRow>>();
  for (const branch of BRANCH_ORDER) {
    const report = reportsByBranch.get(branch);
    if (!report) {
      throw new Error(`Missing report for branch '${branch}'`);
    }
    const map = new Map<string, SerializableRow>();
    for (const row of report.rows) {
      map.set(scenarioKey(row), row);
    }
    rowMapsByBranch.set(branch, map);
  }

  return baselineReport.rows.map((baselineRow) => {
    const key = scenarioKey(baselineRow);
    const rowsByBranch: Record<string, SerializableRow> = {};
    for (const branch of BRANCH_ORDER) {
      const map = rowMapsByBranch.get(branch);
      const row = map?.get(key);
      if (!row) {
        throw new Error(`Branch '${branch}' is missing scenario '${key}'`);
      }
      rowsByBranch[branch] = row;
    }
    return {
      key,
      targetLabel: baselineRow.targetLabel,
      solveModeLabel: baselineRow.fastMode ? "Fast" : "Normal",
      priorityLabel: baselineRow.priorityLabel,
      priorityTime: baselineRow.priorityTime,
      rowsByBranch,
    };
  });
}

function buildNormalFastPairs(reportsByBranch: Map<string, BenchmarkJson>): NormalFastPair[] {
  const baselineReport = reportsByBranch.get(BASELINE_BRANCH);
  if (!baselineReport) {
    throw new Error(`Missing baseline report for branch '${BASELINE_BRANCH}'`);
  }

  const priorityPairs = baselineReport.rows.filter((row) => !row.fastMode);
  const pairs: NormalFastPair[] = [];

  for (const normalBaselineRow of priorityPairs) {
    const key = normalFastKey(normalBaselineRow);
    const rowsByBranch: NormalFastPair["rowsByBranch"] = {};
    for (const branch of BRANCH_ORDER) {
      const report = reportsByBranch.get(branch);
      if (!report) {
        throw new Error(`Missing report for branch '${branch}'`);
      }
      const normal = report.rows.find((row) => row.targetItemId === normalBaselineRow.targetItemId && !row.fastMode && row.priorityTime === normalBaselineRow.priorityTime);
      const fast = report.rows.find((row) => row.targetItemId === normalBaselineRow.targetItemId && row.fastMode && row.priorityTime === normalBaselineRow.priorityTime);
      if (!normal || !fast) {
        throw new Error(`Missing normal/fast pair for branch '${branch}' scenario '${key}'`);
      }
      rowsByBranch[branch] = { normal, fast };
    }

    pairs.push({
      key,
      targetLabel: normalBaselineRow.targetLabel,
      priorityLabel: normalBaselineRow.priorityLabel,
      rowsByBranch,
    });
  }

  return pairs;
}

function buildSourceListHtml(sourcePaths: Record<string, string>, reportsByBranch: Map<string, BenchmarkJson>): string {
  const lines = BRANCH_ORDER.map((branch) => {
    const sourcePath = sourcePaths[branch];
    const report = reportsByBranch.get(branch);
    const commit = report?.commitShort ?? "unknown";
    return `<li><strong>${escapeHtml(branchLabel(branch))}</strong>: <code>${escapeHtml(path.basename(sourcePath))}</code> (commit <code>${escapeHtml(commit)}</code>)</li>`;
  });
  return `<ul>${lines.join("")}</ul>`;
}

function buildLegendHtml(): string {
  return `
  <div class="legend-grid">
    <div class="legend-item"><span class="swatch" style="background:#f8fafc;"></span><span>&lt; 2% change (neutral)</span></div>
    <div class="legend-item"><span class="swatch" style="background:#dcfce7;"></span><span>~2% improvement</span></div>
    <div class="legend-item"><span class="swatch" style="background:#f15b2d;color:#fff;"></span><span>~50% regression (max dark)</span></div>
    <div class="legend-item"><span class="swatch" style="background:#14532d;color:#fff;"></span><span>~50% improvement (max dark)</span></div>
    <div class="legend-item"><span class="swatch" style="background:#fee2e2;"></span><span>~2% regression</span></div>
  </div>`;
}

function buildScenarioMetricTable(metric: MetricDef, scenarios: Scenario[]): string {
  const headerBranches = BRANCH_ORDER.map((branch) => `<th>${escapeHtml(branchLabel(branch))}</th>`).join("");
  const rows = scenarios
    .map((scenario) => {
      const baselineValue = metricValue(scenario.rowsByBranch[BASELINE_BRANCH], metric.id);
      const branchCells = BRANCH_ORDER.map((branch) => {
        const value = metricValue(scenario.rowsByBranch[branch], metric.id);
        if (branch === BASELINE_BRANCH) {
          return `<td class="baseline-cell"><div class="metric-value">${escapeHtml(metric.format(value))}</div><div class="delta-note">baseline</div></td>`;
        }
        const delta = computeDeltaPercent(baselineValue, value);
        const color = colorForDelta(delta);
        return `<td style="background:${color.background};color:${color.text};"><div class="metric-value">${escapeHtml(
          metric.format(value)
        )}</div><div class="delta-note">${escapeHtml(formatDeltaPercent(delta))}</div></td>`;
      }).join("");
      return `<tr><td>${escapeHtml(scenario.targetLabel)}</td><td>${escapeHtml(scenario.solveModeLabel)}</td><td>${escapeHtml(
        scenario.priorityLabel
      )}</td>${branchCells}</tr>`;
    })
    .join("");

  return `
  <section>
    <h2>${escapeHtml(metric.label)} Matrix</h2>
    <table>
      <thead>
        <tr>
          <th>Artifact</th>
          <th>Mode</th>
          <th>Priority</th>
          ${headerBranches}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function buildFastVsNormalTable(metric: MetricDef, pairs: NormalFastPair[]): string {
  const headerBranches = BRANCH_ORDER.map((branch) => `<th>${escapeHtml(branchLabel(branch))}</th>`).join("");
  const rows = pairs
    .map((pair) => {
      const branchCells = BRANCH_ORDER.map((branch) => {
        const pairRows = pair.rowsByBranch[branch];
        const normalValue = metricValue(pairRows.normal, metric.id);
        const fastValue = metricValue(pairRows.fast, metric.id);
        const delta = computeDeltaPercent(normalValue, fastValue);
        const color = colorForDelta(delta);
        return `<td style="background:${color.background};color:${color.text};"><div class="metric-value">${escapeHtml(
          metric.format(fastValue)
        )}</div><div class="delta-note">vs normal ${escapeHtml(formatDeltaPercent(delta))}</div></td>`;
      }).join("");
      return `<tr><td>${escapeHtml(pair.targetLabel)}</td><td>${escapeHtml(pair.priorityLabel)}</td>${branchCells}</tr>`;
    })
    .join("");

  return `
  <section>
    <h2>Fast vs Normal: ${escapeHtml(metric.shortLabel)}</h2>
    <table>
      <thead>
        <tr>
          <th>Artifact</th>
          <th>Priority</th>
          ${headerBranches}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function buildTotalsByBranch(scenarios: Scenario[], metricId: MetricId): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const branch of BRANCH_ORDER) {
    totals[branch] = scenarios.reduce((sum, scenario) => sum + metricValue(scenario.rowsByBranch[branch], metricId), 0);
  }
  return totals;
}

function buildTotalWallChart(scenarios: Scenario[]): string {
  const totals = buildTotalsByBranch(scenarios, "wallMs");
  const maxValue = Math.max(...BRANCH_ORDER.map((branch) => totals[branch]));
  const baselineTotal = totals[BASELINE_BRANCH];

  const rows = BRANCH_ORDER.map((branch) => {
    const value = totals[branch];
    const widthPercent = maxValue === 0 ? 0 : (value / maxValue) * 100;
    const delta = branch === BASELINE_BRANCH ? 0 : computeDeltaPercent(baselineTotal, value);
    const deltaText = branch === BASELINE_BRANCH ? "baseline" : formatDeltaPercent(delta);
    return `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(branchLabel(branch))}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${widthPercent.toFixed(2)}%;background:${BRANCH_COLORS[branch]};"></div>
        </div>
        <div class="bar-value">${escapeHtml(`${Math.round(value).toLocaleString()} ms`)} <span class="delta-inline">(${escapeHtml(
          deltaText
        )})</span></div>
      </div>
    `;
  }).join("");

  return `
  <section>
    <h2>Total Solver Wall Time (All 18 Scenarios)</h2>
    <div class="bar-chart">${rows}</div>
  </section>`;
}

function buildAverageDeltaSummary(scenarios: Scenario[]): string {
  const rows = METRICS.map((metric) => {
    const candidateCells = BRANCH_ORDER.map((branch) => {
      if (branch === BASELINE_BRANCH) {
        return `<td class="baseline-cell"><div class="metric-value">0.0%</div><div class="delta-note">baseline</div></td>`;
      }
      const deltas = scenarios.map((scenario) => {
        const baseline = metricValue(scenario.rowsByBranch[BASELINE_BRANCH], metric.id);
        const candidate = metricValue(scenario.rowsByBranch[branch], metric.id);
        return computeDeltaPercent(baseline, candidate);
      });
      const finiteDeltas = deltas.filter((value) => Number.isFinite(value));
      const average = finiteDeltas.length > 0 ? finiteDeltas.reduce((sum, value) => sum + value, 0) / finiteDeltas.length : 0;
      const color = colorForDelta(average);
      return `<td style="background:${color.background};color:${color.text};"><div class="metric-value">${escapeHtml(
        formatDeltaPercent(average)
      )}</div><div class="delta-note">avg vs baseline</div></td>`;
    }).join("");
    return `<tr><td>${escapeHtml(metric.label)}</td>${candidateCells}</tr>`;
  }).join("");

  const headerBranches = BRANCH_ORDER.map((branch) => `<th>${escapeHtml(branchLabel(branch))}</th>`).join("");

  return `
  <section>
    <h2>Average Delta vs Baseline</h2>
    <table>
      <thead>
        <tr>
          <th>Metric</th>
          ${headerBranches}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function buildFastNormalAveragesChart(pairs: NormalFastPair[]): string {
  const rows = BRANCH_ORDER.map((branch) => {
    const byMetric = METRICS.map((metric) => {
      const ratios = pairs.map((pair) => {
        const normal = metricValue(pair.rowsByBranch[branch].normal, metric.id);
        const fast = metricValue(pair.rowsByBranch[branch].fast, metric.id);
        if (normal === 0) {
          return 1;
        }
        return fast / normal;
      });
      const averageRatio = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
      return {
        metric,
        ratio: averageRatio,
      };
    });
    return { branch, byMetric };
  });

  const cards = rows
    .map(({ branch, byMetric }) => {
      const metricBars = byMetric
        .map(({ metric, ratio }) => {
          const ratioPercent = ratio * 100;
          const clampedWidth = Math.min(180, Math.max(20, ratioPercent));
          const delta = (ratio - 1) * 100;
          const color = colorForDelta(delta);
          return `
            <div class="ratio-row">
              <div class="ratio-label">${escapeHtml(metric.shortLabel)}</div>
              <div class="ratio-track">
                <div class="ratio-fill" style="width:${clampedWidth.toFixed(1)}px;background:${color.background};border-color:${color.text};"></div>
                <div class="ratio-marker"></div>
              </div>
              <div class="ratio-value">${ratioPercent.toFixed(1)}%</div>
            </div>
          `;
        })
        .join("");
      return `
        <div class="ratio-card">
          <h3>${escapeHtml(branchLabel(branch))}</h3>
          ${metricBars}
        </div>
      `;
    })
    .join("");

  return `
  <section>
    <h2>Fast vs Normal Averages (9 Scenario Pairs per Branch)</h2>
    <p class="note">100% means fast mode matches normal mode. Lower than 100% means fast mode reduced the metric.</p>
    <div class="ratio-grid">${cards}</div>
  </section>`;
}

function generateTimestampTag(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}Z`;
}

function buildHtml(params: {
  generatedAtIso: string;
  sourcePaths: Record<string, string>;
  reportsByBranch: Map<string, BenchmarkJson>;
  scenarios: Scenario[];
  pairs: NormalFastPair[];
}): string {
  const { generatedAtIso, sourcePaths, reportsByBranch, scenarios, pairs } = params;
  const metricMatrices = METRICS.map((metric) => buildScenarioMetricTable(metric, scenarios)).join("\n");
  const fastVsNormalMatrices = METRICS.map((metric) => buildFastVsNormalTable(metric, pairs)).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mission Craft Planner Benchmark Comparison</title>
  <style>
    :root {
      --bg: #f8fafc;
      --panel: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --border: #dbe2ea;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      background: radial-gradient(circle at top left, #eef2ff, #f8fafc 45%);
      color: var(--text);
      line-height: 1.35;
    }
    main {
      max-width: 1700px;
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      overflow-x: auto;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    h1, h2, h3 {
      margin: 0 0 10px 0;
      line-height: 1.2;
    }
    h1 { font-size: 1.6rem; }
    h2 { font-size: 1.15rem; }
    h3 { font-size: 1rem; }
    p, li { color: var(--muted); }
    code {
      font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace;
      font-size: 0.92em;
      color: #1d4ed8;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 10px;
      vertical-align: top;
      text-align: left;
      font-size: 0.88rem;
    }
    th {
      background: #eef2f7;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .metric-value {
      font-weight: 600;
      color: inherit;
      white-space: nowrap;
    }
    .delta-note {
      font-size: 0.76rem;
      opacity: 0.9;
      margin-top: 3px;
      white-space: nowrap;
    }
    .baseline-cell {
      background: #f1f5f9;
      color: #334155;
    }
    .legend-grid {
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: #334155;
      font-size: 0.86rem;
    }
    .swatch {
      width: 18px;
      height: 18px;
      border-radius: 5px;
      border: 1px solid #cbd5e1;
      display: inline-block;
    }
    .bar-chart {
      display: grid;
      gap: 8px;
    }
    .bar-row {
      display: grid;
      grid-template-columns: 260px 1fr 260px;
      align-items: center;
      gap: 10px;
    }
    .bar-label { font-weight: 600; font-size: 0.9rem; }
    .bar-track {
      background: #e2e8f0;
      border-radius: 999px;
      height: 12px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 999px;
    }
    .bar-value {
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-size: 0.86rem;
      color: #0f172a;
    }
    .delta-inline {
      color: #475569;
      font-size: 0.8rem;
    }
    .ratio-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }
    .ratio-card {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      background: #f8fafc;
    }
    .ratio-row {
      display: grid;
      grid-template-columns: 88px 1fr 54px;
      gap: 8px;
      align-items: center;
      margin: 7px 0;
    }
    .ratio-label {
      font-size: 0.78rem;
      color: #334155;
      font-weight: 600;
    }
    .ratio-track {
      position: relative;
      height: 12px;
      border-radius: 999px;
      background: #e2e8f0;
      overflow: hidden;
      border: 1px solid #cbd5e1;
    }
    .ratio-fill {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      border-right: 1px solid transparent;
    }
    .ratio-marker {
      position: absolute;
      top: -1px;
      bottom: -1px;
      left: 99px;
      width: 2px;
      background: #475569;
      opacity: 0.6;
    }
    .ratio-value {
      font-size: 0.78rem;
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: #0f172a;
    }
    .note {
      margin-top: 0;
      margin-bottom: 10px;
      font-size: 0.87rem;
    }
    @media (max-width: 1024px) {
      body { padding: 12px; }
      .bar-row { grid-template-columns: 180px 1fr 140px; }
    }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Mission Craft Planner Benchmark Comparison</h1>
      <p>Generated at <code>${escapeHtml(generatedAtIso)}</code>. Baseline is <code>main</code>. Cell colors use absolute deltas vs baseline: neutral under 2%, ramping to darkest at 50%+.</p>
      ${buildLegendHtml()}
      <h3>Source reports</h3>
      ${buildSourceListHtml(sourcePaths, reportsByBranch)}
    </section>

    ${buildTotalWallChart(scenarios)}
    ${buildAverageDeltaSummary(scenarios)}
    ${buildFastNormalAveragesChart(pairs)}

    ${metricMatrices}

    ${fastVsNormalMatrices}
  </main>
</body>
</html>`;
}

async function main(): Promise<void> {
  const sourcePaths: Record<string, string> = {};
  const reportsByBranch = new Map<string, BenchmarkJson>();

  for (const branch of BRANCH_ORDER) {
    const reportPath = await findLatestReportJsonPath(branch);
    const report = await loadBenchmarkJson(reportPath);
    sourcePaths[branch] = reportPath;
    reportsByBranch.set(branch, report);
  }

  const scenarios = buildScenarioList(reportsByBranch);
  const normalFastPairs = buildNormalFastPairs(reportsByBranch);

  const generatedAt = new Date();
  const html = buildHtml({
    generatedAtIso: generatedAt.toISOString(),
    sourcePaths,
    reportsByBranch,
    scenarios,
    pairs: normalFastPairs,
  });

  const outputPath = path.join(REPORTS_DIR, `benchmark-comparison-${generateTimestampTag(generatedAt)}.html`);
  await fs.writeFile(outputPath, html, "utf8");

  console.log(`Generated benchmark comparison report.`);
  console.log(`Output: ${outputPath}`);
  for (const branch of BRANCH_ORDER) {
    console.log(`${branch}: ${sourcePaths[branch]}`);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Failed to generate benchmark comparison report: ${message}`);
  process.exit(1);
});
