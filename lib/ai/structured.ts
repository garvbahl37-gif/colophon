import { generateObject, generateText, tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import { parseSpec } from "./providers";

type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

/**
 * Schema-constrained generation that works on backends without native
 * structured outputs.
 *
 * Ollama Cloud accepts `response_format: json_schema` and then ignores it -
 * a request for a plan object comes back as a Markdown table. What it does
 * honour, reliably, is tool calling. So on that backend the schema is
 * expressed as a single tool the model is forced to call, and the tool's
 * arguments ARE the object. Everywhere else, `generateObject` uses the
 * provider's real structured-output support.
 *
 * Either way the result is parsed through the Zod schema before it is
 * returned. Tool arguments are shaped by the model, not guaranteed by it:
 * open models will happily invent an enum member that was never offered, and
 * that needs to fail here rather than three layers downstream.
 */
export async function generateStructured<SCHEMA extends z.ZodTypeAny>(options: {
  /** The config spec string, used to choose the strategy. */
  spec: string;
  model: LanguageModel;
  schema: SCHEMA;
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: ProviderOptions;
  maxRetries?: number;
}): Promise<z.infer<SCHEMA>> {
  const {
    spec,
    model,
    schema,
    system,
    prompt,
    temperature = 0,
    maxOutputTokens,
    providerOptions,
    maxRetries = 1,
  } = options;

  /*
    Two attempts, because one strategy is not reliably available.

    Forced tool calling is the best option on backends without real structured
    outputs, and gpt-oss refuses it often enough to matter: measured over the
    eval suite, the query planner fell back to verbatim search on 6 of 11
    questions, either because no tool call came back at all or because the
    arguments were missing a required field. Every one of those questions lost
    its decomposition, its HyDE passages and its keyword extraction, silently,
    while the pipeline reported success.

    The model is perfectly capable of writing the object; it just will not
    always route it through the tool API. So a refusal falls back to asking for
    JSON in the reply and parsing it leniently. That is strictly better than
    giving up, and it fails loudly if both routes fail.
  */
  let raw: unknown;
  if (nativeStructuredOutputs(spec)) {
    raw = await viaResponseFormat();
  } else {
    try {
      raw = await viaToolCall();
    } catch {
      raw = await viaJsonInText();
    }
  }

  let parsed = schema.safeParse(raw);
  if (!parsed.success && !nativeStructuredOutputs(spec)) {
    // A tool call that returned a malformed object is the same failure as one
    // that never arrived; retrying it as prose is worth one more round trip.
    raw = await viaJsonInText();
    parsed = schema.safeParse(raw);
  }
  if (!parsed.success) {
    throw new Error(`Structured output failed validation: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data as z.infer<SCHEMA>;

  async function viaResponseFormat(): Promise<unknown> {
    const { object } = await generateObject({
      model,
      schema: schema as z.ZodType<Record<string, unknown>>,
      system,
      prompt: prompt ?? "",
      temperature,
      maxOutputTokens,
      providerOptions,
      maxRetries,
    });
    return object;
  }

  async function viaToolCall(): Promise<unknown> {
    const { toolCalls } = await generateText({
      model,
      system,
      prompt: prompt ?? "",
      temperature,
      maxOutputTokens,
      providerOptions,
      maxRetries,
      // No `execute`: the loop stops at the call and hands back the arguments.
      tools: {
        respond: tool({
          description: "Return the result. Call this exactly once, and call nothing else.",
          inputSchema: schema as z.ZodType<Record<string, unknown>>,
        }),
      },
      toolChoice: { type: "tool", toolName: "respond" },
    });

    const call = toolCalls.find((c) => c.toolName === "respond");
    if (!call) throw new Error("Model returned no structured output.");
    return call.input;
  }

  /**
   * Ask for the object as text and dig it out of whatever comes back.
   *
   * Open models wrap JSON in prose, in Markdown fences, or in both, and will
   * occasionally emit a leading comment. Scanning for the first balanced brace
   * run handles all three without a parser, and without trusting the model to
   * have followed the formatting instruction it was just given.
   */
  async function viaJsonInText(): Promise<unknown> {
    const shape = JSON.stringify(z.toJSONSchema(schema as z.ZodType), null, 2);
    const { text } = await generateText({
      model,
      system,
      prompt: `${prompt ?? ""}\n\nReply with a single JSON object matching this schema, and nothing else — no prose, no code fence:\n${shape}`,
      temperature,
      maxOutputTokens,
      providerOptions,
      maxRetries,
    });

    const json = firstJsonObject(text);
    if (!json) throw new Error("Model returned no parseable object.");
    return json;
  }
}

/** The first complete `{...}` in a string, brace-counted so nesting survives. */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Backends whose `response_format: json_schema` is actually enforced. */
function nativeStructuredOutputs(spec: string): boolean {
  return parseSpec(spec).backend === "gateway";
}
