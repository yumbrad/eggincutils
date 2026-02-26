# TODO - Unified Egg Inc Utils Handoff

This document is a full-context restart handoff for a fresh coding agent.

## 1) Project Goal

Unify three tools into one codebase (`../eggincutils`) and deprecate separate deploys:
- `../xp-ge-craft`
- `../egginc-ship-timer`
- previous static `../eggincutils` menu

Primary new feature: **Mission + Craft Planner** with inputs:
- EID
- target artifact/stone
- target quantity
- optimization slider (GE efficiency <-> time efficiency)

Must consider:
- recursive crafting tree and craft-history GE discounts
- mission drop probabilities from Menno dataset
- ship availability + star level + epic research (FTL and Zero-G)
- 3 mission slots
- rarity agnostic planning (shinies effectively fungible for planning; fuel is out of scope)

## 2) Repos Available to Agent

Sandbox/session is expected to run from `../eggincutils` and can read sibling repos:
- `../xp-ge-craft` (existing inventory parser, recipes, discount logic, HiGHS history)
- `../egginc-ship-timer` (existing ship timer UX/data references)
- `../egg` (carpetsage monorepo with authoritative ship mission config + Menno drop data references)

Key external/source context confirmed:
- Menno credit in carpetsage: `../egg/wasmegg/artifact-explorer/src/components/LootDataCredit.vue`
- Menno drop endpoint in carpetsage updater: `../egg/wasmegg/artifact-explorer/update-loot-data.sh`
  - `https://eggincdatacollection.azurewebsites.net/api/GetCarpetDataTrimmed?newDropsOnly`

## 3) What Was Already Implemented (Current State)

### 3.1 App scaffold
`../eggincutils` converted to Next.js (App Router, TS):
- `package.json`
- `next.config.js`
- `next-env.d.ts`
- `tsconfig.json`
- `app/layout.tsx`
- `app/globals.css`
- `app/page.tsx` (new menu)
- `netlify.toml` switched to Next plugin build
- old static `index.html` removed

### 3.2 Data imported into `../eggincutils/data`
Copied from sibling repos:
- `data/ei.proto` (from `xp-ge-craft`)
- `data/recipes.json` (from `xp-ge-craft`)
- `data/artifact-display.json` (from `xp-ge-craft`)
- `data/names.json` (from `xp-ge-craft`)
- `data/eiafx-config.json` (from carpetsage `../egg/wasmegg/_common/eiafx/eiafx-config.json`)

### 3.3 Shared libs added
- `lib/recipes.ts`
- `lib/item-utils.ts`
- `lib/ship-data.ts`
- `lib/loot-data.ts`
- `lib/profile.ts`
- `lib/planner.ts`

### 3.4 APIs added
- `app/api/profile/route.ts`
  - returns parsed profile by EID (inventory, craft counts, mission-derived ship levels, epic research)
- `app/api/plan/route.ts`
  - input: `{eid,targetItemId,quantity,priorityTime,includeSlotted}`
  - output: profile summary + computed mission/craft plan

### 3.5 New planner UI
- `app/mission-craft-planner/page.tsx`
  - input form for EID/target/qty/slider/includeSlotted
  - calls `/api/plan`
  - renders plan KPIs + craft rows + mission rows + ship progression snapshot + notes

### 3.6 Migration placeholders
- `app/xp-ge-craft/page.tsx`
- `app/ship-timer/page.tsx`

### 3.7 Build status
Validated in `../eggincutils`:
- `npm install` succeeded
- `npm run build` succeeded (Next 14)

## 4) Current Planner Behavior (Important)

Planner in `lib/planner.ts` is a **first vertical slice**, not final optimizer:

1. Build recursive closure of target recipe ingredients.
2. Load mission actions from Menno dataset (`lib/loot-data.ts`) for currently available mission options.
3. For each required item, choose between:
   - crafting now (with craft-history discount), or
   - deferring demand to mission farming, based on weighted score using slider.
4. Allocate missions greedily over unmet demand using best coverage-per-second.
5. Convert slot time using 3-slot assumption: `expectedHours = totalSlotSeconds / 3 / 3600`.

This is expected-value + greedy allocation. It is intentionally rerunnable after each return.

## 5) Key Assumptions/Decisions Locked In

- Fuel constraints are **out of scope for now**.
- Rarity is treated as **agnostic/fungible for planning**.
- 3 mission slots are explicitly modeled in time aggregation.
- Version drift strategy:
  - profile parser tries version candidates in `lib/profile.ts`:
    - env-driven latest (`EI_CLIENT_VERSION` etc)
    - fallback older values (68/1.28.0 Android)
- Menno drop dataset loaded from endpoint by default; can be overridden by `LOOT_DATA_URL`.

## 6) Remaining Work (Prioritized)

## Phase A - Hardening current vertical slice
1. Validate `/api/profile` against multiple real EIDs; fix enum parsing edge cases if needed.
2. Improve planner UI item naming/icons (currently mostly item IDs in result tables).
3. Add robust error surface for empty/invalid loot data and no-coverage missions.
4. Add API schema validation (e.g. zod) for `/api/plan` and `/api/profile` responses.
5. Add tests for `lib/ship-data.ts`, `lib/profile.ts`, `lib/planner.ts`.

### Phase A status (updated 2026-02-24)
- [x] 1. Real-EID validation pass completed using redacted test EIDs.
- [x] 2. Planner tables now render item display names and icon URLs instead of raw IDs.
- [x] 3. Loot-data schema/empty checks added; planner no-coverage now returns explicit 422 errors.
- [x] 4. Zod request/response validation added to `/api/plan` and `/api/profile`.
- [x] 5. Vitest suite added for `ship-data`, `profile` parsing helpers, and planner coverage/helpers.

## Phase B - Algorithm upgrade
1. Replace greedy mission allocation with formal optimizer core:
   - HiGHS/MILP preferred for mission mix + craft decisions.
2. Include horizon decisions where mission launches can raise star levels and unlock better mission options.
3. Model slider as weighted objective with normalized GE/time terms.
4. Add rolling-horizon mode / replanning endpoint from current observed returns.

### Phase B status (updated 2026-02-25)
- [x] 1. Craft + mission allocation now runs in a unified HiGHS model with exact craft-discount scheduling (plus heuristic fallback path for solver/runtime failures).
- [x] 2. Added bounded horizon/star-progression search that can insert prep launches to unlock/level ships before final mission allocation.
- [x] 3. Added slider-aware normalized objective references in solver planning (now using statistically expected mission yields only).
- [x] 4. Added `/api/plan/replan` endpoint that replans from a supplied profile snapshot plus observed returns/mission-launch updates.

## Phase C - Integrate old tools fully
1. Port `../xp-ge-craft` UI/features into `/xp-ge-craft` route in this repo.
2. Port `../egginc-ship-timer` UI/features into `/ship-timer` route in this repo.
3. Remove external links and make all utilities native in one deploy.

### Phase C status (updated 2026-02-25)
- [x] 1. Ported XP/GE optimizer into native `/xp-ge-craft` route with solver-backed client UI and native `/api/inventory`.
- [x] 2. Ported ship timer into native `/ship-timer` route with launch/FTL/sleep controls, grouped/flat views, sorting, and shareable URL state.
- [x] 3. Removed migration-style external-link dependency on both utility routes.

## Phase D - UX quality
1. Add ship + artifact images in planner results.
2. Better mission recommendation presentation (timeline/gantt style for 3 slots).
3. Add copyable/shareable plan state in URL.

### Phase D status (updated 2026-02-25)
- [ ] 1. Add ship + artifact images in planner results.
- [x] 2. Added a 3-slot timeline/gantt-style mission visualization with lane balancing, per-block details, and prep-only workload visibility.
- [ ] 3. Add copyable/shareable plan state in URL.

## 7) Technical Notes for Fresh Agent

### 7.1 Where to start coding next
Suggested first task on restart:
- Add unit tests + deterministic fixtures around planner/profile parsing before algorithm changes.

### 7.2 Critical files map
- Entry/menu: `app/page.tsx`
- Planner page: `app/mission-craft-planner/page.tsx`
- Plan API: `app/api/plan/route.ts`
- Profile API: `app/api/profile/route.ts`
- Planner core: `lib/planner.ts`
- EID parsing: `lib/profile.ts`
- Ship unlock/level/options: `lib/ship-data.ts`
- Loot loader: `lib/loot-data.ts`
- Recipes/item helpers: `lib/recipes.ts`, `lib/item-utils.ts`

### 7.3 Build/dev commands
From `../eggincutils`:
- `npm install`
- `npm run dev`
- `npm run build`

### 7.4 Environment variables
Optional vars currently supported:
- `LOOT_DATA_URL`
- `EI_CLIENT_VERSION`
- `EI_APP_VERSION`
- `EI_PLATFORM`
- `EI_PLATFORM_VALUE`

### 7.5 Known caveats
- `node_modules` and `.next` exist locally from prior build.
- Planner mission table currently displays raw `targetAfxId` for targets; no target-name mapping yet.
- Craft plan currently shows `itemId` strings; can be upgraded with `artifact-display.json` mapping.
- No persistence layer yet (no saved EIDs/plans).

## 8) Suggested Next Session Execution Checklist

1. Run `npm run build` to confirm baseline clean state.
2. Hit `/mission-craft-planner` with a known EID and verify profile load + plan response.
3. Add automated tests for profile parsing and ship level calculations.
4. Upgrade mission allocation from greedy to solver-backed.
5. Start porting `/xp-ge-craft` route content from sibling repo.
6. Start porting `/ship-timer` route content from sibling repo.

## 9) Definition of Done for Unified v1

- One production deploy from `../eggincutils` hosting all three tools.
- Planner handles EID profile + target/qty + slider reliably.
- 3-slot planning shown clearly.
- XP-GE tool parity migrated.
- Ship-timer tool parity migrated.
- Basic test coverage and reproducible build.

---

Post handoff plan miscellaneous TODOs:
1. Change (parenthesis) text in item dropdown change to (T1) or (T3) etc instead of (Fragment) or (Complex)... Also, change "henerprise-short" style text underneath Ship name to just "Short" "Extended" etc. Also remove "target id: xx" under target name
2. Local storage or cookie based saving of last selected options (and EID, shared across tools)
3. "techyum's eggy tools" ... "🥚 Egg Inc. C2C (chicken-to-consumer) Premium Suite™ with Dilithium Enterprise Resource Planning (DERP™)" (replace title and subtitle above title, respectively) ... plus, try making subtitle above title #ff1279 color in both light/dark modes (but keep or add ability to change per mode in case one needs tweaking)
