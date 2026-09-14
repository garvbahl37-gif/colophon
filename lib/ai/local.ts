import { parseSpec } from "./providers";

/**
 * In-process embeddings and reranking via ONNX.
 *
 * This exists because the retrieval half of RAG has no free hosted option on
 * every provider — Ollama Cloud serves no embeddings and no reranker — and
 * because a bi-encoder and a cross-encoder small enough to run on CPU are
 * genuinely good at this job. bge-base is competitive with hosted embedding
 * APIs on MTEB retrieval, and ms-marco-MiniLM is a real cross-encoder: it reads
 * query and passage together in one pass, which is the whole point of a rerank
 * stage and is not something a hosted bi-encoder can imitate.
 *
 * EVERY reference to `@huggingface/transformers` in this file is behind a
 * dynamic import, and nothing imports this module eagerly. That is deliberate:
 * the package pulls in ~210MB of onnxruntime-node with native bindings, and a
 * static import puts all of it in the serverless bundle even for a deployment
 * whose embeddings are routed to a hosted provider and will never call this
 * code. Loading it on first use keeps it out of the graph entirely.
 *
 * Weights download once from the Hugging Face hub (~110MB combined) and are
 * cached on disk, which is fine on a long-lived machine and is exactly why this
 * backend is unsuitable for serverless: a cold start would re-download them.
 */

type Transformers = typeof import("@huggingface/transformers");

let transformersPromise: Promise<Transformers> | null = null;

async function loadTransformers(): Promise<Transformers> {
  transformersPromise ??= (async () => {
    const mod = await import("@huggingface/transformers");
    mod.env.allowLocalModels = false;
    return mod;
  })();
  return transformersPromise;
}

// Bi-encoders are trained with an asymmetric objective: queries get an
// instruction prefix, passages do not. Omitting it measurably hurts recall.
const QUERY_PREFIX: Record<string, string> = {
  "bge-": "Represent this sentence for searching relevant passages: ",
  "e5-": "query: ",
  "gte-": "",
};

const PASSAGE_PREFIX: Record<string, string> = {
  "bge-": "",
  "e5-": "passage: ",
  "gte-": "",
};

function prefixFor(modelId: string, table: Record<string, string>): string {
  const name = modelId.toLowerCase();
  for (const [key, value] of Object.entries(table)) {
    if (name.includes(key)) return value;
  }
  return "";
}

/** BGE and most retrieval encoders pool the CLS token; E5 and GTE mean-pool. */
function poolingFor(modelId: string): "cls" | "mean" {
  return modelId.toLowerCase().includes("bge-") ? "cls" : "mean";
}

type Extractor = Awaited<ReturnType<Transformers["pipeline"]>>;
const extractors = new Map<string, Promise<Extractor>>();

function getExtractor(modelId: string) {
  let existing = extractors.get(modelId);
  if (!existing) {
    existing = (async () => {
      const { pipeline } = await loadTransformers();
      return pipeline("feature-extraction", modelId, { dtype: "fp32" });
    })();
    extractors.set(modelId, existing);
  }
  return existing;
}

export async function localEmbed(
  spec: string,
  texts: string[],
  kind: "query" | "document",
): Promise<number[][]> {
  const { id } = parseSpec(spec);
  const extractor = await getExtractor(id);
  const prefix = prefixFor(id, kind === "query" ? QUERY_PREFIX : PASSAGE_PREFIX);

  const output = await (extractor as (
    input: string[],
    opts: { pooling: "cls" | "mean"; normalize: boolean },
  ) => Promise<{ tolist(): number[][] }>)(
    texts.map((t) => `${prefix}${t}`),
    { pooling: poolingFor(id), normalize: true },
  );

  return output.tolist();
}

interface CrossEncoder {
  tokenizer: Awaited<ReturnType<Transformers["AutoTokenizer"]["from_pretrained"]>>;
  model: Awaited<ReturnType<Transformers["AutoModelForSequenceClassification"]["from_pretrained"]>>;
}

const crossEncoders = new Map<string, Promise<CrossEncoder>>();

function getCrossEncoder(modelId: string) {
  let existing = crossEncoders.get(modelId);
  if (!existing) {
    existing = (async () => {
      const { AutoTokenizer, AutoModelForSequenceClassification } = await loadTransformers();
      return {
        tokenizer: await AutoTokenizer.from_pretrained(modelId),
        model: await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: "fp32" }),
      };
    })();
    crossEncoders.set(modelId, existing);
  }
  return existing;
}

/**
 * True cross-encoder reranking: each (query, passage) pair is tokenised
 * together and scored in one forward pass, so the model sees the actual
 * interaction rather than comparing two independently-produced vectors.
 */
export async function localRerank(
  spec: string,
  query: string,
  documents: string[],
): Promise<number[]> {
  const { id } = parseSpec(spec);
  const { tokenizer, model } = await getCrossEncoder(id);

  const scores: number[] = [];
  // Batch to bound peak memory; these models have a 512-token window so the
  // tensors stay small, but a 40-candidate pool at full width is still real RAM.
  const BATCH = 8;
  for (let i = 0; i < documents.length; i += BATCH) {
    const batch = documents.slice(i, i + BATCH);
    const inputs = (tokenizer as unknown as (
      text: string[],
      opts: { text_pair: string[]; padding: boolean; truncation: boolean },
    ) => unknown)(Array(batch.length).fill(query), {
      text_pair: batch,
      padding: true,
      truncation: true,
    });
    const { logits } = (await (model as unknown as (i: unknown) => Promise<{
      logits: { sigmoid(): { tolist(): number[][] } };
    }>)(inputs));
    for (const row of logits.sigmoid().tolist()) scores.push(row[0]);
  }
  return scores;
}

/** Loads the weights ahead of the first request so users never wait mid-query. */
export async function warmLocalModels(embedSpec?: string, rerankSpec?: string) {
  const jobs: Promise<unknown>[] = [];
  if (embedSpec && parseSpec(embedSpec).backend === "local") {
    jobs.push(localEmbed(embedSpec, ["warm"], "query"));
  }
  if (rerankSpec && parseSpec(rerankSpec).backend === "local") {
    jobs.push(localRerank(rerankSpec, "warm", ["warm"]));
  }
  await Promise.all(jobs);
}
