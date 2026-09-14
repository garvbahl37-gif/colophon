/**
 * Provisions the database.
 *
 * Rather than trusting EMBEDDING_DIMENSIONS, this probes the configured
 * embedding model with a real call and builds the vector column to match.
 * A width mismatch is otherwise a runtime error that only appears on the very
 * first insert, long after setup "succeeded".
 */
import "./env";
import { config } from "../lib/config";
import { schema, sql } from "../lib/db/client";
import { schemaSql, vectorType } from "../lib/db/schema";

/*
  Uses the application's own connection rather than opening a second one.
  A separate `postgres()` here silently missed search_path and TLS, so setup
  created tables in the configured schema and then looked for them in `public`
  — reporting `relation "index_meta" does not exist` against a database where
  it plainly did. One place decides how this app connects.
*/
const reset = process.argv.includes("--reset");
const url = process.env.DATABASE_URL ?? "postgres://localhost:5432/colophon";

const dim = (n: string | number) => `\x1b[2m${n}\x1b[0m`;
const ok = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const info = (s: string) => console.log(`\x1b[36m›\x1b[0m ${s}`);
const warn = (s: string) => console.log(`\x1b[33m!\x1b[0m ${s}`);

async function probeDimensions(): Promise<number> {
  const { isLocal, parseSpec, requiredKeyFor } = await import("../lib/ai/providers");
  const spec = config.models.embed;
  const key = requiredKeyFor(spec);

  if (key && !process.env[key] && !(key === "AI_GATEWAY_API_KEY" && process.env.VERCEL_OIDC_TOKEN)) {
    warn(`${key} not set - falling back to EMBEDDING_DIMENSIONS=${config.embedding.dimensions}.`);
    warn(`  Re-run 'pnpm db:reset' once the key is set if the model's width differs.`);
    return config.embedding.dimensions;
  }

  info(
    isLocal(spec)
      ? `Loading ${parseSpec(spec).id} locally (first run downloads weights)...`
      : `Probing ${spec} for its output width...`,
  );
  const { embedQuery } = await import("../lib/ai/models");
  const v = await embedQuery("dimension probe");
  ok(`${parseSpec(spec).id} returns ${v.length}-dimensional vectors`);
  return v.length;
}

async function main() {
  await sql`SELECT 1`;
  ok(`Connected ${dim(`${url.replace(/\/\/.*@/, "//")} · schema ${schema}`)}`);

  if (reset) {
    warn("--reset: dropping chunks, documents, query_log, index_meta");
    await sql.unsafe(
      `DROP TABLE IF EXISTS ${schema}.chunks, ${schema}.documents, ` +
        `${schema}.query_log, ${schema}.index_meta CASCADE;`,
    );
  }

  /*
    Create the schema only if it is genuinely absent. `CREATE SCHEMA IF NOT
    EXISTS` still requires CREATE on the database, which a least-privilege
    application role should not have — and usually the schema was already
    provisioned by a migration run as the owner.
  */
  const [{ exists: schemaExists }] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}) AS exists
  `;
  if (!schemaExists) {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    ok(`Created schema ${dim(schema)}`);
  }

  const dimensions = await probeDimensions();

  // Scoped to our schema: an unqualified relname matches a `chunks` table in
  // any schema on the database, which on a shared Supabase project is a real
  // possibility and would compare against the wrong column.
  const existing = await sql`
    SELECT a.atttypmod AS width
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = 'chunks' AND a.attname = 'embedding'
  `.catch(() => []);

  if (existing.length > 0 && existing[0].width !== dimensions && existing[0].width > 0) {
    console.error(
      `\x1b[31m✗\x1b[0m chunks.embedding is ${existing[0].width}-wide but ${config.models.embed} emits ${dimensions}.\n` +
        `  Run: pnpm db:reset`,
    );
    process.exit(1);
  }

  await sql.unsafe(schemaSql(dimensions, schema));
  const { column, ops } = vectorType(dimensions);
  ok(`Schema applied ${dim(`${column} · ${ops} · hnsw`)}`);

  await sql`
    INSERT INTO index_meta (key, value)
    VALUES ('embedding', ${sql.json({ model: config.models.embed, dimensions })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;

  const [{ count: docs }] = await sql`SELECT count(*)::int AS count FROM documents`;
  const [{ count: chunks }] = await sql`SELECT count(*)::int AS count FROM chunks`;
  ok(`Ready ${dim(`${docs} documents · ${chunks} chunks`)}`);
  await sql.end();
}

main().catch(async (e) => {
  console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
  await sql.end().catch(() => {});
  process.exit(1);
});
