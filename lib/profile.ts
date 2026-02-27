import axios from "axios";
import protobuf from "protobufjs";
import path from "path";
import zlib from "zlib";

import { buildMissionOptions, computeShipLevels, MissionRecord, ShipLevelInfo } from "./ship-data";

export type Inventory = Record<string, number>;
export type CraftCounts = Record<string, number>;
export type ShinyRaritySelection = {
  rare: boolean;
  epic: boolean;
  legendary: boolean;
};

export type PlayerProfile = {
  eid: string;
  inventory: Inventory;
  craftCounts: CraftCounts;
  epicResearchFTLLevel: number;
  epicResearchZerogLevel: number;
  shipLevels: ShipLevelInfo[];
  missionOptions: ReturnType<typeof buildMissionOptions>;
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

type GetPlayerProfileOptions = {
  includeArtifactRarities?: Partial<ShinyRaritySelection>;
  includeShinyArtifacts?: boolean;
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
          game?: {
            epicResearch?: Array<{ id?: string; level?: number }>;
          };
          artifactsDb?: {
            inventoryItems?: BackupInventoryItem[];
            artifactStatus?: BackupCraftableArtifact[];
            missionArchive?: BackupMissionInfo[];
            missionInfos?: BackupMissionInfo[];
          };
        };
      };

      if (data.errorCode && data.errorCode !== "NO_ERROR" && data.errorCode !== 0) {
        throw new Error(data.errorMessage || "error fetching backup");
      }

      const inventory = parseInventory(
        data.backup?.artifactsDb?.inventoryItems || [],
        includeSlotted,
        includeArtifactRarities
      );
      const craftCounts = parseCraftCounts(data.backup?.artifactsDb?.artifactStatus || []);
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

      return {
        eid,
        inventory,
        craftCounts,
        epicResearchFTLLevel,
        epicResearchZerogLevel,
        shipLevels,
        missionOptions,
      };
    } catch (error) {
      lastError = error;
    }
  }

  const details = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`unable to fetch profile for EID ${eid}: ${details}`);
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

export function parseInventory(
  items: BackupInventoryItem[],
  includeSlotted: boolean,
  includeShinyArtifacts: boolean | Partial<ShinyRaritySelection> = true
): Inventory {
  const inventory = {} as Inventory;
  const includeShinyRarities = normalizeShinyRaritySelection(includeShinyArtifacts);
  const addQuantity = (spec: { name?: string; level?: string | number }, quantity: number) => {
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
