import { z } from "zod";

const DURATION_TYPES = ["TUTORIAL", "SHORT", "LONG", "EPIC"] as const;
const FALSEY_STRINGS = new Set(["0", "false", "no", "off"]);

const nonNegativeFiniteSchema = z.number().finite().min(0);
const nonNegativeIntSchema = z.number().int().min(0);

function parseIncludeSlotted(raw: unknown): boolean {
  if (raw == null) {
    return true;
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
  return true;
}

function parseFastMode(raw: unknown): boolean {
  if (raw == null) {
    return false;
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
  return false;
}

export const profileQuerySchema = z
  .object({
    eid: z.string().trim().min(1, "eid is required"),
    includeSlotted: z.string().optional(),
  })
  .transform((value) => ({
    eid: value.eid,
    includeSlotted: parseIncludeSlotted(value.includeSlotted),
  }));

export type ProfileQuery = z.infer<typeof profileQuerySchema>;

export const planRequestSchema = z
  .object({
    eid: z.string().trim().min(1, "eid is required"),
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
    fastMode: z.union([z.boolean(), z.number(), z.string()]).optional(),
  })
  .transform((value) => ({
    eid: value.eid,
    targetItemId: value.targetItemId,
    quantity: value.quantity,
    priorityTime: value.priorityTime,
    includeSlotted: parseIncludeSlotted(value.includeSlotted),
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
  observedReturns: z.array(observedReturnSchema).optional().default([]),
  missionLaunches: z.array(missionLaunchUpdateSchema).optional().default([]),
}).transform((value) => ({
  ...value,
  fastMode: parseFastMode(value.fastMode),
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

export const plannerResultSchema = z.object({
  targetItemId: z.string().min(1),
  quantity: nonNegativeIntSchema,
  priorityTime: z.number().finite().min(0).max(1),
  geCost: nonNegativeFiniteSchema,
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

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
}
