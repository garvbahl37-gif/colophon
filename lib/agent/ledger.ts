import { extractMarkers } from "@/lib/util/citations";
import type { Candidate, Citation } from "@/lib/retrieval/types";

/**
 * Stable citation numbering across an entire agent run.
 *
 * An agentic loop searches several times, and the same passage can surface in
 * more than one search. If each tool call numbered its own results, [3] would
 * mean a different passage in step 1 than in step 4, and the model - which sees
 * all of them in its history - would cite incoherently.
 *
 * The ledger assigns each chunk one number the first time it is ever seen and
 * keeps it for the rest of the run, so citations are globally consistent and
 * the UI can resolve any marker in the final answer back to a real passage.
 */
export class EvidenceLedger {
  private byChunk = new Map<string, number>();
  private entries: Candidate[] = [];

  /** Registers passages and returns them tagged with their citation markers. */
  register(candidates: Candidate[]): Array<Candidate & { marker: number }> {
    return candidates.map((candidate) => {
      let marker = this.byChunk.get(candidate.id);
      if (marker == null) {
        marker = this.entries.length + 1;
        this.byChunk.set(candidate.id, marker);
        this.entries.push(candidate);
      } else {
        // Keep the best evidence seen for this chunk across searches.
        const existing = this.entries[marker - 1];
        if ((candidate.rerankScore ?? 0) > (existing.rerankScore ?? 0)) {
          this.entries[marker - 1] = { ...candidate };
        }
      }
      return { ...candidate, marker };
    });
  }

  get(marker: number): Candidate | undefined {
    return this.entries[marker - 1];
  }

  get size(): number {
    return this.entries.length;
  }

  all(): Candidate[] {
    return this.entries;
  }

  /** Only the passages the answer actually cited, in marker order. */
  citationsFor(answer: string): Citation[] {
    return extractMarkers(answer, this.entries.length).map((marker) => {
      const c = this.entries[marker - 1];
      return {
        marker,
        chunkId: c.id,
        documentId: c.documentId,
        documentTitle: c.documentTitle,
        headingPath: c.headingPath,
        page: c.page,
        snippet: c.content,
        score: c.rerankScore ?? c.rrfScore,
      };
    });
  }
}
