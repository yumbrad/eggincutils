import { afxIdToTargetFamilyName, isUntargetedTargetAfxId } from "./item-utils";
import { shipDisplayName } from "./ship-data";
import {
  isSendDurationType,
  SEND_DURATIONS,
  SEND_SHIPS,
  SEND_UNTARGETED_ONLY_SHIPS,
  SEND_UNTARGETED_TARGET_AFX_ID,
  type SendDurationType,
} from "./ship-sends";

/**
 * Locked launches: sends the player commits a plan to before it is built
 * (PlannerOptions.lockedLaunches). Each row is at least that many launches of
 * a ship and length, at a target or at whatever target the planner picks; the
 * planner may add more. Unless a row flies in the plan's dubcap, its launches
 * go first, after the ships in the air return: before a fresh dubcap, or
 * after one already running. Client-safe.
 */

export const MAX_LOCKED_LAUNCH_ROWS = 20;
export const MAX_LOCKED_LAUNCHES_PER_ROW = 999;

export type LockedLaunch = {
  ship: string;
  durationType: SendDurationType;
  /** A target's afx id (10000 for untargeted), or null for any target, which the planner picks. */
  targetAfxId: number | null;
  launches: number;
  /** In the plan's dubcap; only counts when the plan includes one. */
  dubcap?: boolean;
};

/** Valid rows only: known ships and lengths, 1 to MAX_LOCKED_LAUNCHES_PER_ROW launches each. */
export function sanitizeLockedLaunches(raw: unknown): LockedLaunch[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rows: LockedLaunch[] = [];
  for (const value of raw) {
    if (rows.length >= MAX_LOCKED_LAUNCH_ROWS || !value || typeof value !== "object") {
      continue;
    }
    const record = value as Record<string, unknown>;
    const ship = typeof record.ship === "string" ? record.ship : "";
    const launches = Math.round(Number(record.launches));
    if (!SEND_SHIPS.includes(ship) || !isSendDurationType(record.durationType) || !(launches >= 1)) {
      continue;
    }
    const target = record.targetAfxId;
    const targetAfxId = SEND_UNTARGETED_ONLY_SHIPS.has(ship)
      ? SEND_UNTARGETED_TARGET_AFX_ID
      : typeof target === "number" && Number.isInteger(target) && target >= 0
        ? target
        : null;
    rows.push({
      ship,
      durationType: record.durationType,
      targetAfxId,
      launches: Math.min(MAX_LOCKED_LAUNCHES_PER_ROW, launches),
      ...(record.dubcap === true ? { dubcap: true } : {}),
    });
  }
  return rows;
}

/** "Henerprise extended" (lowercase length, as plan notes read). */
export function lockedShipLengthLabel(ship: string, durationType: string): string {
  const length = SEND_DURATIONS.find((entry) => entry.value === durationType)?.label ?? durationType;
  return `${shipDisplayName(ship)} ${length.toLowerCase()}`;
}

/** "2 Henerprise extended, any target". */
export function describeLockedLaunch(lock: LockedLaunch): string {
  const target =
    lock.targetAfxId === null
      ? "any target"
      : isUntargetedTargetAfxId(lock.targetAfxId)
        ? "untargeted"
        : afxIdToTargetFamilyName(lock.targetAfxId);
  return `${lock.launches} ${lockedShipLengthLabel(lock.ship, lock.durationType)}, ${target}`;
}

/**
 * The locks on one ship and length, in the dubcap or out of it: `launches`
 * in all, of which `targets` name their target. Rows at named targets only
 * share a target with each other, so a plan meets every row when it has
 * enough launches at each named target and enough in all.
 */
export type LockedLaunchGroup = {
  ship: string;
  durationType: SendDurationType;
  dubcap: boolean;
  launches: number;
  targets: Array<{ targetAfxId: number; launches: number }>;
};

/** Rows grouped for the solve; a dubcap row counts as an ordinary one when the plan has no dubcap. */
export function groupLockedLaunches(locks: LockedLaunch[], includeDubcap: boolean): LockedLaunchGroup[] {
  const groups = new Map<string, LockedLaunchGroup>();
  for (const lock of locks) {
    const dubcap = Boolean(lock.dubcap) && includeDubcap;
    const key = `${lock.ship}|${lock.durationType}|${dubcap ? 1 : 0}`;
    let group = groups.get(key);
    if (!group) {
      group = { ship: lock.ship, durationType: lock.durationType, dubcap, launches: 0, targets: [] };
      groups.set(key, group);
    }
    group.launches += lock.launches;
    if (lock.targetAfxId !== null) {
      const target = isUntargetedTargetAfxId(lock.targetAfxId) ? SEND_UNTARGETED_TARGET_AFX_ID : lock.targetAfxId;
      const entry = group.targets.find((existing) => existing.targetAfxId === target);
      if (entry) {
        entry.launches += lock.launches;
      } else {
        group.targets.push({ targetAfxId: target, launches: lock.launches });
      }
    }
  }
  return Array.from(groups.values());
}

export function lockedLaunchGroupsKey(groups: LockedLaunchGroup[]): string {
  return groups
    .map(
      (group) =>
        `${group.ship}|${group.durationType}|${group.dubcap ? "d" : "o"}|${group.launches}|${group.targets
          .map((target) => `${target.targetAfxId}:${target.launches}`)
          .sort()
          .join(",")}`
    )
    .sort()
    .join(";");
}

/** Whether a launch at `targetAfxId` counts toward a lock at `lockTargetAfxId` (untargeted ids all alike). */
export function lockedTargetMatches(lockTargetAfxId: number, targetAfxId: number): boolean {
  return isUntargetedTargetAfxId(lockTargetAfxId) ? isUntargetedTargetAfxId(targetAfxId) : lockTargetAfxId === targetAfxId;
}

export function lockedGroupMatches(
  group: LockedLaunchGroup,
  mission: { ship: string; durationType: string; dubcap?: boolean }
): boolean {
  return mission.ship === group.ship && mission.durationType === group.durationType && Boolean(mission.dubcap) === group.dubcap;
}

/**
 * How many of each plan row's launches are locked ones: launches at named
 * targets first, then the any-target locks, lowest stars first (they fly
 * first). Rows already in the air don't count.
 */
export function assignLockedLaunches(
  rows: ReadonlyArray<{ ship: string; durationType: string; level: number; targetAfxId: number; launches: number; dubcap?: boolean; inAir?: boolean }>,
  groups: LockedLaunchGroup[]
): number[] {
  const locked = rows.map(() => 0);
  for (const group of groups) {
    const order = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !row.inAir && lockedGroupMatches(group, row))
      .sort((a, b) => a.row.level - b.row.level || a.index - b.index);
    const take = (want: number, fits: (targetAfxId: number) => boolean): number => {
      let left = want;
      for (const { row, index } of order) {
        if (left <= 0) {
          break;
        }
        if (!fits(row.targetAfxId)) {
          continue;
        }
        const room = Math.max(0, Math.round(row.launches) - locked[index]);
        const taken = Math.min(room, left);
        locked[index] += taken;
        left -= taken;
      }
      return want - left;
    };
    let named = 0;
    for (const target of group.targets) {
      named += take(target.launches, (targetAfxId) => lockedTargetMatches(target.targetAfxId, targetAfxId));
    }
    take(Math.max(0, group.launches - named), () => true);
  }
  return locked;
}
