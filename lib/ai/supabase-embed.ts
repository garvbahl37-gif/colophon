import { parseSpec } from "./providers";

/**
 * Embeddings via a Supabase Edge Function.
 *
 * The app's serverless runtime cannot load the native ONNX runtime
 * (`libonnxruntime.so.1` is absent on Vercel), so in-process embedding is not
 * an option in production. Supabase Edge Runtime ships gte-small natively, so
 * the work moves next to the database the vectors are written to: no extra
 * provider, no API key beyond the project's own publishable key, and no model
 * weights downloading on every cold start.
 *
 * gte-small returns 384 normalised dimensions and is English-only, truncating
 * past 512 tokens — which is comfortably above this app's chunk size.
 */

/*
  Batching here is bounded by work, not by count.

  Inference in the edge function is native and CPU-bound, and the Edge Runtime
  kills a worker that exceeds its CPU budget of roughly two seconds. That kill
  is not a response: the worker dies mid-run, so the status is 546 with no body
  and nothing to read. Sending sixty-four chunks per request was hopeless for
  any real document and only ever worked because the seeded corpus is short.

  Measured against the deployed function, cost fits

      ms = 110 + 110 * inputs + 0.33 * characters

  against a ~2000ms ceiling. Sixteen tiny search strings fit comfortably; four
  ingestion chunks do not. A fixed batch SIZE is therefore the wrong unit at any
  value, which is why the previous constant failed as documents grew: the thing
  that varies is how much text a chunk holds.

  So batches are packed to a predicted cost instead, which lands at one or two
  500-token chunks per request and a dozen short queries. That would be slow
  done serially, so requests run concurrently -- the ceiling is per worker, and
  separate requests get separate workers. Throughput comes from parallelism
  rather than from batch size, which is the only direction actually open.
*/
const COST_FIXED_MS = 110;
const COST_PER_INPUT_MS = 110;
const COST_PER_CHAR_MS = 0.33;

/** Conservative share of the ~2000ms ceiling, leaving room for a cold start. */
const BUDGET_MS = 1500;

/** Separate requests get separate workers, so the CPU ceiling does not stack. */
const CONCURRENCY = 4;

function cost(text: string): number {
  return COST_PER_INPUT_MS + text.length * COST_PER_CHAR_MS;
}

/** Greedily fill batches up to the budget; a single input always gets to go. */
function pack(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let spent = COST_FIXED_MS;

  for (const text of texts) {
    const price = cost(text);
    if (current.length > 0 && spent + price > BUDGET_MS) {
      batches.push(current);
      current = [];
      spent = COST_FIXED_MS;
    }
    current.push(text);
    spent += price;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Status the Edge Runtime returns when it kills a worker over its CPU budget. */
const WORKER_LIMIT = 546;

class EmbedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function endpoint(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error("SUPABASE_URL is not set, but embeddings are routed to supabase:");
  }
  return `${url.replace(/\/$/, "")}/functions/v1/embed`;
}

function key(): string {
  const k = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!k) {
    throw new Error("SUPABASE_PUBLISHABLE_KEY is not set, but embeddings are routed to supabase:");
  }
  return k;
}

async function callOnce(inputs: string[]): Promise<number[][]> {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: key(),
      authorization: `Bearer ${key()}`,
    },
    body: JSON.stringify({ inputs }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    embeddings?: number[][];
    error?: string;
  };

  if (!res.ok || body.error) {
    // A killed worker has no body, and the gateway's reason phrase for a
    // non-standard status is literally "<none>" — so say what happened instead
    // of forwarding that.
    const detail =
      body.error ??
      (res.status === WORKER_LIMIT
        ? `the edge function exceeded its CPU budget on ${inputs.length} inputs`
        : res.statusText || "no detail");
    throw new EmbedError(`Supabase embed failed (${res.status}): ${detail}`, res.status);
  }
  if (!body.embeddings?.length) throw new EmbedError("Supabase embed returned no vectors", 500);
  if (body.embeddings.length !== inputs.length) {
    throw new EmbedError(
      `Supabase embed returned ${body.embeddings.length} vectors for ${inputs.length} inputs`,
      500,
    );
  }
  return body.embeddings;
}

/**
 * Embed a batch, halving and retrying if the worker ran out of CPU.
 *
 * The budget is time, so no fixed batch size is provably safe — a single long
 * chunk can exhaust it alone. Halving converges in log2(BATCH) extra requests
 * at worst and turns a hard failure into a slower success. If one input on its
 * own still cannot be embedded, that is a real error and it surfaces.
 */
async function embedBatch(inputs: string[]): Promise<number[][]> {
  try {
    return await callOnce(inputs);
  } catch (error) {
    const recoverable =
      error instanceof EmbedError && (error.status === WORKER_LIMIT || error.status >= 500);
    if (!recoverable || inputs.length === 1) throw error;

    const mid = Math.ceil(inputs.length / 2);
    const head = await embedBatch(inputs.slice(0, mid));
    const tail = await embedBatch(inputs.slice(mid));
    return [...head, ...tail];
  }
}

export async function supabaseEmbed(spec: string, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  // gte-small ignores the model id beyond validation, but keeping it in the
  // spec means the routing table still documents which model produced a column.
  parseSpec(spec);

  const batches = pack(texts);
  const results: number[][][] = new Array(batches.length);

  // A shared cursor rather than chunked ranges, so one slow batch does not hold
  // up a lane that could be working. Results land by index, so order survives.
  let next = 0;
  async function lane(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= batches.length) return;
      results[i] = await embedBatch(batches[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => lane()),
  );

  return results.flat();
}
