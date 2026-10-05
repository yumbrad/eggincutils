import { NextRequest } from "next/server";

import { formatZodIssues, prePlanSendsSchema, profileQuerySchema } from "../../../lib/api-schemas";
import { applyPrePlanSendsToProfile } from "../../../lib/preplan-sends";
import { getPlayerProfile } from "../../../lib/profile";

export const runtime = "nodejs";

const QUERY_FIELDS = [
  "eid",
  "includeSlotted",
  "inventorySource",
  "includeInventoryFragments",
  "includeInventoryRare",
  "includeInventoryEpic",
  "includeInventoryLegendary",
] as const;

type InventoryQuery = Partial<Record<(typeof QUERY_FIELDS)[number], string>>;

function invalidRequest(details: string[]): Response {
  return new Response(JSON.stringify({ error: "invalid query parameters", details }), { status: 400 });
}

// GET serves the diagnostics page; the craft planner POSTs, since its pre-plan
// sends can outgrow a query string.
export async function GET(request: NextRequest): Promise<Response> {
  let prePlanSends: unknown = [];
  const prePlanSendsRaw = request.nextUrl.searchParams.get("prePlanSends");
  if (prePlanSendsRaw) {
    try {
      prePlanSends = JSON.parse(prePlanSendsRaw);
    } catch {
      return invalidRequest(["prePlanSends: expected JSON array"]);
    }
  }
  const query: InventoryQuery = {};
  for (const field of QUERY_FIELDS) {
    query[field] = request.nextUrl.searchParams.get(field) ?? undefined;
  }
  return inventoryResponse(query, prePlanSends);
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest(["body: expected JSON object"]);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidRequest(["body: expected JSON object"]);
  }
  const record = body as Record<string, unknown>;
  const query: InventoryQuery = {};
  for (const field of QUERY_FIELDS) {
    const value = record[field];
    query[field] = typeof value === "string" ? value : typeof value === "boolean" ? String(value) : undefined;
  }
  return inventoryResponse(query, record.prePlanSends ?? []);
}

async function inventoryResponse(query: InventoryQuery, prePlanSends: unknown): Promise<Response> {
  const parsedPrePlanSends = prePlanSendsSchema.safeParse(prePlanSends);
  if (!parsedPrePlanSends.success) {
    return invalidRequest(formatZodIssues(parsedPrePlanSends.error));
  }

  const parsedQuery = profileQuerySchema.safeParse({
    eid: query.eid ?? "",
    includeSlotted: query.includeSlotted,
    inventorySource: query.inventorySource,
    includeInventoryFragments: query.includeInventoryFragments,
    // The craft planner defaults shiny artifacts to "skip" (unlike /api/profile) so results match
    // the in-game auto-craft counts unless the player explicitly opts in.
    includeInventoryRare: query.includeInventoryRare ?? "false",
    includeInventoryEpic: query.includeInventoryEpic ?? "false",
    includeInventoryLegendary: query.includeInventoryLegendary ?? "false",
  });
  if (!parsedQuery.success) {
    return invalidRequest(formatZodIssues(parsedQuery.error));
  }

  try {
    const includeRarities = {
      rare: parsedQuery.data.includeInventoryRare,
      epic: parsedQuery.data.includeInventoryEpic,
      legendary: parsedQuery.data.includeInventoryLegendary,
    };
    let profile = await getPlayerProfile(parsedQuery.data.eid, parsedQuery.data.includeSlotted, {
      inventorySource: parsedQuery.data.inventorySource,
      includeArtifactRarities: includeRarities,
      includeStoneFragments: parsedQuery.data.includeInventoryFragments,
    });
    const shinyIngredientCount = profile.shinyIngredientCount || 0;
    // Stars before any pre-plan sends, for the send picker.
    const shipLevels = profile.shipLevels.map((info) => ({
      ship: info.ship,
      unlocked: info.unlocked,
      level: info.level,
      maxLevel: info.maxLevel,
    }));
    const prePlanResult = await applyPrePlanSendsToProfile(profile, parsedPrePlanSends.data, {
      includeRarities,
      includeStoneFragments: parsedQuery.data.includeInventoryFragments,
    });
    profile = prePlanResult.profile;
    return new Response(
      JSON.stringify({
        inventory: profile.inventory,
        craftCounts: profile.craftCounts,
        craftingXp: profile.craftingXp,
        shinyIngredientCount,
        shipLevels,
        prePlanSends: {
          addedInventory: prePlanResult.addedInventory,
          appliedLaunches: prePlanResult.appliedLaunches,
          skippedLaunches: prePlanResult.skippedLaunches,
          noLootLaunches: prePlanResult.noLootLaunches,
          rows: prePlanResult.rows,
        },
      }),
      { status: 200 }
    );
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        error: "unable to get artifact inventory",
        details,
      }),
      { status: 502 }
    );
  }
}
