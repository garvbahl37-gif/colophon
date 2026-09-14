import { sql } from "@/lib/db/client";
import { config } from "@/lib/config";
import { parseSpec, requiredKeyFor } from "@/lib/ai/providers";

export async function GET() {
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
    checks.database = { ok: false, detail: (error as Error).message };
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
