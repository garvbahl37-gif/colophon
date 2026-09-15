import { databaseHint, sql } from "@/lib/db/client";
import { config } from "@/lib/config";
import { parseSpec, requiredKeyFor } from "@/lib/ai/providers";
import { assertWithinRate, guardResponse } from "@/lib/util/guard";

/*
  Public and unauthenticated, which is the point: the routing table and the
  retrieval settings are already in the README, and an instance that will not
  say how it is configured is not auditable. It reports whether a key is
  present, never its value.

  It does touch the database, though, so it is rate limited like everything
  else that does. An endpoint that is cheap for us and free for a stranger to
  call in a loop is still a way to spend our connection pool.
*/
export async function GET(req: Request) {
  try {
    assertWithinRate(req, 30, "health");
  } catch (error) {
    const refused = guardResponse(error);
    if (refused) return refused;
    throw error;
  }

  const checks: Record<string, { ok: boolean; detail: string }> = {};

  try {
    const [meta] = await sql<{ value: { model: string; dimensions: number } }[]>`
      SELECT value FROM index_meta WHERE key = 'embedding'
    `;
    checks.database = {
      ok: true,
      detail: meta ? `${meta.value.model} · ${meta.value.dimensions}d` : "schema present",
    };
  } catch (error) {
    checks.database = { ok: false, detail: databaseHint(error) };
  }

  // Only check for keys the CURRENT routing actually needs. A setup running
  // entirely on Ollama plus local ONNX needs no gateway key, and reporting it
  // as unhealthy would be wrong.
  const needed = new Map<string, string[]>();
  for (const [stage, spec] of Object.entries(config.models)) {
    const key = requiredKeyFor(spec);
    if (key) needed.set(key, [...(needed.get(key) ?? []), stage]);
  }

  for (const [key, stages] of needed) {
    const present =
      Boolean(process.env[key]) ||
      (key === "AI_GATEWAY_API_KEY" && Boolean(process.env.VERCEL_OIDC_TOKEN));
    checks[key] = {
      ok: present,
      detail: present ? `set · used by ${stages.join(", ")}` : `missing · required by ${stages.join(", ")}`,
    };
  }

  return Response.json({
    ok: Object.values(checks).every((c) => c.ok),
    checks,
    routing: Object.fromEntries(
      Object.entries(config.models).map(([stage, spec]) => {
        const { backend, id } = parseSpec(spec);
        return [stage, `${backend} · ${id}`];
      }),
    ),
    retrieval: config.retrieval,
  });
}
