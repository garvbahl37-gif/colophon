import postgres from "postgres";

const configured = process.env.DATABASE_URL;
const url = configured ?? "postgres://localhost:5432/colophon";

/**
 * Whether DATABASE_URL was actually set.
 *
 * Falling back to localhost is right for development and actively misleading
 * in production, where the resulting "ECONNREFUSED 127.0.0.1:5432" sends people
 * hunting for a Postgres that was never supposed to be there. Callers use this
 * to say what is really wrong: the variable is missing.
 */
export const hasDatabaseUrl = Boolean(configured);

export function databaseHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!hasDatabaseUrl) {
    return "DATABASE_URL is not set, so the app fell back to localhost. Set it to your Postgres connection string.";
  }
  return message;
}

/**
 * Colophon keeps its tables in their own schema.
 *
 * On a shared database this is not tidiness, it is collision avoidance: a
 * Supabase project almost always already has a `public.documents`, and Colophon
 * has one too. Pinning `search_path` at connection time means every query in
 * the codebase stays unqualified and still lands in the right place.
 *
 * `extensions` is on the path because Supabase installs pgvector there rather
 * than in public, and the `vector` type has to be resolvable.
 */
export const schema = process.env.DB_SCHEMA ?? "public";
const searchPath = [schema, "extensions", "public"]
  .filter((v, i, a) => a.indexOf(v) === i)
  .join(", ");

declare global {
  var __colophonSql: postgres.Sql | undefined;
}

/**
 * Single pooled connection, memoised across Next.js hot reloads so dev doesn't
 * leak connections on every file save.
 */
export const sql: postgres.Sql =
  globalThis.__colophonSql ??
  postgres(url, {
    /*
      Three, not twelve, because the pool being drawn from is not this one.

      Measured against production: 25 concurrent requests to a single endpoint
      returned 10 failures reading

        (EMAXCONNSESSION) max clients reached in session mode
        - max clients are limited to pool_size: 15

      The database sits behind Supabase's pooler in session mode, where a
      client holds its Postgres connection for the whole session rather than
      the whole transaction, and the ceiling for the entire deployment is 15.
      Asking for 12 of those from one serverless instance means two warm
      instances can exhaust the deployment, and a third gets nothing -- which
      surfaced as intermittent 503s on the conversation list while a chat
      request was in flight, because chat holds a connection across a
      twenty-second model call.

      A request here uses one connection at a time (the three retrieval arms
      are fused in a single statement), so a small ceiling costs nothing and
      leaves room for the other instances. The real fix is the transaction
      pooler on port 6543, which returns the connection per transaction
      instead of per session; `prepare: false` below is already what that
      mode requires, so it is a URL change and nothing more.
    */
    max: 3,
    /*
      Five seconds, because a warm instance between requests is still holding
      client slots that another instance needs. Twenty seconds of grace is
      right for a long-lived server, where reconnecting is the expensive part;
      here the scarce resource is the slot, not the handshake.
    */
    idle_timeout: 5,
    prepare: false,
    connection: { search_path: searchPath },
    // Supabase and every other hosted Postgres terminates TLS at the pooler.
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? undefined : "require",
  });

if (process.env.NODE_ENV !== "production") globalThis.__colophonSql = sql;

/** Serialise a JS number[] into pgvector's text input format. */
export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** Parse pgvector's text output format back into a JS number[]. */
export function fromVector(v: string | number[] | null): number[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return v.slice(1, -1).split(",").map(Number);
}
