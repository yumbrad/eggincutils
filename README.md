# eggincutils

Unified Egg, Inc. utility app (Next.js).

## Routes

- `/` menu
- `/mission-craft-planner` new planner (EID + target + quantity + GE/time slider)
- `/xp-ge-craft` native XP + GE craft optimizer
- `/xp-ge-craft/diagnostics` inventory/API diagnostics for the optimizer
- `/ship-timer` native ship return planner

## Development

```bash
npm install
npm run dev
npm run test
```

## Planner Data Sources

- Recipes and item metadata are vendored from `xp-ge-craft`.
- Ship mission parameters are vendored from carpetsage `eiafx-config`.
- Drop data loads from Menno backend by default:
  - `https://eggincdatacollection.azurewebsites.net/api/GetCarpetDataTrimmed?newDropsOnly`

You can override with:

- `LOOT_DATA_URL`
- `LOOT_DATA_CACHE_FILE`
- `LOOT_DATA_FALLBACK_FILE`
- `LOOT_DATA_CACHE_TTL_SECONDS`
- `EI_CLIENT_VERSION`
- `EI_APP_VERSION`
- `EI_PLATFORM`
- `EI_PLATFORM_VALUE`

Loot data loading now uses layered caching:

- In-memory process cache
- Disk cache file (`LOOT_DATA_CACHE_FILE`, default `/tmp/eggincutils-loot-cache.json`)
- Optional vendored fallback snapshot (`LOOT_DATA_FALLBACK_FILE`, default `data/loot-data-snapshot.json`)

If the disk/fallback cache is stale, stale data is served immediately and a background refresh is attempted.

## Current Planner Model

The planner combines recursive crafting (with craft-count GE discounts) and expected mission drops, with a 3-slot mission-time model.
It is an initial greedy/expected-value model and should be rerun after returns.

## Replanning Endpoint

Use `POST /api/plan/replan` to replan from a current snapshot without re-fetching from EID.

Request body fields:

- `profile`: full profile object (same shape as `/api/profile` response payload)
- `targetItemId`, `quantity`, `priorityTime`
- `observedReturns`: optional item drops to add to inventory (`[{ itemId, quantity }]`)
- `missionLaunches`: optional launches completed since snapshot (`[{ ship, durationType, launches }]`)
