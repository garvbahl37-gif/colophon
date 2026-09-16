/**
 * Citation marker normalisation.
 *
 * Models do not reliably emit the bracket characters you ask for. gpt-oss
 * consistently returns CJK full-width brackets - 【1】 - and others reach for
 * ［1］ or 〔1〕. Left alone, every one of those silently fails to resolve: the
 * answer looks cited, the citation panel is empty, and the groundedness audit
 * reports 0% citation density on a perfectly well-cited answer.
 *
 * Normalising on the way out costs nothing and makes the prompt instruction a
 * preference rather than a load-bearing requirement.
 */

/*
  Tolerates every marker shape these models actually emit, not just the one the
  prompt asks for:

    [1]            what we ask for
    【1】           gpt-oss reaches for CJK full-width brackets
    【1†L9-L13】    and sometimes appends an OpenAI-style line range
    ［1］ 〔1〕      other full-width variants

  Left unhandled, the answer looks cited, the citation panel is empty, and the
  groundedness audit reports 0% density on a perfectly well-cited answer.
*/
const MARKER = /[[［【〔]\s*(\d{1,3})\s*(?:[†‡][^\]］】〕]{0,40})?[\]］】〕]/g;

/** Rewrites every bracket variant to plain ASCII `[n]`. */
export function normaliseCitationMarkers(text: string): string {
  return text.replace(MARKER, (_, n: string) => `[${Number(n)}]`);
}

/** Every distinct marker number in the text, in ascending order. */
export function extractMarkers(text: string, max: number): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(MARKER)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= max) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}


/**
 * The answer, broken into the units a citation attaches to.
 *
 * Both the groundedness audit and the coverage view need "the claims in this
 * answer, and what supports each", and they had begun deriving it separately —
 * two definitions of a sentence drifting apart, so a density of 67% and a
 * coverage map showing three of four claims cited could both be right and
 * disagree. One definition, used by both.
 *
 * Fenced code is removed first. A code block is quoted material, not a claim,
 * and its full stops would otherwise split it into several imaginary ones.
 */
interface Claim {
  text: string;
  /** Markers cited by this sentence, ascending. Empty means uncited. */
  markers: number[];
}

export function claimsIn(answer: string, max: number): Claim[] {
  return answer
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25)
    .map((text) => ({ text, markers: extractMarkers(text, max) }));
}

/**
 * Rewrites LaTeX delimiters to the ones the Markdown maths plugin understands.
 *
 * remark-math recognises `$…$` and `$$…$$`. Models reach for the LaTeX
 * delimiters instead — `\(…\)` inline and `\[…\]` display — and asking the
 * prompt to prefer dollars is the same losing bet as asking it to prefer ASCII
 * brackets for citations: it mostly complies, and the failures are silent. An
 * unrecognised formula does not error, it prints its own source at the reader,
 * which is how ColBERT's scoring function arrived as a line of backslashes.
 *
 * Fenced code is left alone. A shell snippet containing \[ is not a formula,
 * and rewriting inside a code block would corrupt the one place the text is
 * supposed to be reproduced exactly.
 */
export function normaliseMathDelimiters(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            // On its own lines: remark-math only treats $$ as DISPLAY maths
            // when it stands alone, and inline is the wrong shape for a scoring
            // function the surrounding sentence is introducing.
            .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `\n\n$$\n${body.trim()}\n$$\n\n`)
            .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`),
    )
    .join("");
}
