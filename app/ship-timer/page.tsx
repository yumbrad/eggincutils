"use client";

import Link from "next/link";
import Image from "next/image";
import React, { JSX, useEffect, useMemo, useState } from "react";

import { SHIP_TIMER_COPY } from "../../lib/ship-timer-copy";
import styles from "./page.module.css";

type ViewMode = "grouped" | "flat";
type SortMode = "ship" | "return";

type MissionSetting = {
  setting: "Short" | "Standard" | "Extended";
  baseDur: string;
};

type ShipConfig = {
  ship: string;
  ftlAffected: boolean;
  imageFiles: string[];
  missions: MissionSetting[];
};

type MissionRow = {
  key: string;
  ship: ShipConfig;
  shipName: string;
  setting: MissionSetting["setting"];
  settingOrder: number;
  duration: string;
  durationMinutes: number;
  ret: Date;
  retMinOfDay: number;
  bad: boolean;
};

const SHIP_IMAGE_SIZE = 128;
const SHIP_PREVIEW_IMAGE_SIZE = 512;
const SHIP_IMAGE_HOSTS = ["https://eggincassets.pages.dev", "https://eggincassets.tcl.sh"];

const SHIPS: ShipConfig[] = [
  {
    ship: "Atreggies Henliner",
    ftlAffected: true,
    imageFiles: ["afx_ship_atreggies.png", "afx_ship_atreggies_henliner.png"],
    missions: [
      { setting: "Short", baseDur: "2d" },
      { setting: "Standard", baseDur: "3d" },
      { setting: "Extended", baseDur: "4d" },
    ],
  },
  {
    ship: "Henerprise",
    ftlAffected: true,
    imageFiles: ["afx_ship_henerprise.png"],
    missions: [
      { setting: "Short", baseDur: "1d" },
      { setting: "Standard", baseDur: "2d" },
      { setting: "Extended", baseDur: "4d" },
    ],
  },
  {
    ship: "Voyegger",
    ftlAffected: true,
    imageFiles: ["afx_ship_voyegger.png"],
    missions: [
      { setting: "Short", baseDur: "12h" },
      { setting: "Standard", baseDur: "1d12h" },
      { setting: "Extended", baseDur: "3d" },
    ],
  },
  {
    ship: "Defihent",
    ftlAffected: true,
    imageFiles: ["afx_ship_defihent.png"],
    missions: [
      { setting: "Short", baseDur: "8h" },
      { setting: "Standard", baseDur: "1d" },
      { setting: "Extended", baseDur: "2d" },
    ],
  },
  {
    ship: "Galeggtica",
    ftlAffected: true,
    imageFiles: ["afx_ship_galeggtica.png"],
    missions: [
      { setting: "Short", baseDur: "6h" },
      { setting: "Standard", baseDur: "16h" },
      { setting: "Extended", baseDur: "1d6h" },
    ],
  },
  {
    ship: "Cornish-Hen Corvette",
    ftlAffected: true,
    imageFiles: ["afx_ship_corellihen_corvette.png", "afx_ship_cornish_hen_corvette.png", "afx_ship_cornish_hen.png"],
    missions: [
      { setting: "Short", baseDur: "4h" },
      { setting: "Standard", baseDur: "12h" },
      { setting: "Extended", baseDur: "1d" },
    ],
  },
  {
    ship: "Quintillion Chicken",
    ftlAffected: true,
    imageFiles: ["afx_ship_millenium_chicken.png", "afx_ship_quintillion_chicken.png", "afx_ship_quintillion.png"],
    missions: [
      { setting: "Short", baseDur: "3h" },
      { setting: "Standard", baseDur: "6h" },
      { setting: "Extended", baseDur: "12h" },
    ],
  },
  {
    ship: "BCR",
    ftlAffected: false,
    imageFiles: ["afx_ship_bcr.png"],
    missions: [
      { setting: "Short", baseDur: "1h30m" },
      { setting: "Standard", baseDur: "4h" },
      { setting: "Extended", baseDur: "8h" },
    ],
  },
  {
    ship: "Chicken Heavy",
    ftlAffected: false,
    imageFiles: ["afx_ship_chicken_heavy.png"],
    missions: [
      { setting: "Short", baseDur: "45m" },
      { setting: "Standard", baseDur: "1h30m" },
      { setting: "Extended", baseDur: "4h" },
    ],
  },
  {
    ship: "Chicken Nine",
    ftlAffected: false,
    imageFiles: ["afx_ship_chicken_9.png", "afx_ship_chicken_nine.png"],
    missions: [
      { setting: "Short", baseDur: "30m" },
      { setting: "Standard", baseDur: "1h" },
      { setting: "Extended", baseDur: "3h" },
    ],
  },
  {
    ship: "Chicken One",
    ftlAffected: false,
    imageFiles: ["afx_ship_chicken_1.png", "afx_ship_chicken_one.png"],
    missions: [
      { setting: "Short", baseDur: "20m" },
      { setting: "Standard", baseDur: "1h" },
      { setting: "Extended", baseDur: "2h" },
    ],
  },
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toLocalDatetimeValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function parseDurationToMinutes(s: string): number {
  const re = /^(?:(\d+)\s*d)?(?:(\d+)\s*h)?(?:(\d+)\s*m)?$/i;
  const match = s.replace(/\s+/g, "").match(re);
  if (!match) {
    throw new Error(`Bad duration: ${s}`);
  }
  const days = match[1] ? parseInt(match[1], 10) : 0;
  const hrs = match[2] ? parseInt(match[2], 10) : 0;
  const mins = match[3] ? parseInt(match[3], 10) : 0;
  return days * 24 * 60 + hrs * 60 + mins;
}

function formatMinutesAsDuration(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  const days = Math.floor(safe / (24 * 60));
  const hours = Math.floor((safe % (24 * 60)) / 60);
  const mins = safe % 60;
  const parts: string[] = [];
  if (days) {
    parts.push(`${days}d`);
  }
  if (hours) {
    parts.push(`${hours}h`);
  }
  if (mins) {
    parts.push(`${mins}m`);
  }
  return parts.length > 0 ? parts.join(" ") : "0m";
}

function effectiveDurationMinutes(baseMinutes: number, ftlAffected: boolean, ftlUpgrades: number): number {
  if (!ftlAffected) {
    return baseMinutes;
  }
  const multiplier = 1 - ftlUpgrades / 100;
  return Math.max(1, Math.round(baseMinutes * multiplier));
}

function parseTimeToMinutesOfDay(t: string): number {
  const [hh, mm] = t.split(":").map(Number);
  return hh * 60 + mm;
}

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function inSleepWindow(minOfDay: number, sleepStart: number, sleepEnd: number): boolean {
  if (sleepStart === sleepEnd) {
    return false;
  }
  if (sleepStart < sleepEnd) {
    return minOfDay >= sleepStart && minOfDay < sleepEnd;
  }
  return minOfDay >= sleepStart || minOfDay < sleepEnd;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(c1: [number, number, number], c2: [number, number, number], t: number): string {
  const [r1, g1, b1] = c1;
  const [r2, g2, b2] = c2;
  const r = Math.round(lerp(r1, r2, t));
  const g = Math.round(lerp(g1, g2, t));
  const b = Math.round(lerp(b1, b2, t));
  return `rgb(${r},${g},${b})`;
}

function awakeT(minOfDay: number, sleepStart: number, sleepEnd: number): number {
  const awakeStart = sleepEnd;
  const awakeEnd = sleepStart;
  const awakeLen = (awakeEnd - awakeStart + 1440) % 1440;
  if (awakeLen === 0) {
    return minOfDay / 1440;
  }
  const delta = (minOfDay - awakeStart + 1440) % 1440;
  return Math.max(0, Math.min(1, delta / awakeLen));
}

function timeColor(t: number): string {
  const peach: [number, number, number] = [248, 205, 180];
  const yellow: [number, number, number] = [255, 245, 160];
  const blue: [number, number, number] = [170, 210, 255];
  if (t < 0.5) {
    return lerpColor(peach, yellow, t / 0.5);
  }
  return lerpColor(yellow, blue, (t - 0.5) / 0.5);
}

function toDeg(min: number): number {
  return (min / 1440) * 360;
}

function clockFaceColor(minOfDay: number, sleepStart: number, sleepEnd: number): string {
  if (inSleepWindow(minOfDay, sleepStart, sleepEnd)) {
    return "#ffb8d2";
  }
  return timeColor(awakeT(minOfDay, sleepStart, sleepEnd));
}

function localDayStamp(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

function fmtReturn(d: Date): string {
  const now = new Date();
  const dayDiff = Math.round((localDayStamp(d) - localDayStamp(now)) / 86400000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });

  let dayLabel = "today";
  if (dayDiff === 1) {
    dayLabel = "tomorrow";
  } else if (dayDiff === -1) {
    dayLabel = "yesterday";
  } else if (dayDiff > 1) {
    dayLabel = `+${dayDiff} days`;
  } else if (dayDiff < -1) {
    dayLabel = `${dayDiff} days`;
  }
  return `${time} ${dayLabel} (${weekday})`;
}

function shipInitials(name: string): string {
  return (
    name
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join("")
      .slice(0, 4)
      .toUpperCase() || "SHIP"
  );
}

function buildShipImageCandidates(ship: ShipConfig, size: number): string[] {
  const urls: string[] = [];
  for (const file of ship.imageFiles) {
    for (const host of SHIP_IMAGE_HOSTS) {
      urls.push(`${host}/${size}/egginc/${file}`);
    }
  }
  return Array.from(new Set(urls));
}

function clockBackground(minOfDay: number, sleepStart: number, sleepEnd: number): string {
  const stepMin = 5;
  const stops: string[] = [];
  for (let m = 0; m <= 1440; m += stepMin) {
    const sampleMin = m === 1440 ? 0 : m;
    stops.push(`${clockFaceColor(sampleMin, sleepStart, sleepEnd)} ${toDeg(m)}deg`);
  }
  return `conic-gradient(from -90deg, ${stops.join(", ")})`;
}

function compareShipThenSetting(a: MissionRow, b: MissionRow): number {
  const ship = a.shipName.localeCompare(b.shipName);
  if (ship !== 0) {
    return ship;
  }
  return a.settingOrder - b.settingOrder;
}

function compareEarliestReturn(a: MissionRow, b: MissionRow): number {
  const time = a.ret.getTime() - b.ret.getTime();
  if (time !== 0) {
    return time;
  }
  return compareShipThenSetting(a, b);
}

function clampFtl(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(60, Math.round(value)));
}

function returnCellBackgroundColor(minOfDay: number, bad: boolean, sleepStart: number, sleepEnd: number): string | undefined {
  if (bad) {
    return undefined;
  }
  return timeColor(awakeT(minOfDay, sleepStart, sleepEnd));
}

function ShipImage({ ship, flat }: { ship: ShipConfig; flat: boolean }): JSX.Element {
  const candidates = useMemo(() => buildShipImageCandidates(ship, SHIP_IMAGE_SIZE), [ship]);
  const previewCandidates = useMemo(() => buildShipImageCandidates(ship, SHIP_PREVIEW_IMAGE_SIZE), [ship]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    setCandidateIndex(0);
    setFallback(false);
  }, [ship.ship]);

  if (fallback || candidateIndex >= candidates.length) {
    return <span className={styles.shipFallback}>{shipInitials(ship.ship)}</span>;
  }

  const previewSrc = previewCandidates[candidateIndex] || previewCandidates[0] || candidates[candidateIndex];
  const baseImage = (
    <img
      className={styles.shipImage}
      src={candidates[candidateIndex]}
      alt={ship.ship}
      loading="lazy"
      onError={() => {
        const next = candidateIndex + 1;
        if (next < candidates.length) {
          setCandidateIndex(next);
        } else {
          setFallback(true);
        }
      }}
      data-flat={flat ? "1" : "0"}
    />
  );

  if (!flat) {
    return baseImage;
  }

  return (
    <span className={styles.shipImageWrap}>
      {baseImage}
      <span className={styles.shipImagePreview} aria-hidden="true">
        <img className={styles.shipImageLarge} src={previewSrc} alt="" loading="lazy" />
      </span>
    </span>
  );
}

function ReturnClock({
  minOfDay,
  sleepStart,
  sleepEnd,
}: {
  minOfDay: number;
  sleepStart: number;
  sleepEnd: number;
}): JSX.Element {
  const angle = toDeg(minOfDay) - 90;
  const style = {
    background: clockBackground(minOfDay, sleepStart, sleepEnd),
    borderColor: inSleepWindow(minOfDay, sleepStart, sleepEnd) ? "#e88fb2" : "#9fd18b",
    "--handAngle": `${angle}deg`,
    "--handColor": inSleepWindow(minOfDay, sleepStart, sleepEnd) ? "#b30000" : "#222",
  } as React.CSSProperties;
  return <div className={styles.clock} style={style} aria-hidden="true" />;
}

export default function ShipTimerPage(): JSX.Element {
  const [launchValue, setLaunchValue] = useState<string>(() => toLocalDatetimeValue(new Date()));
  const [ftlValue, setFtlValue] = useState<number>(60);
  const [sleepStartValue, setSleepStartValue] = useState<string>("23:00");
  const [sleepEndValue, setSleepEndValue] = useState<string>("07:00");
  const [viewMode, setViewMode] = useState<ViewMode>("grouped");
  const [sortMode, setSortMode] = useState<SortMode>("ship");
  const [copyStatus, setCopyStatus] = useState<string>("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const launch = params.get("launch");
    const ftl = params.get("ftl");
    const sleepStart = params.get("sleepStart");
    const sleepEnd = params.get("sleepEnd");
    const view = params.get("viewMode");
    const sort = params.get("sortMode");

    if (launch) {
      setLaunchValue(launch);
    }
    if (ftl != null) {
      setFtlValue(clampFtl(Number(ftl)));
    }
    if (sleepStart) {
      setSleepStartValue(sleepStart);
    }
    if (sleepEnd) {
      setSleepEndValue(sleepEnd);
    }
    if (view === "grouped" || view === "flat") {
      setViewMode(view);
    }
    if (sort === "ship" || sort === "return") {
      setSortMode(sort);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("launch", launchValue);
    params.set("ftl", String(ftlValue));
    params.set("sleepStart", sleepStartValue);
    params.set("sleepEnd", sleepEndValue);
    params.set("viewMode", viewMode);
    params.set("sortMode", sortMode);
    const url = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", url);
  }, [launchValue, ftlValue, sleepStartValue, sleepEndValue, viewMode, sortMode]);

  const launchDate = useMemo(() => {
    const parsed = new Date(launchValue);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }, [launchValue]);

  const sleepStart = useMemo(() => parseTimeToMinutesOfDay(sleepStartValue), [sleepStartValue]);
  const sleepEnd = useMemo(() => parseTimeToMinutesOfDay(sleepEndValue), [sleepEndValue]);

  const rows = useMemo(() => {
    if (!launchDate) {
      return [] as MissionRow[];
    }
    const out: MissionRow[] = [];
    for (const ship of SHIPS) {
      for (const mission of ship.missions) {
        const baseMinutes = parseDurationToMinutes(mission.baseDur);
        const durationMinutes = effectiveDurationMinutes(baseMinutes, ship.ftlAffected, ftlValue);
        const ret = new Date(launchDate.getTime() + durationMinutes * 60 * 1000);
        const retMin = minutesOfDay(ret);
        const bad = inSleepWindow(retMin, sleepStart, sleepEnd);
        out.push({
          key: `${ship.ship}:${mission.setting}`,
          ship,
          shipName: ship.ship,
          setting: mission.setting,
          settingOrder: mission.setting === "Short" ? 0 : mission.setting === "Standard" ? 1 : 2,
          duration: formatMinutesAsDuration(durationMinutes),
          durationMinutes,
          ret,
          retMinOfDay: retMin,
          bad,
        });
      }
    }
    return out;
  }, [launchDate, ftlValue, sleepStart, sleepEnd]);

  const sortedRows = useMemo(() => {
    const clone = [...rows];
    clone.sort(sortMode === "return" ? compareEarliestReturn : compareShipThenSetting);
    return clone;
  }, [rows, sortMode]);

  const groupedRows = useMemo(() => {
    const byShip = new Map<string, MissionRow[]>();
    for (const row of rows) {
      const list = byShip.get(row.shipName) || [];
      list.push(row);
      byShip.set(row.shipName, list);
    }
    const groups = Array.from(byShip.values()).map((shipRows) => {
      shipRows.sort((a, b) => a.settingOrder - b.settingOrder);
      const minRet = shipRows.reduce((min, row) => (row.ret < min ? row.ret : min), shipRows[0].ret);
      return {
        ship: shipRows[0].ship,
        shipName: shipRows[0].shipName,
        minRet,
        rows: shipRows,
      };
    });

    groups.sort((a, b) => {
      if (sortMode === "return") {
        const time = a.minRet.getTime() - b.minRet.getTime();
        if (time !== 0) {
          return time;
        }
      }
      return a.shipName.localeCompare(b.shipName);
    });

    return groups;
  }, [rows, sortMode]);

  async function copyLink(): Promise<void> {
    setCopyStatus("");
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus("Copy failed.");
    }
  }

  return (
    <main className="page">
      <div className="panel brand-panel" style={{ marginBottom: 12 }}>
        <div className="brand-header" data-compact="1">
          <Link href="/" className="brand-mark-shell brand-mark-link" aria-label="Back to menu">
            <Image src="/media/hamster_egg_poly.png" alt="" width={1024} height={1536} className="brand-mark" priority />
          </Link>
          <div className="brand-copy">
            <h1 className="brand-title">{SHIP_TIMER_COPY.title}</h1>
            <p className="muted brand-subtitle">{SHIP_TIMER_COPY.subtitle}</p>
            <details className="info-disclosure">
              <summary className="subtle-info-link">More info</summary>
              <p className="muted">{SHIP_TIMER_COPY.longDescription}</p>
            </details>
          </div>
        </div>
      </div>

      <div className={`panel ${styles.controlsCard}`}>
        <div className={styles.row}>
          <div className={styles.control}>
            <label htmlFor="launchInput">Launch time</label>
            <div className={styles.launchInline}>
              <input
                id="launchInput"
                className={styles.launchInput}
                type="datetime-local"
                value={launchValue}
                onChange={(event) => setLaunchValue(event.target.value)}
              />
              <button type="button" onClick={() => setLaunchValue(toLocalDatetimeValue(new Date()))}>
                Use now
              </button>
            </div>
            <div className={styles.mutedSmall}>Uses your device timezone.</div>
          </div>

          <div className={styles.control}>
            <label htmlFor="ftlInput">FTL Drive Upgrades (0 to 60) / 60</label>
            <input
              id="ftlInput"
              className={styles.ftlInput}
              type="number"
              min={0}
              max={60}
              step={1}
              value={ftlValue}
              onChange={(event) => setFtlValue(clampFtl(Number(event.target.value)))}
            />
            <div className={styles.mutedSmall}>
              Each point reduces mission duration by 1% for Quintillion Chicken and higher ships.
            </div>
          </div>
        </div>

        <div className={styles.row} style={{ marginTop: 10 }}>
          <div className={styles.control}>
            <label htmlFor="sleepStartInput">Sleep window start</label>
            <input
              id="sleepStartInput"
              type="time"
              value={sleepStartValue}
              onChange={(event) => setSleepStartValue(event.target.value)}
            />
          </div>
          <div className={styles.control}>
            <label htmlFor="sleepEndInput">Sleep window end</label>
            <input id="sleepEndInput" type="time" value={sleepEndValue} onChange={(event) => setSleepEndValue(event.target.value)} />
          </div>
        </div>

        <div className={`${styles.row} ${styles.actionsRow}`} style={{ marginTop: 10 }}>
          <div className={styles.control}>
            <label>View</label>
            <div className={styles.toggleGroup}>
              <button
                type="button"
                className={viewMode === "grouped" ? styles.active : ""}
                onClick={() => setViewMode("grouped")}
              >
                Grouped by ship
              </button>
              <button type="button" className={viewMode === "flat" ? styles.active : ""} onClick={() => setViewMode("flat")}>
                Flat list
              </button>
            </div>
          </div>
          <div className={styles.control}>
            <label>Sort</label>
            <div className={styles.toggleGroup}>
              <button type="button" className={sortMode === "ship" ? styles.active : ""} onClick={() => setSortMode("ship")}>
                Ship (A→Z)
              </button>
              <button type="button" className={sortMode === "return" ? styles.active : ""} onClick={() => setSortMode("return")}>
                Earliest return
              </button>
            </div>
          </div>
          <div className={styles.mutedSmall}>Tip: use Flat list + Earliest return when deciding what to launch next.</div>
        </div>

        <div className={`${styles.row} ${styles.actionsRow}`} style={{ marginTop: 10 }}>
          <button type="button" onClick={copyLink}>
            Copy shareable link
          </button>
          <div className={styles.mutedSmall}>{copyStatus || "Stores settings in the URL so you can bookmark it."}</div>
        </div>
      </div>

      <div className={`panel ${viewMode === "flat" ? styles.flat : ""}`}>
        {launchDate ? (
          <div className={styles.summary}>
            Launch: {fmtReturn(launchDate)} | FTL Drive Upgrades: {ftlValue}/60 | Sleep window: {sleepStartValue} to{" "}
            {sleepEndValue}
          </div>
        ) : (
          <div className={styles.summary}>Enter a valid launch time to compute return schedule.</div>
        )}

        <div className={styles.tableWrap}>
          <table className={styles.resultsTable}>
            <thead>
              <tr>
                <th>Ship</th>
                <th>Setting</th>
                <th>Duration</th>
                <th>Return time</th>
              </tr>
            </thead>
            <tbody>
              {viewMode === "flat" &&
                sortedRows.map((row) => (
                  <tr key={row.key} className={row.bad ? styles.badRow : ""}>
                    <td className={styles.shipCell}>
                      <div className={styles.shipBox}>
                        <strong className={styles.shipTitle}>{row.ship.ship}</strong>
                        <ShipImage ship={row.ship} flat />
                      </div>
                    </td>
                    <td>{row.setting}</td>
                    <td className="mono">{row.duration}</td>
                    <td style={{ backgroundColor: returnCellBackgroundColor(row.retMinOfDay, row.bad, sleepStart, sleepEnd) }}>
                      <div className={styles.returnWrap}>
                        <ReturnClock minOfDay={row.retMinOfDay} sleepStart={sleepStart} sleepEnd={sleepEnd} />
                        <span>{fmtReturn(row.ret)}</span>
                      </div>
                    </td>
                  </tr>
                ))}

              {viewMode === "grouped" &&
                groupedRows.map((group) =>
                  group.rows.map((row, idx) => (
                    <tr
                      key={`${group.shipName}:${row.setting}`}
                      className={`${row.bad ? styles.badRow : ""} ${idx === group.rows.length - 1 ? styles.shipSep : ""}`.trim()}
                    >
                      {idx === 0 && (
                        <td
                          className={`${styles.shipCell} ${group.rows.length > 1 ? styles.shipGrouped : ""}`.trim()}
                          rowSpan={group.rows.length}
                        >
                          <div className={styles.shipBox}>
                            <strong className={styles.shipTitle}>{row.ship.ship}</strong>
                            <ShipImage ship={row.ship} flat={false} />
                          </div>
                        </td>
                      )}
                      <td>{row.setting}</td>
                      <td className="mono">{row.duration}</td>
                      <td style={{ backgroundColor: returnCellBackgroundColor(row.retMinOfDay, row.bad, sleepStart, sleepEnd) }}>
                        <div className={styles.returnWrap}>
                          <ReturnClock minOfDay={row.retMinOfDay} sleepStart={sleepStart} sleepEnd={sleepEnd} />
                          <span>{fmtReturn(row.ret)}</span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
            </tbody>
          </table>
        </div>

        <div className={styles.pageLinks}>
          <Link href="/" className="subtle-link">
            Back to menu
          </Link>
        </div>
      </div>
    </main>
  );
}
