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

const BATCH = 64;

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
    throw new Error(`Supabase embed failed (${res.status}): ${body.error ?? res.statusText}`);
  }
  if (!body.embeddings?.length) throw new Error("Supabase embed returned no vectors");
  return body.embeddings;
}

export async function supabaseEmbed(spec: string, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  // gte-small ignores the model id beyond validation, but keeping it in the
  // spec means the routing table still documents which model produced a column.
  parseSpec(spec);

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await callOnce(texts.slice(i, i + BATCH))));
  }
  return out;
}
