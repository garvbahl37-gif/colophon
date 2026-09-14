"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/util/cn";
import { breadcrumb } from "@/lib/util/breadcrumb";
import { plainText } from "@/lib/util/plain-text";
import type { RetrievalRound, RetrievedPassage } from "@/lib/ai/types";

/**
 * A retrieved chunk, set as text rather than printed as Markdown source.
 *
 * Chunks are stored verbatim, which is correct — the citation has to be what
 * the document actually says. But verbatim source is not readable: a passage
 * from a web page arrives full of `**bold**`, escaped `3\.` list numbers, and
 * link syntax carrying a URL and a title attribute, which together bury the
 * sentence the reader is trying to check. Rendering it here changes nothing
 * about what was retrieved or cited, only what the eye has to wade through.
 *
 * Links are rendered as their text. The URL is noise in a panel this size, and
 * it arrived from an ingested document, so turning it into something clickable
 * would let any indexed page place a live link inside the interface. Images are
 * dropped for the same reason, and because a chunk is prose, not a figure.
 */
function Excerpt({ text }: { text: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  // The bottom fade is a lie when everything already fits, so only wear it
  // when there is genuinely more text below the fold.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    setOverflowing(node.scrollHeight > node.clientHeight + 2);
  }, [text]);

  return (
    <div ref={scroller} className="excerpt-scroll" data-overflowing={overflowing}>
      <div className="prose-excerpt">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children }) => <span className="cite-link">{children}</span>,
            img: () => null,
          }}
        >
          {text}
        </Markdown>
      </div>
    </div>
  );
}

/**
 * The passage meter.
 *
 * Every retrieved passage shows two things a normal citation list hides: how
 * strongly the cross-encoder rated it, and which retrieval arm actually found
 * it. The second bar splits jade/amber by each arm's contribution to the fused
 * rank, so an all-jade bar means "found by meaning alone" and an all-amber bar
 * means "found by exact wording alone" - the single most useful signal when
 * you are deciding whether your chunking or your embedding is at fault.
 */
export function PassageMeter({
  passage,
  active,
  onSelect,
}: {
  passage: RetrievedPassage;
  active?: boolean;
  onSelect?: (p: RetrievedPassage) => void;
}) {
  const [open, setOpen] = useState(false);

  const rerank = passage.rerankScore;
  // RRF contribution per arm, from rank position rather than raw score -
  // cosine distance and ts_rank_cd are not on comparable scales.
  const denseWeight = passage.denseRank ? 1 / (60 + passage.denseRank) : 0;
  const lexicalWeight = passage.sparseRank ? 1 / (60 + passage.sparseRank) : 0;
  const total = denseWeight + lexicalWeight;
  const densePct = total ? (denseWeight / total) * 100 : 0;
  const lexicalPct = total ? 100 - densePct : 0;

  // Lead with the section. Every passage in a result set usually shares the
  // same document, so the title is the part that carries no information and
  // the heading is the part that gets truncated away if the title goes first.
  const title = plainText(passage.documentTitle);
  const section = plainText(passage.headingPath.at(-1) ?? "") || title;
  const where = breadcrumb(passage.documentTitle, passage.headingPath, " › ");

  return (
    <li className={cn("border-b border-hairline", active && "bg-bg-2")}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          onSelect?.(passage);
        }}
        aria-expanded={open}
        className="w-full px-4 py-3 text-left transition-colors hover:bg-bg-2"
      >
        <div className="flex items-baseline gap-2">
          <span className="mono shrink-0 text-micro text-brand-3">[{passage.marker}]</span>
          <span className="min-w-0 flex-1 truncate text-small text-fg-2" title={where}>
            {section}
            {section !== title && <span className="text-fg-3"> · {title}</span>}
          </span>
          {rerank != null && (
            <span className="mono shrink-0 text-micro text-fg">{rerank.toFixed(3)}</span>
          )}
        </div>

        {/* Cross-encoder relevance. */}
        <div className="mt-1.5 h-[3px] w-full overflow-hidden  bg-line">
          <div
            className="h-full  bg-fused transition-[width] duration-500"
            style={{ width: `${Math.round((rerank ?? passage.rrfScore) * 100)}%` }}
          />
        </div>

        {/* Which arm found it. */}
        <div className="mt-1 flex h-[3px] w-full overflow-hidden  bg-line">
          <div className="h-full bg-jade transition-[width] duration-500" style={{ width: `${densePct}%` }} />
          <div className="h-full bg-amber transition-[width] duration-500" style={{ width: `${lexicalPct}%` }} />
        </div>

        <div className="mono mt-1.5 flex gap-3 text-micro text-fg-3">
          <span className={passage.denseRank ? "text-jade/75" : ""}>
            vector {passage.denseRank ? `#${passage.denseRank}` : "—"}
          </span>
          <span className={passage.sparseRank ? "text-amber/75" : ""}>
            lexical {passage.sparseRank ? `#${passage.sparseRank}` : "—"}
          </span>
          {passage.page != null && <span>p.{passage.page}</span>}
        </div>
      </button>

      {/* The excerpt. Two stacked pieces of evidence, labelled, because the
          written context and the document's own words are different kinds of
          claim and running them together hides which is which.

          `border-line`, not the `border-white/6` this carried from the dark
          palette — on the light ground that rule was invisible, so the panel
          appeared to bleed into the row above it. */}
      {open && (
        <div className="border-t border-line bg-bg-2 px-4 py-3.5">
          {passage.context && (
            <div className="mb-3.5">
              <p className="label mb-1.5 text-fg-3">Written context</p>
              <p className="border-l-2 border-brand/50 pl-2.5 text-micro leading-relaxed text-fg-2">
                {passage.context}
              </p>
            </div>
          )}

          <p className="label mb-1.5 text-fg-3">Passage</p>
          <Excerpt text={passage.snippet} />

          <p
            className="mono mt-3 truncate border-t border-hairline pt-2.5 text-micro text-fg-3"
            title={where}
          >
            {where}
            {passage.page != null && ` · p.${passage.page}`}
          </p>
        </div>
      )}
    </li>
  );
}

/** One search the system ran, with everything it returned. */
export function RetrievalRoundView({
  round,
  onSelect,
  activeChunkId,
}: {
  round: RetrievalRound;
  onSelect?: (p: RetrievedPassage) => void;
  activeChunkId?: string | null;
}) {
  const running = round.status === "running";

  return (
    <section className="border-b border-line">
      <header className="px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-fg-3">search</span>
          <span className="mono min-w-0 flex-1 truncate text-small text-fg" title={round.query}>
            {round.query}
          </span>
          {round.ms != null && <span className="mono text-micro text-fg-3">{round.ms}ms</span>}
        </div>

        {running ? (
          <div className="scanning relative mt-2 h-[2px] w-full overflow-hidden  bg-line" />
        ) : (
          <div className="mono mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-micro text-fg-3">
            {round.dense != null && <span className="text-jade/70">vector {round.dense}</span>}
            {round.sparse != null && <span className="text-amber/70">lexical {round.sparse}</span>}
            {round.fused != null && <span>fused {round.fused}</span>}
            <span>kept {round.passages.length}</span>
            {round.scope && <span>scoped to {round.scope}</span>}
          </div>
        )}
      </header>

      {round.passages.length > 0 && (
        <ul>
          {round.passages.map((p) => (
            <PassageMeter
              key={`${round.id}-${p.chunkId}`}
              passage={p}
              active={activeChunkId === p.chunkId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
