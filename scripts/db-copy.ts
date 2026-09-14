/**
 * Copies a corpus between two databases.
 *
 *   pnpm db:copy "<source-url>" "<target-url>" [source-schema] [target-schema]
 *
 * Copies rather than re-ingests. Re-ingesting would re-run contextualisation —
 * one LLM call per chunk — and re-embed everything, for a result that is
 * identical only if the same models are configured. Embeddings are moved as
 *-is, which is exactly right when the embedding model is unchanged and exactly
 * wrong when it is not: vectors from different models are not comparable, so
 * this refuses to run when the stored dimension does not match the target's.
 */
import "./env";
import postgres from "postgres";

const [sourceUrl, targetUrl, sourceSchema = "public", targetSchema = "colophon"] =
  process.argv.slice(2);

if (!sourceUrl || !targetUrl) {
  console.error('usage: pnpm db:copy "<source-url>" "<target-url>" [source-schema] [target-schema]');
  process.exit(1);
}

const ok = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const info = (s: string) => console.log(`\x1b[36m›\x1b[0m ${s}`);
const dim = (s: string | number) => `\x1b[2m${s}\x1b[0m`;

function connect(url: string, schema: string) {
  return postgres(url, {
    max: 1,
    prepare: false,
    connection: { search_path: `${schema}, extensions, public` },
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? undefined : "require",
  });
}

const from = connect(sourceUrl, sourceSchema);
const to = connect(targetUrl, targetSchema);

async function main() {
  const [srcDim] = await from<{ width: number }[]>`
    SELECT a.atttypmod AS width
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${sourceSchema} AND c.relname = 'chunks' AND a.attname = 'embedding'
  `;
  const [tgtDim] = await to<{ width: number }[]>`
    SELECT a.atttypmod AS width
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${targetSchema} AND c.relname = 'chunks' AND a.attname = 'embedding'
  `;

  if (!srcDim || !tgtDim) throw new Error("chunks.embedding not found in one of the schemas");
  if (srcDim.width !== tgtDim.width) {
    throw new Error(
      `Embedding width differs: source ${srcDim.width}, target ${tgtDim.width}. ` +
        `Vectors from different models are not comparable — re-ingest instead of copying.`,
    );
  }
  ok(`Embedding width matches ${dim(`${srcDim.width}d`)}`);

  const documents = await from`SELECT * FROM documents ORDER BY created_at`;
  info(`Copying ${documents.length} documents`);

  let chunkTotal = 0;
  for (const doc of documents) {
    await to`INSERT INTO documents ${to(doc as never)} ON CONFLICT (id) DO NOTHING`;

    // embedding::text so the vector survives the hop as its literal form; the
    // target casts it back on insert.
    const chunks = await from`
      SELECT id, document_id, ordinal, content, context, indexed_text, heading_path,
             page, char_start, char_end, token_count, embedding::text AS embedding,
             metadata, created_at
      FROM chunks WHERE document_id = ${doc.id as string} ORDER BY ordinal
    `;

    const BATCH = 100;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      await to`
        INSERT INTO chunks ${to(slice as never)}
        ON CONFLICT (id) DO NOTHING
      `;
    }
    chunkTotal += chunks.length;
    ok(`${doc.title} ${dim(`${chunks.length} chunks`)}`);
  }

  const [after] = await to<{ d: number; c: number }[]>`
    SELECT (SELECT count(*)::int FROM documents) AS d, (SELECT count(*)::int FROM chunks) AS c
  `;
  ok(`Target now holds ${dim(`${after.d} documents · ${after.c} chunks`)} (copied ${chunkTotal})`);

  await from.end();
  await to.end();
}

main().catch(async (e) => {
  console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
  await from.end().catch(() => {});
  await to.end().catch(() => {});
  process.exit(1);
});
