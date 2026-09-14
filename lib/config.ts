/**
 * Single source of truth for every tunable in the RAG pipeline.
 *
 * Nothing in lib/retrieval or lib/ingest hardcodes a model id, a `k`, or a
 * weight — they all read from here, so the whole system can be re-tuned from
 * .env.local without touching code, and the eval harness can sweep values.
 */

const num = (v: string | undefined, fallback: number) => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (v: string | undefined, fallback: boolean) =>
  v == null ? fallback : v !== "false" && v !== "0";

export const config = {
  models: {
    /** Writes the final grounded answer. Quality matters most here. */
    generate: process.env.MODEL_GENERATE ?? "ollama:gpt-oss:120b",
    /** Rewrites / decomposes / HyDEs the query. Latency-critical, so small. */
    plan: process.env.MODEL_PLAN ?? "ollama:gpt-oss:20b",
    /** Writes the situating context for each chunk at ingest time. */
    contextualize: process.env.MODEL_CONTEXTUALIZE ?? "ollama:gpt-oss:20b",
    /** Judges context sufficiency and answer groundedness. */
    grade: process.env.MODEL_GRADE ?? "ollama:gpt-oss:20b",
    embed: process.env.MODEL_EMBED ?? "local:Xenova/bge-base-en-v1.5",
    /** True cross-encoder. Falls back to a listwise LLM reranker if absent. */
    rerank: process.env.MODEL_RERANK ?? "local:Xenova/ms-marco-MiniLM-L-6-v2",
  },

  retrieval: {
    /** Candidates pulled per arm (dense + sparse) per sub-query. */
    candidates: num(process.env.RETRIEVAL_CANDIDATES, 40),
    /** Reciprocal Rank Fusion smoothing constant. 60 is the paper default. */
    rrfK: num(process.env.RETRIEVAL_RRF_K, 60),
    denseWeight: num(process.env.RETRIEVAL_DENSE_WEIGHT, 0.5),
    sparseWeight: num(process.env.RETRIEVAL_SPARSE_WEIGHT, 0.5),
    /** Weight of the verbatim-identifier arm. Only active when a query has any. */
    identifierWeight: num(process.env.RETRIEVAL_IDENTIFIER_WEIGHT, 0.6),
    /** How many survive the cross-encoder. */
    rerankTopN: num(process.env.RETRIEVAL_RERANK_TOP_N, 10),
    /** How many finally reach the generator after MMR + expansion. */
    contextChunks: num(process.env.RETRIEVAL_CONTEXT_CHUNKS, 8),
    /** Agentic re-retrieval budget. 1 = no self-correction. */
    maxHops: num(process.env.RETRIEVAL_MAX_HOPS, 2),
    /** MMR tradeoff: 1.0 = pure relevance, 0.0 = pure diversity. */
    mmrLambda: num(process.env.RETRIEVAL_MMR_LAMBDA, 0.72),
    /** Small-to-big: ± this many sibling chunks appended to each winner. */
    neighborWindow: num(process.env.RETRIEVAL_NEIGHBOR_WINDOW, 1),
    /** HNSW search breadth. Higher = better recall, slower. */
    efSearch: num(process.env.RETRIEVAL_EF_SEARCH, 120),
    /** Rerank scores below this are treated as noise and dropped. */
    minRerankScore: num(process.env.RETRIEVAL_MIN_RERANK_SCORE, 0.015),
  },

  chunking: {
    targetTokens: num(process.env.CHUNK_TARGET_TOKENS, 500),
    overlapTokens: num(process.env.CHUNK_OVERLAP_TOKENS, 64),
    minTokens: num(process.env.CHUNK_MIN_TOKENS, 48),
    maxTokens: num(process.env.CHUNK_MAX_TOKENS, 900),
  },

  contextual: {
    enabled: bool(process.env.CONTEXTUAL_RETRIEVAL, true),
    /** Docs longer than this get a windowed excerpt as context, not the whole text. */
    maxDocChars: num(process.env.CONTEXTUAL_MAX_DOC_CHARS, 48_000),
    /** Parallel contextualization requests. */
    concurrency: num(process.env.CONTEXTUAL_CONCURRENCY, 8),
  },

  embedding: {
    dimensions: num(process.env.EMBEDDING_DIMENSIONS, 768),
    /** Batch size for embedMany at ingest. */
    batchSize: num(process.env.EMBEDDING_BATCH_SIZE, 96),
  },
} as const;

export type Config = typeof config;
