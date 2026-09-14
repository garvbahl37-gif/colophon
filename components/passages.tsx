"use client";

import { useState } from "react";
import { cn } from "@/lib/util/cn";
import { breadcrumb } from "@/lib/util/breadcrumb";
import type { RetrievalRound, RetrievedPassage } from "@/lib/ai/types";

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
  const section = passage.headingPath.at(-1) ?? passage.documentTitle;
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
            {section !== passage.documentTitle && (
              <span className="text-fg-3"> · {passage.documentTitle}</span>
            )}
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

      {open && (
        <div className="border-t border-white/6 bg-bg-2 px-4 py-3">
          {passage.context && (
            <p className="mb-2 border-l-2 border-jade/40 pl-2 text-micro leading-relaxed text-fg-3">
              {passage.context}
            </p>
          )}
          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-small leading-relaxed text-fg-2">
            {passage.snippet}
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
