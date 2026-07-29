import { z } from "zod";
import { generateNotesStream, ServiceBusyError } from "@/lib/ai/generate";
import { getFormat } from "@/lib/ai/prompts";
import { auth } from "@/lib/auth";
import { createNote } from "@/lib/db/queries/notes";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { withRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/notes/generate — streaming Quick Notes (W2, docs/05).
 *
 * Thin (AGENTS.md): session → validate → call the AI layer → shape the response. All model
 * spend, caching, quota, the degradation ladder and the ledger live in `generateNotesStream`
 * (lib/ai/generate.ts) — this handler never touches a model or the database directly (notes are
 * persisted through the userId-scoped query layer).
 *
 * Response contract — the client branches on `X-Edgify-Kind`:
 *   - `stream` : body is progressive markdown text; `X-Edgify-Tier` names the tier.
 *   - `final`  : JSON `{ data, tier, notice }` — a cache hit, a quiz, or the demo/quota fallback.
 *   - `busy`   : JSON `{ message }` — every tier failed and no demo exists (the only failure).
 *   - `message`: JSON `{ message }` — input the user can fix (too short / too long).
 * No raw errors, status codes, or vendor names ever reach the body (docs/04 §7).
 *
 * Rate limited per IP BEFORE the session lookup (docs/06 Phase 2). This is the expensive one:
 * unwrapped, an unauthenticated caller drives a session DB read per request, and this route is
 * the entry point to model-tier spend. The limit is generous enough for a shared campus NAT —
 * authenticated users are already bounded by the per-user daily quota (docs/04 §5); this exists
 * to stop an anonymous burst, not to ration real work.
 */

export const dynamic = "force-dynamic";

const MIN_CHARS = 200;
const MAX_CHARS = 40_000;

const bodySchema = z.object({
  text: z.string(),
  format: z.string(),
});

const NO_STORE = { "Cache-Control": "no-store" } as const;

function reply(
  kind: "final" | "busy" | "message" | "auth",
  body: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(body, {
    status,
    headers: { ...NO_STORE, "X-Edgify-Kind": kind },
  });
}

async function handler(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return reply("auth", { message: "Please sign in again to continue." }, 401);
  }
  const userId = session.user.id;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return reply("message", {
      message: "Something went wrong on our side. Please try again in a moment.",
    });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success || !getFormat(parsed.data.format)) {
    // The UI only ever sends a known format and non-empty text; this is an unexpected client.
    return reply("message", {
      message: "Something went wrong on our side. Please try again in a moment.",
    });
  }

  const text = parsed.data.text.trim();
  if (text.length < MIN_CHARS) {
    return reply("message", {
      message: "There isn't enough text here to work with. Add a few paragraphs.",
    });
  }
  if (text.length > MAX_CHARS) {
    return reply("message", {
      message:
        "That's more than Edgify can take at once. Trim it to about 40,000 characters and try again.",
    });
  }

  const format = parsed.data.format;
  const input = { userId, operation: "quick_notes" as const, format, text };

  let result;
  try {
    result = await generateNotesStream(input, {}, { signal: request.signal });
  } catch (err) {
    if (err instanceof ServiceBusyError) {
      return reply("busy", { message: err.message });
    }
    // Never surface a raw error (docs/04 §7); map anything unexpected to the calm message.
    log.error("notes generate: unexpected failure", err, { userId, format });
    return reply("busy", {
      message: "Server is busy, please try again in a moment.",
    });
  }

  if (result.kind === "final") {
    // Persist only genuinely new generations: never demo/sample content (docs/04 §2), and never
    // re-save a cache hit (the note already exists from the first generation).
    if (result.tier === "free" || result.tier === "paid") {
      void persistNote(userId, format, result.data);
    }
    return reply("final", {
      data: result.data,
      tier: result.tier,
      notice: result.notice,
    });
  }

  // Live stream: forward tokens, accumulate for best-effort persistence on completion.
  const encoder = new TextEncoder();
  const tier = result.tier;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let accumulated = "";
      try {
        for await (const chunk of result.textStream) {
          accumulated += chunk;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        // Tokens already sent; end the stream calmly. The client keeps what it has.
        log.error("notes generate: mid-stream failure", err, { userId, format });
      } finally {
        controller.close();
      }
      if (accumulated.trim().length > 0) {
        void persistNote(userId, format, accumulated);
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...NO_STORE,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Edgify-Kind": "stream",
      "X-Edgify-Tier": tier,
    },
  });
}

export const POST = withRateLimit("notes-generate", handler, {
  limit: 60,
  windowMs: 60_000,
});

/** Best-effort save (W2 step 10). A failure is logged, never surfaced (docs/04 §7). */
async function persistNote(userId: string, format: string, data: unknown): Promise<void> {
  const contentMd = typeof data === "string" ? data : JSON.stringify(data);
  try {
    await createNote(userId, {
      format,
      contentMd,
      promptVersion: env.PROMPT_VERSION,
    });
  } catch (err) {
    log.error("notes generate: note persistence failed", err, { userId, format });
  }
}
