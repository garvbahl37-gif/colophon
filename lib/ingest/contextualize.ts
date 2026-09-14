import { generateText } from "ai";
import { config } from "@/lib/config";
import { contextualizeModel, fastStageOptions, FAST_STAGE_MAX_TOKENS } from "@/lib/ai/models";
import { mapLimit } from "@/lib/util/async";
import { breadcrumb } from "@/lib/util/breadcrumb";
import type { RawChunk } from "./chunker";

/**
 * Anthropic's Contextual Retrieval: before indexing, ask a cheap model to write
 * one or two sentences situating each chunk inside its parent document, and
 * prepend that to the text we embed and full-text index.
 *
 * The win is on chunks whose meaning depends on context they don't contain —
 * "the limit was raised to 30 seconds" is unretrievable until it becomes
 * "From the Retry Policy section of the Gateway RFC: the limit was raised…".
 * Anthropic measured a 35–49% reduction in retrieval failures.
 *
 * The whole document is sent on every call, but it goes in a cache-marked
 * content block, so after the first chunk the document is billed at cache-read
 * rates instead of input rates.
 */

const INSTRUCTION = `Here is the chunk we want to situate within the whole document.

<chunk>
{{CHUNK}}
</chunk>

Give a short, succinct context (1–2 sentences, under 60 words) that situates this chunk within the overall document, for the purpose of improving search retrieval of the chunk.

Name the specific section, entity, version, or subject the chunk is about, so the chunk is findable without the rest of the document. Resolve pronouns and vague references ("it", "this feature", "the limit") to concrete names.

Answer with the context only. No preamble, no quotes.`;

/** Keep the cached prefix byte-identical across chunks so the cache actually hits. */
function documentWindow(fullText: string, chunk: RawChunk): string {
  if (fullText.length <= config.contextual.maxDocChars) return fullText;
  const half = Math.floor(config.contextual.maxDocChars / 2);
  const mid = Math.floor((chunk.charStart + chunk.charEnd) / 2);
  const start = Math.max(0, mid - half);
  const end = Math.min(fullText.length, start + config.contextual.maxDocChars);
  return `…${fullText.slice(start, end)}…`;
}

export async function contextualizeChunks(
  chunks: RawChunk[],
  fullText: string,
  documentTitle: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  if (!config.contextual.enabled) return chunks.map(() => "");

  const windowed = fullText.length > config.contextual.maxDocChars;
  let done = 0;

  return mapLimit(chunks, config.contextual.concurrency, async (chunk) => {
    try {
      const { text } = await generateText({
        model: contextualizeModel(),
        maxOutputTokens: FAST_STAGE_MAX_TOKENS,
        temperature: 0,
        providerOptions: fastStageOptions(),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `<document title="${documentTitle}">\n${documentWindow(fullText, chunk)}\n</document>`,
                // Cache the document block; subsequent chunks read it back
                // instead of re-paying input cost for the whole file.
                providerOptions: windowed
                  ? {}
                  : { anthropic: { cacheControl: { type: "ephemeral" } } },
              },
              { type: "text", text: INSTRUCTION.replace("{{CHUNK}}", chunk.content) },
            ],
          },
        ],
      });
      return text.trim();
    } catch {
      // Contextualization is an enhancement, never a gate. A failed call
      // degrades that chunk to plain indexing rather than failing the ingest.
      return breadcrumb(documentTitle, chunk.headingPath);
    } finally {
      onProgress?.(++done, chunks.length);
    }
  });
}

/** The text that actually gets embedded and full-text indexed. */
export function buildIndexedText(chunk: RawChunk, context: string, title: string): string {
  return [context, breadcrumb(title, chunk.headingPath), chunk.content]
    .filter(Boolean)
    .join("\n\n");
}
