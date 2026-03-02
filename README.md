# Hens in Space (`eggincutils`)

Open-source Egg, Inc. utility suite built with Next.js.

This repo bundles multiple tools in one app:
- Mission Craft Planner
- XP + GE Craft Optimizer
- Ship Timer

## Features

- Unified web UI for multiple Egg, Inc. workflows.
- Server-side APIs for profile fetch + planning.
- Mission planner with normal/fast solve modes, rerun support, and streaming progress.
- Layered loot-data caching (memory, disk, fallback snapshot).
- Benchmark scripts for repeatable planner performance reports.

## Routes

- `/` Home
- `/mission-craft-planner`
- `/xp-ge-craft`
- `/xp-ge-craft/diagnostics`
- `/ship-timer`

## API Endpoints

- `GET /api/profile?eid=...&includeSlotted=...`
- `GET /api/inventory?eid=...&includeSlotted=...`
- `POST /api/plan`
- `POST /api/plan/stream` (NDJSON progress + result stream)
- `POST /api/plan/replan`

## Tech Stack

- Next.js 14 (App Router)
- React 18
- TypeScript
- Zod
- Vitest

## Local Development

### Prerequisites

- Node.js 20+
- npm 10+

### Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Quality Checks

```bash
npm run build
npm run test
npm run lint
```

## Environment Variables

### Profile/API behavior

- `EI_CLIENT_VERSION` (default `70`)
- `EI_APP_VERSION` (default `1.35`)
- `EI_PLATFORM` (default `IOS`)
- `EI_PLATFORM_VALUE` (default `2`)

### Loot data

- `LOOT_DATA_URL`  
  Default: `https://eggincdatacollection.azurewebsites.net/api/GetCarpetDataTrimmed?newDropsOnly`
- `LOOT_DATA_CACHE_FILE`  
  Default: `/tmp/eggincutils-loot-cache.json`
- `LOOT_DATA_FALLBACK_FILE`  
  Default: `data/loot-data-snapshot.json`
- `LOOT_DATA_CACHE_TTL_SECONDS`

### Streaming planner

- `PLAN_STREAM_HEARTBEAT_MS` (default `15000`, bounded to 5000..60000)

### Benchmark scripts

- `BENCHMARK_EID` (or pass EID as first CLI argument to archive script)

## Benchmark Workflow

```bash
# 1) Archive a live benchmark profile snapshot (EID is redacted in output)
npm run benchmark:mission-craft:archive-profile -- <EID>

# 2) Run benchmark matrix and generate reports (.md/.json/.csv)
npm run benchmark:mission-craft

# 3) Convert latest markdown report to json/csv (if needed)
npm run benchmark:mission-craft:convert-report
```

Reports are written under:
- `benchmarks/mission-craft-planner/reports/`

Benchmark metadata paths are stored repo-relative (not absolute local filesystem paths).

## Solve Input Snapshots

Mission Craft Planner can export a reproducible solve-input snapshot (inputs only) from the **Advanced: Path Comparison** header via **Download solve snapshot**.

Snapshot file includes:
- Planner request settings (`targetItemId`, `quantity`, `priorityTime`, `fastMode`)
- Source filters (inventory/drop rarity + slotted settings)
- Full profile solve state (inventory, craft counts, ship history/levels, mission options)
- Advanced compare combos (available + selected)

Replay a snapshot from CLI:

```bash
npm run mission-craft:run-snapshot -- <snapshot.json>
```

Optional flags:
- `--compare` also runs monolithic compare combos from the snapshot (uses selected combos, or falls back to available combos if none are selected)
- `--json` prints full run diagnostics JSON (environment, parsed solver-note diagnostics, progress events, plan summary, full plan, and optional compare results)
- `--out <file>` writes the same full diagnostics JSON to a file
- `--progress` / `--no-progress` force-enable or disable live solver progress lines

## Deployment

- Fly.io config: `fly.toml`
- GitHub Actions deploy workflow: `.github/workflows/fly-deploy.yml`
  - Requires repo secret: `FLY_API_TOKEN`
- Netlify config: `netlify.toml`

## Privacy and Open-Source Notes

- Benchmark profile snapshots intentionally redact EID (`"eid": "REDACTED"`).
- Do not commit personal raw profile exports or private tokens.
- Editor temp/lock files are ignored in both git and docker contexts.

## Project Structure

- `app/` Next.js routes/pages/API handlers
- `lib/` planner logic, schemas, data loaders
- `scripts/` benchmarking + report tooling
- `data/` static game/planner data
- `benchmarks/` benchmark inputs and generated reports

## Disclaimer

This is an unofficial project and is not affiliated with Auxbrain.

## License

No license file is currently included. Add a `LICENSE` before publishing if you want explicit reuse terms.
