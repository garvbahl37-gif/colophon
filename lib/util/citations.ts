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

const MARKER = /[[［【〔]\s*(\d{1,3})\s*[\]］】〕]/g;

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

/** True when a sentence carries at least one citation in any bracket style. */
export function hasMarker(text: string): boolean {
  return new RegExp(MARKER.source).test(text);
}
