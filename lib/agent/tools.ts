import { tool } from "ai";
import { z } from "zod";
import { sql } from "@/lib/db/client";
import { config } from "@/lib/config";
import { embedQuery } from "@/lib/ai/models";
import { expandNeighbours, fuseAcrossQueries, hybridSearch } from "@/lib/retrieval/hybrid";
import { rerankCandidates } from "@/lib/retrieval/rerank";
import type { Candidate } from "@/lib/retrieval/types";
import { breadcrumb } from "@/lib/util/breadcrumb";
import type { EvidenceLedger } from "./ledger";

export interface ToolContext {
  ledger: EvidenceLedger;
  documentIds: string[] | null;
  /** Called whenever a tool starts, finishes, or fails, so the UI can trace it. */
  onEvent: (event: ToolEvent) => void;
}

export type ToolEvent =
  | { type: "search:start"; id: string; query: string; scope: string | null }
  | {
      type: "search:done";
      id: string;
      query: string;
      scope: string | null;
      ms: number;
      dense: number;
      sparse: number;
      fused: number;
      kept: number;
      method: string;
      candidates: Array<Candidate & { marker: number }>;
    }
  | { type: "search:error"; id: string; query: string; message: string }
  | { type: "read:done"; id: string; chunkId: string; ms: number }
  | { type: "list:done"; id: string; count: number };

let counter = 0;
const nextId = () => `t${++counter}`;

/**
 * The agent's retrieval toolbelt.
 *
 * The important design choice: each tool is a thin handle on the SAME advanced
 * pipeline used in deterministic mode - HyDE-free dense + lexical hybrid, RRF
 * fusion, cross-encoder rerank. The agent decides *what* and *when* to search;
 * the pipeline decides *how* to search well. Giving an agent a naive
 * `similaritySearch` and hoping the loop compensates is how agentic RAG ends up
 * slower AND worse than a fixed pipeline.
 */
export function createRagTools(ctx: ToolContext) {
  return {
    searchCorpus: tool({
      description:
        "Search the document corpus. Runs hybrid dense + lexical retrieval with cross-encoder reranking. " +
        "Returns numbered passages you can cite. Call this multiple times with different phrasings or sub-questions " +
        "when one search does not fully answer the question.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "A focused, self-contained search question. Phrase it the way the source document would phrase it, " +
              "not the way the user did.",
          ),
        keywords: z
          .array(z.string())
          .optional()
          .describe(
            "Exact identifiers that must match literally: function names, error codes, versions, product names. " +
              "Omit ordinary English words.",
          ),
        documentIds: z
          .array(z.string())
          .optional()
          .describe("Restrict the search to these document ids. Omit to search everything."),
        topK: z
          .number()
          .int()
          .min(1)
          .max(15)
          .optional()
          .describe("How many passages to return. Default 6. Use more for broad or comparative questions."),
      }),
      execute: async ({ query, keywords = [], documentIds, topK = 6 }) => {
        const id = nextId();
        const scope = documentIds?.length ? `${documentIds.length} document(s)` : null;
        ctx.onEvent({ type: "search:start", id, query, scope });
        const started = Date.now();

        /*
          A retrieval failure and an empty corpus are completely different
          situations, and conflating them is how this system produced its worst
          possible output: embeddings were unavailable in production, the search
          returned nothing, and the model concluded "the sources do not say" —
          a confident, wrong answer that the groundedness audit then passed,
          because that sentence is itself perfectly grounded.

          So a broken search says it is broken, loudly, and instructs the model
          not to answer from the absence of results.
        */
        let raw;
        let lexical: string;
        try {
          const embedding = await embedQuery(query);
          lexical = [query, ...keywords, ...keywords].join(" ");
          raw = await hybridSearch({
            embedding,
            text: lexical,
            documentIds: documentIds?.length ? documentIds : ctx.documentIds,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.onEvent({ type: "search:error", id, query, message });
          return {
            failed: true,
            error: message,
            instruction:
              "SEARCH IS UNAVAILABLE — this is an infrastructure failure, not an empty corpus. " +
              "Do not answer the question, and do not say the sources lack the information. " +
              "Tell the user that document search is currently failing and report this error verbatim.",
          };
        }

        const dense = raw.filter((c) => c.denseRank != null).length;
        const sparse = raw.filter((c) => c.sparseRank != null).length;

        const { candidates: reranked, method } = await rerankCandidates(query, raw, topK);
        const expanded = await expandNeighbours(reranked);
        const registered = ctx.ledger.register(expanded);

        ctx.onEvent({
          type: "search:done",
          id,
          query,
          scope,
          ms: Date.now() - started,
          dense,
          sparse,
          fused: raw.length,
          kept: registered.length,
          method,
          candidates: registered,
        });

        if (registered.length === 0) {
          return {
            found: 0,
            note: "No passages matched. Try different vocabulary, or call listDocuments to see what the corpus actually covers.",
            passages: [],
          };
        }

        return {
          found: registered.length,
          passages: registered.map((c) => ({
            cite: c.marker,
            from: breadcrumb(c.documentTitle, c.headingPath) + (c.page ? ` (p.${c.page})` : ""),
            relevance: Number((c.rerankScore ?? c.rrfScore).toFixed(3)),
            text: (c.expandedContent ?? c.content).slice(0, 4000),
          })),
        };
      },
    }),

    listDocuments: tool({
      description:
        "List what is actually in the corpus: titles, ids and sizes. Use this when a search comes back empty, " +
        "when the user asks what you know about, or to scope a search to specific documents.",
      inputSchema: z.object({}),
      execute: async () => {
        const id = nextId();
        const rows = await sql<
          { id: string; title: string; source_type: string; chunk_count: number }[]
        >`
          SELECT id, title, source_type, chunk_count
          FROM documents
          WHERE status = 'ready'
          ORDER BY created_at DESC
          LIMIT 200
        `;
        ctx.onEvent({ type: "list:done", id, count: rows.length });
        return {
          documents: rows.map((r) => ({
            id: r.id,
            title: r.title,
            type: r.source_type,
            passages: r.chunk_count,
          })),
        };
      },
    }),

    readSection: tool({
      description:
        "Read the passages surrounding one you already retrieved, by its citation number. " +
        "Use this when a passage is clearly relevant but cuts off mid-explanation, or when you need the " +
        "definition or table that sits just before or after it.",
      inputSchema: z.object({
        cite: z.number().int().min(1).describe("The citation number of a passage you already have."),
        before: z.number().int().min(0).max(4).optional().describe("Passages to read before it. Default 1."),
        after: z.number().int().min(0).max(4).optional().describe("Passages to read after it. Default 2."),
      }),
      execute: async ({ cite, before = 1, after = 2 }) => {
        const id = nextId();
        const started = Date.now();
        const anchor = ctx.ledger.get(cite);
        if (!anchor) return { error: `No passage is numbered [${cite}].` };

        const rows = await sql<{ ordinal: number; content: string; heading_path: string[] }[]>`
          SELECT ordinal, content, heading_path
          FROM chunks
          WHERE document_id = ${anchor.documentId}
            AND ordinal BETWEEN ${anchor.ordinal - before} AND ${anchor.ordinal + after}
          ORDER BY ordinal
        `;

        ctx.onEvent({ type: "read:done", id, chunkId: anchor.id, ms: Date.now() - started });

        return {
          from: anchor.documentTitle,
          cite,
          text: rows.map((r) => r.content).join("\n\n").slice(0, 8000),
        };
      },
    }),
  };
}

/** Fuses several search results when the agent ran parallel searches in one step. */
export function fuseToolResults(results: { query: string; candidates: Candidate[] }[]): Candidate[] {
  return fuseAcrossQueries(results).slice(0, config.retrieval.rerankTopN);
}
