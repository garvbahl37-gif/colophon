/**
 * Guards for endpoints that cost money or change state.
 *
 * This app is deployed publicly with no user accounts, and two of its routes
 * are expensive: ingestion runs one LLM call per chunk, and chat runs a whole
 * agent loop. Without a gate, a stranger with the URL can drain the API key
 * behind it or delete the corpus. These are the cheapest controls that
 * actually close that, and they are deliberately not an auth system — a
 * single shared secret plus a per-IP budget is the right size for this.
 */

/** Writes are refused entirely unless a secret is configured AND matches. */
export function assertCanWrite(req: Request): void {
  const expected = process.env.COLOPHON_WRITE_TOKEN;

  // Local development stays frictionless; a public deployment does not.
  if (!expected) {
    if (process.env.VERCEL) {
      throw new GuardError(
        "This deployment is read-only: COLOPHON_WRITE_TOKEN is not configured.",
        503,
      );
    }
    return;
  }

  const supplied =
    req.headers.get("x-colophon-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";

  if (!timingSafeEqual(supplied, expected)) {
    throw new GuardError("Not authorised to modify the corpus.", 401);
  }
}

export class GuardError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Constant-time compare so a wrong token cannot be found byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── Rate limiting ─────────────────────────────────────────────────────────
   In-memory and per-instance, which on serverless means the real limit is
   looser than the number here. That is an honest trade: it stops a single
   client hammering one warm instance, costs nothing, and needs no Redis. It
   is not a defence against a distributed attacker, and the write token is
   what actually protects the expensive paths.
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
