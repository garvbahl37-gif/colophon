export interface Candidate {
  id: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  content: string;
  context: string | null;
  headingPath: string[];
  page: number | null;
  tokenCount: number;

  /** Rank/score from the pgvector arm. Null means this arm never saw it. */
  denseRank: number | null;
  denseScore: number | null;
  /** Rank/score from the Postgres full-text arm. */
  sparseRank: number | null;
  sparseScore: number | null;
  /** Rank/score from the verbatim-identifier arm. */
  identRank: number | null;
  identScore: number | null;
  /** Weighted Reciprocal Rank Fusion across the arms. */
  rrfScore: number;
  /** Cross-encoder relevance, present only after the rerank stage. */
  rerankScore?: number;
  /** Which sub-query surfaced this chunk. */
  viaQueries?: string[];
  /** Populated by neighbour expansion for generation-time context. */
  expandedContent?: string;
}

export type TraceStage =
  | "plan"
  | "retrieve"
  | "rerank"
  | "grade"
  | "compress"
  | "generate"
  | "verify";

export type TraceStatus = "running" | "done" | "skipped" | "error";

export interface TraceSpan {
  id: string;
  /**
   * A span that wraps the whole run rather than being one step of it - the
   * agent loop, which opens before its own tool calls and closes after them.
   * Rendered last, as a footer, so the trace reads in causal order.
   */
  summary?: boolean;
  stage: TraceStage;
  label: string;
  status: TraceStatus;
  ms?: number;
  detail?: string;
  metrics?: Record<string, string | number>;
}

export interface QueryPlan {
  /** The user's question rewritten to stand alone without chat history. */
  standalone: string;
  /** Independent retrievals to run. One entry for a simple question. */
  subQueries: string[];
  /**
   * One fabricated ideal answer per sub-query, index-aligned with `subQueries`.
   *
   * A single hypothetical shared across sub-queries makes decomposition a
   * no-op for the dense arm: every sub-query embeds the same vector, returns
   * the same rows, and cross-query RRF then doubles their score — actively
   * amplifying whichever side the one hypothetical leaned toward.
   */
  hypotheticals: string[];
  /** Rare identifiers worth forcing into the lexical arm. */
  keywords: string[];
  /** False for greetings and meta-questions, which skip retrieval entirely. */
  needsRetrieval: boolean;
  intent: "factual" | "comparative" | "procedural" | "summarisation" | "conversational";
}

export interface Citation {
  marker: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string[];
  page: number | null;
  snippet: string;
  score: number;
}

/** A sentence in the answer that the groundedness auditor could not support. */
export interface GroundingIssue {
  claim: string;
  reason: string;
}
