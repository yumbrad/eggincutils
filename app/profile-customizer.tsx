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
 * research, crafting level, ship stars and the in-air toggle over the
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

  function open(): void {
    dialogRef.current?.showModal();
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
            <p>
              Values you set replace {source}&apos;s when planning, in both planners. Leave one blank to use{" "}
              {isDemo ? "the demo's" : "your backup's"}.
            </p>
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
            <p className={styles.note}>
              Where each ship starts; planned launches still level it up from there. Setting a ship unlocks it, and a ship
              whose launches unlock the next one may start a star above what you set.
            </p>
          </section>

          <section className={styles.section}>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={Boolean(overrides.ignoreInFlight)}
                onChange={(event) => set({ ignoreInFlight: event.target.checked })}
              />
              Ignore ships in the air
              {summary && summary.inFlightCount > 0 && <span className={styles.real}>({summary.inFlightCount} now)</span>}
            </label>
          </section>

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
