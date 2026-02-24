import { z } from "zod";

export type LootJson = {
  missions: MissionLootStore[];
};

export type MissionLootStore = {
  afxShip: number;
  afxDurationType: number;
  missionId: string;
  levels: MissionLevelLootStore[];
};

export type MissionLevelLootStore = {
  level: number;
  targets: MissionTargetLootStore[];
};

export type MissionTargetLootStore = {
  totalDrops: number;
  targetAfxId: number;
  items: ArtifactTierLootStore[];
};

export type ArtifactTierLootStore = {
  afxId: number;
  afxLevel: number;
  itemId: string;
  counts: [number, number, number, number];
};

const DEFAULT_LOOT_URL =
  "https://eggincdatacollection.azurewebsites.net/api/GetCarpetDataTrimmed?newDropsOnly";

let cache: LootJson | null = null;
let inflight: Promise<LootJson> | null = null;

const nonNegativeNumberSchema = z.number().finite().min(0);

const artifactTierLootStoreSchema = z.object({
  afxId: z.number().int(),
  afxLevel: z.number().int(),
  itemId: z.string().min(1),
  counts: z.tuple([
    nonNegativeNumberSchema,
    nonNegativeNumberSchema,
    nonNegativeNumberSchema,
    nonNegativeNumberSchema,
  ]),
});

const missionTargetLootStoreSchema = z.object({
  totalDrops: nonNegativeNumberSchema,
  targetAfxId: z.number().int(),
  items: z.array(artifactTierLootStoreSchema),
});

const missionLevelLootStoreSchema = z.object({
  level: z.number().int().min(0),
  targets: z.array(missionTargetLootStoreSchema),
});

const missionLootStoreSchema = z.object({
  afxShip: z.number().int(),
  afxDurationType: z.number().int(),
  missionId: z.string().min(1),
  levels: z.array(missionLevelLootStoreSchema),
});

const lootJsonSchema = z.object({
  missions: z.array(missionLootStoreSchema),
});

function zodIssueSummary(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "unknown validation issue";
  }
  const path = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${path}: ${issue.message}`;
}

export class LootDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LootDataError";
  }
}

function lootUrl(): string {
  return process.env.LOOT_DATA_URL || DEFAULT_LOOT_URL;
}

export async function loadLootData(): Promise<LootJson> {
  if (cache) {
    return cache;
  }
  if (inflight) {
    return inflight;
  }
  inflight = fetch(lootUrl(), {
    method: "GET",
    cache: "no-store",
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new LootDataError(`loot data request failed: HTTP ${response.status}`);
      }
      return await response.json();
    })
    .then((payload) => {
      const parsed = lootJsonSchema.safeParse(payload);
      if (!parsed.success) {
        throw new LootDataError(`loot data schema validation failed (${zodIssueSummary(parsed.error)})`);
      }
      if (parsed.data.missions.length === 0) {
        throw new LootDataError("loot data response was empty (no missions)");
      }
      const hasAnyTargets = parsed.data.missions.some((mission) =>
        mission.levels.some((level) => level.targets.length > 0)
      );
      if (!hasAnyTargets) {
        throw new LootDataError("loot data response contained no mission targets");
      }
      cache = parsed.data;
      return parsed.data;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function resetLootDataCacheForTests(): void {
  cache = null;
  inflight = null;
}
