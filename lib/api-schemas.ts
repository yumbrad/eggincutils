import { z } from "zod";

import { MAX_PRE_PLAN_LAUNCHES_PER_ROW, MAX_PRE_PLAN_SEND_ROWS } from "./preplan-import";
import { SHINY_RARITIES } from "./shiny-odds";

const DURATION_TYPES = ["TUTORIAL", "SHORT", "LONG", "EPIC"] as const;
const INVENTORY_SOURCES = ["main", "virtue"] as const;
const VIRTUE_TANK_EGGS = ["curiosity", "integrity", "humility", "resilience", "kindness"] as const;
const VIRTUE_FUEL_EGGS = ["curiosity", "integrity", "kindness", "resilience"] as const;
const VIRTUE_START_TANKS = ["current", "ideal"] as const;
const MAX_VIRTUE_SHIFT_CAP = 15;
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

function parseDisabledByDefault(raw: unknown): boolean {
  return parseEnabledByDefault(raw, false);
}

function parseInventorySource(raw: unknown): (typeof INVENTORY_SOURCES)[number] {
  if (typeof raw === "string" && raw.trim().toLowerCase() === "virtue") {
    return "virtue";
  }
  return "main";
}

export const profileQuerySchema = z
  .object({
    eid: z.string().trim().min(1, "eid is required"),
    includeSlotted: z.string().optional(),
    inventorySource: z.string().optional(),
    includeInventoryRare: z.string().optional(),
    includeInventoryEpic: z.string().optional(),
    includeInventoryLegendary: z.string().optional(),
    includeInventoryFragments: z.string().optional(),
  })
  .transform((value) => ({
    eid: value.eid,
    includeSlotted: parseIncludeSlotted(value.includeSlotted),
    inventorySource: parseInventorySource(value.inventorySource),
    includeInventoryRare: parseEnabledByDefault(value.includeInventoryRare, true),
    includeInventoryEpic: parseEnabledByDefault(value.includeInventoryEpic, true),
    includeInventoryLegendary: parseEnabledByDefault(value.includeInventoryLegendary, true),
    includeInventoryFragments: parseEnabledByDefault(value.includeInventoryFragments, true),
  }));

export type ProfileQuery = z.infer<typeof profileQuerySchema>;

// Path of Virtue shift cap (the Balance slider's detents in virtue mode) and
// whether the first tank is the player's current contents or the ideal mix.
// Null or blank means "not given" for both: a bare z.coerce would read null,
// "" and [] as 0 — the strictest cap — so only numbers and numeric strings
// are accepted.
export const virtueShiftCapSchema = z
  .union([z.number(), z.string().trim()])
  .nullish()
  .transform((value) => (value == null || value === "" ? undefined : Number(value)))
  .pipe(
    z
      .number()
      .finite()
      .transform((value) => Math.max(0, Math.min(MAX_VIRTUE_SHIFT_CAP, Math.round(value))))
      .pipe(nonNegativeIntSchema.max(MAX_VIRTUE_SHIFT_CAP))
      .optional()
  );
export const virtueStartTankSchema = z
  .union([z.enum(VIRTUE_START_TANKS), z.literal("")])
  .nullish()
  .transform((value) => value || undefined);

export const prePlanSendSchema = z.object({
  ship: z.string().trim().min(1),
  durationType: z.enum(["SHORT", "LONG", "EPIC"]),
  targetAfxId: z.coerce.number().int(),
  launches: z.coerce
    .number()
    .finite()
    .transform((value) => Math.max(0, Math.round(value)))
    .pipe(nonNegativeIntSchema.max(MAX_PRE_PLAN_LAUNCHES_PER_ROW)),
});

export const prePlanSendsSchema = z.array(prePlanSendSchema).max(MAX_PRE_PLAN_SEND_ROWS);

export type PrePlanSendRequest = z.infer<typeof prePlanSendSchema>;

const plannerTargetSchema = z.object({
  targetItemId: z.string().trim().min(1, "targetItemId is required"),
  quantity: z.coerce
    .number()
    .finite()
    .default(1)
    .transform((value) => Math.max(1, Math.round(value)))
    .pipe(nonNegativeIntSchema.max(1_000_000)),
  craftGoal: z.boolean().optional(),
  // Quantity is then a percent chance (the planner turns it into a craft-count goal).
  shinyRarity: z.enum(SHINY_RARITIES).optional(),
});

const shinyGoalPlanSchema = z.object({
  itemId: z.string().min(1),
  rarity: z.enum(SHINY_RARITIES),
  targetChance: z.number().finite().min(0).max(1),
  craftedBefore: nonNegativeIntSchema,
  crafts: nonNegativeIntSchema,
  reached: z.boolean(),
});

export const planRequestSchema = z
  .object({
    eid: z.string().trim().default(""),
    targetItemId: z.string().trim().min(1, "targetItemId is required"),
    targets: z.array(plannerTargetSchema).min(1).max(10).optional(),
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
    inventorySource: z.string().optional(),
    includeSlotted: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeInventoryRare: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeInventoryEpic: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeInventoryLegendary: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeInventoryFragments: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeDropRare: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeDropEpic: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeDropLegendary: z.union([z.boolean(), z.number(), z.string()]).optional(),
    includeDropFragments: z.union([z.boolean(), z.number(), z.string()]).optional(),
    targetCraftedOnly: z.union([z.boolean(), z.number(), z.string()]).optional(),
    fastMode: z.union([z.boolean(), z.number(), z.string()]).optional(),
    allowedShipDurations: z
      .array(z.object({ ship: z.string().min(1), durationType: z.enum(["SHORT", "LONG", "EPIC"]) }))
      .optional(),
    selectedConsumptionItemIds: z.array(z.string().trim().min(1)).max(84).optional(),
    virtueShiftCap: virtueShiftCapSchema,
    virtueStartTank: virtueStartTankSchema,
  })
  .transform((value) => ({
    eid: value.eid,
    targetItemId: value.targetItemId,
    targets: value.targets,
    quantity: value.quantity,
    priorityTime: value.priorityTime,
    inventorySource: parseInventorySource(value.inventorySource),
    includeSlotted: parseIncludeSlotted(value.includeSlotted),
    includeInventoryRare: parseEnabledByDefault(value.includeInventoryRare, true),
    includeInventoryEpic: parseEnabledByDefault(value.includeInventoryEpic, true),
    includeInventoryLegendary: parseEnabledByDefault(value.includeInventoryLegendary, true),
    includeInventoryFragments: parseEnabledByDefault(value.includeInventoryFragments, true),
    includeDropRare: parseEnabledByDefault(value.includeDropRare, true),
    includeDropEpic: parseEnabledByDefault(value.includeDropEpic, true),
    includeDropLegendary: parseEnabledByDefault(value.includeDropLegendary, true),
    includeDropFragments: parseEnabledByDefault(value.includeDropFragments, true),
    targetCraftedOnly: parseDisabledByDefault(value.targetCraftedOnly),
    fastMode: parseFastMode(value.fastMode),
    allowedShipDurations: value.allowedShipDurations,
    selectedConsumptionItemIds: value.selectedConsumptionItemIds ?? [],
    virtueShiftCap: value.virtueShiftCap,
    virtueStartTank: value.virtueStartTank,
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

const inFlightMissionSchema = z.object({
  ship: z.string().min(1),
  durationType: z.string().min(1),
  status: z.string().min(1),
  level: nonNegativeIntSchema,
  capacity: nonNegativeIntSchema,
  targetAfxId: nonNegativeIntSchema.nullable(),
  secondsRemaining: nonNegativeIntSchema,
});

function virtueTankEggValuesSchema(valueSchema: z.ZodNumber) {
  return z.object({
    curiosity: valueSchema,
    integrity: valueSchema,
    humility: valueSchema,
    resilience: valueSchema,
    kindness: valueSchema,
  });
}

export const virtueTankSnapshotSchema = z.object({
  tankLevel: nonNegativeIntSchema.max(7),
  capacity: nonNegativeFiniteSchema,
  fuels: virtueTankEggValuesSchema(nonNegativeFiniteSchema),
  limits: virtueTankEggValuesSchema(nonNegativeFiniteSchema.max(1)),
  fillingEnabled: z.boolean(),
  shiftCount: nonNegativeIntSchema,
  soulEggs: nonNegativeFiniteSchema,
  currentEgg: z.enum(VIRTUE_TANK_EGGS).nullable(),
  backupTimeSeconds: nonNegativeFiniteSchema.nullable(),
});

export const playerProfileSchema = z.object({
  eid: z.string().min(1),
  inventory: z.record(z.string(), nonNegativeFiniteSchema),
  craftCounts: z.record(z.string(), nonNegativeIntSchema),
  craftingXp: nonNegativeFiniteSchema,
  epicResearchFTLLevel: nonNegativeIntSchema,
  epicResearchZerogLevel: nonNegativeIntSchema,
  shipLevels: z.array(shipLevelInfoSchema),
  missionOptions: z.array(missionOptionSchema),
  inFlightMissions: z.array(inFlightMissionSchema).optional(),
  shinyIngredientCount: nonNegativeIntSchema.optional(),
  virtueTank: virtueTankSnapshotSchema.optional(),
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
  targets: z.array(plannerTargetSchema).min(1).max(10).optional(),
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
  inventorySource: z.string().optional(),
  fastMode: z.union([z.boolean(), z.number(), z.string()]).optional(),
  includeDropRare: z.union([z.boolean(), z.number(), z.string()]).optional(),
  includeDropEpic: z.union([z.boolean(), z.number(), z.string()]).optional(),
  includeDropLegendary: z.union([z.boolean(), z.number(), z.string()]).optional(),
  includeDropFragments: z.union([z.boolean(), z.number(), z.string()]).optional(),
  targetCraftedOnly: z.union([z.boolean(), z.number(), z.string()]).optional(),
  allowedShipDurations: z
    .array(z.object({ ship: z.string().min(1), durationType: z.enum(["SHORT", "LONG", "EPIC"]) }))
    .optional(),
  selectedConsumptionItemIds: z.array(z.string().trim().min(1)).max(84).optional(),
  observedReturns: z.array(observedReturnSchema).optional().default([]),
  missionLaunches: z.array(missionLaunchUpdateSchema).optional().default([]),
  virtueShiftCap: virtueShiftCapSchema,
  virtueStartTank: virtueStartTankSchema,
}).transform((value) => ({
  ...value,
  inventorySource: parseInventorySource(value.inventorySource),
  fastMode: parseFastMode(value.fastMode),
  includeDropRare: parseEnabledByDefault(value.includeDropRare, true),
  includeDropEpic: parseEnabledByDefault(value.includeDropEpic, true),
  includeDropLegendary: parseEnabledByDefault(value.includeDropLegendary, true),
  includeDropFragments: parseEnabledByDefault(value.includeDropFragments, true),
  targetCraftedOnly: parseDisabledByDefault(value.targetCraftedOnly),
  selectedConsumptionItemIds: value.selectedConsumptionItemIds ?? [],
}));

export type ReplanRequest = z.infer<typeof replanRequestSchema>;

const planCraftRowSchema = z.object({
  itemId: z.string().min(1),
  count: nonNegativeIntSchema,
});

const planConsumptionRowSchema = z.object({
  itemId: z.string().min(1),
  count: nonNegativeIntSchema,
  yields: z.array(
    z.object({
      itemId: z.string().min(1),
      quantity: nonNegativeFiniteSchema,
    })
  ),
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
  inAir: z.boolean().optional(),
  secondsRemaining: nonNegativeIntSchema.optional(),
  launchSecondsRemaining: z.array(nonNegativeIntSchema).optional(),
  rowKey: z.string().min(1).optional(),
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
  craftGoal: z.boolean().optional(),
  craftGoalTotal: nonNegativeFiniteSchema.optional(),
  craftedBefore: nonNegativeFiniteSchema.optional(),
});

const planTargetBreakdownRowSchema = planTargetBreakdownSchema.extend({
  itemId: z.string().min(1),
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

// Path of Virtue tank mode (lib/virtue-tank-plan.ts, lib/virtue-tanks.ts).
// Every field is listed rather than passed through: z.object strips unknown
// keys, and lib/api-schemas.test.ts pins these schemas to the TypeScript types
// so a field added there fails the typecheck instead of vanishing from the
// plan routes. Fuel amounts are only required to be finite: changeFromCurrent
// is a signed delta, and the game's float noise can leave a leftover a fraction
// of an egg below zero.
const virtueFuelAmountSchema = z.number().finite();
const virtueFuelVectorSchema = z.object({
  curiosity: virtueFuelAmountSchema.optional(),
  integrity: virtueFuelAmountSchema.optional(),
  kindness: virtueFuelAmountSchema.optional(),
  resilience: virtueFuelAmountSchema.optional(),
});
const virtueLimitPctSchema = nonNegativeIntSchema.max(100);
const virtueLimitPctsSchema = z.object({
  curiosity: virtueLimitPctSchema.optional(),
  integrity: virtueLimitPctSchema.optional(),
  kindness: virtueLimitPctSchema.optional(),
  resilience: virtueLimitPctSchema.optional(),
});
const virtueStartModeSchema = z.enum(VIRTUE_START_TANKS);

const virtueTankRefillSchema = z.object({
  route: z.array(z.enum([...VIRTUE_FUEL_EGGS, "humility"])),
  shifts: nonNegativeIntSchema,
  add: virtueFuelVectorSchema,
  fillTo: virtueFuelVectorSchema,
  limitPct: virtueLimitPctsSchema,
  drain: virtueFuelVectorSchema,
  drainHumility: z.boolean(),
});

const virtueTankIdealFillSchema = z.object({
  fillTo: virtueFuelVectorSchema,
  limitPct: virtueLimitPctsSchema,
  changeFromCurrent: virtueFuelVectorSchema.optional(),
  drainHumility: z.boolean(),
});

const virtueUnitLaunchesSchema = z.object({
  unitId: z.string().min(1),
  launches: nonNegativeIntSchema,
});
const virtueTankLaunchOrderEntrySchema = virtueUnitLaunchesSchema.extend({
  tankIndex: nonNegativeIntSchema,
});

const virtueTankSchema = z.object({
  index: nonNegativeIntSchema,
  label: z.string().min(1),
  refill: virtueTankRefillSchema.nullable(),
  idealFill: virtueTankIdealFillSchema.optional(),
  startContents: virtueFuelVectorSchema,
  used: virtueFuelVectorSchema,
  leftover: virtueFuelVectorSchema,
  launches: z.array(virtueUnitLaunchesSchema),
  capacity: nonNegativeFiniteSchema,
});

const virtueTankScheduleBlockSchema = virtueTankLaunchOrderEntrySchema.extend({
  startSeconds: nonNegativeFiniteSchema,
  endSeconds: nonNegativeFiniteSchema,
});

const virtueTankPackSchema = z.object({
  startMode: virtueStartModeSchema,
  capacity: nonNegativeFiniteSchema,
  tanks: z.array(virtueTankSchema),
  totalShifts: nonNegativeIntSchema,
  refillLoops: nonNegativeIntSchema,
  totalFuel: virtueFuelVectorSchema,
  feasible: z.boolean(),
  exact: z.boolean(),
  launchOrder: z.array(virtueTankLaunchOrderEntrySchema),
  schedule: z.object({
    makespanSeconds: nonNegativeFiniteSchema,
    lanes: z.array(z.array(virtueTankScheduleBlockSchema)),
  }),
  unplaced: z.array(virtueUnitLaunchesSchema.extend({ reason: z.string() })),
  notes: z.array(z.string()),
  diagnostics: z.array(z.string()),
});

const virtueTankPlanUnitSchema = z.object({
  id: z.string().min(1),
  ship: z.string().min(1),
  durationType: z.string().min(1),
  level: nonNegativeIntSchema,
  durationSeconds: nonNegativeFiniteSchema,
  launches: nonNegativeIntSchema,
  isPrep: z.boolean().optional(),
  prepOrder: z.number().finite().optional(),
  fuelPerLaunch: virtueFuelVectorSchema.optional(),
  missionRowKey: z.string().min(1).optional(),
  targetAfxId: z.number().int().nullable().optional(),
});

const virtueTopUpYieldSchema = z.object({
  goldMeteorite: nonNegativeFiniteSchema,
  tauCetiGeode: nonNegativeFiniteSchema,
  solarTitanium: nonNegativeFiniteSchema,
});

const virtueLastTankTopUpSchema = z.object({
  tankIndex: nonNegativeIntSchema,
  roomBefore: nonNegativeFiniteSchema,
  launches: z.array(
    z.object({
      ship: z.string().min(1),
      durationType: z.string().min(1),
      level: nonNegativeIntSchema,
      targetAfxId: z.number().int().nullable(),
      launches: nonNegativeIntSchema,
    })
  ),
  fillTo: virtueFuelVectorSchema,
  limitPct: virtueLimitPctsSchema,
  expected: virtueTopUpYieldSchema,
  totalValue: nonNegativeFiniteSchema,
  netValue: nonNegativeFiniteSchema,
  slotSeconds: nonNegativeFiniteSchema,
});

export const virtueTankPlannerResultSchema = z.object({
  shiftCap: nonNegativeIntSchema.max(MAX_VIRTUE_SHIFT_CAP),
  plannedShiftCap: nonNegativeIntSchema,
  overCap: z.boolean(),
  neededShifts: nonNegativeIntSchema.optional(),
  neededShiftsProven: z.boolean().optional(),
  fasterOption: z
    .object({
      shifts: nonNegativeIntSchema,
      expectedHours: nonNegativeFiniteSchema,
    })
    .optional(),
  startMode: virtueStartModeSchema,
  capacity: nonNegativeFiniteSchema,
  units: z.array(virtueTankPlanUnitSchema),
  pack: virtueTankPackSchema,
  notes: z.array(z.string()),
  lastTankTopUp: virtueLastTankTopUpSchema.optional(),
});

export const plannerResultSchema = z.object({
  targetItemId: z.string().min(1),
  quantity: nonNegativeIntSchema,
  targets: z.array(plannerTargetSchema),
  shinyGoals: z.array(shinyGoalPlanSchema).optional(),
  priorityTime: z.number().finite().min(0).max(1),
  objectiveMode: z.enum(["ge", "virtueFuel"]).default("ge"),
  geCost: nonNegativeFiniteSchema,
  fuelCost: nonNegativeFiniteSchema.default(0),
  totalSlotSeconds: nonNegativeIntSchema,
  expectedHours: nonNegativeFiniteSchema,
  weightedScore: nonNegativeFiniteSchema,
  crafts: z.array(planCraftRowSchema),
  consumptions: z.array(planConsumptionRowSchema).default([]),
  missions: z.array(planMissionRowSchema),
  unmetItems: z.array(planUnmetItemSchema),
  targetBreakdown: planTargetBreakdownSchema,
  targetBreakdowns: z.array(planTargetBreakdownRowSchema),
  progression: z.object({
    prepHours: nonNegativeFiniteSchema,
    prepLaunches: z.array(planProgressionLaunchSchema),
    projectedShipLevels: z.array(planProgressionShipSchema),
  }),
  inFlight: z
    .object({
      missionCount: nonNegativeIntSchema,
      secondsRemaining: nonNegativeIntSchema,
    })
    .default({ missionCount: 0, secondsRemaining: 0 }),
  schedule: z
    .object({
      missionSeconds: nonNegativeIntSchema,
      inAirSeconds: nonNegativeIntSchema,
      totalSeconds: nonNegativeIntSchema,
    })
    .default({ missionSeconds: 0, inAirSeconds: 0, totalSeconds: 0 }),
  notes: z.array(z.string()),
  availableCombos: z.array(availableComboSchema),
  virtueTanks: virtueTankPlannerResultSchema.optional(),
});

export const planApiResponseSchema = z.object({
  profile: z.object({
    eid: z.string().min(1),
    epicResearchFTLLevel: nonNegativeIntSchema,
    epicResearchZerogLevel: nonNegativeIntSchema,
    shipLevels: z.array(shipLevelInfoSchema),
    // Lets API callers price shifts (Soul Eggs, shift count) and show the tank
    // the plan started from; the planner page reads it from /api/profile.
    virtueTank: virtueTankSnapshotSchema.optional(),
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
  targets: z.array(plannerTargetSchema).min(1).max(10).optional(),
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
  includeDropFragments: z.union([z.boolean(), z.number(), z.string()]).optional(),
  targetCraftedOnly: z.union([z.boolean(), z.number(), z.string()]).optional(),
  selectedConsumptionItemIds: z.array(z.string().trim().min(1)).max(84).optional(),
}).transform((value) => ({
  ...value,
  includeDropRare: parseEnabledByDefault(value.includeDropRare, true),
  includeDropEpic: parseEnabledByDefault(value.includeDropEpic, true),
  includeDropLegendary: parseEnabledByDefault(value.includeDropLegendary, true),
  includeDropFragments: parseEnabledByDefault(value.includeDropFragments, true),
  targetCraftedOnly: parseDisabledByDefault(value.targetCraftedOnly),
  selectedConsumptionItemIds: value.selectedConsumptionItemIds ?? [],
}));

export type CompareRequest = z.infer<typeof compareRequestSchema>;

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
}
