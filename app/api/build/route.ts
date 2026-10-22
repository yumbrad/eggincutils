import { APP_BUILD } from "../../../lib/app-build";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ build: APP_BUILD }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
