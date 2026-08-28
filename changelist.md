**Changelist**

- Various bug fixes

**Craft XP / XP-GE Planner**

- Added **Include as ingredients** controls with separate toggles for **Slotted stones** and **Stone
fragments**.
  - Stone fragments can now be excluded from XP craft planning.
  - Preferences persist.

- Added crafting XP/level summaries to the planner tables.
  - Shows **Current** and **Post plan** crafting level + total XP.
  - Includes a progress bar to the next level.
  - Added zoom controls to switch between current-level progress and full Level 1-30 progress.
  - Crafting XP is now read from the player profile/EID data.

- Reworked the **Max-XP Craft Order** table.
  - **Tree view**: unindented rows are manual crafts; indented rows are actual auto-crafts.
  - **Flat view**: one row per crafted artifact, useful for sorting and analysis.
  - Flat view headers are sortable by artifact, tier, manual crafts, auto crafts, XP, GE cost, net
remaining, and used-by.

- Fixed the “promotion” issue in Max-XP craft plans.
  - If you already own intermediate artifacts, the plan now still schedules any remaining optimal manual
crafts instead of hiding them as if they would auto-craft under a parent.
  - This fixes cases like already-owned T3 deflectors causing the displayed manual plan to under-deliver
XP.

- Added **Max crafts** limits to Max-XP plans.
  - Available in Tree and Flat views.
  - Blank means unlimited.
  - `0` prevents that artifact from being crafted at all, including as an auto-crafted ingredient for
parent crafts.

- Added better ingredient visibility.
  - Hover craft/count values to see starting inventory, inventory consumed, used-by, and consumes details.
  - Artifact names now show crafting recipe tooltips where applicable.
  - Added an **Ingredients consumed from inventory by this plan** section for base/un craftable
ingredients.

- Improved Standalone Craft Options.
  - Moved into a collapsible drawer.
  - Open/closed state persists.
  - The post-plan XP box reflects the **Max GE Efficiency Plan** for the standalone table.

**Artifact Attainment / Mission Craft Planner**

- Added **craft-count goals** to the Goals card.
  - Each target row has a mode chip: **copies** (how many more to end up with, the old behaviour) or
**craft count** (an all-time craft-count goal, e.g. the 300 that maxes an artifact's crafting discount).
  - The plan crafts the difference from the count already on your save, so the same goal works from any
device without checking your craft count by hand.
  - Copies a higher tier consumes still count toward the goal, so chasing 300 T3 crafts while also
building T4s does not over-craft.
  - The row shows how many you have crafted so far; the craft table and plan notes show the goal, the
count before the plan, and the count after it.
  - Only tiers that can be crafted offer the chip; mission drops never count, since they do not raise a
craft count.

- Added **Fragments** as a separate ingredient/source category next to R / E / L / Slotted.
  - Inventory stone fragments can be included/excluded.
  - Dropped stone fragments can be included/excluded.
  - These preferences persist.

- Added large-quantity acceleration for **Faster, less optimal solve**.
  - Fast mode solves a smaller representative quantity, scales the mission/craft pattern, and reports the
acceleration in plan notes.
  - Scaled plans now recalculate GE cost, remaining demand, projected ship levels, mission rows, and
available combos from the scaled output.

- Added progression-aware replay for scaled mission plans.
  - Replays repeated launches through projected ship level gains.
  - Swaps in higher-star mission yields when ship level changes make them available.
  - Prunes repeated launches once expected mission drops cover the remaining demand.

- Improved normal-mode candidate quality for large requests.
  - Normal mode now tests scaled small-block incumbent candidates in addition to the full-quantity solve.
  - If the scaled/replayed incumbent beats the full solve, normal mode adopts it before GE polish.
  - This helps catch cases where LP screening ranks the better repeated-pattern candidate too low.

- Capped normal-mode GE polish.
  - GE polish now uses a conservative 20-second solver time limit.
  - Fast mode skips GE polish entirely to preserve speed.
  - If polish times out or fails, the baseline integer plan is kept.

- Fixed mission timeline display behavior.
  - The top **Expected mission time** KPI now uses the backend planner model total instead of the UI
timeline heuristic.
  - The visual 3-slot timeline now schedules longer launch blocks first and assigns work to the shortest
current slot, reducing display-only lane imbalance.
  - Timeline placement now preserves star-level order within each ship/duration chain, so a later higher-star
block cannot be displayed before its lower-star prerequisite block just because it is longer.

- Added monolithic incumbent checks from mixed-solver choices.
  - After the mixed plan is assembled, the planner now solves single-combo monolithic candidates for the
ship/duration/target combos it actually selected.
  - If one of those monolithic candidates compares better on the active GE/time priority, it replaces the
mixed result.
  - The check is capped to a small number of chosen combos and runs in both normal and fast solve modes.
