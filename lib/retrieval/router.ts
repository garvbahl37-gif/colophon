import { config } from "@/lib/config";
import type { QueryPlan } from "./types";

/**
 * Choosing a retrieval strategy per question instead of running one for all.
 *
 * The pipeline has a single set of dials — how many candidates, how the arms
 * are weighted, whether to spend a cross-encoder pass — and they were tuned for
 * the hardest case: an open conceptual question over a corpus that may not
 * contain the answer. Most questions are not that. "What is ERR_Q_0042?" is
 * decided entirely by the identifier arm, and everything after it is latency
 * spent confirming a result that was already correct at rank one.
 *
 * The signals are deliberately cheap and mostly deterministic. The planner
 * already read the question and returned its keywords, its decomposition and
 * its intent; reading those costs nothing, where a second model call to
 * classify would cost a whole round trip on a provider that serialises them —
 * spending latency to decide how to save latency.
 *
 * Every route states what it gives up. A router that only ever adds work is
 * not a router, it is a default.
 */

export type Route = "lookup" | "compare" | "summarize" | "explore";

export interface Strategy {
  route: Route;
  /** Candidates pulled per arm, per sub-query. */
  candidates: number;
  /** Fusion weights. Lookups lean on exact wording, explanations on meaning. */
  denseWeight: number;
  sparseWeight: number;
  /** Whether to spend the cross-encoder pass. */
  rerank: boolean;
  /** Whether to embed the invented passage instead of the sub-query. */
  hyde: boolean;
  /** Sibling chunks appended to each winner. */
  neighborWindow: number;
  /** One line, shown in the trace, saying what was chosen and why. */
  because: string;
}

/** A question that names something exactly: an error code, a setting, a version. */
export const IDENTIFIER = /\b(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|[a-z]+_[a-z_]+|v\d+\.\d+|\d{3,}|[A-Za-z]+\(\)|ERR[_A-Z0-9]+)\b/;
export const QUOTED = /["'`][^"'`]{3,}["'`]/;
export const COMPARISON = /\b(versus|vs\.?|compare|difference|differ|both|either|rather than|instead of|against)\b/i;
export const SUMMARY = /\b(summar|overview|outline|gist|what (?:is|are) .{0,20}about|key points|tl;?dr)/i;

export function chooseStrategy(plan: QueryPlan, question: string): Strategy {
  const base = config.retrieval;

  const hasIdentifier = plan.keywords.length > 0 || IDENTIFIER.test(question) || QUOTED.test(question);
  const looksComparative = COMPARISON.test(question) || plan.subQueries.length > 1;
  const looksSummary = SUMMARY.test(question);
  const short = question.trim().split(/\s+/).length <= 8;

  /*
    Order matters. A comparison naming two error codes is still a comparison:
    it needs both regions of the corpus, and narrowing it to the exact-wording
    path would retrieve one side well and the other not at all.
  */
  if (looksComparative) {
    return {
      route: "compare",
      candidates: Math.round(base.candidates * 1.25),
      denseWeight: base.denseWeight,
      sparseWeight: base.sparseWeight,
      rerank: true,
      hyde: true,
      neighborWindow: base.neighborWindow,
      because:
        "two or more subjects — widened the candidate pool so each side is represented before fusion",
    };
  }

  if (looksSummary) {
    return {
      route: "summarize",
      candidates: base.candidates,
      denseWeight: 0.7,
      sparseWeight: 0.3,
      rerank: true,
      hyde: true,
      // Coverage beats precision here: a summary built from isolated sentences
      // reads as a list of fragments.
      neighborWindow: base.neighborWindow + 1,
      because: "asks for coverage — favoured meaning over exact wording and widened each passage",
    };
  }

  if (hasIdentifier && short) {
    return {
      route: "lookup",
      // The identifier arm either finds it or it does not; a deeper pool adds
      // near-misses for the reranker to sort, not answers.
      candidates: Math.round(base.candidates * 0.6),
      denseWeight: 0.3,
      sparseWeight: 0.7,
      // The one real saving. A cross-encoder pass is a model call, and this
      // provider runs those one at a time.
      rerank: false,
      // A fabricated passage is written in general prose and dilutes the exact
      // token the question is built around.
      hyde: false,
      neighborWindow: base.neighborWindow,
      because: "names something exactly — leaned on the literal arms and skipped the rerank pass",
    };
  }

  return {
    route: "explore",
    candidates: base.candidates,
    denseWeight: base.denseWeight,
    sparseWeight: base.sparseWeight,
    rerank: true,
    hyde: true,
    neighborWindow: base.neighborWindow,
    because: "open question — ran the full pipeline",
  };
}
