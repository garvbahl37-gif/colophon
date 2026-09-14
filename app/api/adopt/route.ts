import { sql } from "@/lib/db/client";
import { currentOwner } from "@/lib/util/owner";

/**
 * One-time claim of the shared sample corpus by the browser that visits it.
 *
 * Documents with a null owner are readable by every visitor. Moving them to a
 * specific owner cannot be done from a server or a migration, because the
 * owner id lives in an httpOnly cookie that only the operator's own browser
 * holds — so the claim has to be made from that browser, by visiting this.
 *
 * It is inert unless COLOPHON_ADOPT_KEY is configured AND the supplied key
 * matches, so the endpoint existing is not itself a way to seize the corpus.
 * Remove the variable once the claim is made; the route then answers 404 to
 * everyone, including whoever knew the key.
 *
 * The key arrives in the request body, never in the URL. A query string is
 * written to the platform's access log, the browser's history and every proxy
 * in between, so a one-time secret placed there outlives its one use in at
 * least three logs. The /adopt page carries it in the URL fragment, which is
 * never transmitted, and posts it from the browser instead.
 */

/** Constant-time compare so the key cannot be found one byte at a time. */
function matches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: Request) {
  const expected = process.env.COLOPHON_ADOPT_KEY;

  let supplied = "";
  try {
    supplied = ((await req.json()) as { key?: string }).key ?? "";
  } catch {
    supplied = "";
  }

  // Indistinguishable from a route that does not exist: an unconfigured
  // instance and a wrong key answer identically.
  if (!expected || !matches(supplied, expected)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const owner = await currentOwner();
  const claimed = await sql`
    UPDATE documents SET owner_id = ${owner}, updated_at = now()
    WHERE owner_id IS NULL
    RETURNING id, title
  `;

  return Response.json({
    claimed: claimed.length,
    titles: claimed.map((d) => d.title),
    note: "These documents are now private to this browser. No other visitor can list, search or delete them.",
  });
}
