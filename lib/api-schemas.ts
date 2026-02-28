import { z } from "zod";

const DURATION_TYPES = ["TUTORIAL", "SHORT", "LONG", "EPIC"] as const;
const FALSEY_STRINGS = new Set(["0", "false", "no", "off"]);

const nonNegativeFiniteSchema = z.number().finite().min(0);
const nonNegativeIntSchema = z.number().int().min(0);

function parseIncludeSlotted(raw: unknown): boolean {
  return parseEnabledByDefault(raw, true);
}

function parseEnabledByDefault(raw: unknown, defaultValue: boolean): boolean {
  if (raw == null) {
    return defaultValue;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "number") {
    return raw !== 0;
  }
  if (typeof raw === "string") {
    return !FALSEY_STRINGS.has(raw.trim().toLowerCase());
  }
  return defaultValue;
}

function parseFastMode(raw: unknown): boolean {
  return parseEnabledByDefault(raw, false);
}

export const profileQuerySchema = z
  .object({
    eid: z.string().trim().min(1, "eid is required"),
    includeSlotted: z.string().optional(),
    includeInventoryRare: z.string().optional(),
    includeInventoryEpic: z.string().optional(),
    includeInventoryLegendary: z.string().optional(),
  })
  .transform((value) => ({
    eid: value.eid,
    includeSlotted: parseIncludeSlotted(value.includeSlotted),
    includeInventoryRare: parseEnabledByDefault(value.includeInventoryRare, true),
    includeInventoryEpic: parseEnabledByDefault(value.includeInventoryEpic, true),
    includeInventoryLegendary: parseEnabledByDefault(value.includeInventoryLegendary, true),
  }));

export type ProfileQuery = z.infer<typeof profileQuerySchema>;

export const planRequestSchema = z
  .object({
    eid: z.string().trim().default(""),
    targetItemId: z.string().trim().min(1, "targetItemId is required"),
    quantity: z.coerce
      .number()
      .finite()
      .default(1)
      .transform((value) => Math.max(1, Math.round(value)))
      .pipe(nonNegativeIntSchema.max(1_000_000)),
    priorityTime: z.coerce
      .number()
      .finite()
      .default(0.5)
      .transform((value) => Math.max(0, Math.min(1, value))),
    includeSlotted: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeInventoryRare: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeInventoryEpic: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeInventoryLegendary: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeDropRare: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeDropEpic: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeDropLegendary: z.union([z.boolean(), z.number(), z.string()]).optional(),
    fastMode: z.union([z.boolean(), z.number(), z.string()]).optional(),
  })
  .transform((value) => ({
    eid: value.eid,
    targetItemId: value.targetItemId,
    quantity: value.quantity,
    priorityTime: value.priorityTime,
    includeSlotted: parseIncludeSlotted(value.includeSlotted),
    includeInventoryRare: parseEnabledByDefault(value.includeInventoryRare, true),
    includeInventoryEpic: parseEnabledByDefault(value.includeInventoryEpic, true),
    includeInventoryLegendary: parseEnabledByDefault(value.includeInventoryLegendary, true),
    includeDropRare: parseEnabledByDefault(value.includeDropRare, true),
    includeDropEpic: parseEnabledByDefault(value.includeDropEpic, true),
    includeDropLegendary: parseEnabledByDefault(value.includeDropLegendary, true),
    fastMode: parseFastMode(value.fastMode),
  }));

export type PlanRequest = z.infer<typeof planRequestSchema>;

const launchesByDurationSchema = z.object({
  TUTORIAL: nonNegativeIntSchema,
  SHORT: nonNegativeIntSchema,
  LONG: nonNegativeIntSchema,
  EPIC: nonNegativeIntSchema,
});

export const shipLevelInfoSchema = z.object({
  ship: z.string().min(1),
  unlocked: z.boolean(),
  launches: nonNegativeIntSchema,
  launchPoints: nonNegativeFiniteSchema,
  level: nonNegativeIntSchema,
  maxLevel: nonNegativeIntSchema,
  launchesByDuration: launchesByDurationSchema,
});

export const missionOptionSchema = z.object({
  ship: z.string().min(1),
  missionId: z.string().min(1),
  durationType: z.enum(DURATION_TYPES),
  level: nonNegativeIntSchema,
  durationSeconds: nonNegativeIntSchema,
  capacity: nonNegativeIntSchema,
});

export const playerProfileSchema = z.object({
  eid: z.string().min(1),
  inventory: z.record(z.string(), nonNegativeFiniteSchema),
  craftCounts: z.record(z.string(), nonNegativeIntSchema),
  epicResearchFTLLevel: nonNegativeIntSchema,
  epicResearchZerogLevel: nonNegativeIntSchema,
  shipLevels: z.array(shipLevelInfoSchema),
  missionOptions: z.array(missionOptionSchema),
});

const observedReturnSchema = z.object({
  itemId: z.string().trim().min(1),
  quantity: z.coerce.number().finite().min(0),
});

const missionLaunchUpdateSchema = z.object({
  ship: z.string().trim().min(1),
  durationType: z.enum(DURATION_TYPES),
  launches: z.coerce
    .number()
    .finite()
    .transform((value) => Math.max(0, Math.round(value)))
    .pipe(nonNegativeIntSchema.max(100_000)),
});

export const replanRequestSchema = z.object({
  profile: playerProfileSchema,
  targetItemId: z.string().trim().min(1, "targetItemId is required"),
  quantity: z.coerce
    .number()
    .finite()
    .default(1)
    .transform((value) => Math.max(1, Math.round(value)))
    .pipe(nonNegativeIntSchema.max(1_000_000)),
  priorityTime: z.coerce
    .number()
    .finite()
    .default(0.5)
    .transform((value) => Math.max(0, Math.min(1, value))),
  fastMode: z.union([z.boolean(), z.number(), z.string()]).optional(),
  includeDropRare: z.union([z.boolean(), z.number(), z.string()]).optional(),
  includeDropEpic: z.union([z.boolean(), z.number(), z.string()]).optional(),
  includeDropLegendary: z.union([z.boolean(), z.number(), z.string()]).optional(),
  observedReturns: z.array(observedReturnSchema).optional().default([]),
  missionLaunches: z.array(missionLaunchUpdateSchema).optional().default([]),
}).transform((value) => ({
  ...value,
  fastMode: parseFastMode(value.fastMode),
  includeDropRare: parseEnabledByDefault(value.includeDropRare, true),
  includeDropEpic: parseEnabledByDefault(value.includeDropEpic, true),
  includeDropLegendary: parseEnabledByDefault(value.includeDropLegendary, true),
}));

export type ReplanRequest = z.infer<typeof replanRequestSchema>;

const planCraftRowSchema = z.object({
  itemId: z.string().min(1),
  count: nonNegativeIntSchema,
});

const planMissionYieldSchema = z.object({
  itemId: z.string().min(1),
  quantity: nonNegativeFiniteSchema,
});

const planMissionRowSchema = z.object({
  missionId: z.string().min(1),
  ship: z.string().min(1),
  durationType: z.enum(DURATION_TYPES),
  level: nonNegativeIntSchema,
  targetAfxId: z.number().int(),
  launches: nonNegativeIntSchema,
  durationSeconds: nonNegativeIntSchema,
  expectedYields: z.array(planMissionYieldSchema),
});

const planUnmetItemSchema = z.object({
  itemId: z.string().min(1),
  quantity: nonNegativeFiniteSchema,
});

const planTargetBreakdownSchema = z.object({
  requested: nonNegativeFiniteSchema,
  fromInventory: nonNegativeFiniteSchema,
  fromCraft: nonNegativeFiniteSchema,
  fromMissionsExpected: nonNegativeFiniteSchema,
  shortfall: nonNegativeFiniteSchema,
});

const planProgressionLaunchSchema = z.object({
  ship: z.string().min(1),
  durationType: z.enum(DURATION_TYPES),
  launches: nonNegativeIntSchema,
  durationSeconds: nonNegativeIntSchema,
  reason: z.string().min(1),
});

const planProgressionShipSchema = z.object({
  ship: z.string().min(1),
  unlocked: z.boolean(),
  level: nonNegativeIntSchema,
  maxLevel: nonNegativeIntSchema,
  launches: nonNegativeIntSchema,
  launchPoints: nonNegativeFiniteSchema,
});

const availableComboSchema = z.object({
  ship: z.string().min(1),
  durationType: z.enum(DURATION_TYPES),
  targetAfxId: z.number().int(),
});

export const plannerResultSchema = z.object({
  targetItemId: z.string().min(1),
  quantity: nonNegativeIntSchema,
  priorityTime: z.number().finite().min(0).max(1),
  geCost: nonNegativeFiniteSchema,
  totalSlotSeconds: nonNegativeIntSchema,
  expectedHours: nonNegativeFiniteSchema,
  weightedScore: nonNegativeFiniteSchema,
  crafts: z.array(planCraftRowSchema),
  missions: z.array(planMissionRowSchema),
  unmetItems: z.array(planUnmetItemSchema),
  targetBreakdown: planTargetBreakdownSchema,
  progression: z.object({
    prepHours: nonNegativeFiniteSchema,
    prepLaunches: z.array(planProgressionLaunchSchema),
    projectedShipLevels: z.array(planProgressionShipSchema),
  }),
  notes: z.array(z.string()),
  availableCombos: z.array(availableComboSchema),
});

export const planApiResponseSchema = z.object({
  profile: z.object({
    eid: z.string().min(1),
    epicResearchFTLLevel: nonNegativeIntSchema,
    epicResearchZerogLevel: nonNegativeIntSchema,
    shipLevels: z.array(shipLevelInfoSchema),
  }),
  plan: plannerResultSchema,
});

const selectedComboSchema = z.object({
  ship: z.string().min(1),
  durationType: z.enum(DURATION_TYPES),
  targetAfxId: z.number().int(),
});

export const compareRequestSchema = z.object({
  profile: playerProfileSchema,
  targetItemId: z.string().trim().min(1, "targetItemId is required"),
  quantity: z.coerce
    .number()
    .finite()
    .default(1)
    .transform((value) => Math.max(1, Math.round(value)))
    .pipe(nonNegativeIntSchema.max(1_000_000)),
  priorityTime: z.coerce
    .number()
    .finite()
    .default(0.5)
    .transform((value) => Math.max(0, Math.min(1, value))),
  selectedCombos: z.array(selectedComboSchema).min(1).max(20),
  includeDropRare: z.union([z.boolean(), z.number(), z.string()]).optional(),
  includeDropEpic: z.union([z.boolean(), z.number(), z.string()]).optional(),
  includeDropLegendary: z.union([z.boolean(), z.number(), z.string()]).optional(),
}).transform((value) => ({
  ...value,
  includeDropRare: parseEnabledByDefault(value.includeDropRare, true),
  includeDropEpic: parseEnabledByDefault(value.includeDropEpic, true),
  includeDropLegendary: parseEnabledByDefault(value.includeDropLegendary, true),
}));

export type CompareRequest = z.infer<typeof compareRequestSchema>;

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
}
