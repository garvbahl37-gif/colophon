import { z } from "zod";
import { planModel } from "@/lib/ai/models";
import { generateStructured } from "@/lib/ai/structured";
import { config } from "@/lib/config";
import { PLANNER_SYSTEM, plannerPrompt } from "@/lib/ai/prompts";
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
      // Planning runs once per question and decides everything downstream, so
      // unlike contextualisation it is worth letting the model actually think.
      providerOptions: { ollama: { reasoning_effort: "medium" } },
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
 * The lexical arm searches the literal question plus any rare identifiers,
 * repeated so `ts_rank_cd` weights them above the surrounding filler words.
 */
export function lexicalQuery(plan: QueryPlan, subQuery: string): string {
  return [subQuery, ...plan.keywords, ...plan.keywords].join(" ");
}
