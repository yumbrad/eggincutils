import { NextRequest } from "next/server";

import { formatZodIssues, playerProfileSchema, profileQuerySchema } from "../../../lib/api-schemas";
import { getPlayerProfile } from "../../../lib/profile";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const parsedQuery = profileQuerySchema.safeParse({
    eid: request.nextUrl.searchParams.get("eid") ?? "",
    includeSlotted: request.nextUrl.searchParams.get("includeSlotted") ?? undefined,
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
    const profile = await getPlayerProfile(parsedQuery.data.eid, parsedQuery.data.includeSlotted);
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
    return new Response(JSON.stringify(validatedProfile.data), { status: 200 });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: "unable to get profile", details }), { status: 502 });
  }
}
