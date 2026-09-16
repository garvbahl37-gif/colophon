"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/util/cn";
import { breadcrumb } from "@/lib/util/breadcrumb";
import { normaliseCitationMarkers } from "@/lib/util/citations";
import type { Citation, Contradiction, GroundingIssue } from "@/lib/retrieval/types";

/**
 * Turns bare citation markers into Markdown links so react-markdown will hand
 * them back as anchors we can render as chips.
 *
 * The negative lookahead matters: `[1](https://…)` is already a link, and
 * rewriting it would produce `[1](#cite-1)(https://…)`.
 */
function linkCitations(text: string): string {
  return normaliseCitationMarkers(text).replace(/\[(\d{1,3})\](?!\()/g, "[$1](#cite-$1)");
}

export function Answer({
  text,
  citations,
  streaming,
  onCite,
}: {
  text: string;
  citations: Citation[];
  streaming?: boolean;
  onCite?: (citation: Citation) => void;
}) {
  const byMarker = new Map(citations.map((c) => [c.marker, c]));

  return (
    <div className="prose-colophon text-base leading-[1.62] text-fg">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...props }) {
            const marker = href?.startsWith("#cite-") ? Number(href.slice(6)) : null;
            if (marker == null) {
              return (
                <a
                  {...props}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-3 underline decoration-brand/40 underline-offset-2 hover:decoration-brand-3"
                >
                  {children}
                </a>
              );
            }

            const citation = byMarker.get(marker);
            return (
              <button
                type="button"
                title={
                  citation
                    ? breadcrumb(citation.documentTitle, citation.headingPath, " › ")
                    : "Source not resolved"
                }
                onClick={() => citation && onCite?.(citation)}
                className={cn(
                  "mono mx-[1px] inline-flex h-[17px] min-w-[17px] items-center justify-center  px-[3px] align-[0.5px] text-micro leading-none transition-colors",
                  citation
                    ? "bg-brand/20 text-brand-3 hover:bg-brand/35"
                    : "bg-line text-fg-3",
                )}
              >
                {marker}
              </button>
            );
          },
        }}
      >
        {linkCitations(text)}
      </Markdown>
      {streaming && <span className="caret" aria-hidden />}
    </div>
  );
}

/**
 * The verdict from the post-hoc groundedness audit.
 *
 * A clean result is stated quietly; an unsupported claim is named in full,
 * because "this specific sentence isn't in your sources" is the only version
 * of this warning a reader can act on.
 */
export function GroundingBadge({
  grounding,
  onCite,
}: {
  grounding: {
    supported: boolean;
    issues: GroundingIssue[];
    contradictions?: Contradiction[];
    citationDensity: number;
  };
  onCite?: (marker: number) => void;
}) {
  const density = Math.round(grounding.citationDensity * 100);
  const conflicts = grounding.contradictions ?? [];

  return (
    <div className="space-y-2">
      {grounding.supported ? (
        <div className="mono flex items-center gap-2 text-micro text-fg-3">
          <span className="h-1.5 w-1.5 bg-jade" />
          Every claim traces to a source
          <span className="text-fg-3/70">{density}% of sentences cited</span>
        </div>
      ) : (
        <div className="border border-alert/40 bg-alert/5 px-3 py-2">
          <div className="flex items-center gap-2 text-micro text-alert">
            <span className="h-1.5 w-1.5 bg-alert" />
            {grounding.issues.length === 1
              ? "1 claim is not supported by the sources"
              : `${grounding.issues.length} claims are not supported by the sources`}
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {grounding.issues.map((issue, i) => (
              <li key={i} className="text-micro leading-snug text-fg-2">
                <span className="text-fg">“{issue.claim}”</span>
                <span className="text-fg-3"> — {issue.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        Reported separately from groundedness, and in a different colour,
        because it is a different kind of problem. An unsupported claim is a
        fault in the answer. A contradiction is a fault in the corpus: both
        passages are real, the answer may have handled it perfectly, and the
        reader still needs to know their documents disagree — that is usually
        the more useful finding of the two.
      */}
      {conflicts.length > 0 && (
        <div className="border border-amber/40 bg-amber/5 px-3 py-2">
          <div className="flex items-center gap-2 text-micro text-amber">
            <span className="h-1.5 w-1.5 bg-amber" />
            {conflicts.length === 1
              ? "Two sources disagree"
              : `${conflicts.length} disagreements between sources`}
          </div>
          <ul className="mt-1.5 space-y-2">
            {conflicts.map((c, i) => (
              <li key={i} className="text-micro leading-snug text-fg-2">
                <span className="text-fg">{c.claim}</span>
                <span className="mono ml-1.5 text-fg-3">
                  {c.markers.map((m, j) => (
                    <span key={m}>
                      {j > 0 && " vs "}
                      <button
                        type="button"
                        onClick={() => onCite?.(m)}
                        className="text-brand-3 hover:underline"
                      >
                        [{m}]
                      </button>
                    </span>
                  ))}
                </span>
                <p className="mt-0.5 text-fg-3">{c.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
