import { generateText } from "ai";
import { config } from "@/lib/config";
import { contextualizeModel } from "@/lib/ai/models";
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
 * Chunks are described in groups, not one per request.
 *
 * The original shape was one call per chunk, each carrying the whole document.
 * That is the shape Anthropic describes, and it is cheap on Anthropic because
 * the document sits in a cache-marked block and is billed at cache-read rates
 * after the first call. This deployment generates with Ollama, which does not
 * implement that cache control and silently ignores it, so every chunk was
 * re-sending the entire document as fresh input. A 52-chunk page meant 52 full
 * copies of itself, and ingestion took four minutes — almost all of it here.
 *
 * Sending the document once and asking for ten context lines against it costs
 * barely more than asking for one, because the document dominates the prompt.
 * The cache hint is kept for backends that honour it.
 */

/*
  Output format, and why it is not a schema.

  The obvious move is schema-constrained generation, and it does not survive
  contact with this model: gpt-oss refuses the forced tool call outright
  ("Model response did not contain a call to the required tool"), and a large
  prompt plus a tool definition returns a 500 from Ollama Cloud. Numbered lines
  are what it will actually produce, and they parse unambiguously.

  Two settings are load-bearing, both found by measurement:

  - Default reasoning effort, not the low setting the other fast stages use.
    At low effort the model writes perfectly good contexts and silently ignores
    the line format, so every one of them fails to parse.
  - A budget with a flat allowance on top of the per-excerpt share. The model
    reasons before it answers and that reasoning is billed against the same
    ceiling: ten excerpts spent 1507 output tokens for maybe 350 of prose. A
    ceiling sized only from the excerpt count stops mid-list with finishReason
    "length" and loses the tail of the group.
*/

const LINE = /^\s*(\d+)\s*\|\s*(.+)$/;

function instruction(count: number): string {
  return `For EACH of the ${count} numbered excerpts above, write ONE sentence of at most 25 words situating it within the document, so it can be found by search without the rest of the document.

Name the specific section, entity, version, or subject it is about, and resolve vague references ("it", "this feature", "the limit") to concrete names. Do not restate the excerpt.

Answer with exactly one line per excerpt, in this format and nothing else:
1| context here
2| context here`;
}

/*
  Sections that gain nothing from a written context.

  A reference list, a "See also" column or an external-links block is already
  nothing but names; a sentence explaining that it is the reference list of the
  document adds no retrievable signal and costs a generation. On an encyclopedia
  page these are a large share of the chunks, and on this provider every
  generation is time the reader waits, so they take the heading trail directly.
*/
const BOILERPLATE =
  /^(references?|bibliography|external links?|see also|further reading|notes|citations|sources|footnotes|navigation|contents)$/i;

function isBoilerplate(chunk: RawChunk): boolean {
  return chunk.headingPath.some((h) => BOILERPLATE.test(h.trim()));
}

/** Pull "n| text" lines out of the reply, ignoring any preamble it adds. */
function parseLines(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split("\n")) {
    const match = LINE.exec(line);
    if (!match) continue;
    const context = match[2].trim();
    if (context) out.set(Number(match[1]), context);
  }
  return out;
}

/**
 * What the model is shown alongside a group of excerpts.
 *
 * Anthropic's version sends the entire document with every call, which is
 * affordable there because it sits in a cache-marked block. Without that cache
 * the document IS the cost: a 75k-character page shipped six times over made
 * ingestion slow and pushed some requests into provider errors outright.
 *
 * Almost none of that text is doing work. Situating an excerpt needs the
 * document's shape — its title and section outline, which is what "name the
 * specific section" actually draws on — plus enough nearby prose to resolve a
 * pronoun. The outline costs a few hundred characters and is derived from the
 * chunks themselves rather than generated, and the window is local to the
 * group. A whole document that already fits inside the local budget is simply
 * sent as it is, and stays byte-identical across groups so a caching backend
 * still hits.
 */
function documentBrief(fullText: string, group: RawChunk[], all: RawChunk[]): string {
  const limit = config.contextual.maxDocChars;
  if (fullText.length <= limit) return fullText;

  const outline = [...new Set(all.map((c) => c.headingPath.join(" > ")).filter(Boolean))]
    .slice(0, 60)
    .map((h) => `- ${h}`)
    .join("\n");

  const span = config.contextual.windowChars;
  const mid = Math.floor((group[0].charStart + group[group.length - 1].charEnd) / 2);
  const start = Math.max(0, Math.min(mid - Math.floor(span / 2), fullText.length - span));
  const window = `…${fullText.slice(start, start + span)}…`;

  return outline ? `Section outline:\n${outline}\n\nNearby text:\n${window}` : window;
}

function groupsOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function contextualizeChunks(
  chunks: RawChunk[],
  fullText: string,
  documentTitle: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  if (!config.contextual.enabled) return chunks.map(() => "");

  const windowed = fullText.length > config.contextual.maxDocChars;
  const results = new Map<RawChunk, string>();
  let done = 0;

  // Settled without a model, and reported as progress so the bar still moves.
  const worth: RawChunk[] = [];
  for (const chunk of chunks) {
    if (isBoilerplate(chunk)) results.set(chunk, breadcrumb(documentTitle, chunk.headingPath));
    else worth.push(chunk);
  }
  done = chunks.length - worth.length;
  if (done > 0) onProgress?.(done, chunks.length);

  const groups = groupsOf(worth, Math.max(1, config.contextual.batchSize));

  await mapLimit(groups, config.contextual.concurrency, async (group) => {
    // Always available, and what a failed or missing entry falls back to.
    const fallback = (chunk: RawChunk) => breadcrumb(documentTitle, chunk.headingPath);

    try {
      const excerpts = group
        .map((chunk, i) => `<excerpt n="${i + 1}">\n${chunk.content}\n</excerpt>`)
        .join("\n\n");

      const { text } = await generateText({
        model: contextualizeModel(),
        maxOutputTokens: Math.min(6000, 140 * group.length + 1000),
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `<document title="${documentTitle}">\n${documentBrief(fullText, group, chunks)}\n</document>`,
                providerOptions: windowed
                  ? {}
                  : { anthropic: { cacheControl: { type: "ephemeral" } } },
              },
              { type: "text", text: `${excerpts}\n\n${instruction(group.length)}` },
            ],
          },
        ],
      });

      // The model chooses these numbers, so nothing guarantees one per excerpt.
      // A missing or blank entry degrades to the heading trail; it must never
      // shift every later context onto the wrong chunk, which is the failure
      // that would quietly poison the index.
      const byNumber = parseLines(text);
      group.forEach((chunk, i) => {
        results.set(chunk, byNumber.get(i + 1) || fallback(chunk));
      });
    } catch (error) {
      // Contextualization is an enhancement, never a gate. A failed call
      // degrades those chunks to plain indexing rather than failing the ingest
      // -- but it degrades retrieval quality for them, so it is not silent.
      console.warn(
        `[contextualize] group of ${group.length} fell back to heading trails:`,
        error instanceof Error ? error.message : error,
      );
      for (const chunk of group) results.set(chunk, fallback(chunk));
    } finally {
      done += group.length;
      onProgress?.(done, chunks.length);
    }
  });

  return chunks.map((chunk) => results.get(chunk) ?? "");
}

/** The text that actually gets embedded and full-text indexed. */
export function buildIndexedText(chunk: RawChunk, context: string, title: string): string {
  return [context, breadcrumb(title, chunk.headingPath), chunk.content]
    .filter(Boolean)
    .join("\n\n");
}
