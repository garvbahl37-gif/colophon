import { config } from "@/lib/config";
import { cosine } from "@/lib/ai/models";
import { getEmbeddings } from "./hybrid";
import type { Candidate } from "./types";

/**
 * Maximal Marginal Relevance.
 *
 * Reranking optimises each passage independently, so the top-8 of a well-indexed
 * corpus is often eight paraphrases of the same paragraph - high scoring, and
 * collectively worth about one passage. MMR trades a little per-item relevance
 * for coverage, which is what actually determines whether the generator can
 * answer a comparative or multi-part question.
 *
 *   score(d) = lambda * relevance(d) - (1 - lambda) * max_similarity(d, selected)
 */
export async function diversify(
  candidates: Candidate[],
  k = config.retrieval.contextChunks,
  lambda = config.retrieval.mmrLambda,
): Promise<Candidate[]> {
  if (candidates.length <= k) return candidates;

  const vectors = await getEmbeddings(candidates.map((c) => c.id)).catch(() => new Map());
  if (vectors.size === 0) return candidates.slice(0, k);

  const relevance = (c: Candidate) => c.rerankScore ?? c.rrfScore;
  const max = Math.max(...candidates.map(relevance), 1e-9);

  const selected: Candidate[] = [];
  const pool = [...candidates];

  while (selected.length < k && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const vector = vectors.get(pool[i].id);
      const redundancy =
        vector && selected.length
          ? Math.max(
              ...selected.map((s) => {
                const sv = vectors.get(s.id);
                return sv ? cosine(vector, sv) : 0;
              }),
            )
          : 0;

      const score = lambda * (relevance(pool[i]) / max) - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]);
  }

  return selected;
}

/**
 * Orders the final context for the generator.
 *
 * Long-context models attend most reliably to the beginning and end of their
 * input and are measurably weaker in the middle. So the best passage goes
 * first, the second best goes last, and the rest fill the middle - rather than
 * the strict descending order that would bury rank 2 in the dead zone.
 */
export function orderForAttention(candidates: Candidate[]): Candidate[] {
  if (candidates.length <= 2) return candidates;
  const head: Candidate[] = [];
  const tail: Candidate[] = [];
  candidates.forEach((c, i) => (i % 2 === 0 ? head.push(c) : tail.unshift(c)));
  return [...head, ...tail];
}

/** Trims the context to a token budget, dropping the weakest passages first. */
export function fitBudget(candidates: Candidate[], maxTokens = 12_000): Candidate[] {
  const kept: Candidate[] = [];
  let total = 0;
  for (const c of candidates) {
    const size = Math.ceil((c.expandedContent ?? c.content).length / 4);
    if (total + size > maxTokens && kept.length > 0) break;
    kept.push(c);
    total += size;
  }
  return kept;
}
