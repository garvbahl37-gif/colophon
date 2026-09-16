import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { sql, toVector } from "@/lib/db/client";
import { config } from "@/lib/config";
import { embedQuery } from "@/lib/ai/models";
import type { Citation, Contradiction, GroundingIssue } from "./types";

/** The verdict that accompanied an answer, replayed with it. */
export interface CachedGrounding {
  supported: boolean;
  issues: GroundingIssue[];
  contradictions: Contradiction[];
  citationDensity: number;
}

/**
 * Answering a question that has already been answered.
 *
 * Generation dominates this pipeline — measured at 17 to 35 seconds against a
 * provider that runs requests one at a time — so the cheapest possible answer
 * is one that was produced earlier. Exact-string caching would almost never
 * fire, because nobody asks a question the same way twice. Matching on the
 * embedding does: "what's the retry backoff?" and "how long does it wait
 * between retries?" are different strings and the same question.
 *
 * WHAT MAKES A HIT SAFE
 *
 * The key is more than the question. An entry is only reused for the same
 * owner, the same mode, and the same set of searchable documents. That last
 * part does the invalidation for free: adding or removing a document changes
 * the permitted id set, which changes the key, so a stale corpus cannot answer
 * a fresh question. No sweeper, no TTL guesswork.
 *
 * Owner scoping is a privacy boundary, not a partitioning detail. A cached
 * answer is derived from documents, and serving one across owners would hand a
 * reader prose written from a corpus they may not read.
 *
 * WHERE THE THRESHOLD CAME FROM
 *
 * Measured, against one stored question and eight probes:
 *
 *     1.000  identical
 *     0.955  "retry backoff base delay"                    same question
 *     0.946  "What's the base delay for retry backoff?"     same question
 *     0.748  "What is the starting delay before a retry?"   same question
 *     0.723  "What is the maximum retry delay cap?"         DIFFERENT ANSWER
 *     0.691  "How long does it wait between retry attempts?" same question
 *     0.565  "What is the per-attempt request timeout?"     DIFFERENT ANSWER
 *     0.429  "What is the circuit breaker open duration?"   DIFFERENT ANSWER
 *
 * The lists interleave. A genuine rewording scores 0.691 while a question with
 * a different answer scores 0.723, so no threshold catches every paraphrase
 * without also serving the wrong answer to someone — this is a property of
 * question-to-question similarity, not something to tune away.
 *
 * So the floor sits above the whole interleaved region, at 0.90: comfortably
 * under the weakest reused entry (0.946) and well clear of the closest wrong
 * one (0.723). That makes this a near-duplicate cache and not a paraphrase
 * cache, which is the honest description. A miss costs one slow answer; a false
 * hit returns confident, fully cited prose answering a question nobody asked,
 * and the reader has no way to tell.
 */

const SIMILARITY_FLOOR = 0.9;

/** Identifies the corpus this answer was produced from. */
function scopeKey(documentIds: string[]): string {
  return createHash("sha256").update([...documentIds].sort().join(",")).digest("hex").slice(0, 32);
}

export interface CacheHit {
  answer: string;
  citations: Citation[];
  /*
    Replayed with the answer, not recomputed and not dropped.

    A cached answer that arrives without its groundedness verdict is the one
    answer in this system nobody can audit -- and it looks identical to one
    that passed. Re-running the audit would cost the model call the cache
    exists to avoid, and would be auditing the same text against the same
    passages to reach the same conclusion. So the verdict is stored with it.
  */
  grounding: CachedGrounding | null;
  similarity: number;
  /** The question that produced it, so the reader can see what was matched. */
  question: string;
  ageSeconds: number;
}

export async function probeCache(args: {
  question: string;
  ownerId: string;
  mode: string;
  documentIds: string[];
}): Promise<CacheHit | null> {
  if (!config.cache.enabled || args.documentIds.length === 0) return null;

  try {
    const embedding = await embedQuery(args.question);
    const [row] = await sql<
      {
        question: string;
        answer: string;
        citations: Citation[];
        grounding: CachedGrounding | null;
        similarity: number;
        age_seconds: number;
        id: string;
      }[]
    >`
      SELECT id, question, answer, citations, grounding,
             (1 - (embedding <=> ${toVector(embedding)}))::float8 AS similarity,
             extract(epoch FROM (now() - created_at))::float8 AS age_seconds
      FROM answer_cache
      WHERE owner_id = ${args.ownerId}
        AND mode = ${args.mode}
        AND scope_key = ${scopeKey(args.documentIds)}
      ORDER BY embedding <=> ${toVector(embedding)}
      LIMIT 1
    `;

    if (!row || row.similarity < SIMILARITY_FLOOR) return null;

    // Best-effort: a hit is still a hit if the counter fails to increment.
    void sql`UPDATE answer_cache SET hits = hits + 1 WHERE id = ${row.id}`.catch(() => {});

    return {
      answer: row.answer,
      citations: row.citations ?? [],
      grounding: row.grounding ?? null,
      similarity: row.similarity,
      question: row.question,
      ageSeconds: row.age_seconds,
    };
  } catch (error) {
    // A cache that cannot be read must never be a cache that breaks answering,
    // and must not be indistinguishable from a cache that is simply empty.
    console.warn("[cache] probe failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function storeAnswer(args: {
  question: string;
  answer: string;
  citations: Citation[];
  ownerId: string;
  mode: string;
  documentIds: string[];
  grounding: CachedGrounding | null;
}): Promise<void> {
  if (!config.cache.enabled || args.documentIds.length === 0) return;
  // An answer that said it could not answer is not worth repeating.
  if (!args.answer.trim() || args.citations.length === 0) {
    console.warn(
      `[cache] not storing: ${args.citations.length} citations, ${args.answer.length} chars`,
    );
    return;
  }

  try {
    const embedding = await embedQuery(args.question);
    await sql`
      INSERT INTO answer_cache
        (id, owner_id, question, embedding, answer, citations, grounding, mode, scope_key)
      VALUES (${nanoid(12)}, ${args.ownerId}, ${args.question}, ${toVector(embedding)},
              ${args.answer}, ${sql.json(args.citations as never)},
              ${args.grounding ? sql.json(args.grounding as never) : null},
              ${args.mode}, ${scopeKey(args.documentIds)})
    `;
  } catch (error) {
    /*
      Storing is an optimisation and must never fail the answer -- but it must
      not fail silently either. A cache that cannot write looks exactly like a
      cache that is merely cold: honest misses, plausible latency, and no hit
      ever. That is precisely how this shipped broken once.
    */
    console.warn(
      "[cache] store failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
