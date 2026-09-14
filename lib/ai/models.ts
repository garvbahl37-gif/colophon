import { embed, embedMany } from "ai";
import { config } from "@/lib/config";
import {
  embeddingModel as gatewayEmbeddingModel,
  isLocal,
  languageModel,
  parseSpec,
  requiredKeyFor,
} from "./providers";

/**
 * Stage-level accessors. Nothing outside this file knows which provider backs
 * which stage - callers ask for "the grading model" and get whatever the config
 * currently routes that stage to.
 */
export const generateModel = () => languageModel(config.models.generate);
export const planModel = () => languageModel(config.models.plan);
export const contextualizeModel = () => languageModel(config.models.contextualize);
export const gradeModel = () => languageModel(config.models.grade);

/**
 * Options for the cheap, high-volume stages (planning, grading, contextualising).
 *
 * gpt-oss and the other open reasoning models spend their output budget on a
 * reasoning block before they emit any content, so a stage capped at a couple
 * of hundred tokens returns an empty string rather than an answer. Dialing
 * reasoning effort down keeps these stages both correct and roughly 40% faster,
 * and the keys for backends that do not support it are simply ignored.
 */
export function fastStageOptions() {
  return {
    ollama: { reasoning_effort: "low" },
    openai: { reasoningEffort: "low" },
  } as const;
}

/** Reasoning tokens come out of the same budget as content, so budgets stay generous. */
export const FAST_STAGE_MAX_TOKENS = 900;

/** Asymmetric encoding: telling the encoder which side it is on is worth real recall. */
type InputType = "query" | "document";

function hostedProviderOptions(inputType: InputType) {
  return {
    voyage: { inputType },
    cohere: { inputType: inputType === "query" ? "search_query" : "search_document" },
  };
}

export async function embedQuery(text: string): Promise<number[]> {
  if (isLocal(config.models.embed)) {
    // Imported here, not at module scope: a hosted deployment must never pull
    // onnxruntime into its bundle for a code path it will not execute.
    const { localEmbed } = await import("./local");
    const [vector] = await localEmbed(config.models.embed, [text], "query");
    return vector;
  }
  const { embedding } = await embed({
    model: gatewayEmbeddingModel(config.models.embed),
    value: text,
    providerOptions: hostedProviderOptions("query"),
    maxRetries: 2,
  });
  return embedding;
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (isLocal(config.models.embed)) {
    const { localEmbed } = await import("./local");
    const out: number[][] = [];
    // Local inference is CPU-bound, so batches stay small regardless of the
    // configured API batch size.
    const BATCH = Math.min(config.embedding.batchSize, 16);
    for (let i = 0; i < texts.length; i += BATCH) {
      out.push(...(await localEmbed(config.models.embed, texts.slice(i, i + BATCH), "document")));
    }
    return out;
  }

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += config.embedding.batchSize) {
    const { embeddings } = await embedMany({
      model: gatewayEmbeddingModel(config.models.embed),
      values: texts.slice(i, i + config.embedding.batchSize),
      providerOptions: hostedProviderOptions("document"),
      maxRetries: 3,
    });
    out.push(...embeddings);
  }
  return out;
}

/** Cosine similarity. Used by MMR diversification. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Checks that every key the current routing actually needs is present -
 * a config running entirely on Ollama plus local ONNX needs no gateway key,
 * and demanding one would be wrong.
 */
export function assertCredentials() {
  const needed = new Set<string>();
  for (const spec of Object.values(config.models)) {
    const key = requiredKeyFor(spec);
    if (key) needed.add(key);
  }

  const missing = [...needed].filter((key) => {
    if (key === "AI_GATEWAY_API_KEY") {
      return !process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN;
    }
    return !process.env[key];
  });

  if (missing.length > 0) {
    const stages = Object.entries(config.models)
      .filter(([, spec]) => missing.includes(requiredKeyFor(spec) ?? ""))
      .map(([stage, spec]) => `${stage} -> ${spec}`)
      .join(", ");
    throw new Error(`Missing ${missing.join(" and ")} in .env.local. Required by: ${stages}`);
  }
}

/** Back-compat alias used by the API routes. */
export const assertGatewayKey = assertCredentials;

/** What the UI shows in the model chip. */
export function activeRouting() {
  return Object.fromEntries(
    Object.entries(config.models).map(([stage, spec]) => {
      const { backend, id } = parseSpec(spec);
      return [stage, { backend, id }];
    }),
  );
}
