import { formatZodIssues, planApiResponseSchema, planRequestSchema, playerProfileSchema } from "../../../../lib/api-schemas";
import { LootDataError } from "../../../../lib/loot-data";
import { getPlayerProfile } from "../../../../lib/profile";
import { MissionCoverageError, planForTarget, type PlannerProgressEvent } from "../../../../lib/planner";

export const runtime = "nodejs";

type PlanStreamMessage =
  | { type: "progress"; progress: PlannerProgressEvent }
  | { type: "result"; data: unknown }
  | { type: "error"; error: string; details?: unknown };

function enqueueLine(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, payload: PlanStreamMessage): void {
  controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
}

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

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const streamStartedAtMs = Date.now();
      const safeEnqueue = (payload: PlanStreamMessage) => {
        if (closed) {
          return;
        }
        try {
          enqueueLine(controller, encoder, payload);
        } catch {
          closed = true;
        }
      };
      const safeClose = () => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          controller.close();
        } catch {
          // Ignore duplicate close attempts.
        }
      };
      const emitProgress = (
        event: Omit<PlannerProgressEvent, "elapsedMs"> & { elapsedMs?: number }
      ) => {
        safeEnqueue({
          type: "progress",
          progress: {
            ...event,
            elapsedMs: event.elapsedMs ?? Date.now() - streamStartedAtMs,
          },
        });
      };

      void (async () => {
        try {
          emitProgress({
            phase: "init",
            message: "Fetching profile data...",
          });
          const profile = await getPlayerProfile(parsedPayload.data.eid, parsedPayload.data.includeSlotted);
          const validatedProfile = playerProfileSchema.safeParse(profile);
          if (!validatedProfile.success) {
            safeEnqueue({
              type: "error",
              error: "profile response validation failed",
              details: formatZodIssues(validatedProfile.error),
            });
            safeClose();
            return;
          }

          emitProgress({
            phase: "init",
            message: "Profile loaded. Starting planner solve...",
          });
          const solveElapsedOffsetMs = Date.now() - streamStartedAtMs;
          const result = await planForTarget(
            validatedProfile.data,
            parsedPayload.data.targetItemId,
            parsedPayload.data.quantity,
            parsedPayload.data.priorityTime,
            {
              fastMode: parsedPayload.data.fastMode,
              onProgress: (progress) => {
                safeEnqueue({
                  type: "progress",
                  progress: {
                    ...progress,
                    elapsedMs: solveElapsedOffsetMs + Math.max(0, Math.round(progress.elapsedMs)),
                  },
                });
              },
            }
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
            safeEnqueue({
              type: "error",
              error: "plan response validation failed",
              details: formatZodIssues(validatedResponse.error),
            });
            safeClose();
            return;
          }

          safeEnqueue({ type: "result", data: validatedResponse.data });
          safeClose();
        } catch (error) {
          if (error instanceof MissionCoverageError) {
            safeEnqueue({
              type: "error",
              error: "no mission coverage for required items",
              details: error.itemIds,
            });
            safeClose();
            return;
          }
          if (error instanceof LootDataError) {
            safeEnqueue({
              type: "error",
              error: "loot data unavailable",
              details: error.message,
            });
            safeClose();
            return;
          }
          const details = error instanceof Error ? error.message : String(error);
          safeEnqueue({
            type: "error",
            error: "planning failed",
            details,
          });
          safeClose();
        }
      })();
    },
    cancel() {
      // Client disconnected.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
