import {
  formatZodIssues,
  planApiResponseSchema,
  playerProfileSchema,
  replanRequestSchema,
} from "../../../../lib/api-schemas";
import { LootDataError } from "../../../../lib/loot-data";
import { MissionCoverageError, planForTarget } from "../../../../lib/planner";
import { applyReplanUpdates, replanVirtueTankNote } from "../../../../lib/replan";
import { buildVirtueTankPlannerOptions } from "../../../../lib/virtue-tank-plan";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let payloadRaw: unknown;
  try {
    payloadRaw = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }

  const parsedPayload = replanRequestSchema.safeParse(payloadRaw);
  if (!parsedPayload.success) {
    return new Response(
      JSON.stringify({
        error: "invalid replan request",
        details: formatZodIssues(parsedPayload.error),
      }),
      { status: 400 }
    );
  }

  try {
    const updates = {
      observedReturns: parsedPayload.data.observedReturns,
      missionLaunches: parsedPayload.data.missionLaunches,
    };
    const updatedProfile = applyReplanUpdates(parsedPayload.data.profile, updates);
    const validatedProfile = playerProfileSchema.safeParse(updatedProfile);
    if (!validatedProfile.success) {
      return new Response(
        JSON.stringify({
          error: "replan profile validation failed",
          details: formatZodIssues(validatedProfile.error),
        }),
        { status: 500 }
      );
    }

    const virtue = parsedPayload.data.inventorySource === "virtue";
    const result = await planForTarget(
      validatedProfile.data,
      parsedPayload.data.targetItemId,
      parsedPayload.data.quantity,
      parsedPayload.data.priorityTime,
      {
        objectiveMode: virtue ? "virtueFuel" : "ge",
        virtueTank: virtue
          ? buildVirtueTankPlannerOptions(
              validatedProfile.data.virtueTank,
              parsedPayload.data.virtueShiftCap,
              parsedPayload.data.virtueStartTank
            )
          : undefined,
        fastMode: parsedPayload.data.fastMode,
        missionDropRarities: {
          rare: parsedPayload.data.includeDropRare,
          epic: parsedPayload.data.includeDropEpic,
          legendary: parsedPayload.data.includeDropLegendary,
          fragments: parsedPayload.data.includeDropFragments,
        },
        targetCraftedOnly: parsedPayload.data.targetCraftedOnly,
        targets: parsedPayload.data.targets,
        allowedShipDurations: parsedPayload.data.allowedShipDurations,
        selectedConsumptionItemIds: parsedPayload.data.selectedConsumptionItemIds,
      }
    );
    const tankNote = virtue ? replanVirtueTankNote(validatedProfile.data, updates) : null;
    if (tankNote) {
      result.notes.push(tankNote);
    }

    const responsePayload = {
      profile: {
        eid: validatedProfile.data.eid,
        epicResearchFTLLevel: validatedProfile.data.epicResearchFTLLevel,
        epicResearchZerogLevel: validatedProfile.data.epicResearchZerogLevel,
        shipLevels: validatedProfile.data.shipLevels,
        virtueTank: validatedProfile.data.virtueTank,
      },
      plan: result,
    };

    const validatedResponse = planApiResponseSchema.safeParse(responsePayload);
    if (!validatedResponse.success) {
      return new Response(
        JSON.stringify({
          error: "replan response validation failed",
          details: formatZodIssues(validatedResponse.error),
        }),
        { status: 500 }
      );
    }

    return new Response(JSON.stringify(validatedResponse.data), { status: 200 });
  } catch (error) {
    if (error instanceof MissionCoverageError) {
      return new Response(
        JSON.stringify({
          error: "no mission coverage for required items",
          details: error.itemIds,
        }),
        { status: 422 }
      );
    }
    if (error instanceof LootDataError) {
      return new Response(
        JSON.stringify({
          error: "loot data unavailable",
          details: error.message,
        }),
        { status: 502 }
      );
    }
    const details = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: "replanning failed", details }), { status: 500 });
  }
}
