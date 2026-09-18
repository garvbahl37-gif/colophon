/** Corpus integrity check: pnpm doctor */
import "./env";
import { sql, schema } from "../lib/db/client";
import { config } from "../lib/config";

/**
 * What is wrong with the corpus that nothing else will tell you.
 *
 * Every check here exists because the condition it looks for actually happened
 * and stayed invisible. The one that prompted the file: two documents carried no
 * situating line at all, having been ingested while batched contextualisation
 * was failing silently. They looked completely normal — right chunk counts,
 * status ready, retrievable — and they quietly skewed an evaluation, because the
 * documents they competed against had been ingested after the fix.
 *
 * Nothing here is a performance metric. These are all states that should be
 * impossible, phrased as questions with a right answer, so a wrong one is a bug
 * rather than a judgement call.
 */

interface Finding {
  level: "fail" | "warn";
  what: string;
  detail: string;
  fix: string;
}

const findings: Finding[] = [];
const ok: string[] = [];

function report(level: Finding["level"], count: number, what: string, detail: string, fix: string) {
  if (count > 0) findings.push({ level, what, detail, fix });
  else ok.push(what);
}

const [{ chunks, documents }] = await sql<{ chunks: number; documents: number }[]>`
  SELECT (SELECT count(*)::int FROM chunks) AS chunks,
         (SELECT count(*)::int FROM documents) AS documents
`;

/*
  Contextual retrieval is the ingestion headline and the easiest thing to lose:
  the call fails, the chunk is indexed anyway, and the only symptom is slightly
  worse retrieval on that document forever.
*/
const [ctx] = await sql<{ missing: number }[]>`
  SELECT count(*)::int AS missing
  FROM chunks c JOIN documents d ON d.id = c.document_id
  WHERE c.context IS NULL AND d.superseded_by IS NULL
`;
report(
  "fail",
  config.contextual.enabled ? ctx.missing : 0,
  "every indexed passage carries a situating line",
  `${ctx.missing} of ${chunks} passages have none, so they are indexed on their body text alone`,
  "re-ingest those documents; they were indexed while contextualisation was failing",
);

/*
  "Ready with zero chunks" is the shape of the bug where a failed ingest answered
  every future upload of the same file with "already indexed".
*/
const [empty] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM documents WHERE status = 'ready' AND chunk_count = 0
`;
report("fail", empty.n, "no document claims to be ready while holding nothing",
  `${empty.n} documents are marked ready with zero passages`,
  "delete them; they will answer a re-upload as a duplicate and return nothing");

/* A document stuck mid-pipeline is one whose function died. */
const [stuck] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM documents
  WHERE status NOT IN ('ready', 'failed') AND updated_at < now() - interval '30 minutes'
`;
report("warn", stuck.n, "nothing is stuck mid-ingest",
  `${stuck.n} documents have been indexing for over 30 minutes`,
  "the function that was processing them died; delete and re-ingest");

/* Chunk counts drift when a partial failure leaves the row's summary stale. */
const [drift] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM documents d
  WHERE d.status = 'ready'
    AND d.chunk_count <> (SELECT count(*) FROM chunks c WHERE c.document_id = d.id)
`;
report("fail", drift.n, "recorded passage counts match the passages",
  `${drift.n} documents report a chunk count that disagrees with the table`,
  "re-ingest; the row's summary drifted from its contents");

/*
  Two current versions of one document means the version chain broke.

  Grouped by title as well as source, matching how ingestion decides identity:
  two unrelated uploads called notes.md are two documents, not a broken chain,
  and a checker that called that a failure would be training the reader to
  ignore it.
*/
const [dupes] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM (
    SELECT source_uri, coalesce(owner_id, ''), title, count(*)
    FROM documents
    WHERE superseded_by IS NULL AND source_uri IS NOT NULL AND status = 'ready'
    GROUP BY 1, 2, 3 HAVING count(*) > 1
  ) x
`;
report("fail", dupes.n, "one current version per document",
  `${dupes.n} sources have more than one current version`,
  "the supersede step did not run; the newest should retire the others");

/* The column width and the model must agree or every insert fails at runtime. */
const [meta] = await sql<{ value: { model: string; dimensions: number } }[]>`
  SELECT value FROM index_meta WHERE key = 'embedding'
`;
const [width] = await sql<{ w: number }[]>`
  SELECT a.atttypmod AS w FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ${schema} AND c.relname = 'chunks' AND a.attname = 'embedding'
`;
const mismatch = meta && width && width.w > 0 && width.w !== meta.value.dimensions ? 1 : 0;
report("fail", mismatch, "the embedding column matches the model that filled it",
  `column is ${width?.w}-wide, index_meta records ${meta?.value.dimensions} from ${meta?.value.model}`,
  "run pnpm db:reset and re-ingest; the two can never be reconciled in place");

/* A saved conversation with no messages is a row the reader will click into
   and find empty -- worse than it not being listed at all. */
const [hollow] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM conversations WHERE jsonb_array_length(messages) = 0
`;
report("fail", hollow.n, "every saved conversation has messages in it",
  `${hollow.n} conversations are listed but hold nothing`,
  "delete them; they will open empty");

/* Vectors are what retrieval runs on; a null one is a passage that cannot be found. */
const [novec] = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM chunks WHERE embedding IS NULL
`;
report("fail", novec.n, "every passage has a vector",
  `${novec.n} passages have no embedding and are unreachable by the dense arm`,
  "re-ingest those documents");

/* ── Output ─────────────────────────────────────────────────────────────── */

const dim = (t: string) => `\x1b[2m${t}\x1b[0m`;
console.log(`\n\x1b[1mCorpus integrity\x1b[0m  ${dim(`${documents} documents · ${chunks} passages · schema ${schema}`)}\n`);

for (const name of ok) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
for (const f of findings) {
  const tag = f.level === "fail" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m!\x1b[0m";
  console.log(`  ${tag} ${f.what}`);
  console.log(`      ${f.detail}`);
  console.log(`      ${dim(f.fix)}`);
}

const failed = findings.filter((f) => f.level === "fail").length;
console.log(
  failed > 0
    ? `\n  \x1b[31m${failed} problem${failed === 1 ? "" : "s"} that should be impossible.\x1b[0m\n`
    : `\n  \x1b[32mNothing wrong that this knows how to look for.\x1b[0m\n`,
);

await sql.end();

/*
  exitCode rather than exit(): process.exit tears the process down before stdout
  has necessarily flushed, so piping this through pnpm printed a clean exit code
  and not one line of the report.
*/
process.exitCode = failed > 0 ? 1 : 0;
