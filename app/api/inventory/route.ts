import { NextRequest } from "next/server";

import { formatZodIssues, prePlanSendsSchema, profileQuerySchema } from "../../../lib/api-schemas";
import { applyPrePlanSendsToProfile } from "../../../lib/preplan-sends";
import { getPlayerProfile } from "../../../lib/profile";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  let prePlanSends: unknown[] = [];
  const prePlanSendsRaw = request.nextUrl.searchParams.get("prePlanSends");
  if (prePlanSendsRaw) {
    try {
      prePlanSends = JSON.parse(prePlanSendsRaw) as unknown[];
    } catch {
      return new Response(
        JSON.stringify({
          error: "invalid query parameters",
          details: ["prePlanSends: expected JSON array"],
        }),
        { status: 400 }
      );
    }
  }
  const parsedPrePlanSends = prePlanSendsSchema.safeParse(prePlanSends);
  if (!parsedPrePlanSends.success) {
    return new Response(
      JSON.stringify({
        error: "invalid query parameters",
        details: formatZodIssues(parsedPrePlanSends.error),
      }),
      { status: 400 }
    );
  }

  const parsedQuery = profileQuerySchema.safeParse({
    eid: request.nextUrl.searchParams.get("eid") ?? "",
    includeSlotted: request.nextUrl.searchParams.get("includeSlotted") ?? undefined,
    inventorySource: request.nextUrl.searchParams.get("inventorySource") ?? undefined,
    includeInventoryFragments: request.nextUrl.searchParams.get("includeInventoryFragments") ?? undefined,
    // The craft planner defaults shiny artifacts to "skip" (unlike /api/profile) so results match
    // the in-game auto-craft counts unless the player explicitly opts in.
    includeInventoryRare: request.nextUrl.searchParams.get("includeInventoryRare") ?? "false",
    includeInventoryEpic: request.nextUrl.searchParams.get("includeInventoryEpic") ?? "false",
    includeInventoryLegendary: request.nextUrl.searchParams.get("includeInventoryLegendary") ?? "false",
  });
  if (!parsedQuery.success) {
    return new Response(
      JSON.stringify({
        error: "invalid query parameters",
        details: formatZodIssues(parsedQuery.error),
      }),
      { status: 400 }
    );
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
        prePlanSends: {
          addedInventory: prePlanResult.addedInventory,
          appliedLaunches: prePlanResult.appliedLaunches,
          skippedLaunches: prePlanResult.skippedLaunches,
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
