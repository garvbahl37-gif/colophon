import type { UIMessage } from "ai";
import type { Citation, GroundingIssue, QueryPlan, TraceSpan } from "@/lib/retrieval/types";

/** A retrieved passage as the UI needs it - scores included, embeddings not. */
export interface RetrievedPassage {
  marker: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string[];
  page: number | null;
  snippet: string;
  context: string | null;
  denseScore: number | null;
  sparseScore: number | null;
  denseRank: number | null;
  sparseRank: number | null;
  rrfScore: number;
  rerankScore: number | null;
}

export interface RetrievalRound {
  id: string;
  query: string;
  status: "running" | "done";
  scope: string | null;
  ms?: number;
  dense?: number;
  sparse?: number;
  fused?: number;
  method?: string;
  passages: RetrievedPassage[];
}

export type ColophonMode = "agent" | "pipeline";

/**
 * The typed contract between the RAG route and the UI.
 *
 * Every stage of the pipeline streams into the same message the answer streams
 * into, so the trace is part of the conversation record rather than ephemeral
 * telemetry - reopen a thread and you still see exactly how each answer was
 * retrieved.
 */
export type ColophonUIMessage = UIMessage<
  { latencyMs?: number; mode?: ColophonMode; model?: string },
  {
    trace: TraceSpan;
    plan: QueryPlan;
    retrieval: RetrievalRound;
    citations: Citation[];
    grounding: {
      supported: boolean;
      issues: GroundingIssue[];
      citationDensity: number;
    };
    notice: { level: "info" | "warning" | "error"; message: string };
  }
>;
