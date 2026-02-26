import fs from "fs/promises";
import path from "path";

import { playerProfileSchema } from "../lib/api-schemas";
import { getPlayerProfile } from "../lib/profile";

const INCLUDE_SLOTTED = true;
const SNAPSHOT_PATH = path.join(
  process.cwd(),
  "benchmarks",
  "mission-craft-planner",
  "profile-snapshot-benchmark.json"
);

type ProfileSnapshotFile = {
  schemaVersion: 1;
  capturedAt: string;
  includeSlotted: boolean;
  profile: ReturnType<typeof playerProfileSchema.parse>;
};

async function main(): Promise<void> {
  const benchmarkEid = process.env.BENCHMARK_EID || process.argv[2];
  if (!benchmarkEid) {
    throw new Error("missing EID: set BENCHMARK_EID or pass it as the first argument");
  }

  console.log("Fetching live profile snapshot for provided EID...");
  const profile = await getPlayerProfile(benchmarkEid, INCLUDE_SLOTTED);
  const validated = playerProfileSchema.parse(profile);

  const payload: ProfileSnapshotFile = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    includeSlotted: INCLUDE_SLOTTED,
    profile: {
      ...validated,
      eid: "REDACTED",
    },
  };

  await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
  await fs.writeFile(SNAPSHOT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`Saved benchmark profile snapshot: ${SNAPSHOT_PATH}`);
  console.log(
    `Inventory items: ${Object.keys(validated.inventory).length}, craft counts: ${Object.keys(
      validated.craftCounts
    ).length}, ship entries: ${validated.shipLevels.length}`
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to archive benchmark profile: ${message}`);
  process.exit(1);
});
