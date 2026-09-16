import type { RawChunk } from "./chunker";

/**
 * What changed between two versions of a document.
 *
 * Re-ingesting a source whose content has moved on used to produce a second,
 * unrelated document row: same title, no relationship, and the stale text still
 * fully searchable. The corpus then held two answers to the same question with
 * nothing to say which was current — the exact fault the contradiction auditor
 * now reports, manufactured by the ingest path itself.
 *
 * The comparison is deliberately structural rather than textual. A word-level
 * diff of a re-flowed document is mostly noise, and nobody reads it; what a
 * reader wants to know is which SECTIONS moved, because that is the unit they
 * think in and the unit citations point at. Comparing heading trails and the
 * text under them answers that without a model and without a diff library.
 */

export interface VersionChange {
  added: string[];
  removed: string[];
  changed: string[];
  /** True when the text moved but the section structure did not. */
  bodyOnly: boolean;
}

/** A section's identity is its heading trail; untitled leading text shares one. */
function sectionsOf(chunks: { headingPath: string[]; content: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of chunks) {
    const key = chunk.headingPath.join(" > ") || "(opening)";
    out.set(key, (out.get(key) ?? "") + chunk.content);
  }
  return out;
}

/** Whitespace-insensitive: a re-wrapped paragraph is not a change. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function compareVersions(
  previous: { headingPath: string[]; content: string }[],
  next: RawChunk[],
): VersionChange {
  const before = sectionsOf(previous);
  const after = sectionsOf(next);

  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...after.keys()].filter(
    (k) => before.has(k) && normalise(before.get(k)!) !== normalise(after.get(k)!),
  );

  return {
    added,
    removed,
    changed,
    bodyOnly: added.length === 0 && removed.length === 0 && changed.length > 0,
  };
}

/** One line for the document list, in the reader's terms rather than counts. */
export function describeChange(change: VersionChange): string {
  const parts: string[] = [];
  if (change.changed.length) parts.push(`${change.changed.length} section${change.changed.length === 1 ? "" : "s"} rewritten`);
  if (change.added.length) parts.push(`${change.added.length} added`);
  if (change.removed.length) parts.push(`${change.removed.length} removed`);
  return parts.length ? parts.join(", ") : "no section-level changes";
}
