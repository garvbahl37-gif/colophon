/**
 * Strips inline Markdown so a fragment can be set as a label.
 *
 * Headings and titles are stored exactly as the document wrote them, which is
 * right — they are part of the citation. But a heading converted from HTML
 * frequently arrives carrying its own anchor, as in
 * "[](#how-multimodal-ai-works)How Multimodal AI Works", and a title can carry
 * emphasis. Printed verbatim into a one-line label those become the first thing
 * the eye lands on, and the label is too short to survive the noise.
 *
 * Mostly this decides what a human is asked to read. It also reaches indexed
 * text through `breadcrumb`, which is a second, smaller win: an anchor like
 * "(#how-multimodal-ai-works)" contributed nothing to a vector and put URL
 * fragments in the lexical index. Existing chunks keep whatever they were
 * indexed with; this improves documents from here on.
 *
 * Chunk bodies are never flattened through here. They are stored verbatim
 * because the citation has to be what the document actually says, and anywhere
 * the full text is shown it is rendered as Markdown instead.
 */
export function plainText(input: string): string {
  return (
    input
      // Images carry no label text worth keeping in a one-line context.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // Inline and reference links: keep the text, drop the target. An empty
      // text (a bare anchor) correctly collapses to nothing.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      // Leading heading markers and blockquote carets.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      // Emphasis and inline code. Bounded so a lone asterisk in prose survives.
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/(\*|_)(?=\S)([^*_]*?\S)\1/g, "$2")
      .replace(/`([^`]+)`/g, "$1")
      // Backslash escapes, which is what turns "3\." back into "3.".
      .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}
