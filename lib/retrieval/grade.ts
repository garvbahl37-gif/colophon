import { z } from "zod";
import { fastStageOptions, gradeModel } from "@/lib/ai/models";
import { generateStructured } from "@/lib/ai/structured";
import { config } from "@/lib/config";
import { GROUNDEDNESS_SYSTEM, SUFFICIENCY_SYSTEM } from "@/lib/ai/prompts";
import { hasMarker } from "@/lib/util/citations";
import type { Candidate, GroundingIssue } from "./types";

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
    return { sufficient: false, confidence: 1, missing: "No passages retrieved.", refinedQuery: null };
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
});

export interface Groundedness {
  supported: boolean;
  issues: GroundingIssue[];
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
    return { supported: true, issues: [], citationDensity };
  }

  try {
    const sources = candidates
      .map((c, i) => `<source id="${i + 1}">\n${(c.expandedContent ?? c.content).slice(0, 2500)}\n</source>`)
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

    return { supported: object.supported && object.issues.length === 0, issues: object.issues, citationDensity };
  } catch {
    return { supported: true, issues: [], citationDensity };
  }
}
