import fs from "fs";
import path from "path";

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
const DEFAULT_LOOT_CACHE_FILE = "/tmp/eggincutils-loot-cache.json";
const DEFAULT_LOOT_FALLBACK_FILE = path.join(process.cwd(), "data", "loot-data-snapshot.json");
const DEFAULT_LOOT_CACHE_TTL_SECONDS = 24 * 60 * 60;

let cache: LootJson | null = null;
let inflight: Promise<LootJson> | null = null;
let refreshInflight: Promise<void> | null = null;
let cacheEtag: string | null = null;
let cacheFetchedAtMs = 0;

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

function lootCacheFilePath(): string {
  return process.env.LOOT_DATA_CACHE_FILE || DEFAULT_LOOT_CACHE_FILE;
}

function lootFallbackFilePath(): string {
  return process.env.LOOT_DATA_FALLBACK_FILE || DEFAULT_LOOT_FALLBACK_FILE;
}

function lootCacheTtlSeconds(): number {
  const raw = Number(process.env.LOOT_DATA_CACHE_TTL_SECONDS || DEFAULT_LOOT_CACHE_TTL_SECONDS);
  if (!Number.isFinite(raw)) {
    return DEFAULT_LOOT_CACHE_TTL_SECONDS;
  }
  return Math.max(0, Math.round(raw));
}

type PersistedLootCache = {
  fetchedAtMs: number;
  etag?: string;
  payload: LootJson;
};

function parseLootPayload(payload: unknown): LootJson {
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
  return parsed.data;
}

function ensureParentDirectory(filePath: string): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
}

function readPersistedCache(filePath: string): PersistedLootCache | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const rawText = fs.readFileSync(filePath, "utf8");
    if (!rawText.trim()) {
      return null;
    }
    const parsed = JSON.parse(rawText) as Partial<PersistedLootCache>;
    if (parsed && parsed.payload && typeof parsed.fetchedAtMs === "number") {
      return {
        fetchedAtMs: Math.max(0, Math.round(parsed.fetchedAtMs)),
        etag: typeof parsed.etag === "string" && parsed.etag.length > 0 ? parsed.etag : undefined,
        payload: parseLootPayload(parsed.payload),
      };
    }

    // Backward compatibility: allow a raw LootJson snapshot file.
    const payload = parseLootPayload(parsed);
    return {
      fetchedAtMs: 0,
      payload,
    };
  } catch {
    return null;
  }
}

function writePersistedCache(filePath: string, record: PersistedLootCache): void {
  ensureParentDirectory(filePath);
  const tempFile = `${filePath}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(record));
  fs.renameSync(tempFile, filePath);
}

function isCacheFresh(fetchedAtMs: number): boolean {
  const ttlMs = lootCacheTtlSeconds() * 1000;
  if (ttlMs <= 0) {
    return false;
  }
  if (fetchedAtMs <= 0) {
    return false;
  }
  return Date.now() - fetchedAtMs <= ttlMs;
}

async function fetchRemoteLoot(currentEtag?: string, allowNotModifiedPayload?: LootJson): Promise<PersistedLootCache> {
  const headers: Record<string, string> = {};
  if (currentEtag) {
    headers["If-None-Match"] = currentEtag;
  }
  const response = await fetch(lootUrl(), {
    method: "GET",
    cache: "no-store",
    headers,
  });
  if (response.status === 304 && allowNotModifiedPayload) {
    return {
      fetchedAtMs: Date.now(),
      etag: currentEtag,
      payload: allowNotModifiedPayload,
    };
  }
  if (!response.ok) {
    throw new LootDataError(`loot data request failed: HTTP ${response.status}`);
  }
  const payload = parseLootPayload(await response.json());
  const etag = response.headers.get("etag") || undefined;
  return {
    fetchedAtMs: Date.now(),
    etag,
    payload,
  };
}

function triggerBackgroundRefresh(cachedPayload: LootJson | null): void {
  if (refreshInflight) {
    return;
  }
  refreshInflight = (async () => {
    try {
      const refreshed = await fetchRemoteLoot(cacheEtag || undefined, cachedPayload || undefined);
      cache = refreshed.payload;
      cacheEtag = refreshed.etag || null;
      cacheFetchedAtMs = refreshed.fetchedAtMs;
      try {
        writePersistedCache(lootCacheFilePath(), refreshed);
      } catch {
        // Ignore filesystem cache write failures.
      }
    } catch {
      // Keep stale data when refresh fails.
    } finally {
      refreshInflight = null;
    }
  })();
}

export async function loadLootData(): Promise<LootJson> {
  if (cache) {
    if (!isCacheFresh(cacheFetchedAtMs)) {
      triggerBackgroundRefresh(cache);
    }
    return cache;
  }
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    const cacheFilePath = lootCacheFilePath();
    const persisted = readPersistedCache(cacheFilePath);
    if (persisted) {
      cache = persisted.payload;
      cacheEtag = persisted.etag || null;
      cacheFetchedAtMs = persisted.fetchedAtMs;
      if (isCacheFresh(persisted.fetchedAtMs)) {
        return persisted.payload;
      }
      triggerBackgroundRefresh(persisted.payload);
      return persisted.payload;
    }

    const fallback = readPersistedCache(lootFallbackFilePath());
    if (fallback) {
      cache = fallback.payload;
      cacheEtag = fallback.etag || null;
      cacheFetchedAtMs = fallback.fetchedAtMs;
      triggerBackgroundRefresh(fallback.payload);
      return fallback.payload;
    }

    const remote = await fetchRemoteLoot(cacheEtag || undefined, cache || undefined);
    cache = remote.payload;
    cacheEtag = remote.etag || null;
    cacheFetchedAtMs = remote.fetchedAtMs;
    try {
      writePersistedCache(cacheFilePath, remote);
    } catch {
      // Ignore filesystem cache write failures.
    }
    return remote.payload;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

export function resetLootDataCacheForTests(): void {
  cache = null;
  inflight = null;
  refreshInflight = null;
  cacheEtag = null;
  cacheFetchedAtMs = 0;
}
