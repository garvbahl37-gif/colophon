import { breadcrumb } from "@/lib/util/breadcrumb";
import { gateway, rerank } from "ai";
import { z } from "zod";
import { config } from "@/lib/config";
import { fastStageOptions, gradeModel } from "@/lib/ai/models";
import { backendOf } from "@/lib/ai/providers";
import { generateStructured } from "@/lib/ai/structured";
import type { Candidate } from "./types";

export type RerankMethod = "cross-encoder" | "local-cross-encoder" | "llm-listwise" | "none";

export interface RerankOutcome {
  candidates: Candidate[];
  method: RerankMethod;
  model: string;
}

/**
 * The single highest-leverage stage in the pipeline.
 *
 * Bi-encoders embed the query and the document independently, so they can only
 * ever compare two vectors that never saw each other. A cross-encoder reads the
 * query and the passage together in one forward pass and scores the actual
 * interaction - which is why it routinely reorders the top-40 into a materially
 * better top-8, and why retrieving wide then reranking narrow beats retrieving
 * narrow.
 *
 * It is also the stage most likely to be unavailable (no rerank model on the
 * key, provider outage), so there is a listwise LLM fallback and, below that,
 * fusion order. Retrieval degrades; it never fails.
 */
export async function rerankCandidates(
  query: string,
  candidates: Candidate[],
  topN = config.retrieval.rerankTopN,
): Promise<RerankOutcome> {
  if (candidates.length === 0) return { candidates, method: "none", model: "-" };
  if (candidates.length === 1) {
    return { candidates: [{ ...candidates[0], rerankScore: 1 }], method: "none", model: "-" };
  }

  const documents = candidates.map(asDocument);

  try {
    const backend = backendOf(config.models.rerank);

    /*
      `llm:` is a first-class choice, not a failure path. Where no cross-encoder
      can run — a serverless runtime without the native ONNX libraries, or a
      gateway without billing — a listwise pass by a small model is the best
      reranking available, and asking for it explicitly beats letting the real
      reranker throw on every single query and catching it.
    */
    if (backend === "llm") return llmRerank(query, candidates, topN);

    const ranking =
      backend === "local"
        ? await runLocal(query, documents)
        : await runHosted(query, documents, topN);

    const scored = ranking
      .map((r) => ({ ...candidates[r.originalIndex], rerankScore: r.score }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topN)
      .filter((c) => c.rerankScore >= config.retrieval.minRerankScore);

    // Everything scoring as noise usually means the corpus genuinely has
    // nothing relevant. Keep the single best so the grader can say so, rather
    // than handing the generator an empty context and letting it improvise.
    const kept =
      scored.length > 0
        ? scored
        : [{ ...candidates[ranking[0].originalIndex], rerankScore: ranking[0].score }];

    return {
      candidates: kept,
      method: backendOf(config.models.rerank) === "local" ? "local-cross-encoder" : "cross-encoder",
      model: config.models.rerank,
    };
  } catch {
    return llmRerank(query, candidates, topN);
  }
}

interface Ranked {
  originalIndex: number;
  score: number;
}

/** ONNX cross-encoder running in this process - no key, no network. */
async function runLocal(query: string, documents: string[]): Promise<Ranked[]> {
  const { localRerank } = await import("@/lib/ai/local");
  const scores = await localRerank(config.models.rerank, query, documents);
  return scores
    .map((score, originalIndex) => ({ originalIndex, score }))
    .sort((a, b) => b.score - a.score);
}

/** Hosted reranker (Cohere, Voyage) through the AI Gateway. */
async function runHosted(query: string, documents: string[], topN: number): Promise<Ranked[]> {
  const { ranking } = await rerank({
    model: gateway.rerankingModel(config.models.rerank),
    documents,
    query,
    topN: Math.min(topN, documents.length),
    maxRetries: 1,
  });
  return ranking.map((r) => ({ originalIndex: r.originalIndex, score: r.score }));
}

function asDocument(c: Candidate): string {
  const location = breadcrumb(c.documentTitle, c.headingPath);
  return `${location}\n${c.context ? `${c.context}\n` : ""}${c.content}`.slice(0, 6000);
}

const ListwiseSchema = z.object({
  rankings: z.array(
    z.object({
      index: z.number().int(),
      relevance: z.number().min(0).max(1),
    }),
  ),
});

/** Fallback: one listwise pass asking a small model to score each passage. */
async function llmRerank(
  query: string,
  candidates: Candidate[],
  topN: number,
): Promise<RerankOutcome> {
  try {
    const listing = candidates
      .map((c, i) => `<passage index="${i}">\n${asDocument(c).slice(0, 1200)}\n</passage>`)
      .join("\n\n");

    const object = await generateStructured({
      spec: config.models.grade,
      model: gradeModel(),
      schema: ListwiseSchema,
      maxOutputTokens: 2000,
      providerOptions: fastStageOptions(),
      system:
        "Score how well each passage helps answer the query, from 0 (irrelevant) to 1 (directly answers it). " +
        "Judge the passage's usefulness for answering, not its topical similarity - a passage about the right subject " +
        "that does not contain the requested fact scores low. Return one entry per passage index.",
      prompt: `<query>${query}</query>\n\n${listing}`,
    });

    const byIndex = new Map(object.rankings.map((r) => [r.index, r.relevance]));
    const scored = candidates
      .map((c, i) => ({ ...c, rerankScore: byIndex.get(i) ?? 0 }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topN)
      .filter((c) => c.rerankScore >= config.retrieval.minRerankScore);

    return {
      candidates: scored.length ? scored : candidates.slice(0, topN),
      method: "llm-listwise",
      model: config.models.grade,
    };
  } catch {
    // Last resort: trust the fusion order.
    return {
      candidates: candidates.slice(0, topN).map((c) => ({ ...c, rerankScore: c.rrfScore })),
      method: "none",
      model: "-",
    };
  }
}
