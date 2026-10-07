"use client";

import { useEffect, useRef, useState } from "react";

import {
  MAX_CRAFTING_LEVEL,
  MAX_FTL_RESEARCH_LEVEL,
  MAX_ZEROG_RESEARCH_LEVEL,
  normalizeProfileOverrides,
  profileOverrideCount,
  readProfileOverrides,
  writeProfileOverrides,
  type ProfileOverrides,
  type ProfileSummary,
} from "../lib/profile-overrides";
import { buildTargetOptions, filterTargetOptions, type TargetOption } from "../lib/goal-rows";
import { recipes } from "../lib/recipes";
import { shipDisplayName, shipStarRanges } from "../lib/ship-data";
import styles from "./profile-customizer.module.css";

/** This EID's customized profile values (blank EID = the demo profile), kept in step with storage. */
export function useProfileOverrides(eid: string): [ProfileOverrides, (next: ProfileOverrides) => void] {
  const [overrides, setOverrides] = useState<ProfileOverrides>({});
  const key = eid.trim();
  useEffect(() => {
    setOverrides(readProfileOverrides(key));
  }, [key]);
  function update(next: ProfileOverrides): void {
    const normalized = normalizeProfileOverrides(next);
    writeProfileOverrides(key, normalized);
    setOverrides(normalized);
  }
  return [overrides, update];
}

// Ships with stars to set (the Chicken One has none).
const SHIP_RANGES = shipStarRanges().filter((entry) => entry.maxLevel > 0);

function parseField(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Math.round(Number(trimmed));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A "Customize profile" link by the EID that opens a dialog for setting
 * research, crafting level, starting ship stars and item counts over the
 * backup's (or the demo's) values. Once anything is set it shows as a chip
 * with the count and a reset, so a customized profile is never forgotten.
 */
export default function ProfileCustomizer({
  eid,
  overrides,
  onChange,
  summary,
  pendingNote,
}: {
  eid: string;
  overrides: ProfileOverrides;
  onChange: (next: ProfileOverrides) => void;
  /** The backup's own values, once a profile has loaded. */
  summary: ProfileSummary | null;
  /** Shown on the chip, e.g. "recalculate to apply". */
  pendingNote?: string | null;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const count = profileOverrideCount(overrides);
  const isDemo = !eid.trim();
  const source = isDemo ? "the demo profile" : "your backup";

  // While it's open the page behind stays put (no scrolling along with the
  // dialog on phones), and closing returns to where the page was.
  const scrollLockRef = useRef<{ y: number; overflow: string } | null>(null);

  function open(): void {
    const root = document.documentElement;
    scrollLockRef.current = { y: window.scrollY, overflow: root.style.overflow };
    root.style.overflow = "hidden";
    dialogRef.current?.showModal();
  }

  function onClosed(): void {
    const lock = scrollLockRef.current;
    if (!lock) {
      return;
    }
    scrollLockRef.current = null;
    document.documentElement.style.overflow = lock.overflow;
    window.scrollTo(0, lock.y);
  }

  function set(patch: Partial<ProfileOverrides>): void {
    onChange({ ...overrides, ...patch });
  }

  function setStars(ship: string, raw: string): void {
    const shipStars = { ...(overrides.shipStars || {}) };
    if (raw === "") {
      delete shipStars[ship];
    } else {
      shipStars[ship] = Number(raw);
    }
    set({ shipStars });
  }

  return (
    <>
      {count === 0 ? (
        <button type="button" className={styles.trigger} onClick={open}>
          Customize profile
        </button>
      ) : (
        <span className={styles.chip}>
          <button type="button" className={styles.chipOpen} onClick={open} title="Edit the customized values">
            Customized profile · {count} {count === 1 ? "change" : "changes"}
            {pendingNote ? <span className={styles.chipNote}> · {pendingNote}</span> : null}
          </button>
          <button
            type="button"
            className={styles.chipReset}
            onClick={() => onChange({})}
            aria-label="Reset the customized profile"
            title={`Use ${source} as it is`}
          >
            ×
          </button>
        </span>
      )}
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby="profile-customizer-title"
        onClose={onClosed}
        onClick={(event) => {
          // A click on the backdrop (the dialog itself, outside its body) closes it.
          if (event.target === dialogRef.current) {
            dialogRef.current?.close();
          }
        }}
      >
        <div className={styles.body}>
          <header className={styles.header}>
            <h2 id="profile-customizer-title">Customize profile</h2>
            <p>Leave any blank to use {isDemo ? "the demo profile's" : "your backup's"}.</p>
          </header>

          <section className={styles.section}>
            <h3>Research and crafting</h3>
            <div className={styles.fieldGrid}>
              <NumberField
                label="FTL drive research"
                value={overrides.epicResearchFTLLevel}
                max={MAX_FTL_RESEARCH_LEVEL}
                min={0}
                real={summary?.epicResearchFTLLevel}
                onChange={(value) => set({ epicResearchFTLLevel: value })}
              />
              <NumberField
                label="Zero-G research"
                value={overrides.epicResearchZerogLevel}
                max={MAX_ZEROG_RESEARCH_LEVEL}
                min={0}
                real={summary?.epicResearchZerogLevel}
                onChange={(value) => set({ epicResearchZerogLevel: value })}
              />
              <NumberField
                label="Crafting level"
                value={overrides.craftingLevel}
                max={MAX_CRAFTING_LEVEL}
                min={1}
                real={summary?.craftingLevel}
                onChange={(value) => set({ craftingLevel: value })}
              />
            </div>
          </section>

          <section className={styles.section}>
            <h3>Starting ship stars</h3>
            <div className={styles.shipGrid}>
              {SHIP_RANGES.map(({ ship, maxLevel }) => {
                const real = summary?.ships.find((entry) => entry.ship === ship);
                const value = overrides.shipStars?.[ship];
                return (
                  <label key={ship} className={styles.shipRow} data-set={value != null ? "1" : "0"}>
                    <span className={styles.shipName}>{shipDisplayName(ship)}</span>
                    <select value={value == null ? "" : String(value)} onChange={(event) => setStars(ship, event.target.value)}>
                      <option value="">{real ? (real.unlocked ? `${real.level}★` : "locked") : "—"}</option>
                      {Array.from({ length: maxLevel + 1 }, (_, stars) => (
                        <option key={stars} value={stars}>
                          {stars}★
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </section>

          <ItemOverrides overrides={overrides} summary={summary} onChange={set} />

          <footer className={styles.footer}>
            <button type="button" className={styles.resetAll} onClick={() => onChange({})} disabled={count === 0}>
              Reset all
            </button>
            <button type="button" onClick={() => dialogRef.current?.close()}>
              Done
            </button>
          </footer>
        </div>
      </dialog>
    </>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  real,
  onChange,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  real: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);
  return (
    <label className={styles.field} data-set={value != null ? "1" : "0"}>
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        placeholder={real == null ? "—" : String(real)}
        onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, ""))}
        onBlur={() => {
          const parsed = parseField(draft);
          onChange(parsed == null ? undefined : Math.max(min, Math.min(max, parsed)));
        }}
      />
      <span className={styles.real}>
        {min}–{max}
      </span>
    </label>
  );
}

let itemOptions: TargetOption[] | null = null;
const ITEM_RESULT_LIMIT = 8;

/**
 * Inventory and craft counts: only the items you've changed are listed, and
 * a search adds one. Each count shows the backup's greyed until you type;
 * clearing both of an item's counts drops it.
 */
function ItemOverrides({
  overrides,
  summary,
  onChange,
}: {
  overrides: ProfileOverrides;
  summary: ProfileSummary | null;
  onChange: (patch: Partial<ProfileOverrides>) => void;
}) {
  itemOptions ??= buildTargetOptions();
  const options = itemOptions;
  const [query, setQuery] = useState("");
  // Items added from the search that don't have a value yet.
  const [added, setAdded] = useState<string[]>([]);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const editedKeys = Array.from(
    new Set([...Object.keys(overrides.inventory || {}), ...Object.keys(overrides.craftCounts || {}), ...added])
  );
  const results = query.trim()
    ? filterTargetOptions(options, query)
        .filter((option) => !editedKeys.includes(option.itemKey))
        .slice(0, ITEM_RESULT_LIMIT)
    : [];

  useEffect(() => {
    if (focusKey) {
      firstFieldRef.current?.focus();
      setFocusKey(null);
    }
  }, [focusKey]);

  function add(option: TargetOption): void {
    setAdded((current) => (current.includes(option.itemKey) ? current : [...current, option.itemKey]));
    setQuery("");
    setFocusKey(option.itemKey);
  }

  function setCount(kind: "inventory" | "craftCounts", itemKey: string, value: number | undefined): void {
    const next = { ...(overrides[kind] || {}) };
    if (value == null) {
      delete next[itemKey];
    } else {
      next[itemKey] = value;
    }
    onChange({ [kind]: next });
  }

  function remove(itemKey: string): void {
    const inventory = { ...(overrides.inventory || {}) };
    const craftCounts = { ...(overrides.craftCounts || {}) };
    delete inventory[itemKey];
    delete craftCounts[itemKey];
    setAdded((current) => current.filter((key) => key !== itemKey));
    onChange({ inventory, craftCounts });
  }

  return (
    <section className={styles.section}>
      <h3>Inventory and craft counts</h3>
      <div className={styles.itemSearch}>
        <input
          type="text"
          value={query}
          placeholder="Add an item…"
          aria-label="Add an item to change its count"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results[0]) {
              event.preventDefault();
              add(results[0]);
            }
          }}
        />
        {results.length > 0 && (
          <ul className={styles.itemResults} role="listbox">
            {results.map((option) => (
              <li key={option.itemKey} role="option" aria-selected={false}>
                <button type="button" onClick={() => add(option)}>
                  {option.iconUrl ? <img src={option.iconUrl} alt="" width={18} height={18} loading="lazy" /> : null}
                  {option.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {editedKeys.length > 0 && (
        <div className={styles.itemRows}>
          {editedKeys.map((itemKey) => {
            const option = options.find((candidate) => candidate.itemKey === itemKey);
            const craftable = Boolean(recipes[itemKey]);
            return (
              <div key={itemKey} className={styles.itemRow}>
                <span className={styles.itemName} title={option?.label || itemKey}>
                  {option?.iconUrl ? <img src={option.iconUrl} alt="" width={18} height={18} loading="lazy" /> : null}
                  <span>{option?.label || itemKey}</span>
                </span>
                <CountField
                  label="have"
                  itemLabel={option?.label || itemKey}
                  value={overrides.inventory?.[itemKey]}
                  real={summary ? Math.floor(summary.inventory[itemKey] || 0) : undefined}
                  inputRef={focusKey === itemKey ? firstFieldRef : undefined}
                  onChange={(value) => setCount("inventory", itemKey, value)}
                />
                {craftable ? (
                  <CountField
                    label="crafted"
                    itemLabel={option?.label || itemKey}
                    value={overrides.craftCounts?.[itemKey]}
                    real={summary ? Math.round(summary.craftCounts[itemKey] || 0) : undefined}
                    onChange={(value) => setCount("craftCounts", itemKey, value)}
                  />
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  className={styles.itemRemove}
                  onClick={() => remove(itemKey)}
                  aria-label={`Use the backup's counts for ${option?.label || itemKey}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CountField({
  label,
  itemLabel,
  value,
  real,
  inputRef,
  onChange,
}: {
  label: string;
  itemLabel: string;
  value: number | undefined;
  real: number | undefined;
  inputRef?: React.Ref<HTMLInputElement>;
  onChange: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);
  return (
    <label className={styles.countField} data-set={value != null ? "1" : "0"}>
      <span>{label}</span>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        aria-label={`${itemLabel} ${label}`}
        value={draft}
        placeholder={real == null ? "—" : real.toLocaleString()}
        onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, ""))}
        onBlur={() => onChange(parseField(draft))}
      />
    </label>
  );
}
