import axios from "axios";
import protobuf from "protobufjs";
import path from "path";
import zlib from "zlib";

import { buildMissionOptions, computeShipLevels, MissionRecord, ShipLevelInfo } from "./ship-data";
import {
  parseVirtueTankFuels,
  parseVirtueTankLimits,
  virtueTankCapacityForLevel,
  VIRTUE_TANK_CAPACITIES,
  type VirtueTankEggKey,
  type VirtueTankSnapshot,
} from "./virtue-fuel";

export type Inventory = Record<string, number>;
export type CraftCounts = Record<string, number>;
export type InventorySource = "main" | "virtue";
export type ShinyRaritySelection = {
  rare: boolean;
  epic: boolean;
  legendary: boolean;
};

export type PlayerProfile = {
  eid: string;
  inventory: Inventory;
  craftCounts: CraftCounts;
  craftingXp: number;
  epicResearchFTLLevel: number;
  epicResearchZerogLevel: number;
  shipLevels: ShipLevelInfo[];
  missionOptions: ReturnType<typeof buildMissionOptions>;
  /** Absent for synthetic profiles (demo, benchmark snapshots). */
  inFlightMissions?: InFlightMission[];
  /** Rare/epic/legendary artifacts counted as ingredients under the requested rarity selection. */
  shinyIngredientCount?: number;
  /** Path of Virtue fuel tank and shift state; absent when the player has no virtue data. */
  virtueTank?: VirtueTankSnapshot;
};

/**
 * A launched mission whose loot has not landed in the artifact inventory yet:
 * still flying, or back but not collected. These already count toward ship
 * levels, but their drops exist nowhere in `inventory`.
 */
export type InFlightMission = {
  ship: string;
  durationType: string;
  status: string;
  level: number;
  capacity: number;
  /** null when the mission was sent without a target. */
  targetAfxId: number | null;
  secondsRemaining: number;
};

type BackupInventoryItem = {
  artifact?: {
    spec?: {
      name?: string;
      level?: string | number;
      rarity?: string;
    };
    stones?: Array<{
      name?: string;
      level?: string | number;
      rarity?: string;
    }>;
  };
  quantity?: number;
};

type BackupCraftableArtifact = {
  spec?: {
    name?: string;
    level?: string | number;
  };
  count?: number;
};

type BackupMissionInfo = {
  ship?: string;
  durationType?: string;
  status?: string;
};

/**
 * Decoded with `defaults: false` so an absent `targetArtifact` stays absent
 * rather than collapsing to the enum's zero value (which would read as a
 * Lunar Totem target on every untargeted mission).
 */
type SparseMissionInfo = BackupMissionInfo & {
  level?: number;
  capacity?: number;
  secondsRemaining?: number;
  /** Unix seconds when the mission launched. */
  startTimeDerived?: number;
  durationSeconds?: number;
  targetArtifact?: string;
  /** Absent means STANDARD — the proto's zero value. */
  type?: string;
};

type GetPlayerProfileOptions = {
  includeArtifactRarities?: Partial<ShinyRaritySelection>;
  includeShinyArtifacts?: boolean;
  includeStoneFragments?: boolean;
  inventorySource?: InventorySource;
};

type BackupArtifactsDb = {
  inventoryItems?: BackupInventoryItem[];
  artifactStatus?: BackupCraftableArtifact[];
  missionArchive?: BackupMissionInfo[];
  missionInfos?: BackupMissionInfo[];
  virtueAfxDb?: {
    inventoryItems?: BackupInventoryItem[];
    /** The virtue DB's own craft status list; see craftCountsForSource. */
    artifactStatus?: BackupCraftableArtifact[];
  };
};

/**
 * The slice of a decoded `Backup` the virtue tank is read from. Decoded with
 * `defaults: true`, so an absent message field reads as null and an absent
 * repeated field as [].
 */
type BackupVirtueTankSource = {
  /** Unix seconds of the client's last sync. */
  approxTime?: number | null;
  artifacts?: {
    /** The one tank level, shared by both farms. */
    tankLevel?: number | null;
  } | null;
  virtue?: {
    shiftCount?: number | null;
    afx?: {
      tankFuels?: number[] | null;
      tankLimits?: number[] | null;
      tankFillingEnabled?: boolean | null;
    } | null;
  } | null;
  game?: {
    soulEggsD?: number | null;
  } | null;
  farms?: Array<{ eggType?: string | number | null }> | null;
};

interface AuthenticatedMessagePayload {
  message?: Uint8Array;
  compressed?: boolean;
  originalSize?: number;
}

const BACKUP_URL = "https://www.auxbrain.com/ei/bot_first_contact";
const PROTO_PATH = path.join(process.cwd(), "data", "ei.proto");
const LEVEL_INDEX: Record<string, number> = {
  INFERIOR: 0,
  LESSER: 1,
  NORMAL: 2,
  GREATER: 3,
  SUPERIOR: 4,
};
const VERSION_CANDIDATES = [
  {
    clientVersion: Number(process.env.EI_CLIENT_VERSION || "70"),
    appVersion: process.env.EI_APP_VERSION || "1.35",
    platform: process.env.EI_PLATFORM || "IOS",
    platformValue: Number(process.env.EI_PLATFORM_VALUE || "2"),
  },
  {
    clientVersion: 68,
    appVersion: "1.28.0",
    platform: "ANDROID",
    platformValue: 1,
  },
];

let protoRootPromise: Promise<protobuf.Root> | null = null;

export async function getPlayerProfile(
  eid: string,
  includeSlotted = true,
  options: GetPlayerProfileOptions = {}
): Promise<PlayerProfile> {
  const root = await getProtoRoot();
  const RequestMessage = root.lookupType("ei.EggIncFirstContactRequest");
  const ResponseMessage = root.lookupType("ei.EggIncFirstContactResponse");
  const AuthenticatedMessage = root.lookupType("ei.AuthenticatedMessage");
  const includeArtifactRarities = normalizeShinyRaritySelection(
    options.includeArtifactRarities ?? options.includeShinyArtifacts
  );
  const includeStoneFragments = options.includeStoneFragments !== false;
  const inventorySource = options.inventorySource || "main";

  let lastError: unknown = null;

  for (const version of VERSION_CANDIDATES) {
    try {
      const payload = {
        eiUserId: eid,
        clientVersion: version.clientVersion,
        deviceId: "eggincutils",
        platform: version.platformValue,
        rinfo: {
          build: version.appVersion,
          clientVersion: version.clientVersion,
          platform: version.platform,
          version: version.appVersion,
        },
      };
      const errMsg = RequestMessage.verify(payload);
      if (errMsg) {
        throw new Error(errMsg);
      }

      const message = RequestMessage.create(payload);
      const buffer = RequestMessage.encode(message).finish();
      const formBody = new URLSearchParams({
        data: Buffer.from(buffer).toString("base64"),
      }).toString();

      const response = await axios.post(BACKUP_URL, formBody, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        responseType: "arraybuffer",
      });

      const decodedResponse = decodeFirstContactResponse({
        responseBytes: normalizeResponseBytes(new Uint8Array(response.data)),
        ResponseMessage,
        AuthenticatedMessage,
      });

      const data = ResponseMessage.toObject(decodedResponse, {
        longs: String,
        enums: String,
        defaults: true,
      }) as {
        errorCode?: string | number;
        errorMessage?: string;
        backup?: {
          /** Unix seconds of the client's last sync. */
          approxTime?: number;
          artifacts?: {
            craftingXp?: number;
            tankLevel?: number;
          };
          virtue?: {
            shiftCount?: number;
            afx?: {
              tankFuels?: number[];
              tankLimits?: number[];
              tankFillingEnabled?: boolean;
            } | null;
          } | null;
          game?: {
            epicResearch?: Array<{ id?: string; level?: number }>;
            soulEggsD?: number;
          };
          farms?: Array<{ eggType?: string }>;
          artifactsDb?: BackupArtifactsDb;
        };
      };

      if (data.errorCode && data.errorCode !== "NO_ERROR" && data.errorCode !== 0) {
        throw new Error(data.errorMessage || "error fetching backup");
      }

      const inventoryItems = inventoryItemsForSource(data.backup?.artifactsDb, inventorySource);
      const inventory = parseInventory(
        inventoryItems,
        includeSlotted,
        includeArtifactRarities,
        includeStoneFragments
      );
      const shinyIngredientCount = countShinyIngredients(inventoryItems, includeSlotted, includeArtifactRarities);
      const craftCounts = craftCountsForSource(data.backup?.artifactsDb, inventorySource);
      const missionArchive = data.backup?.artifactsDb?.missionArchive || [];
      const missionInfos = data.backup?.artifactsDb?.missionInfos || [];
      const missions = parseMissions([...missionArchive, ...missionInfos]);

      let epicResearchFTLLevel = 0;
      let epicResearchZerogLevel = 0;
      for (const research of data.backup?.game?.epicResearch || []) {
        if (research.id === "afx_mission_time") {
          epicResearchFTLLevel = research.level || 0;
        }
        if (research.id === "afx_mission_capacity") {
          epicResearchZerogLevel = research.level || 0;
        }
      }

      const shipLevels = computeShipLevels(missions);
      const missionOptions = buildMissionOptions(shipLevels, epicResearchFTLLevel, epicResearchZerogLevel);
      const inFlightMissions = parseInFlightMissions(
        sparseMissionInfos(decodedResponse, root),
        root.lookupEnum("ei.ArtifactSpec.Name").values,
        inventorySource,
        { backupApproxTimeSeconds: data.backup?.approxTime || 0 }
      );

      return {
        eid,
        inventory,
        craftCounts,
        craftingXp: Math.max(0, Math.floor(data.backup?.artifacts?.craftingXp || 0)),
        epicResearchFTLLevel,
        epicResearchZerogLevel,
        shipLevels,
        missionOptions,
        inFlightMissions,
        shinyIngredientCount,
        virtueTank: parseVirtueTank(data.backup),
      };
    } catch (error) {
      lastError = error;
    }
  }

  const details = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`unable to fetch profile for EID ${eid}: ${details}`);
}

export function inventoryItemsForSource(
  artifactsDb: BackupArtifactsDb | undefined,
  inventorySource: InventorySource
): BackupInventoryItem[] {
  if (inventorySource === "virtue") {
    return artifactsDb?.virtueAfxDb?.inventoryItems || [];
  }
  return artifactsDb?.inventoryItems || [];
}

/**
 * Virtue mode adds the virtue DB's own craft counts on top of the main farm's,
 * as carpetsage's PoV optimizer does, rather than replacing them: in real
 * backups every virtue `artifact_status` count is 0 (and never `discovered`)
 * even with a well-stocked virtue inventory, so reading it alone would wipe
 * the craft discount. Main mode reads only the main counts.
 */
export function craftCountsForSource(
  artifactsDb: BackupArtifactsDb | undefined,
  inventorySource: InventorySource
): CraftCounts {
  const craftCounts = parseCraftCounts(artifactsDb?.artifactStatus || []);
  if (inventorySource !== "virtue") {
    return craftCounts;
  }
  for (const [name, count] of Object.entries(parseCraftCounts(artifactsDb?.virtueAfxDb?.artifactStatus || []))) {
    craftCounts[name] = (craftCounts[name] || 0) + count;
  }
  return craftCounts;
}

const VIRTUE_EGG_BY_ENUM: Record<string, VirtueTankEggKey> = {
  CURIOSITY: "curiosity",
  INTEGRITY: "integrity",
  HUMILITY: "humility",
  RESILIENCE: "resilience",
  KINDNESS: "kindness",
};
const VIRTUE_EGG_BY_ENUM_VALUE: Record<number, VirtueTankEggKey> = {
  50: "curiosity",
  51: "integrity",
  52: "humility",
  53: "resilience",
  54: "kindness",
};

function virtueEggForEggType(eggType: string | number | null | undefined): VirtueTankEggKey | null {
  if (typeof eggType === "number") {
    return VIRTUE_EGG_BY_ENUM_VALUE[eggType] ?? null;
  }
  if (typeof eggType === "string") {
    return VIRTUE_EGG_BY_ENUM[eggType.trim().toUpperCase()] ?? null;
  }
  return null;
}

/**
 * The virtue egg the player is on, or null when they are on the main game.
 * The Path of Virtue takes over the home farm (`farms[0]`) and contract farms
 * never run a virtue egg, so the first farm with one is it. Not
 * `game.currentFarm`: that is just the farm on screen, so a backup synced from
 * a contract farm would lose the egg.
 */
function currentVirtueEgg(farms: BackupVirtueTankSource["farms"]): VirtueTankEggKey | null {
  for (const farm of farms || []) {
    const egg = virtueEggForEggType(farm?.eggType);
    if (egg) {
      return egg;
    }
  }
  return null;
}

function finiteNonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Path of Virtue fuel tank state, or undefined when the backup has no virtue
 * data at all.
 *
 * Capacity comes from `artifacts.tankLevel`: the tank level is shared by both
 * farms and only recorded there — `virtue.afx.tankLevel` is not set, so it
 * decodes as 0. The virtue eggs' contents and fill caps do live in
 * `virtue.afx`.
 */
export function parseVirtueTank(backup: BackupVirtueTankSource | null | undefined): VirtueTankSnapshot | undefined {
  const virtue = backup?.virtue;
  if (!virtue) {
    return undefined;
  }
  const tankLevel = Math.min(
    VIRTUE_TANK_CAPACITIES.length - 1,
    Math.floor(finiteNonNegative(backup.artifacts?.tankLevel))
  );
  const approxTime = finiteNonNegative(backup.approxTime);
  return {
    tankLevel,
    capacity: virtueTankCapacityForLevel(tankLevel),
    fuels: parseVirtueTankFuels(virtue.afx?.tankFuels ?? undefined),
    limits: parseVirtueTankLimits(virtue.afx?.tankLimits ?? undefined),
    fillingEnabled: virtue.afx?.tankFillingEnabled === true,
    shiftCount: Math.floor(finiteNonNegative(virtue.shiftCount)),
    soulEggs: finiteNonNegative(backup.game?.soulEggsD),
    currentEgg: currentVirtueEgg(backup.farms),
    backupTimeSeconds: approxTime > 0 ? approxTime : null,
  };
}

async function getProtoRoot(): Promise<protobuf.Root> {
  if (!protoRootPromise) {
    protoRootPromise = protobuf.load(PROTO_PATH);
  }
  return protoRootPromise;
}

const SHINY_RARITIES = new Set(["RARE", "EPIC", "LEGENDARY"]);
const DEFAULT_INCLUDE_SHINY_RARITIES: ShinyRaritySelection = {
  rare: true,
  epic: true,
  legendary: true,
};

function normalizeShinyRaritySelection(
  raw?: boolean | Partial<ShinyRaritySelection>
): ShinyRaritySelection {
  if (typeof raw === "boolean") {
    return raw
      ? { ...DEFAULT_INCLUDE_SHINY_RARITIES }
      : { rare: false, epic: false, legendary: false };
  }
  if (!raw) {
    return { ...DEFAULT_INCLUDE_SHINY_RARITIES };
  }
  return {
    rare: raw.rare !== false,
    epic: raw.epic !== false,
    legendary: raw.legendary !== false,
  };
}

function shouldIncludeArtifactRarity(rarity: unknown, selection: ShinyRaritySelection): boolean {
  if (typeof rarity !== "string") {
    return true;
  }
  const normalized = rarity.trim().toUpperCase();
  if (!SHINY_RARITIES.has(normalized)) {
    return true;
  }
  if (normalized === "RARE") {
    return selection.rare;
  }
  if (normalized === "EPIC") {
    return selection.epic;
  }
  if (normalized === "LEGENDARY") {
    return selection.legendary;
  }
  return true;
}

function isShinyArtifactRarity(rarity: unknown): boolean {
  if (typeof rarity !== "string") {
    return false;
  }
  return SHINY_RARITIES.has(rarity.trim().toUpperCase());
}

function isStoneFragmentSpec(spec?: { name?: string }): boolean {
  return typeof spec?.name === "string" && spec.name.trim().toUpperCase().endsWith("_STONE_FRAGMENT");
}

export function parseInventory(
  items: BackupInventoryItem[],
  includeSlotted: boolean,
  includeShinyArtifacts: boolean | Partial<ShinyRaritySelection> = true,
  includeStoneFragments = true
): Inventory {
  const inventory = {} as Inventory;
  const includeShinyRarities = normalizeShinyRaritySelection(includeShinyArtifacts);
  const addQuantity = (spec: { name?: string; level?: string | number }, quantity: number) => {
    if (!includeStoneFragments && isStoneFragmentSpec(spec)) {
      return;
    }
    const name = formatSpecName(spec);
    if (!name || quantity <= 0) {
      return;
    }
    inventory[name] = (inventory[name] || 0) + quantity;
  };

  for (const item of items) {
    const quantity = Math.max(0, Math.round(item.quantity || 0));
    const spec = item.artifact?.spec;
    const stones = item.artifact?.stones || [];
    const excludeSlottedShinyArtifact =
      !includeSlotted && stones.length > 0 && isShinyArtifactRarity(item.artifact?.spec?.rarity);
    const canUseArtifactAsIngredient = shouldIncludeArtifactRarity(item.artifact?.spec?.rarity, includeShinyRarities);
    if (spec && canUseArtifactAsIngredient && !excludeSlottedShinyArtifact) {
      addQuantity(spec, quantity);
    }

    if (!includeSlotted) {
      continue;
    }

    for (const stone of stones) {
      addQuantity(stone, quantity > 0 ? quantity : 1);
    }
  }
  return inventory;
}

/**
 * Number of shiny (rare/epic/legendary) artifacts that parseInventory would count as
 * ingredients under the same slotted/rarity rules. Used to warn that they must be
 * demoted in game before crafting.
 */
export function countShinyIngredients(
  items: BackupInventoryItem[],
  includeSlotted: boolean,
  includeShinyArtifacts: boolean | Partial<ShinyRaritySelection> = true
): number {
  const includeShinyRarities = normalizeShinyRaritySelection(includeShinyArtifacts);
  let count = 0;
  for (const item of items) {
    const rarity = item.artifact?.spec?.rarity;
    if (!isShinyArtifactRarity(rarity) || !shouldIncludeArtifactRarity(rarity, includeShinyRarities)) {
      continue;
    }
    const stones = item.artifact?.stones || [];
    if (!includeSlotted && stones.length > 0) {
      continue;
    }
    if (!formatSpecName(item.artifact?.spec)) {
      continue;
    }
    count += Math.max(0, Math.round(item.quantity || 0));
  }
  return count;
}

export function parseCraftCounts(items: BackupCraftableArtifact[]): CraftCounts {
  const craftCounts = {} as CraftCounts;
  for (const item of items) {
    const name = formatSpecName(item.spec);
    if (!name) {
      continue;
    }
    craftCounts[name] = item.count || 0;
  }
  return craftCounts;
}

/**
 * Feeds ship levels, so this deliberately keeps both farms' missions: a virtue
 * launch levels the same ship a main-farm launch does. Do not filter these by
 * `MissionInfo.type` — only the in-air projection below is farm-specific.
 */
export function parseMissions(items: BackupMissionInfo[]): MissionRecord[] {
  const missions: MissionRecord[] = [];
  for (const item of items) {
    if (!item.ship || !item.durationType || !item.status) {
      continue;
    }
    missions.push({
      ship: item.ship,
      durationType: item.durationType,
      status: item.status,
    });
  }
  return missions;
}

// Launched, but the loot is still owed to the player: `EXPLORING` is in the
// air, `RETURNED`/`ANALYZING` are back but not yet collected. All three already
// count toward ship levels while contributing nothing to `inventory`.
const IN_FLIGHT_STATUSES = new Set(["EXPLORING", "RETURNED", "ANALYZING"]);

/**
 * `VirtueDB` has no mission list of its own, so both farms share one
 * `missionInfos` list and a mission only belongs to the farm named by its
 * `type`. Each farm has its own independent three mission slots, so an
 * outstanding mission from the other farm neither owes this farm drops nor
 * blocks a slot it could launch into — it is excluded outright.
 *
 * Note the deliberate asymmetry with `parseMissions` above, which does not
 * filter by type: launches from either farm level the same ships.
 */
function missionMatchesSource(type: string | undefined, inventorySource: InventorySource): boolean {
  const isVirtueMission = type === "VIRTUE";
  return isVirtueMission === (inventorySource === "virtue");
}

/**
 * How long until this mission actually lands, right now.
 *
 * `secondsRemaining` is a snapshot the client wrote at its last sync, so by the
 * time we read the backup it is stale by however long ago that was — often
 * hours. The launch timestamp is absolute, so `launch + duration` gives a real
 * return time regardless of when the player last opened the game. Only when
 * that is missing do we fall back to ageing the snapshot by the backup's own
 * timestamp.
 *
 * A mission whose return time has already passed reads as 0: it has landed and
 * is waiting to be collected, even if the stale backup still says EXPLORING.
 */
function secondsUntilReturn(
  item: SparseMissionInfo,
  nowSeconds: number,
  backupApproxTimeSeconds: number
): number {
  if (item.startTimeDerived && item.durationSeconds) {
    return Math.max(0, item.startTimeDerived + item.durationSeconds - nowSeconds);
  }
  const snapshot = item.secondsRemaining || 0;
  const staleness = backupApproxTimeSeconds > 0 ? Math.max(0, nowSeconds - backupApproxTimeSeconds) : 0;
  return Math.max(0, snapshot - staleness);
}

export function parseInFlightMissions(
  items: SparseMissionInfo[],
  artifactAfxIdByName: Record<string, number>,
  inventorySource: InventorySource = "main",
  timing: { nowSeconds?: number; backupApproxTimeSeconds?: number } = {}
): InFlightMission[] {
  const nowSeconds = timing.nowSeconds ?? Date.now() / 1000;
  const backupApproxTimeSeconds = timing.backupApproxTimeSeconds ?? 0;
  const missions: InFlightMission[] = [];
  for (const item of items) {
    if (!item.ship || !item.durationType || !item.status) {
      continue;
    }
    if (!IN_FLIGHT_STATUSES.has(item.status)) {
      continue;
    }
    if (!missionMatchesSource(item.type, inventorySource)) {
      continue;
    }
    const targetAfxIdRaw = item.targetArtifact != null ? artifactAfxIdByName[item.targetArtifact] : undefined;
    missions.push({
      ship: item.ship,
      durationType: item.durationType,
      status: item.status,
      level: Math.max(0, Math.round(item.level || 0)),
      capacity: Math.max(0, Math.round(item.capacity || 0)),
      targetAfxId: typeof targetAfxIdRaw === "number" ? targetAfxIdRaw : null,
      secondsRemaining: Math.round(secondsUntilReturn(item, nowSeconds, backupApproxTimeSeconds)),
    });
  }
  return missions;
}

function sparseMissionInfos(decodedResponse: protobuf.Message, root: protobuf.Root): SparseMissionInfo[] {
  const missionInfoType = root.lookupType("ei.MissionInfo");
  const raw = (
    decodedResponse as unknown as {
      backup?: { artifactsDb?: { missionInfos?: protobuf.Message[] } };
    }
  ).backup?.artifactsDb?.missionInfos;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(
    (mission) => missionInfoType.toObject(mission, { enums: String, defaults: false }) as SparseMissionInfo
  );
}

export function formatSpecName(spec?: { name?: string; level?: string | number }): string | null {
  if (!spec?.name || spec.name === "UNKNOWN" || spec.level == null) {
    return null;
  }
  const levelIndex = typeof spec.level === "number" ? spec.level : LEVEL_INDEX[spec.level] ?? null;
  if (levelIndex == null) {
    return null;
  }
  const normalizedName = spec.name.toLowerCase();
  if (normalizedName.endsWith("_stone_fragment")) {
    const baseName = normalizedName.replace("_stone_fragment", "_stone");
    const tier = levelIndex + 1;
    return `${baseName}_${tier}`;
  }
  if (normalizedName.endsWith("_stone")) {
    const tier = levelIndex + 2;
    return `${normalizedName}_${tier}`;
  }
  const tier = levelIndex + 1;
  return `${normalizedName}_${tier}`;
}

function decodeFirstContactResponse(options: {
  responseBytes: Uint8Array;
  ResponseMessage: protobuf.Type;
  AuthenticatedMessage: protobuf.Type;
}): protobuf.Message {
  const { responseBytes, ResponseMessage, AuthenticatedMessage } = options;
  try {
    return ResponseMessage.decode(responseBytes);
  } catch (responseError) {
    let authenticatedPayload: AuthenticatedMessagePayload;
    try {
      const decoded = AuthenticatedMessage.decode(responseBytes);
      authenticatedPayload = AuthenticatedMessage.toObject(decoded, {
        defaults: true,
        bytes: Uint8Array,
      }) as AuthenticatedMessagePayload;
    } catch (authError) {
      const responseDetails = responseError instanceof Error ? responseError.message : String(responseError);
      const authDetails = authError instanceof Error ? authError.message : String(authError);
      throw new Error(
        `failed to decode first-contact response (${responseDetails}); authenticated wrapper decode failed (${authDetails})`
      );
    }

    if (!authenticatedPayload?.message || authenticatedPayload.message.length === 0) {
      const responseDetails = responseError instanceof Error ? responseError.message : String(responseError);
      throw new Error(`authenticated response contained no payload (${responseDetails})`);
    }

    let payloadBytes = authenticatedPayload.message;
    if (authenticatedPayload.compressed || hasCompressionHeader(payloadBytes)) {
      payloadBytes = inflateAuthenticatedMessage(authenticatedPayload.message);
    }

    return ResponseMessage.decode(payloadBytes);
  }
}

function inflateAuthenticatedMessage(message: Uint8Array): Uint8Array {
  const payload = Buffer.from(message);
  const methods: Array<() => Uint8Array> = [];

  if (isGzipHeader(payload)) {
    methods.push(() => zlib.unzipSync(payload));
  }
  if (isValidZlibHeader(payload)) {
    methods.push(() => zlib.inflateSync(payload));
  }
  methods.push(() => zlib.inflateRawSync(payload));

  let lastError: unknown;
  for (const method of methods) {
    try {
      return method();
    } catch (error) {
      lastError = error;
    }
  }
  const details = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`unable to decompress authenticated message payload: ${details}`);
}

function hasCompressionHeader(payload: Uint8Array): boolean {
  return isGzipHeader(payload) || isValidZlibHeader(payload);
}

function isGzipHeader(payload: Uint8Array): boolean {
  return payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b;
}

function isValidZlibHeader(payload: Uint8Array): boolean {
  if (payload.length < 2 || payload[0] !== 0x78) {
    return false;
  }
  const header = (payload[0] << 8) + payload[1];
  return header % 31 === 0;
}

function normalizeResponseBytes(responseBytes: Uint8Array): Uint8Array {
  if (responseBytes.length === 0 || !isTextPayload(responseBytes)) {
    return responseBytes;
  }

  let payloadText = Buffer.from(responseBytes).toString("utf8").trim();
  if (!payloadText) {
    return responseBytes;
  }
  if (payloadText.startsWith("data=")) {
    try {
      payloadText = decodeURIComponent(payloadText.slice("data=".length));
    } catch {
      return responseBytes;
    }
  }

  const base64Payload = payloadText.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Payload)) {
    return responseBytes;
  }
  try {
    const decoded = Buffer.from(base64Payload, "base64");
    return decoded.length > 0 ? new Uint8Array(decoded) : responseBytes;
  } catch {
    return responseBytes;
  }
}

function isTextPayload(responseBytes: Uint8Array): boolean {
  for (let index = 0; index < responseBytes.length; index += 1) {
    const byte = responseBytes[index];
    const isAsciiPrintable = byte >= 0x20 && byte <= 0x7e;
    const isWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (!isAsciiPrintable && !isWhitespace) {
      return false;
    }
  }
  return true;
}
