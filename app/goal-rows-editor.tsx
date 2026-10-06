"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import {
  appendTargetRow,
  CRAFT_DISCOUNT_MAX_COUNT,
  CRAFT_GOAL_DEFAULT_COUNT,
  filterTargetOptions,
  goalRowMode,
  MAX_TARGET_ROWS,
  MAX_TARGET_QUANTITY,
  newTargetRowId,
  normalizedShinyGoalPercent,
  normalizedTargetQuantity,
  normalizeTargetRowQuantity,
  removeTargetRow,
  selectTargetRowOption,
  setTargetRowGoalMode,
  setTargetRowQuantityInput,
  setTargetRowShinyRarity,
  type GoalMode,
  type PlannerTargetRow,
  type TargetOption,
} from "../lib/goal-rows";
import { itemIdToCanonicalKey } from "../lib/item-utils";
import { itemIdTakesCraftCountGoal } from "../lib/recipes";
import {
  craftsForShinyChance,
  itemIdTakesShinyGoal,
  MAX_SHINY_GOAL_CRAFTS,
  MAX_SHINY_GOAL_PERCENT,
  MIN_SHINY_GOAL_PERCENT,
  SHINY_RARITY_LABELS,
  shinyRaritiesFor,
  type ShinyRarity,
} from "../lib/shiny-odds";
import styles from "./goal-rows-editor.module.css";

/** What a row update did, for pages that mirror the first row elsewhere. */
export type GoalRowsChange =
  | { kind: "select"; rowId: string }
  | { kind: "quantity"; rowId: string; rawValue: string }
  | { kind: "normalizeQuantity"; rowId: string }
  | { kind: "goalMode"; rowId: string; mode: GoalMode }
  | { kind: "shinyRarity"; rowId: string; rarity: ShinyRarity }
  | { kind: "add"; rowId: string }
  | { kind: "remove"; rowId: string };

const DEFAULT_CRAFT_COUNT_TITLE = `Aiming for an all-time craft count instead of new copies: ${CRAFT_GOAL_DEFAULT_COUNT} crafts maxes this artifact's shiny luck; ${CRAFT_DISCOUNT_MAX_COUNT} already maxes its GE discount. The count comes from your save, so it is the same on every device. Mission drops do not raise it, and copies a higher tier consumes still do, so the plan crafts exactly the difference.`;
const DEFAULT_COPIES_TITLE = "Read this number as copies to add to what you already have.";
const SHINY_TITLE =
  "Aim for a chance of ending with at least one copy of this rarity or better. The plan crafts enough to reach it from crafting alone, counting your craft count and crafting level rising as you craft; shiny drops from the planned missions add to it.";

/** A per-craft or overall chance: two decimals under 1%, one above. */
export function formatShinyPercent(chance: number): string {
  const percent = chance * 100;
  return `${percent > 0 && percent < 1 ? percent.toFixed(2) : percent.toFixed(1)}%`;
}

const GOAL_MODE_LABELS: Record<GoalMode, string> = { copies: "copies", crafts: "craft count", shiny: "shiny" };

type GoalRowsEditorProps = {
  rows: PlannerTargetRow[];
  /** Apply a row update. `update` maps the latest rows to the next ones; `change` says what it did. */
  onRowsChange: (update: (rows: PlannerTargetRow[]) => PlannerTargetRow[], change: GoalRowsChange) => void;
  options: TargetOption[];
  /** All-time craft counts by canonical key, or null until a profile loads. */
  craftCounts: Record<string, number> | null;
  /** Rows that can't be removed (the attainment planner always keeps one goal). */
  minRows?: number;
  /** Item for a new row when there is no row to copy (or `copyLastRowItem` is off). */
  newRowItemId: string;
  /** A new row starts on the last row's item (true) or on `newRowItemId`. */
  copyLastRowItem?: boolean;
  /** Shown on a row with no item picked yet. */
  emptyRowLabel?: string;
  addLabel?: string;
  copiesTitle?: string;
  craftCountTitle?: string;
  /** Craft-count meta line before craft counts load. */
  craftCountPendingText?: string;
  /** Prefix for the filter input and listbox ids. */
  idPrefix?: string;
  /** Extra content under a row (the XP planner's keeps / status lines). */
  renderRowFooter?: (row: PlannerTargetRow, rowIndex: number) => ReactNode;
  /** Offer shiny-chance goals (the attainment planner); the XP planner imports them as craft counts. */
  allowShinyGoals?: boolean;
  /** Lifetime crafting XP for the shiny goals' crafts estimate, or null until a profile loads. */
  craftingXp?: number | null;
};

/**
 * Goal rows with an icon, a searchable item picker, a quantity stepper, a
 * remove button and, for craftable artifacts, a copies / craft-count chip.
 */
export default function GoalRowsEditor({
  rows,
  onRowsChange,
  options,
  craftCounts,
  minRows = 1,
  newRowItemId,
  copyLastRowItem = true,
  emptyRowLabel = "Choose an item",
  addLabel = "Add target",
  copiesTitle = DEFAULT_COPIES_TITLE,
  craftCountTitle = DEFAULT_CRAFT_COUNT_TITLE,
  craftCountPendingText = "craft count loads with your profile",
  idPrefix = "targetItem",
  renderRowFooter,
  allowShinyGoals = false,
  craftingXp = null,
}: GoalRowsEditorProps) {
  const [activeRowId, setActiveRowId] = useState(rows[0]?.id || "target-1");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const filterInputId = `${idPrefix}Filter`;
  const dropdownId = `${idPrefix}Dropdown`;

  const activeRow = useMemo(
    () => rows.find((row) => row.id === activeRowId) || rows[0] || null,
    [activeRowId, rows]
  );
  const selectedOption = useMemo(
    () => options.find((option) => option.itemId === activeRow?.itemId) || null,
    [activeRow?.itemId, options]
  );
  const filteredOptions = useMemo(
    () => (pickerOpen ? filterTargetOptions(options, filter) : options),
    [filter, options, pickerOpen]
  );

  useEffect(() => {
    if (pickerOpen) {
      return;
    }
    setFilter(selectedOption?.label || "");
  }, [selectedOption, pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    filterInputRef.current?.focus();
    filterInputRef.current?.select();
  }, [pickerOpen, activeRowId]);

  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const selectedIndex = filteredOptions.findIndex((option) => option.itemId === activeRow?.itemId);
    if (selectedIndex >= 0) {
      setActiveIndex(selectedIndex);
      return;
    }
    setActiveIndex(filteredOptions.length > 0 ? 0 : -1);
  }, [activeRow?.itemId, filteredOptions, pickerOpen]);

  useEffect(() => {
    if (!pickerOpen || activeIndex < 0) {
      return;
    }
    const activeNode = containerRef.current?.querySelector<HTMLElement>(`[data-target-option-index="${activeIndex}"]`);
    activeNode?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, pickerOpen, filteredOptions]);

  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      closePicker();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [pickerOpen, selectedOption]);

  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const activeRowNode = containerRef.current?.querySelector<HTMLElement>(`[data-target-row-id="${activeRowId}"]`);
      if (activeRowNode?.contains(target)) {
        return;
      }
      setPickerOpen(false);
      setFilter(selectedOption?.label || "");
    };
    window.addEventListener("mousedown", handleMouseDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
    };
  }, [activeRowId, selectedOption, pickerOpen]);

  function openPicker(rowId?: string): void {
    if (rowId && pickerOpen && rowId === activeRowId) {
      closePicker();
      return;
    }
    if (rowId) {
      setActiveRowId(rowId);
    }
    setPickerOpen(true);
    setFilter("");
  }

  function closePicker(): void {
    setPickerOpen(false);
    setFilter(selectedOption?.label || "");
  }

  function selectOption(option: TargetOption): void {
    const fallbackId = activeRow?.id;
    onRowsChange(
      (current) => selectTargetRowOption(current, fallbackId || current[0]?.id || "target-1", option),
      { kind: "select", rowId: fallbackId || rows[0]?.id || "target-1" }
    );
    setPickerOpen(false);
    setFilter(option.label);
  }

  function updateQuantity(rowId: string, rawValue: string): void {
    onRowsChange((current) => setTargetRowQuantityInput(current, rowId, rawValue), { kind: "quantity", rowId, rawValue });
  }

  function normalizeQuantity(rowId: string): void {
    onRowsChange((current) => normalizeTargetRowQuantity(current, rowId), { kind: "normalizeQuantity", rowId });
  }

  function setGoalMode(rowId: string, mode: GoalMode): void {
    onRowsChange((current) => setTargetRowGoalMode(current, rowId, mode), { kind: "goalMode", rowId, mode });
  }

  function setShinyRarity(rowId: string, rarity: ShinyRarity): void {
    onRowsChange((current) => setTargetRowShinyRarity(current, rowId, rarity), { kind: "shinyRarity", rowId, rarity });
  }

  // Percents step by 5 (snapping to the nearest 5), copies and crafts by 1.
  function steppedQuantity(row: PlannerTargetRow, direction: 1 | -1): string {
    const current = Number(row.quantityInput) || 1;
    if (goalRowMode(row) === "shiny") {
      const snapped = direction > 0 ? Math.floor(current / 5) * 5 + 5 : Math.ceil(current / 5) * 5 - 5;
      return String(Math.max(MIN_SHINY_GOAL_PERCENT, Math.min(MAX_SHINY_GOAL_PERCENT, snapped)));
    }
    return String(Math.max(1, Math.min(MAX_TARGET_QUANTITY, current + direction)));
  }

  function addRow(): void {
    const id = newTargetRowId();
    const itemId = (copyLastRowItem ? rows[rows.length - 1]?.itemId : "") || newRowItemId;
    onRowsChange((current) => appendTargetRow(current, id, itemId), { kind: "add", rowId: id });
    setActiveRowId(id);
    setPickerOpen(true);
    setFilter("");
  }

  function removeRow(rowId: string): void {
    onRowsChange((current) => removeTargetRow(current, rowId, minRows), { kind: "remove", rowId });
  }

  function onFilterKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      if (!pickerOpen) {
        return;
      }
      event.preventDefault();
      closePicker();
      return;
    }
    if (event.key === "Tab") {
      if (pickerOpen) {
        closePicker();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!pickerOpen) {
        openPicker();
        return;
      }
      if (filteredOptions.length === 0) {
        return;
      }
      setActiveIndex((current) => {
        const base = current < 0 ? 0 : current;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        return (base + delta + filteredOptions.length) % filteredOptions.length;
      });
      return;
    }
    if (event.key === "Home" || event.key === "PageUp") {
      if (!pickerOpen || filteredOptions.length === 0) {
        return;
      }
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End" || event.key === "PageDown") {
      if (!pickerOpen || filteredOptions.length === 0) {
        return;
      }
      event.preventDefault();
      setActiveIndex(filteredOptions.length - 1);
      return;
    }
    if (event.key === "Enter") {
      if (!pickerOpen) {
        return;
      }
      event.preventDefault();
      if (filteredOptions.length === 0) {
        return;
      }
      const selected = filteredOptions[Math.max(0, activeIndex)];
      if (selected) {
        selectOption(selected);
      }
    }
  }

  return (
    <div className={styles.targetRows} ref={containerRef}>
      {rows.map((row, rowIndex) => {
        const option = options.find((candidate) => candidate.itemId === row.itemId) || null;
        const rowActive = row.id === activeRowId;
        // The goal modes are only for artifacts that can be crafted.
        const takesCraftGoal = itemIdTakesCraftCountGoal(row.itemId);
        const takesShinyGoal = allowShinyGoals && itemIdTakesShinyGoal(row.itemId);
        const mode = goalRowMode(row);
        const modes: GoalMode[] = takesShinyGoal ? ["copies", "crafts", "shiny"] : ["copies", "crafts"];
        const itemKey = itemIdToCanonicalKey(row.itemId);
        const craftedSoFar = craftCounts ? Math.max(0, Math.round(craftCounts[itemKey] || 0)) : null;
        const craftsToGo =
          craftedSoFar == null ? null : Math.max(0, normalizedTargetQuantity(row.quantityInput) - craftedSoFar);
        const shinyRarities = mode === "shiny" ? shinyRaritiesFor(itemKey) : [];
        const shinyPercent = normalizedShinyGoalPercent(row.quantityInput);
        const shinyEstimate =
          mode === "shiny" && row.shinyRarity && craftedSoFar != null && craftingXp != null
            ? craftsForShinyChance({
                itemKey,
                rarity: row.shinyRarity,
                targetChance: shinyPercent / 100,
                craftedBefore: craftedSoFar,
                craftingXp,
              })
            : null;
        const quantityLabel = `${option?.label || "Target"} ${mode === "shiny" ? "chance in percent" : "quantity"}`;
        return (
          <div key={row.id} className={styles.targetRowGroup}>
          <div className={styles.targetRow} data-target-row-id={row.id}>
            <span className={styles.targetIcon} aria-hidden="true">
              {option?.iconUrl ? (
                <img src={option.iconUrl} alt="" width={32} height={32} loading="lazy" />
              ) : (
                <span className={styles.targetPickerFallbackIcon}>?</span>
              )}
            </span>
            <button
              type="button"
              className={styles.targetRowSelect}
              onClick={() => openPicker(row.id)}
            >
              <span>{option?.label || row.itemId || emptyRowLabel}</span>
              <span className={styles.targetPickerChevron} aria-hidden="true" />
            </button>
            <div className={styles.targetStepper}>
              <button
                type="button"
                aria-label={`Decrease ${quantityLabel}`}
                onClick={() => updateQuantity(row.id, steppedQuantity(row, -1))}
              >
                -
              </button>
              <span className={styles.targetStepperField} data-percent={mode === "shiny" ? "1" : "0"}>
                <input
                  aria-label={quantityLabel}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={row.quantityInput}
                  onChange={(event) => updateQuantity(row.id, event.target.value)}
                  onBlur={() => normalizeQuantity(row.id)}
                />
                {mode === "shiny" && <span aria-hidden="true">%</span>}
              </span>
              <button
                type="button"
                aria-label={`Increase ${quantityLabel}`}
                onClick={() => updateQuantity(row.id, steppedQuantity(row, 1))}
              >
                +
              </button>
            </div>
            <button
              type="button"
              className={styles.targetRemove}
              onClick={() => removeRow(row.id)}
              disabled={rows.length <= minRows}
              aria-label={`Remove target ${rowIndex + 1}`}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4.25 4.25 11.75 11.75M11.75 4.25 4.25 11.75" />
              </svg>
            </button>
            {pickerOpen && rowActive && (
              <div className={styles.targetRowDropdown}>
                <div className={styles.targetPicker}>
                  <input
                    ref={filterInputRef}
                    id={filterInputId}
                    type="text"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    onKeyDown={onFilterKeyDown}
                    placeholder="Filter artifacts"
                    autoComplete="off"
                    className={styles.targetPickerInput}
                    role="combobox"
                    aria-expanded={pickerOpen}
                    aria-controls={dropdownId}
                  />
                </div>
                <ul id={dropdownId} className={styles.targetPickerDropdown} role="listbox">
                  {filteredOptions.length === 0 ? (
                    <li className={styles.targetPickerEmpty}>No match</li>
                  ) : (
                    filteredOptions.map((optionRow, index) => {
                      const selected = optionRow.itemId === row.itemId;
                      const active = index === activeIndex;
                      return (
                        <li
                          key={optionRow.itemId}
                          data-target-option-index={index}
                          className={styles.targetPickerOption}
                          data-active={active ? "1" : "0"}
                          data-selected={selected ? "1" : "0"}
                          role="option"
                          aria-selected={selected}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            selectOption(optionRow);
                          }}
                          onMouseEnter={() => setActiveIndex(index)}
                        >
                          {optionRow.iconUrl ? (
                            <img src={optionRow.iconUrl} alt="" width={22} height={22} className={styles.targetPickerOptionIcon} loading="lazy" />
                          ) : (
                            <span className={styles.targetPickerFallbackIcon} aria-hidden="true">?</span>
                          )}
                          <span className={styles.targetPickerOptionLabel}>{optionRow.label}</span>
                          {selected && <span className={styles.targetPickerCheck}>✓</span>}
                        </li>
                      );
                    })
                  )}
                </ul>
              </div>
            )}
          </div>
          {takesCraftGoal && (
            <div className={styles.targetRowMeta}>
              <span className={styles.targetGoalModes} role="group" aria-label={`${option?.label || "Goal"} goal type`}>
                {modes.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    className={styles.targetGoalMode}
                    data-on={mode === candidate ? "1" : "0"}
                    aria-pressed={mode === candidate}
                    onClick={() => setGoalMode(row.id, candidate)}
                    title={candidate === "shiny" ? SHINY_TITLE : candidate === "crafts" ? craftCountTitle : copiesTitle}
                  >
                    {GOAL_MODE_LABELS[candidate]}
                  </button>
                ))}
              </span>
              {mode === "shiny" ? (
                <>
                  <span className={styles.targetRarities} role="group" aria-label="Rarity">
                    {shinyRarities.map((rarity) => (
                      <button
                        key={rarity}
                        type="button"
                        className={styles.targetRarity}
                        data-rarity={rarity}
                        data-on={row.shinyRarity === rarity ? "1" : "0"}
                        aria-pressed={row.shinyRarity === rarity}
                        disabled={shinyRarities.length === 1}
                        onClick={() => setShinyRarity(row.id, rarity)}
                      >
                        {SHINY_RARITY_LABELS[rarity]}
                      </button>
                    ))}
                  </span>
                  <span className={styles.targetRowMetaText}>
                    {shinyEstimate == null
                      ? "crafts needed load with your profile"
                      : !shinyEstimate.reached
                        ? `can't reach ${shinyPercent}% within ${MAX_SHINY_GOAL_CRAFTS.toLocaleString()} crafts`
                        : `≈ ${shinyEstimate.crafts.toLocaleString()} ${shinyEstimate.crafts === 1 ? "craft" : "crafts"} from crafting alone · ${
                            shinyEstimate.firstChance === shinyEstimate.lastChance
                              ? formatShinyPercent(shinyEstimate.firstChance)
                              : `${formatShinyPercent(shinyEstimate.firstChance)} → ${formatShinyPercent(shinyEstimate.lastChance)}`
                          } each`}
                  </span>
                </>
              ) : mode === "crafts" ? (
                <span className={styles.targetRowMetaText}>
                  {craftedSoFar == null
                    ? craftCountPendingText
                    : craftsToGo === 0
                      ? `${craftedSoFar.toLocaleString()} crafted - goal already met`
                      : `${craftedSoFar.toLocaleString()} crafted, ${craftsToGo?.toLocaleString()} to go`}
                </span>
              ) : (
                craftedSoFar != null &&
                craftedSoFar > 0 && (
                  <span className={styles.targetRowMetaText}>{craftedSoFar.toLocaleString()} crafted so far</span>
                )
              )}
            </div>
          )}
          {renderRowFooter?.(row, rowIndex)}
          </div>
        );
      })}
      <button type="button" className={styles.addTargetButton} onClick={addRow} disabled={rows.length >= MAX_TARGET_ROWS}>
        <span aria-hidden="true">+</span>
        {addLabel}
      </button>
    </div>
  );
}
