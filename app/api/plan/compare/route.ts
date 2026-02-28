import { compareRequestSchema, formatZodIssues } from "../../../../lib/api-schemas";
import { computeMonolithicPaths } from "../../../../lib/planner";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let payloadRaw: unknown;
  try {
    payloadRaw = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }

  const parsed = compareRequestSchema.safeParse(payloadRaw);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        error: "invalid compare request",
        details: formatZodIssues(parsed.error),
      }),
      { status: 400 }
    );
  }

  try {
    const results = await computeMonolithicPaths({
      profile: parsed.data.profile,
      targetItemId: parsed.data.targetItemId,
      quantity: parsed.data.quantity,
      priorityTime: parsed.data.priorityTime,
      selectedCombos: parsed.data.selectedCombos,
      missionDropRarities: {
        rare: parsed.data.includeDropRare,
        epic: parsed.data.includeDropEpic,
        legendary: parsed.data.includeDropLegendary,
      },
    });

    return new Response(JSON.stringify({ paths: results }), { status: 200 });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: "comparison failed", details }), { status: 500 });
  }
}
