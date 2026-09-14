"use client";

import { cn } from "@/lib/util/cn";
import type { TraceSpan, TraceStage } from "@/lib/retrieval/types";

/**
 * The pipeline trace.
 *
 * Retrieval systems fail quietly: a bad rewrite, a reranker that timed out and
 * fell back, a sufficiency check that re-queried and still came up short. All
 * of it is invisible in a finished answer. The trace puts each stage on the
 * record with its latency and its real numbers, attached to the message it
 * produced - so a disappointing answer is diagnosable rather than mysterious.
 */

const STAGE_LABEL: Record<TraceStage, string> = {
  plan: "plan",
  retrieve: "retrieve",
  rerank: "rerank",
  grade: "grade",
  compress: "compress",
  generate: "generate",
  verify: "verify",
};

/** Causal position of each stage in the pipeline. */
const STAGE_ORDER: Record<TraceStage, number> = {
  plan: 0,
  retrieve: 1,
  rerank: 2,
  grade: 3,
  compress: 4,
  generate: 5,
  verify: 6,
};

const STAGE_TINT: Record<TraceStage, string> = {
  plan: "text-fg-2",
  retrieve: "text-jade",
  rerank: "text-fused",
  grade: "text-fg-2",
  compress: "text-amber",
  generate: "text-fg",
  verify: "text-fg-2",
};

export function TraceStrip({ spans, totalMs }: { spans: TraceSpan[]; totalMs?: number }) {
  if (spans.length === 0) return null;
  const slowest = Math.max(...spans.map((s) => s.ms ?? 0), 1);

  // Emission order is not causal order. The agent wrapper opens before the tool
  // calls it makes, and the groundedness audit is emitted last but belongs
  // after generation either way. Sorting by pipeline position, then by arrival,
  // makes the trace read the way the run actually happened.
  const ordered = spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) => STAGE_ORDER[a.span.stage] - STAGE_ORDER[b.span.stage] || a.index - b.index)
    .map(({ span }) => span);

  return (
    <div className="panel">
      <div className="flex items-baseline justify-between border-b border-white/6 px-3 py-1.5">
        <span className="label">Pipeline</span>
        {totalMs != null && (
          <span className="mono text-micro text-fg-3">{(totalMs / 1000).toFixed(2)}s</span>
        )}
      </div>

      <ol className="divide-y divide-white/6">
        {ordered.map((span) => (
          <li
            key={span.id}
            className={cn("px-4 py-2.5", span.summary && "bg-bg-2")}
          >
            <div className="flex items-baseline gap-2.5">
              <span
                className={cn(
                  "mono w-[4.75rem] shrink-0 text-micro",
                  STAGE_TINT[span.stage],
                  span.status === "skipped" && "text-fg-3 line-through",
                  span.status === "error" && "text-alert",
                )}
              >
                {STAGE_LABEL[span.stage]}
              </span>

              <span className="min-w-0 flex-1 truncate text-small text-fg-2" title={span.label}>
                {span.label}
              </span>

              {span.status === "running" ? (
                <span className="scanning relative h-[2px] w-10 overflow-hidden rounded-full bg-line" />
              ) : (
                span.ms != null && (
                  <span className="mono shrink-0 text-micro text-fg-3">{span.ms}ms</span>
                )
              )}
            </div>

            {/* Latency, relative to the slowest stage in this run. */}
            {span.ms != null && span.status !== "running" && (
              <div className="mt-1 ml-[6rem] h-[2px] overflow-hidden rounded-full bg-white/6">
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-500",
                    span.status === "error" ? "bg-alert" : "bg-line",
                  )}
                  style={{ width: `${Math.max(2, (span.ms / slowest) * 100)}%` }}
                />
              </div>
            )}

            {(span.metrics || span.detail) && (
              <div className="mono mt-1 ml-[6rem] flex flex-wrap gap-x-3 gap-y-0.5 text-micro text-fg-3">
                {span.metrics &&
                  Object.entries(span.metrics).map(([key, value]) => (
                    <span key={key}>
                      {key} <span className="text-fg-2">{value}</span>
                    </span>
                  ))}
                {span.detail && (
                  <span className={cn("truncate", span.status === "error" && "text-alert")}>
                    {span.detail}
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Legend for the two retrieval channels. Shown once, in the instrument header. */
export function ChannelLegend() {
  return (
    <div className="mono flex items-center gap-3 text-micro text-fg-3">
      <span className="flex items-center gap-1.5">
        <span className="h-[3px] w-4 rounded-full bg-jade" />
        vector
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-[3px] w-4 rounded-full bg-amber" />
        lexical
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-[3px] w-4 rounded-full bg-fused" />
        reranked
      </span>
    </div>
  );
}
