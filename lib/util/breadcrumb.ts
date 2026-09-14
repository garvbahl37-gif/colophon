/**
 * Builds the "Document > Section > Subsection" trail shown in citations and
 * prepended to indexed text.
 *
 * Markdown documents usually open with an H1 that repeats the title, which
 * would otherwise produce "Gateway RFC 0042 > Gateway RFC 0042 > Timeouts" in
 * every citation and in every embedded chunk.
 */
export function breadcrumb(title: string, headingPath: string[], separator = " > "): string {
  const parts = [title, ...headingPath].filter(Boolean);
  return parts
    .filter((part, i) => i === 0 || part.trim().toLowerCase() !== parts[i - 1].trim().toLowerCase())
    .join(separator);
}
