import { sql } from "@/lib/db/client";
import { GuardError } from "@/lib/util/guard";

/**
 * A spend ceiling for ingestion.
 *
 * Ingestion is the expensive path: one LLM call per chunk to write the
 * situating line, plus an embedding pass. On a public URL with no sign-in,
 * something has to stop a stranger turning that into a bill.
 *
 * This is deliberately NOT an authorisation system. It does not care who you
 * are, only how much has been spent today, which is the thing actually worth
 * protecting. Anyone may add documents; nobody may add ten thousand.
 *
 * The count comes from the corpus itself rather than a counter table, so it
 * needs no migration and is correct across serverless instances that share
 * nothing else. The honest limitation: deleting today's documents frees the
 * budget again, so this bounds accidental and casual abuse, not a determined
 * attacker with a script. The per-IP rate limit is what makes that tedious,
 * and the real backstop is that the API key has its own quota.
 */

const DEFAULT_DAILY_CHUNKS = 600;

function dailyChunkBudget(): number {
  const configured = Number(process.env.COLOPHON_DAILY_CHUNK_BUDGET);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DAILY_CHUNKS;
}

export async function assertWithinIngestBudget(): Promise<void> {
  const budget = dailyChunkBudget();

  /*
    Deliberately instance-wide: it is a spend ceiling, and the bill is not
    per-owner. What it reports back is not, though -- an earlier version named
    how many documents had been added today, which told whoever hit the limit
    how busy everyone else had been. The ceiling is the only useful half.
  */
  const [row] = await sql<{ chunks: number }[]>`
    SELECT coalesce(sum(chunk_count), 0)::int AS chunks
    FROM documents
    WHERE created_at >= date_trunc('day', now())
  `;

  const used = row?.chunks ?? 0;
  if (used >= budget) {
    throw new GuardError(
      `This instance has indexed its daily limit of ${budget} passages. It resets at midnight UTC.`,
      429,
    );
  }
}
