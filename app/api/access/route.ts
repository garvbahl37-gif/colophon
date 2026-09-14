import { assertCanWrite, GuardError } from "@/lib/util/guard";

/**
 * Reports whether this instance accepts writes, and whether the caller's token
 * is one it accepts.
 *
 * Without this the interface can only discover it is locked by failing a real
 * ingest — which means the operator finds out after choosing a file, and has no
 * way to unlock ahead of time or to check a token without spending a request on
 * an LLM-backed route. Verifying here costs a database-free round trip.
 *
 * It deliberately reveals only whether the supplied token matches, never any
 * part of the expected one, and answers in the same shape either way.
 */
export async function GET(req: Request) {
  const configured = Boolean(process.env.COLOPHON_WRITE_TOKEN);

  try {
    assertCanWrite(req);
    return Response.json({ writable: true, protected: configured });
  } catch (error) {
    if (error instanceof GuardError) {
      return Response.json({
        writable: false,
        protected: configured,
        reason: error.message,
      });
    }
    throw error;
  }
}
