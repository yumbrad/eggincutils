import { describe, expect, it } from "vitest";

import { launchesSince, MAX_RECENT_LAUNCHES, planLaunchProgress, type LaunchRecord } from "./launch-progress";
import { parseRecentLaunches } from "./profile";

let nextId = 0;
const launch = (
  ship: string,
  durationType: string,
  targetAfxId: number | null,
  launchedAt: number,
  virtue = true
): LaunchRecord => ({ id: `m${(nextId += 1)}`, ship, durationType, targetAfxId, level: 3, launchedAt, virtue });

const row = (ship: string, durationType: string, targetAfxId: number, launches: number, level = 3, inAir = false) => ({
  ship,
  durationType,
  targetAfxId,
  level,
  launches,
  ...(inAir ? { inAir } : {}),
});

describe("launchesSince", () => {
  it("keeps only launches the baseline didn't have, oldest first", () => {
    const old = launch("HENERPRISE", "EPIC", 3, 100);
    const newer = launch("HENERPRISE", "EPIC", 3, 300);
    const newest = launch("HENERPRISE", "EPIC", 3, 400);
    expect(launchesSince([old], [old, newest, newer]).map((entry) => entry.launchedAt)).toEqual([300, 400]);
  });
});

describe("planLaunchProgress", () => {
  const baseline = [launch("HENERPRISE", "EPIC", 3, 100)];

  it("counts launches against matching rows and flags the rest as off the plan", () => {
    const progress = planLaunchProgress({
      missions: [row("HENERPRISE", "EPIC", 3, 4), row("VOYEGGER", "SHORT", 5, 2, 2), row("ATREGGIES", "EPIC", 9, 3, 1, true)],
      prepLaunches: [],
      fueling: null,
      virtue: true,
      baseline,
      current: [
        ...baseline,
        launch("HENERPRISE", "EPIC", 3, 200),
        launch("HENERPRISE", "EPIC", 3, 210),
        launch("VOYEGGER", "SHORT", 5, 220),
        // Wrong target, and a launch from the main farm, which isn't this plan's.
        launch("VOYEGGER", "SHORT", 7, 230),
        launch("HENERPRISE", "EPIC", 3, 240, false),
      ],
    });
    expect(progress.missionDone).toEqual([2, 1, 0]);
    expect(progress.planned).toBe(6);
    expect(progress.done).toBe(3);
    expect(progress.offPlan.map((entry) => entry.targetAfxId)).toEqual([7]);
    expect(progress.incomplete).toBe(false);
  });

  it("fills lower-star rows first and treats untargeted sends alike", () => {
    const progress = planLaunchProgress({
      missions: [row("HENERPRISE", "SHORT", 10000, 1, 5), row("HENERPRISE", "SHORT", 10000, 1, 4)],
      prepLaunches: [],
      fueling: null,
      virtue: true,
      baseline,
      current: [...baseline, launch("HENERPRISE", "SHORT", null, 200)],
    });
    expect(progress.missionDone).toEqual([0, 1]);
  });

  it("matches the partly fueled ship first and prep launches at any target", () => {
    const progress = planLaunchProgress({
      missions: [row("CHICKFIANT", "SHORT", 3, 2)],
      // 3 Chickfiant shorts of prep: the 2 mission launches count toward them, 1 is left.
      prepLaunches: [{ ship: "CHICKFIANT", durationType: "SHORT", launches: 3 }],
      fueling: { ship: "HENERPRISE", durationType: "EPIC", targetAfxId: null },
      virtue: true,
      baseline,
      current: [
        ...baseline,
        launch("HENERPRISE", "EPIC", null, 150),
        launch("CHICKFIANT", "SHORT", 3, 200),
        launch("CHICKFIANT", "SHORT", 3, 210),
        launch("CHICKFIANT", "SHORT", 8, 220),
        launch("CHICKFIANT", "SHORT", 8, 230),
      ],
    });
    expect(progress.fuelingDone).toBe(true);
    expect(progress.missionDone).toEqual([2]);
    expect(progress.prepDone).toEqual([1]);
    expect(progress.planned).toBe(4);
    expect(progress.done).toBe(4);
    expect(progress.offPlan).toHaveLength(1);
  });

  it("says when the plan's start has fallen out of the kept launches", () => {
    const current = Array.from({ length: MAX_RECENT_LAUNCHES }, (_, index) => launch("HENERPRISE", "EPIC", 3, 1000 + index));
    const progress = planLaunchProgress({
      missions: [row("HENERPRISE", "EPIC", 3, 4)],
      prepLaunches: [],
      fueling: null,
      virtue: true,
      baseline,
      current,
    });
    expect(progress.incomplete).toBe(true);
  });
});

describe("parseRecentLaunches", () => {
  it("keeps launched missions with an id and launch time, tags their farm and target, oldest first", () => {
    const launches = parseRecentLaunches(
      [
        { ship: "HENERPRISE", durationType: "EPIC", status: "ARCHIVED", identifier: "b", startTimeDerived: 200, level: 6, targetArtifact: "PUZZLE_CUBE" },
        { ship: "HENERPRISE", durationType: "EPIC", status: "EXPLORING", identifier: "a", startTimeDerived: 100, type: "VIRTUE" },
        { ship: "HENERPRISE", durationType: "EPIC", status: "FUELING", identifier: "c", startTimeDerived: 300 },
        { ship: "HENERPRISE", durationType: "EPIC", status: "COMPLETE", startTimeDerived: 400 },
      ],
      { PUZZLE_CUBE: 23 }
    );
    expect(launches).toEqual([
      { id: "a", ship: "HENERPRISE", durationType: "EPIC", targetAfxId: null, level: 0, launchedAt: 100, virtue: true },
      { id: "b", ship: "HENERPRISE", durationType: "EPIC", targetAfxId: 23, level: 6, launchedAt: 200, virtue: false },
    ]);
  });
});
