import { z } from "zod";
import { fastStageOptions, gradeModel } from "@/lib/ai/models";
import { generateStructured } from "@/lib/ai/structured";
import { config } from "@/lib/config";
import { GROUNDEDNESS_SYSTEM, SUFFICIENCY_SYSTEM } from "@/lib/ai/prompts";
import { hasMarker } from "@/lib/util/citations";
import { isolate } from "@/lib/security/injection";
import type { Candidate, Contradiction, GroundingIssue } from "./types";

const SufficiencySchema = z.object({
  sufficient: z.boolean(),
  confidence: z.number().min(0).max(1),
  missing: z.string(),
  refinedQuery: z.string(),
});

export interface Sufficiency {
  sufficient: boolean;
  confidence: number;
  missing: string | null;
  refinedQuery: string | null;
}

/**
 * Decides whether to answer or to search again.
 *
 * Ordinary RAG answers from whatever the first retrieval returned, which means
 * a bad first query produces a confidently wrong answer. Grading turns that
 * into a loop with a budget: when the context is missing a specific fact, the
 * grader names it and proposes a query in the corpus's vocabulary rather than
 * the user's - the user's phrasing is what just failed.
 */
export async function gradeSufficiency(
  question: string,
  candidates: Candidate[],
): Promise<Sufficiency> {
  if (candidates.length === 0) {
    return {
      sufficient: false,
      confidence: 1,
      missing: "No passages retrieved — the corpus is empty or retrieval failed.",
      refinedQuery: null,
    };
  }

  try {
    const passages = candidates
      .map((c, i) => `<passage id="${i + 1}">\n${c.content.slice(0, 2000)}\n</passage>`)
      .join("\n\n");

    const object = await generateStructured({
      spec: config.models.grade,
      model: gradeModel(),
      schema: SufficiencySchema,
      system: SUFFICIENCY_SYSTEM,
      prompt: `<question>${question}</question>\n\n<passages>\n${passages}\n</passages>`,
      maxOutputTokens: 1600,
      providerOptions: fastStageOptions(),
    });

    return {
      sufficient: object.sufficient,
      confidence: object.confidence,
      missing: object.sufficient ? null : object.missing.trim() || null,
      refinedQuery: object.sufficient ? null : object.refinedQuery.trim() || null,
    };
  } catch {
    // A failed grader must not block an answer that may well be fine.
    return { sufficient: true, confidence: 0, missing: null, refinedQuery: null };
  }
}

const GroundednessSchema = z.object({
  supported: z.boolean(),
  issues: z.array(z.object({ claim: z.string(), reason: z.string() })).max(6),
  /*
    Asked in the same call as the groundedness audit, deliberately.

    The auditor is already holding the question, the answer and every passage,
    which is exactly what is needed to notice that two passages disagree. A
    separate pass would double the cost of verification on a provider that runs
    requests one at a time, to re-read material already in the context.

    It runs after the answer has streamed, so it costs the reader no latency --
    it arrives as an annotation on text they are already reading.
  */
  contradictions: z
    .array(
      z.object({
        sources: z.array(z.number().int()).min(2).max(4),
        claim: z.string(),
        detail: z.string(),
      }),
    )
    .max(4),
});

export interface Groundedness {
  supported: boolean;
  issues: GroundingIssue[];
  /** Passages that disagree with each other, whatever the answer chose. */
  contradictions: Contradiction[];
  /** Share of answer sentences carrying at least one citation marker. */
  citationDensity: number;
}

/**
 * Post-hoc audit of the generated answer against the passages it was given.
 * Runs after the answer has already streamed, so it costs the user no latency -
 * the verdict arrives as a badge on a message they are already reading.
 */
export async function checkGroundedness(
  question: string,
  answer: string,
  candidates: Candidate[],
): Promise<Groundedness> {
  const sentences = answer
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);

  const cited = sentences.filter(hasMarker).length;
  const citationDensity = sentences.length ? cited / sentences.length : 0;

  if (candidates.length === 0 || answer.trim().length < 40) {
    return { supported: true, issues: [], contradictions: [], citationDensity };
  }

  try {
    /*
      The auditor reads attacker-supplied text too, and was the one prompt still
      interpolating it raw -- a passage closing the sources block here could
      convince the audit that an unsupported answer was fine, which is worse
      than fooling the generator, because the audit is what would have caught
      it. Same isolation as everywhere else.
    */
    const sources = candidates
      .map(
        (c, i) =>
          `<source id="${i + 1}">\n${isolate((c.expandedContent ?? c.content).slice(0, 2500)).text}\n</source>`,
      )
      .join("\n\n");

    const object = await generateStructured({
      spec: config.models.grade,
      model: gradeModel(),
      schema: GroundednessSchema,
      system: GROUNDEDNESS_SYSTEM,
      prompt: `<question>${question}</question>\n\n<sources>\n${sources}\n</sources>\n\n<answer>\n${answer}\n</answer>`,
      maxOutputTokens: 1600,
      providerOptions: fastStageOptions(),
    });

    /*
      Source ids in this prompt are 1-based positions, and the caller passes
      the evidence ledger in marker order -- the ledger stores a passage at
      entries[marker - 1] -- so a position IS the marker the reader sees. The
      bounds check is the part that matters: a model citing source 9 of 6 would
      otherwise produce a conflict pointing at a passage that does not exist.
    */
    const found: Contradiction[] = object.contradictions
      .map((c) => ({
        markers: c.sources.filter((n) => n >= 1 && n <= candidates.length),
        claim: c.claim,
        detail: c.detail,
      }))
      .filter((c) => new Set(c.markers).size >= 2);

    /*
      One disagreement, reported once.

      A fact usually appears in several chunks of the same document, so the
      auditor reports the same conflict against each pair that exhibits it --
      measured, one timeout discrepancy came back three times as [1,3], [1,4]
      and [2,3]. That reads as three problems and is one. Merging on the claim
      keeps the count honest and the marker list complete, which is also more
      useful: every passage that takes a side is worth opening.
    */
    const merged = new Map<string, Contradiction>();
    for (const c of found) {
      const key = c.claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const existing = merged.get(key);
      if (existing) {
        existing.markers = [...new Set([...existing.markers, ...c.markers])].sort((a, b) => a - b);
      } else {
        merged.set(key, { ...c, markers: [...new Set(c.markers)].sort((a, b) => a - b) });
      }
    }
    const contradictions = [...merged.values()];

    return {
      supported: object.supported && object.issues.length === 0,
      issues: object.issues,
      contradictions,
      citationDensity,
    };
  } catch {
    return { supported: true, issues: [], contradictions: [], citationDensity };
  }
}
