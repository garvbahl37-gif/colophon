/**
 * Retrieval evaluation.
 *
 * The point of this file is to stop the architecture being a matter of taste.
 * "Hybrid search plus a cross-encoder is better" is a claim, and every knob in
 * lib/config.ts is a guess until something measures it - so the harness runs
 * the SAME golden set through four configurations and prints them side by side:
 *
 *   vector only     the dense arm alone
 *   lexical only    the full-text arm alone
 *   hybrid          both arms, fused by RRF, no reranking
 *   hybrid + rerank what the app actually ships
 *
 * If the last row does not beat the others, the extra latency is not being
 * earned and the config should change.
 *
 *   pnpm eval            retrieval metrics for all four configurations
 *   pnpm eval --answers  also generate answers and score faithfulness
 */
import "../scripts/env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { writeChart } from "./chart";
import { sql } from "../lib/db/client";
import { config } from "../lib/config";
import { embedQuery } from "../lib/ai/models";
import { fuseAcrossQueries, hybridSearch } from "../lib/retrieval/hybrid";
import { rerankCandidates } from "../lib/retrieval/rerank";
import { lexicalQuery, planQuery } from "../lib/retrieval/query-planner";
import { diversify } from "../lib/retrieval/compress";
import type { Candidate } from "../lib/retrieval/types";

interface GoldenCase {
  id: string;
  question: string;
  relevant: string[];
  mustContain?: string[];
  absent?: boolean;
}

const golden = JSON.parse(
  readFileSync(join(process.cwd(), "evals/golden.json"), "utf8"),
) as { cases: GoldenCase[] };

const K = 3;

interface Variant {
  name: string;
  denseWeight: number;
  sparseWeight: number;
  rerank: boolean;
  /**
   * Runs the real retrieval path — planner, per-sub-query HyDE, cross-query
   * fusion, rerank, MMR — rather than embedding the question verbatim.
   *
   * Without this the harness measured a configuration the app does not ship,
   * so a bug in decomposition or HyDE showed up as exactly zero delta. An
   * instrument that cannot see the thing it is meant to measure is worse than
   * no instrument, because it reads as evidence.
   */
  fullPipeline?: boolean;
}

const VARIANTS: Variant[] = [
  { name: "vector only", denseWeight: 1, sparseWeight: 0, rerank: false },
  { name: "lexical only", denseWeight: 0, sparseWeight: 1, rerank: false },
  { name: "hybrid", denseWeight: 0.5, sparseWeight: 0.5, rerank: false },
  { name: "hybrid + rerank", denseWeight: 0.5, sparseWeight: 0.5, rerank: true },
  { name: "full pipeline", denseWeight: 0.5, sparseWeight: 0.5, rerank: true, fullPipeline: true },
];

/** A passage counts as relevant when it comes from one of the named sections. */
function isRelevant(candidate: Candidate, relevant: string[]): boolean {
  if (relevant.length === 0) return false;
  const haystack = [candidate.documentTitle, ...candidate.headingPath]
    .join(" ")
    .toLowerCase();
  return relevant.some((label) => haystack.includes(label.toLowerCase()));
}

interface Scores {
  hitAt1: number;
  hitRate: number;
  mrr: number;
  ndcg: number;
  ms: number;
}

/**
 * nDCG@k with binary relevance.
 *
 * Hit-rate answers "did we find it at all" and MRR answers "how high was the
 * first one". Neither notices when a question needs two sections and only one
 * is retrieved, which is exactly the failure mode decomposition is meant to
 * fix - so nDCG, which rewards every relevant passage and discounts by
 * position, is the one to watch on multi-part questions.
 *
 * The ideal ranking is the relevant passages ACTUALLY FOUND, moved to the top.
 * The golden set names sections, not chunks, and a section spans several
 * chunks - so the true number of relevant chunks is unknown, and using the
 * count of named sections as the ideal lets DCG exceed IDCG and pushes nDCG
 * above 1. Scoring against "the best possible ordering of what you retrieved"
 * keeps this a measure of ranking quality, which is what separates the
 * variants; hit-rate already measures whether retrieval found the thing.
 */
function ndcgAt(candidates: Candidate[], relevant: string[], k: number): number {
  const gains = candidates.slice(0, k).map((c) => (isRelevant(c, relevant) ? 1 : 0));
  const found = gains.filter(Boolean).length;
  if (found === 0) return 0;

  const dcg = gains.reduce((sum: number, gain, i) => sum + gain / Math.log2(i + 2), 0);
  const idcg = Array.from({ length: found }, (_, i) => 1 / Math.log2(i + 2)).reduce(
    (a: number, b) => a + b,
    0,
  );
  return idcg === 0 ? 0 : Math.min(1, dcg / idcg);
}

/** One question under one configuration, kept so the dashboard can show it. */
export interface CaseResult {
  id: string;
  question: string;
  /** Rank of the first genuinely relevant passage, or null if none was found. */
  firstHit: number | null;
  ndcg: number;
  ms: number;
  /** What actually came back, so a miss can be read rather than guessed at. */
  top: { title: string; heading: string; score: number }[];
}

async function runVariant(
  variant: Variant,
): Promise<{ scores: Scores; misses: string[]; cases: CaseResult[] }> {
  const scored: Scores[] = [];
  const misses: string[] = [];
  const cases: CaseResult[] = [];

  for (const testCase of golden.cases) {
    if (testCase.absent) continue;

    const started = Date.now();
    let candidates: Candidate[];
    let rerankQuery = testCase.question;

    if (variant.fullPipeline) {
      const plan = await planQuery(testCase.question, "");
      rerankQuery = plan.standalone;
      const rounds = await Promise.all(
        plan.subQueries.map(async (subQuery, qi) => {
          const hyde = plan.hypotheticals[qi] ?? "";
          const embedding = await embedQuery(hyde || subQuery);
          return {
            query: subQuery,
            candidates: await hybridSearch({
              embedding,
              text: lexicalQuery(plan, subQuery),
              denseWeight: variant.denseWeight,
              sparseWeight: variant.sparseWeight,
            }),
          };
        }),
      );
      candidates = fuseAcrossQueries(rounds);
    } else {
      const embedding = await embedQuery(testCase.question);
      candidates = await hybridSearch({
        embedding,
        text: testCase.question,
        denseWeight: variant.denseWeight,
        sparseWeight: variant.sparseWeight,
      });
    }

    if (variant.rerank) {
      candidates = (await rerankCandidates(rerankQuery, candidates, K * 3)).candidates;
    }
    if (variant.fullPipeline) {
      candidates = await diversify(candidates, K);
    }
    const top = candidates.slice(0, K);
    const ms = Date.now() - started;

    const firstHit = top.findIndex((c) => isRelevant(c, testCase.relevant));
    if (firstHit === -1) misses.push(testCase.id);

    cases.push({
      id: testCase.id,
      question: testCase.question,
      firstHit: firstHit === -1 ? null : firstHit,
      ndcg: ndcgAt(top, testCase.relevant, K),
      ms,
      top: top.map((c) => ({
        title: c.documentTitle,
        heading: c.headingPath.at(-1) ?? "",
        score: Number((c.rerankScore ?? c.rrfScore).toFixed(4)),
      })),
    });

    scored.push({
      hitAt1: firstHit === 0 ? 1 : 0,
      hitRate: firstHit >= 0 ? 1 : 0,
      mrr: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
      ndcg: ndcgAt(top, testCase.relevant, K),
      ms,
    });
  }

  const mean = (pick: (s: Scores) => number) =>
    scored.reduce((sum, s) => sum + pick(s), 0) / (scored.length || 1);

  return {
    scores: {
      hitAt1: mean((s) => s.hitAt1),
      hitRate: mean((s) => s.hitRate),
      mrr: mean((s) => s.mrr),
      ndcg: mean((s) => s.ndcg),
      ms: mean((s) => s.ms),
    },
    misses,
    cases,
  };
}

function bar(value: number, width = 18): string {
  const filled = Math.max(0, Math.min(width, Math.round(value * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function main() {
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM chunks`;
  if (count === 0) {
    console.error("The corpus is empty. Run: pnpm ingest sample-docs/*.md");
    process.exit(1);
  }

  const answerable = golden.cases.filter((c) => !c.absent).length;
  if (count < K * answerable) {
    console.warn(
      `\n  \x1b[33mNote\x1b[0m the corpus holds only ${count} passages, so k=${K} returns a large ` +
        `fraction of it.\n  Every configuration will look good here; add distractor documents ` +
        `before trusting these numbers.`,
    );
  }
  console.log(
    `\n\x1b[1mRetrieval evaluation\x1b[0m  ${answerable} questions @k=${K}  ` +
      `\x1b[2m${count} chunks · ${config.models.embed} · ${config.models.rerank}\x1b[0m\n`,
  );

  console.log(
    `  ${"configuration".padEnd(17)} ${"hit@1".padEnd(8)} ${`hit@${K}`.padEnd(8)} ${"MRR".padEnd(8)} ${`nDCG@${K}`.padEnd(8)} ${"ms".padStart(6)}   quality`,
  );
  console.log(`  ${"─".repeat(82)}`);

  const results: { variant: Variant; scores: Scores; misses: string[]; cases: CaseResult[] }[] = [];
  for (const variant of VARIANTS) {
    const { scores, misses, cases } = await runVariant(variant);
    results.push({ variant, scores, misses, cases });
    const best = Boolean(variant.fullPipeline);
    console.log(
      `  ${best ? "\x1b[32m" : ""}${variant.name.padEnd(17)}` +
        `${scores.hitAt1.toFixed(2).padEnd(8)}` +
        `${scores.hitRate.toFixed(2).padEnd(8)}` +
        `${scores.mrr.toFixed(3).padEnd(8)}` +
        `${scores.ndcg.toFixed(3).padEnd(8)}` +
        `${Math.round(scores.ms).toString().padStart(6)}   ` +
        `${bar(scores.ndcg)}\x1b[0m`,
    );
  }

  // The whole reason the harness exists: does the shipped configuration win?
  const baseline = results.find((r) => r.variant.name === "vector only")!;
  const shipped = results.find((r) => r.variant.fullPipeline)!;
  const lift = ((shipped.scores.ndcg - baseline.scores.ndcg) / (baseline.scores.ndcg || 1)) * 100;

  console.log(
    `\n  Shipped configuration is ${lift >= 0 ? "\x1b[32m+" : "\x1b[31m"}${lift.toFixed(1)}%\x1b[0m ` +
      `nDCG against vector-only, at ${Math.round(shipped.scores.ms - baseline.scores.ms)}ms extra.`,
  );

  if (shipped.misses.length > 0) {
    console.log(`\n  \x1b[33mMissed entirely:\x1b[0m ${shipped.misses.join(", ")}`);
    console.log(`  \x1b[2mThese are the cases worth reading the trace for.\x1b[0m`);
  }

  /*
    Written for the dashboard, not for a CI gate.

    Terminal output is where these numbers went to be read once and forgotten,
    which is how the suite spent a release reporting that every configuration
    scored the same without anyone acting on it. A file the app can render
    makes a result like "reranking costs 200ms and lowers nDCG" something you
    trip over rather than something you have to go looking for.
  */
  writeFileSync(
    new URL("./results.json", import.meta.url),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        k: K,
        chunks: count,
        questions: answerable,
        models: { embed: config.models.embed, rerank: config.models.rerank },
        variants: results.map((r) => ({
          name: r.variant.name,
          shipped: Boolean(r.variant.fullPipeline),
          scores: r.scores,
          misses: r.misses,
          cases: r.cases,
        })),
      },
      null,
      2,
    ),
  );
  // And the README's picture of the same run, so the two cannot drift.
  writeChart({
    k: K,
    chunks: count,
    questions: answerable,
    models: { embed: config.models.embed, rerank: config.models.rerank },
    variants: results.map((r) => ({
      name: r.variant.name,
      shipped: Boolean(r.variant.fullPipeline),
      scores: r.scores,
    })),
  });
  console.log(
    `\n  \x1b[2mWrote evals/results.json (rendered at /evals) and docs/evaluation.svg\x1b[0m`,
  );

  if (process.argv.includes("--answers")) await scoreAnswers();
  console.log();
  await sql.end();
}

/** End-to-end: generate real answers and audit them for faithfulness. */
async function scoreAnswers() {
  const { checkGroundedness } = await import("../lib/retrieval/grade");
  const { streamText } = await import("ai");
  const { generateModel } = await import("../lib/ai/models");
  const { ANSWER_SYSTEM, answerPrompt } = await import("../lib/ai/prompts");

  console.log(`\n\x1b[1mAnswer quality\x1b[0m\n`);
  console.log(`  ${"case".padEnd(22)} ${"grounded".padEnd(10)} ${"contains".padEnd(10)} cites`);
  console.log(`  ${"─".repeat(60)}`);

  let grounded = 0;
  let contained = 0;
  let checked = 0;

  for (const testCase of golden.cases) {
    const embedding = await embedQuery(testCase.question);
    const raw = await hybridSearch({ embedding, text: testCase.question });
    const { candidates } = await rerankCandidates(testCase.question, raw, config.retrieval.contextChunks);
    const marked = candidates.map((c, i) => ({ ...c, marker: i + 1 }));

    const result = streamText({
      model: generateModel(),
      system: ANSWER_SYSTEM,
      prompt: answerPrompt(testCase.question, marked, ""),
      temperature: 0,
    });
    const answer = await result.text;

    const verdict = await checkGroundedness(testCase.question, answer, candidates);
    const lower = answer.toLowerCase();

    // An `absent` case passes by refusing, so "contains" is inverted for it.
    const hasExpected = testCase.absent
      ? /not (say|cover|contain|include)|does not|no information|isn't in|is not in/.test(lower)
      : (testCase.mustContain ?? []).every((s) => lower.includes(s.toLowerCase()));

    checked++;
    if (verdict.supported) grounded++;
    if (hasExpected) contained++;

    console.log(
      `  ${testCase.id.padEnd(22)} ` +
        `${(verdict.supported ? "\x1b[32myes" : "\x1b[31mno ") + "\x1b[0m"}       ` +
        `${(hasExpected ? "\x1b[32myes" : "\x1b[31mno ") + "\x1b[0m"}       ` +
        `${Math.round(verdict.citationDensity * 100)}%`,
    );
  }

  console.log(
    `\n  ${grounded}/${checked} fully grounded · ${contained}/${checked} contained the expected fact`,
  );
}

main().catch(async (error) => {
  console.error(`\x1b[31m✗\x1b[0m ${error.message}`);
  await sql.end().catch(() => {});
  process.exit(1);
});
