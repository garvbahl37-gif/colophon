import { config } from "@/lib/config";
import { estimateTokens } from "@/lib/util/async";
import type { LoadedDocument } from "./loaders";

export interface RawChunk {
  ordinal: number;
  content: string;
  /** Breadcrumb of enclosing Markdown headings, e.g. ["API", "Auth", "Retries"]. */
  headingPath: string[];
  charStart: number;
  charEnd: number;
  page: number | null;
  tokenCount: number;
}

interface Block {
  text: string;
  start: number;
  end: number;
  headingPath: string[];
  /** Code fences and tables are never split mid-way. */
  atomic: boolean;
}

/**
 * Splits the document on structural boundaries first, and only falls back to
 * sentence packing inside an oversized block.
 *
 * Fixed-window chunking cuts through headings, tables and code fences, which
 * produces chunks that are locally fluent but globally meaningless. Walking the
 * heading tree instead means every chunk knows where it sits in the document,
 * and that breadcrumb is carried into both the embedding and the citation.
 */
function toBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  const headings: string[] = [];

  let offset = 0;
  let buffer: string[] = [];
  let bufferStart = 0;

  const flush = (atomic = false) => {
    const body = buffer.join("\n").trim();
    if (body) {
      blocks.push({
        text: body,
        start: bufferStart,
        end: offset,
        headingPath: [...headings],
        atomic,
      });
    }
    buffer = [];
    bufferStart = offset;
  };

  let inFence = false;
  let fenceStart = 0;

  for (const line of lines) {
    const lineLen = line.length + 1;

    if (/^\s*```/.test(line)) {
      if (!inFence) {
        flush();
        inFence = true;
        fenceStart = offset;
        buffer.push(line);
      } else {
        buffer.push(line);
        offset += lineLen;
        blocks.push({
          text: buffer.join("\n"),
          start: fenceStart,
          end: offset,
          headingPath: [...headings],
          atomic: true,
        });
        buffer = [];
        bufferStart = offset;
        inFence = false;
        continue;
      }
      offset += lineLen;
      continue;
    }

    if (inFence) {
      buffer.push(line);
      offset += lineLen;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      headings.length = Math.min(headings.length, level - 1);
      headings[level - 1] = heading[2].trim();
      for (let i = 0; i < level - 1; i++) headings[i] ??= "";
      offset += lineLen;
      bufferStart = offset;
      continue;
    }

    if (line.trim() === "") {
      flush();
      offset += lineLen;
      bufferStart = offset;
      continue;
    }

    buffer.push(line);
    offset += lineLen;
  }
  flush(inFence);

  return blocks.filter((b) => b.text.trim().length > 0);
}

/** Sentence-ish split that does not break on decimals, abbreviations or lists. */
function splitSentences(text: string): string[] {
  const out = text
    .split(/(?<=[.!?])\s+(?=[A-Z("'\[]|\d+\.\s)/g)
    .flatMap((s) => (estimateTokens(s) > config.chunking.maxTokens ? s.split(/(?<=[;:,])\s+/) : [s]))
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : [text];
}

export function chunkDocument(doc: LoadedDocument): RawChunk[] {
  const { targetTokens, overlapTokens, minTokens, maxTokens } = config.chunking;
  const blocks = toBlocks(doc.text);
  const chunks: Omit<RawChunk, "ordinal" | "page">[] = [];

  let current: { parts: string[]; start: number; end: number; headingPath: string[] } | null = null;

  const commit = () => {
    if (!current) return;
    const content = current.parts.join("\n\n").trim();
    if (content) {
      chunks.push({
        content,
        headingPath: current.headingPath.filter(Boolean),
        charStart: current.start,
        charEnd: current.end,
        tokenCount: estimateTokens(content),
      });
    }
    current = null;
  };

  const push = (text: string, start: number, end: number, headingPath: string[]) => {
    const tokens = estimateTokens(text);
    if (!current) {
      current = { parts: [text], start, end, headingPath };
    } else if (
      estimateTokens(current.parts.join("\n\n")) + tokens <= targetTokens &&
      current.headingPath.join("/") === headingPath.join("/")
    ) {
      current.parts.push(text);
      current.end = end;
    } else {
      // Carry a tail of the previous chunk forward so a fact that straddles a
      // boundary survives in at least one chunk intact.
      const tail = overlapTokens > 0 ? current.parts.at(-1) ?? "" : "";
      const overlap =
        tail && estimateTokens(tail) <= overlapTokens
          ? tail
          : tail.slice(-overlapTokens * 4).replace(/^\S*\s/, "");
      commit();
      current = {
        parts: overlap ? [overlap, text] : [text],
        start,
        end,
        headingPath,
      };
    }
  };

  for (const block of blocks) {
    const tokens = estimateTokens(block.text);

    if (block.atomic || tokens <= targetTokens) {
      if (tokens > maxTokens && !block.atomic) {
        // Fall through to sentence packing below.
      } else {
        push(block.text, block.start, block.end, block.headingPath);
        continue;
      }
    }

    // Oversized prose block: pack sentences up to target.
    commit();
    let acc: string[] = [];
    let accStart = block.start;
    for (const sentence of splitSentences(block.text)) {
      if (estimateTokens([...acc, sentence].join(" ")) > targetTokens && acc.length) {
        const text = acc.join(" ");
        chunks.push({
          content: text,
          headingPath: block.headingPath.filter(Boolean),
          charStart: accStart,
          charEnd: accStart + text.length,
          tokenCount: estimateTokens(text),
        });
        const tail = acc.at(-1) ?? "";
        acc = estimateTokens(tail) <= overlapTokens ? [tail, sentence] : [sentence];
        accStart += text.length;
      } else {
        acc.push(sentence);
      }
    }
    if (acc.length) {
      const text = acc.join(" ");
      chunks.push({
        content: text,
        headingPath: block.headingPath.filter(Boolean),
        charStart: accStart,
        charEnd: accStart + text.length,
        tokenCount: estimateTokens(text),
      });
    }
  }
  commit();

  // Fold runt chunks into their neighbour rather than indexing near-empty rows.
  const merged: typeof chunks = [];
  for (const chunk of chunks) {
    const prev = merged.at(-1);
    if (
      prev &&
      chunk.tokenCount < minTokens &&
      prev.tokenCount + chunk.tokenCount <= maxTokens
    ) {
      prev.content = `${prev.content}\n\n${chunk.content}`;
      prev.charEnd = chunk.charEnd;
      prev.tokenCount = estimateTokens(prev.content);
    } else {
      merged.push({ ...chunk });
    }
  }

  const pageFor = (charStart: number): number | null => {
    if (!doc.pageBreaks?.length) return null;
    let page = 1;
    for (let i = 0; i < doc.pageBreaks.length; i++) {
      if (doc.pageBreaks[i] <= charStart) page = i + 1;
      else break;
    }
    return page;
  };

  return merged.map((c, i) => ({ ...c, ordinal: i, page: pageFor(c.charStart) }));
}
