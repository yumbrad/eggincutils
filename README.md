# eggincutils

Unified Egg, Inc. utility app (Next.js).

## Routes

- `/` menu
- `/mission-craft-planner` new planner (EID + target + quantity + GE/time slider)
- `/xp-ge-craft` migration placeholder
- `/ship-timer` migration placeholder

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
- `EI_CLIENT_VERSION`
- `EI_APP_VERSION`
- `EI_PLATFORM`
- `EI_PLATFORM_VALUE`

## Current Planner Model

The planner combines recursive crafting (with craft-count GE discounts) and expected mission drops, with a 3-slot mission-time model.
It is an initial greedy/expected-value model and should be rerun after returns.
