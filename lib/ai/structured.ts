import { generateObject, generateText, tool, type LanguageModel, type ModelMessage } from "ai";
import type { z } from "zod";
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

  const raw = nativeStructuredOutputs(spec)
    ? await viaResponseFormat()
    : await viaToolCall();

  const parsed = schema.safeParse(raw);
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
}

/** Backends whose `response_format: json_schema` is actually enforced. */
function nativeStructuredOutputs(spec: string): boolean {
  return parseSpec(spec).backend === "gateway";
}
