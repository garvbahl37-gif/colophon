import { z } from "zod";
import { planModel } from "@/lib/ai/models";
import { generateStructured } from "@/lib/ai/structured";
import { config } from "@/lib/config";
import { PLANNER_SYSTEM, plannerPrompt } from "@/lib/ai/prompts";
import { COMPARISON, IDENTIFIER, QUOTED, SUMMARY } from "./router";
import type { QueryPlan } from "./types";

const INTENTS = ["factual", "comparative", "procedural", "summarisation", "conversational"] as const;
type Intent = (typeof INTENTS)[number];

/**
 * `intent` is deliberately a free string rather than a Zod enum.
 *
 * Open models invent enum members that were never offered - "comparison",
 * "value", "acknowledgement" all came back from a strict five-member enum
 * during testing. Rejecting the whole plan over a label we only use for
 * display would throw away a perfectly good set of sub-queries, so the field
 * is accepted loosely and normalised below.
 */
const PlanSchema = z.object({
  intent: z.string(),
  needsRetrieval: z.boolean(),
  standalone: z.string(),
  subQueries: z.array(z.string()).max(4),
  keywords: z.array(z.string()).max(8),
  hypotheticals: z.array(z.string()).max(4),
});


/** Identifiers and quoted phrases, which are the only keywords a lookup needs. */
const IDENTIFIER_ALL = /\b(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|[a-z]+_[a-z_]+|v\d+\.\d+|\d{3,}|[A-Za-z]+\(\)|ERR[_A-Z0-9]+)\b/g;
const QUOTED_ALL = /["'`]([^"'`]{3,})["'`]/g;

/**
 * The plan for a question that does not need planning.
 *
 * Planning is a model call, and on this provider model calls run one at a
 * time, so it is five seconds at the very front of the request -- measured,
 * averaged over three days of production traffic. That is worth paying when
 * the planner has something to do. For "What is ERR_Q_0042?" it has nothing:
 * there is no history, so there are no pronouns to resolve and the standalone
 * query is the question; there is one clause, so there is nothing to
 * decompose; and the router turns HyDE off for these anyway, because a
 * fabricated passage written in general prose dilutes the exact token the
 * question is built around. Five seconds to be told the question back.
 *
 * So the same cheap signals the router uses are read here first, and when
 * they say "lookup" the plan is built directly. The conditions are
 * deliberately the router's own, not an approximation of them: anything this
 * accepts must take the lookup route, or the pipeline would be planning for
 * one strategy and retrieving with another.
 *
 * Returns null whenever there is the slightest doubt, and the model runs.
 */
export function fastPlan(question: string, history: string): QueryPlan | null {
  // A follow-up is exactly the case rewriting exists for. Never skip it.
  if (history) return null;

  const words = question.trim().split(/\s+/);
  if (words.length > 8) return null;
  if (COMPARISON.test(question) || SUMMARY.test(question)) return null;
  if (!IDENTIFIER.test(question) && !QUOTED.test(question)) return null;

  const keywords = [
    ...(question.match(IDENTIFIER_ALL) ?? []),
    ...[...question.matchAll(QUOTED_ALL)].map((m) => m[1]),
  ]
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 8);

  if (keywords.length === 0) return null;

  return {
    intent: "factual",
    needsRetrieval: true,
    standalone: question.trim(),
    subQueries: [question.trim()],
    keywords: [...new Set(keywords)],
    hypotheticals: [""],
  };
}

/**
 * Turns a raw chat turn into a retrieval strategy.
 *
 * Three things happen here, and each fixes a different failure of naive RAG:
 *
 *  - Rewriting kills the follow-up problem. "What about v2?" embeds to nothing
 *    useful; "What is the v2 retry policy?" embeds to the right region.
 *  - Decomposition fixes multi-hop questions, where the top-k for the combined
 *    question is dominated by whichever half is better represented in the corpus.
 *  - HyDE fixes the question/answer asymmetry. Documents are written as answers,
 *    so embedding a hypothetical answer lands closer to them than the question does.
 */
export async function planQuery(question: string, history: string): Promise<QueryPlan> {
  try {
    const object = await generateStructured({
      spec: config.models.plan,
      model: planModel(),
      schema: PlanSchema,
      system: PLANNER_SYSTEM,
      prompt: plannerPrompt(question, history),
      maxOutputTokens: 1600,
      /*
        Default reasoning effort, not "medium".

        Planning decides everything downstream, so this stage was given a
        deliberately generous thinking budget. Measured against it, that
        budget was buying nothing: over three questions, medium averaged
        11427ms and produced a usable plan 3 times out of 3, while the
        provider default averaged 8029ms and also produced a usable plan 3
        times out of 3. Same plans, three and a half seconds apart, on a
        stage that is 41% of a production request -- measured at 8436ms of a
        20.5s answer, to hand back the question verbatim plus two keywords.

        "Worth letting the model think" was a reasonable guess. It was never
        a measurement, and the measurement disagrees.
      */
      providerOptions: {},
    });

    const standalone = object.standalone.trim() || question;
    const subQueries = object.subQueries.map((q) => q.trim()).filter(Boolean);
    const queries = subQueries.length > 1 ? subQueries : [standalone];

    // Align hypotheticals to queries. A model that returns the wrong count
    // must degrade to "no HyDE for that arm", never to "reuse another arm's".
    const hypotheticals = queries.map((_, i) => object.hypotheticals[i]?.trim() ?? "");

    return {
      intent: normaliseIntent(object.intent),
      needsRetrieval: object.needsRetrieval,
      standalone,
      // A single sub-query identical to the standalone adds a redundant round trip.
      subQueries: queries,
      keywords: object.keywords.map((k) => k.trim()).filter(Boolean),
      hypotheticals,
    };
  } catch (error) {
    // Planning is an optimisation. If it fails, search the question verbatim
    // rather than failing the whole request - but say so, because a planner
    // that silently degrades to no decomposition and no HyDE looks identical
    // to one that is working badly.
    console.warn(
      `[planner] falling back to verbatim search: ${error instanceof Error ? error.message : error}`,
    );
    return {
      intent: "factual",
      needsRetrieval: true,
      standalone: question,
      subQueries: [question],
      keywords: [],
      hypotheticals: [""],
    };
  }
}

function normaliseIntent(raw: string): Intent {
  const value = raw.trim().toLowerCase();
  if (INTENTS.includes(value as Intent)) return value as Intent;
  if (/compar|versus|differ|contrast/.test(value)) return "comparative";
  if (/procedur|how.?to|step|instruct/.test(value)) return "procedural";
  if (/summar|overview|digest/.test(value)) return "summarisation";
  if (/greet|thank|ack|chat|social/.test(value)) return "conversational";
  return "factual";
}

/**
 * Text for the full-text arm.
 *
 * Keywords are appended once, not repeated. The previous version repeated them
 * "so ts_rank_cd weights them above the filler words", which never worked: the
 * query is built from `unnest(to_tsvector(...))`, and a tsvector deduplicates
 * lexemes by construction, so the second and third copies vanished before
 * ranking. Weighting identifiers is now the identifier arm's job, which
 * matches them verbatim instead of letting the stemmer take them apart.
 */
export function lexicalQuery(plan: QueryPlan, subQuery: string): string {
  return [subQuery, ...plan.keywords].join(" ");
}
