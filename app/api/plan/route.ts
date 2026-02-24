import { formatZodIssues, planApiResponseSchema, planRequestSchema, playerProfileSchema } from "../../../lib/api-schemas";
import { LootDataError } from "../../../lib/loot-data";
import { getPlayerProfile } from "../../../lib/profile";
import { MissionCoverageError, planForTarget } from "../../../lib/planner";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let payloadRaw: unknown;
  try {
    payloadRaw = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }

  const parsedPayload = planRequestSchema.safeParse(payloadRaw);
  if (!parsedPayload.success) {
    return new Response(
      JSON.stringify({
        error: "invalid plan request",
        details: formatZodIssues(parsedPayload.error),
      }),
      { status: 400 }
    );
  }

  try {
    const profile = await getPlayerProfile(parsedPayload.data.eid, parsedPayload.data.includeSlotted);
    const validatedProfile = playerProfileSchema.safeParse(profile);
    if (!validatedProfile.success) {
      return new Response(
        JSON.stringify({
          error: "profile response validation failed",
          details: formatZodIssues(validatedProfile.error),
        }),
        { status: 500 }
      );
    }
    const result = await planForTarget(
      validatedProfile.data,
      parsedPayload.data.targetItemId,
      parsedPayload.data.quantity,
      parsedPayload.data.priorityTime
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
          error: "plan response validation failed",
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
    return new Response(JSON.stringify({ error: "planning failed", details }), { status: 500 });
  }
}
