import { LootDataError, loadLootData } from "../../../lib/loot-data";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const loot = await loadLootData();
    return new Response(JSON.stringify(loot), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    if (error instanceof LootDataError) {
      return new Response(
        JSON.stringify({ error: "loot data unavailable", details: error.message }),
        { status: 502 }
      );
    }
    const details = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ error: "failed to load loot data", details }),
      { status: 500 }
    );
  }
}
