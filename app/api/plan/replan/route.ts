import {
  formatZodIssues,
  planApiResponseSchema,
  playerProfileSchema,
  replanRequestSchema,
} from "../../../../lib/api-schemas";
import { LootDataError } from "../../../../lib/loot-data";
import { MissionCoverageError, planForTarget } from "../../../../lib/planner";
import { applyReplanUpdates } from "../../../../lib/replan";

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
    const updatedProfile = applyReplanUpdates(parsedPayload.data.profile, {
      observedReturns: parsedPayload.data.observedReturns,
      missionLaunches: parsedPayload.data.missionLaunches,
    });
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

    const result = await planForTarget(
      validatedProfile.data,
      parsedPayload.data.targetItemId,
      parsedPayload.data.quantity,
      parsedPayload.data.priorityTime,
      parsedPayload.data.riskProfile,
      { fastMode: parsedPayload.data.fastMode }
    );

    const responsePayload = {
      profile: {
        eid: validatedProfile.data.eid,
        epicResearchFTLLevel: validatedProfile.data.epicResearchFTLLevel,
        epicResearchZerogLevel: validatedProfile.data.epicResearchZerogLevel,
        shipLevels: validatedProfile.data.shipLevels,
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
