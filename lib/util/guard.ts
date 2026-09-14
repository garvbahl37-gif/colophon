/**
 * Guards for endpoints that cost money.
 *
 * This app is deployed publicly with no user accounts, and two of its routes
 * are expensive: ingestion runs one LLM call per chunk, and chat runs a whole
 * agent loop. The controls here bound how fast anyone can spend that, and
 * deliberately stop there.
 *
 * An earlier version put a shared secret in front of writes. It protected the
 * key, and it also meant the person who owned the instance had to paste a
 * password into their own site before they could add a document — a password
 * that, to be useful in a browser, would have had to be handed to every
 * visitor anyway. That trade was not worth making. What is actually worth
 * protecting here is the bill, and a budget protects the bill without asking
 * anyone to hold a secret: see lib/util/budget.ts for the ceiling, and the
 * per-IP limiter below for the rate.
 *
 * This is a considered trade, not an oversight. Anyone with the URL can add or
 * remove documents. If this instance ever holds something that must not be
 * touched by a stranger, the answer is Vercel Deployment Protection in front
 * of the whole site, not a secret typed into a public page.
 */

export class GuardError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/* ── Rate limiting ─────────────────────────────────────────────────────────
   In-memory and per-instance, which on serverless means the real limit is
   looser than the number here. That is an honest trade: it stops a single
   client hammering one warm instance, costs nothing, and needs no Redis. It
   is not a defence against a distributed attacker; the daily ceiling in
   lib/util/budget.ts is what actually bounds the spend.
*/

const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

export function assertWithinRate(req: Request, limit: number, name: string): void {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  const key = `${name}:${ip}`;
  const now = Date.now();

  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else if (++bucket.count > limit) {
    const seconds = Math.ceil((bucket.resetAt - now) / 1000);
    throw new GuardError(`Too many requests. Try again in ${seconds}s.`, 429);
  }

  // Keep the map from growing without bound on a long-lived instance.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
  }
}

export function guardResponse(error: unknown): Response | null {
  if (error instanceof GuardError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return null;
}
