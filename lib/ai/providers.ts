import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { gateway, type EmbeddingModel, type LanguageModel } from "ai";

/**
 * Per-stage provider routing.
 *
 * A RAG system needs four different kinds of model and almost no provider is
 * the best - or even available - for all four. Ollama Cloud serves strong
 * open-weight chat models with tool calling but exposes no embedding or
 * reranking endpoint at all; the Vercel AI Gateway serves all four; ONNX models
 * run embeddings and a cross-encoder in-process with no key and no network.
 *
 * So every model in config is a spec string that names its own backend:
 *
 *   ollama:gpt-oss:120b                   -> Ollama Cloud
 *   google:gemini-2.5-flash               -> Google, direct
 *   google:text-embedding-004             -> Google embeddings, direct
 *   gateway:anthropic/claude-sonnet-5     -> Vercel AI Gateway
 *   anthropic/claude-sonnet-5             -> Vercel AI Gateway (bare = gateway)
 *   local:Xenova/bge-base-en-v1.5         -> in-process ONNX (never serverless)
 *   supabase:gte-small                    -> Supabase Edge Function
 *   llm:listwise                          -> rerank with the grading model
 *
 * Each stage is then swappable on its own. Run the agent on Ollama and rerank
 * locally today; move generation to Claude by editing one env var tomorrow.
 */

export type Backend = "ollama" | "google" | "gateway" | "local" | "supabase" | "llm";

export interface ModelSpec {
  backend: Backend;
  /** The model id with the backend prefix stripped. Ollama ids keep their colons. */
  id: string;
  /** The original spec, for display. */
  raw: string;
}

const BACKENDS: Backend[] = ["ollama", "google", "gateway", "local", "supabase", "llm"];

export function parseSpec(spec: string): ModelSpec {
  const separator = spec.indexOf(":");
  if (separator > 0) {
    const prefix = spec.slice(0, separator) as Backend;
    if (BACKENDS.includes(prefix)) {
      return { backend: prefix, id: spec.slice(separator + 1), raw: spec };
    }
  }
  return { backend: "gateway", id: spec, raw: spec };
}

/** Short label for the UI - "gpt-oss:120b", not "ollama:gpt-oss:120b". */
export function displayName(spec: string): string {
  return parseSpec(spec).id;
}

let ollamaProvider: ReturnType<typeof createOpenAICompatible> | null = null;

function ollama() {
  if (!ollamaProvider) {
    const apiKey = process.env.OLLAMA_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OLLAMA_API_KEY is not set, but a model is routed to Ollama. " +
          "Set it in .env.local, or point that stage at the gateway instead.",
      );
    }
    ollamaProvider = createOpenAICompatible({
      name: "ollama",
      baseURL: process.env.OLLAMA_BASE_URL ?? "https://ollama.com/v1",
      apiKey,
    });
  }
  return ollamaProvider;
}

/*
  Google, reached directly rather than through the gateway.

  Worth its own backend for two reasons this system feels sharply. It is the
  only provider here that serves BOTH generation and embeddings, so a
  deployment can stop straddling Ollama and a Supabase Edge Function for one
  pipeline. And it answers concurrent requests concurrently -- measured on the
  current setup, four parallel calls to Ollama Cloud take four times as long as
  one, which is why contextualising a document is minutes of wall clock and why
  the router skips reranking on lookups. A provider that parallelises changes
  the arithmetic of every one of those decisions.

  Direct, not via the gateway, because the gateway needs its own billing
  relationship and this needs one key.
*/
let googleProvider: ReturnType<typeof createGoogleGenerativeAI> | null = null;

function google() {
  if (!googleProvider) {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GOOGLE_GENERATIVE_AI_API_KEY is not set, but a model is routed to Google. " +
          "Get one from aistudio.google.com, set it in .env.local, or point that " +
          "stage at another backend.",
      );
    }
    googleProvider = createGoogleGenerativeAI({ apiKey });
  }
  return googleProvider;
}

export function languageModel(spec: string): LanguageModel {
  const { backend, id } = parseSpec(spec);
  switch (backend) {
    case "ollama":
      return ollama().chatModel(id);
    case "google":
      return google()(id);
    case "local":
      throw new Error(
        `"${spec}" routes a language model to the local backend, which only provides ` +
          "embeddings and reranking. Use an ollama: or gateway: model for generation.",
      );
    default:
      return gateway(id);
  }
}

export function embeddingModel(spec: string): EmbeddingModel {
  const { backend, id } = parseSpec(spec);
  if (backend === "gateway") return gateway.textEmbeddingModel(id);
  if (backend === "google") return google().textEmbedding(id);
  throw new Error(
    `Embedding spec "${spec}" is not a gateway model. ` +
      "Local embeddings are handled by lib/ai/local.ts, not the AI SDK provider path.",
  );
}

/** True when a stage needs no API key and no network round trip. */
export function isLocal(spec: string): boolean {
  return parseSpec(spec).backend === "local";
}

export function requiredKeyFor(spec: string): string | null {
  const { backend } = parseSpec(spec);
  if (backend === "ollama") return "OLLAMA_API_KEY";
  if (backend === "google") return "GOOGLE_GENERATIVE_AI_API_KEY";
  if (backend === "gateway") return "AI_GATEWAY_API_KEY";
  if (backend === "supabase") return "SUPABASE_PUBLISHABLE_KEY";
  return null;
}

export function backendOf(spec: string): Backend {
  return parseSpec(spec).backend;
}
