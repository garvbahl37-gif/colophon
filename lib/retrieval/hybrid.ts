import { sql, toVector } from "@/lib/db/client";
import { config } from "@/lib/config";
import type { Candidate } from "./types";

/**
 * Hybrid retrieval: dense ANN and lexical BM25-style search run as two arms of
 * ONE SQL statement and are fused by Reciprocal Rank Fusion before any row
 * leaves the database.
 *
 * Doing the fusion in SQL rather than in JS matters for more than tidiness.
 * Each arm gets its own LIMIT inside the query, so Postgres can use the HNSW
 * index for one and the GIN index for the other and only materialise the union
 * - instead of shipping two full candidate sets over the wire to be merged.
 *
 * RRF is used rather than normalised score blending because cosine distance and
 * ts_rank_cd live on incomparable scales, and any normalisation of them is a
 * guess that drifts with corpus size. Rank position is stable; scores are not.
 */

let vectorTypeCache: Promise<string> | null = null;

/** pgvector uses `halfvec` above 2000 dimensions, so the cast must match the column. */
async function vectorType(): Promise<string> {
  vectorTypeCache ??= (async () => {
    const rows = await sql<{ value: { dimensions: number } }[]>`
      SELECT value FROM index_meta WHERE key = 'embedding'
    `.catch(() => []);
    const dims = rows[0]?.value?.dimensions ?? config.embedding.dimensions;
    return dims > 2000 ? "halfvec" : "vector";
  })();
  return vectorTypeCache;
}

export interface HybridOptions {
  /** Vector to search with - the query embedding, or a HyDE answer embedding. */
  embedding: number[];
  /** Literal text for the lexical arm. Usually the raw user question. */
  text: string;
  /** Candidates per arm before fusion. */
  candidates?: number;
  /** Rows returned after fusion. */
  limit?: number;
  /** Restrict to a subset of the corpus. */
  documentIds?: string[] | null;
  denseWeight?: number;
  sparseWeight?: number;
}

/**
 * Postgres `row_number()` is bigint and `ts_rank_cd` is float4. Both are cast
 * in SQL, and coerced again in `toCandidate`, because a BigInt that reaches
 * `JSON.stringify` fails at the streaming boundary - far from its source, with
 * an error that names neither the column nor the query.
 */
interface Row {
  id: string;
  document_id: string;
  document_title: string;
  ordinal: number;
  content: string;
  context: string | null;
  heading_path: string[];
  page: number | null;
  token_count: number;
  dense_rank: number | null;
  dense_score: number | null;
  sparse_rank: number | null;
  sparse_score: number | null;
  rrf: number;
}

export async function hybridSearch(opts: HybridOptions): Promise<Candidate[]> {
  const {
    embedding,
    text,
    candidates = config.retrieval.candidates,
    limit = config.retrieval.candidates,
    documentIds = null,
    denseWeight = config.retrieval.denseWeight,
    sparseWeight = config.retrieval.sparseWeight,
  } = opts;

  const vtype = await vectorType();
  const filtering = Boolean(documentIds?.length);

  // A metadata filter shrinks the set the HNSW walk is allowed to return, so
  // widen the search breadth to keep recall steady when one is applied.
  const efSearch = filtering
    ? Math.min(800, config.retrieval.efSearch * 4)
    : config.retrieval.efSearch;

  const query = /* sql */ `
    WITH dense AS (
      SELECT c.id,
             (row_number() OVER (ORDER BY c.embedding <=> $1::${vtype}))::int AS rank,
             (1 - (c.embedding <=> $1::${vtype}))::float8 AS score
      FROM chunks c
      WHERE c.embedding IS NOT NULL
        AND ($4::text[] IS NULL OR c.document_id = ANY($4::text[]))
      ORDER BY c.embedding <=> $1::${vtype}
      LIMIT $3
    ),
    -- OR semantics, not AND.
    --
    -- websearch_to_tsquery ANDs every term, so "retry backoff circuit breaker
    -- timing" becomes a query no single chunk can satisfy and the lexical arm
    -- silently returns nothing - leaving "hybrid" search running on one leg.
    -- BM25 and every other lexical ranker score PARTIAL matches; this rebuilds
    -- the query the same way, by stemming the text with to_tsvector (which
    -- also drops stopwords and is injection-safe) and OR-ing the lexemes.
    -- ts_rank_cd then does the actual work of preferring chunks that match
    -- more terms, more densely, closer together.
    tsq AS (
      SELECT string_agg(lexeme, ' | ')::tsquery AS q
      FROM unnest(to_tsvector('english', $2))
    ),
    sparse AS (
      SELECT c.id,
             (row_number() OVER (ORDER BY ts_rank_cd(c.tsv, tsq.q, 32) DESC))::int AS rank,
             ts_rank_cd(c.tsv, tsq.q, 32)::float8 AS score
      FROM chunks c, tsq
      WHERE tsq.q IS NOT NULL
        AND c.tsv @@ tsq.q
        AND ($4::text[] IS NULL OR c.document_id = ANY($4::text[]))
      ORDER BY ts_rank_cd(c.tsv, tsq.q, 32) DESC
      LIMIT $3
    ),
    fused AS (
      SELECT
        COALESCE(d.id, s.id) AS id,
        d.rank AS dense_rank,
        d.score AS dense_score,
        s.rank AS sparse_rank,
        s.score AS sparse_score,
        ($5 * COALESCE(1.0 / ($7 + d.rank), 0.0)
       + $6 * COALESCE(1.0 / ($7 + s.rank), 0.0))::float8 AS rrf
      FROM dense d
      FULL OUTER JOIN sparse s ON d.id = s.id
    )
    SELECT f.id, f.dense_rank, f.dense_score, f.sparse_rank, f.sparse_score, f.rrf,
           c.document_id, c.ordinal, c.content, c.context, c.heading_path,
           c.page, c.token_count, doc.title AS document_title
    FROM fused f
    JOIN chunks c ON c.id = f.id
    JOIN documents doc ON doc.id = c.document_id
    ORDER BY f.rrf DESC
    LIMIT $8
  `;

  const params = [
    toVector(embedding),
    text,
    candidates,
    documentIds?.length ? documentIds : null,
    denseWeight,
    sparseWeight,
    config.retrieval.rrfK,
    limit,
  ];

  const rows = await sql.begin(async (tx) => {
    // SET LOCAL so the override dies with the transaction and never leaks to
    // another request sharing this pooled connection.
    await tx.unsafe(`SET LOCAL hnsw.ef_search = ${Math.floor(efSearch)}`);
    return tx.unsafe<Row[]>(query, params);
  });

  return (rows as unknown as Row[]).map(toCandidate);
}

/** Coerces anything Postgres hands back - bigint, numeric-as-string - to a number. */
function num(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toCandidate(r: Row): Candidate {
  return {
    id: r.id,
    documentId: r.document_id,
    documentTitle: r.document_title,
    ordinal: r.ordinal,
    content: r.content,
    context: r.context,
    headingPath: r.heading_path ?? [],
    page: r.page,
    tokenCount: num(r.token_count) ?? 0,
    denseRank: num(r.dense_rank),
    denseScore: num(r.dense_score),
    sparseRank: num(r.sparse_rank),
    sparseScore: num(r.sparse_score),
    rrfScore: num(r.rrf) ?? 0,
  };
}

/**
 * Merges candidate lists from several sub-queries with a second round of RRF,
 * so a chunk that ranks moderately for every sub-question beats one that ranks
 * first for a single sub-question.
 */
export function fuseAcrossQueries(results: { query: string; candidates: Candidate[] }[]): Candidate[] {
  if (results.length === 1) {
    return results[0].candidates.map((c) => ({ ...c, viaQueries: [results[0].query] }));
  }

  const merged = new Map<string, Candidate & { fused: number }>();
  for (const { query, candidates } of results) {
    candidates.forEach((candidate, index) => {
      const contribution = 1 / (config.retrieval.rrfK + index + 1);
      const existing = merged.get(candidate.id);
      if (existing) {
        existing.fused += contribution;
        existing.viaQueries!.push(query);
        // Keep the strongest per-arm evidence seen across sub-queries.
        existing.denseScore = Math.max(existing.denseScore ?? 0, candidate.denseScore ?? 0) || null;
        existing.sparseScore = Math.max(existing.sparseScore ?? 0, candidate.sparseScore ?? 0) || null;
      } else {
        merged.set(candidate.id, { ...candidate, fused: contribution, viaQueries: [query] });
      }
    });
  }

  return [...merged.values()]
    .sort((a, b) => b.fused - a.fused)
    .map(({ fused, ...rest }) => ({ ...rest, rrfScore: fused }));
}

/**
 * Small-to-big: pull the chunks immediately before and after each winner.
 * Reranking works best on tight, focused chunks; generation works best on
 * continuous prose. Retrieving small and expanding wide gets both.
 */
export async function expandNeighbours(
  candidates: Candidate[],
  window = config.retrieval.neighborWindow,
): Promise<Candidate[]> {
  if (window <= 0 || candidates.length === 0) return candidates;

  const wantedDocs: string[] = [];
  const wantedOrdinals: number[] = [];
  for (const c of candidates) {
    for (let o = c.ordinal - window; o <= c.ordinal + window; o++) {
      if (o < 0) continue;
      wantedDocs.push(c.documentId);
      wantedOrdinals.push(o);
    }
  }

  // Two parallel arrays zipped by `unnest` rather than a row-constructor IN
  // list: it is one bind per array instead of one per pair, and it joins
  // straight onto the (document_id, ordinal) index.
  const rows = await sql<{ document_id: string; ordinal: number; content: string }[]>`
    SELECT c.document_id, c.ordinal, c.content
    FROM chunks c
    JOIN unnest(${wantedDocs}::text[], ${wantedOrdinals}::int[]) AS w(document_id, ordinal)
      ON c.document_id = w.document_id AND c.ordinal = w.ordinal
  `;

  const byKey = new Map(rows.map((r) => [`${r.document_id}:${r.ordinal}`, r.content]));

  return candidates.map((c) => {
    const parts: string[] = [];
    for (let o = c.ordinal - window; o <= c.ordinal + window; o++) {
      const content = o === c.ordinal ? c.content : byKey.get(`${c.documentId}:${o}`);
      if (content) parts.push(content);
    }
    return { ...c, expandedContent: parts.join("\n\n") };
  });
}

export async function getEmbeddings(chunkIds: string[]): Promise<Map<string, number[]>> {
  if (chunkIds.length === 0) return new Map();
  const rows = await sql<{ id: string; embedding: string }[]>`
    SELECT id, embedding::text AS embedding FROM chunks WHERE id = ANY(${chunkIds})
  `;
  return new Map(
    rows.map((r) => [r.id, r.embedding.slice(1, -1).split(",").map(Number)] as const),
  );
}
