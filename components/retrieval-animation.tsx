"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The retrieval pipeline, animated.
 *
 * The teaching idea: keep ONE set of passages on screen and let each stage
 * reorder it. A diagram with arrows tells you the stages exist; watching
 * "Timeouts" climb from sixth to second the moment the cross-encoder runs tells
 * you what a cross-encoder is *for*. The movement is the explanation, which is
 * why rows translate between positions rather than re-rendering in place.
 *
 * Every number here is real: these are the ranks and scores the live app
 * produces for this question against the sample corpus.
 */

interface Passage {
  id: string;
  title: string;
  doc: string;
  vector: number;
  lexical: number;
  rerank: number;
}

const PASSAGES: Passage[] = [
  { id: "cb", title: "Circuit Breaking", doc: "Gateway RFC 0042", vector: 1, lexical: 2, rerank: 0.994 },
  { id: "to", title: "Timeouts", doc: "Gateway RFC 0042", vector: 4, lexical: 7, rerank: 0.929 },
  { id: "rp", title: "Retry Policy", doc: "Gateway RFC 0042", vector: 3, lexical: 1, rerank: 0.845 },
  { id: "ra", title: "Rejected Alternatives", doc: "Gateway RFC 0042", vector: 5, lexical: 4, rerank: 0.609 },
  { id: "mo", title: "Motivation", doc: "Gateway RFC 0042", vector: 2, lexical: 6, rerank: 0.52 },
  { id: "qrp", title: "Retry Policy", doc: "Queue RFC 0071", vector: 7, lexical: 3, rerank: 0.465 },
  { id: "st", title: "Status", doc: "Gateway RFC 0042", vector: 6, lexical: 9, rerank: 0.111 },
  { id: "vt", title: "Visibility Timeout", doc: "Queue RFC 0071", vector: 8, lexical: 5, rerank: 0.088 },
];

/** Weighted Reciprocal Rank Fusion — the same formula the SQL runs. */
const RRF_K = 60;
const rrf = (p: Passage) => 0.5 / (RRF_K + p.vector) + 0.5 / (RRF_K + p.lexical);

type StageId = "vector" | "lexical" | "fuse" | "rerank" | "answer";

const STAGES: {
  id: StageId;
  label: string;
  caption: string;
}[] = [
  {
    id: "vector",
    label: "vector",
    caption:
      "The dense arm embeds the question and walks the HNSW graph. It finds passages that mean the right thing, even in different words.",
  },
  {
    id: "lexical",
    label: "lexical",
    caption:
      "The lexical arm searches the same passages for the literal terms. Note how differently it orders them — it catches what embeddings blur away.",
  },
  {
    id: "fuse",
    label: "fuse",
    caption:
      "Reciprocal Rank Fusion combines the two orderings by rank position, not by score. A passage both arms liked beats one that only topped a single list.",
  },
  {
    id: "rerank",
    label: "rerank",
    caption:
      "The cross-encoder reads the question and each passage together. Timeouts climbs from sixth to second — no bi-encoder could have found that.",
  },
  {
    id: "answer",
    label: "answer",
    caption:
      "The survivors are packed into the prompt, and each claim in the answer cites the passage it came from.",
  },
];

const ROW_H = 52;
const DWELL = 3400;

function orderFor(stage: StageId): Passage[] {
  switch (stage) {
    case "vector":
      return [...PASSAGES].sort((a, b) => a.vector - b.vector);
    case "lexical":
      return [...PASSAGES].sort((a, b) => a.lexical - b.lexical);
    case "fuse":
      return [...PASSAGES].sort((a, b) => rrf(b) - rrf(a));
    default:
      return [...PASSAGES].sort((a, b) => b.rerank - a.rerank);
  }
}

export function RetrievalAnimation() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const region = useRef<HTMLDivElement>(null);

  const stage = STAGES[index];

  // Only run while on screen. An animation looping in a background tab is
  // wasted battery and, on a long page, wasted attention.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = region.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.35,
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !visible) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setTimeout(() => setIndex((i) => (i + 1) % STAGES.length), DWELL);
    return () => clearTimeout(timer);
  }, [index, playing, visible]);

  const positions = useMemo(() => {
    const order = orderFor(stage.id);
    return new Map(order.map((p, i) => [p.id, i]));
  }, [stage.id]);

  const showVector = stage.id !== "lexical";
  const showLexical = stage.id !== "vector";
  const scored = stage.id === "rerank" || stage.id === "answer";
  const survivors = stage.id === "answer" ? 4 : stage.id === "rerank" ? 6 : PASSAGES.length;

  return (
    <div ref={region}>
      {/* Stage selector — also the legend for what is happening. */}
      <div className="rule-heavy flex flex-wrap items-stretch">
        {STAGES.map((s, i) => (
          <button
            key={s.id}
            onClick={() => {
              setIndex(i);
              setPlaying(false);
            }}
            aria-current={i === index}
            className={`mono relative -mt-px flex-1 border-t-2 px-3 py-3 text-left text-micro transition-colors ${
              i === index
                ? "border-t-brand text-brand"
                : "border-t-transparent text-fg-3 hover:text-fg"
            }`}
          >
            <span className="block">{String(i + 1).padStart(2, "0")}</span>
            <span className="mt-0.5 block font-medium">{s.label}</span>
          </button>
        ))}
      </div>

      {/* Caption. aria-live so the explanation reaches screen readers, which
          cannot see rows move. */}
      <p
        aria-live="polite"
        className="mt-6 min-h-[4.5rem] max-w-[58ch] text-small leading-relaxed text-fg-2 sm:min-h-[3.5rem] sm:text-base"
      >
        {stage.caption}
      </p>

      {/* Column headers */}
      <div className="mono mt-8 flex items-baseline gap-4 border-b border-line pb-2 text-micro text-fg-3">
        <span className="w-6 shrink-0">#</span>
        <span className="flex-1">passage</span>
        <span className={`w-16 shrink-0 text-right transition-opacity ${showVector ? "opacity-100" : "opacity-25"}`}>
          vector
        </span>
        <span className={`w-16 shrink-0 text-right transition-opacity ${showLexical ? "opacity-100" : "opacity-25"}`}>
          lexical
        </span>
        <span className={`w-14 shrink-0 text-right transition-opacity ${scored ? "opacity-100" : "opacity-25"}`}>
          score
        </span>
      </div>

      {/* The list. Rows are absolutely placed and translated to their slot, so
          a change of order animates as movement rather than a repaint. */}
      <ol className="relative" style={{ height: PASSAGES.length * ROW_H }}>
        {PASSAGES.map((p) => {
          const slot = positions.get(p.id) ?? 0;
          const dropped = slot >= survivors;
          const cited = stage.id === "answer" && slot < 3;

          return (
            <li
              key={p.id}
              className="absolute inset-x-0 flex items-center gap-4 border-b border-line"
              style={{
                height: ROW_H,
                transform: `translateY(${slot * ROW_H}px)`,
                transition: "transform 620ms cubic-bezier(0.22, 1, 0.36, 1), opacity 400ms linear",
                opacity: dropped ? 0.22 : 1,
              }}
            >
              <span className="mono w-6 shrink-0 text-micro text-fg-3">
                {cited ? (
                  <span className="inline-flex h-5 w-5 items-center justify-center bg-brand text-[11px] font-medium text-white">
                    {slot + 1}
                  </span>
                ) : (
                  String(slot + 1).padStart(2, "0")
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate text-small font-semibold">{p.title}</span>
                <span className="label block truncate">{p.doc}</span>
              </span>

              <Arm rank={p.vector} tone="jade" dim={!showVector} />
              <Arm rank={p.lexical} tone="amber" dim={!showLexical} />

              <span
                className={`mono w-14 shrink-0 text-right text-micro transition-opacity ${
                  scored ? "opacity-100" : "opacity-25"
                }`}
              >
                {scored ? p.rerank.toFixed(3) : rrf(p).toFixed(4)}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="mt-5 flex items-center justify-between gap-4">
        <p className="label">
          {stage.id === "rerank"
            ? "Two passages fall below the relevance floor and are dropped."
            : stage.id === "answer"
              ? "Four passages reach the prompt. Three are cited."
              : "Eight candidates, reordered by each stage."}
        </p>
        <button
          onClick={() => setPlaying((v) => !v)}
          className="mono text-micro text-fg-3 transition-colors hover:text-brand"
        >
          {playing ? "Pause" : "Play"}
        </button>
      </div>
    </div>
  );
}

/** One arm's rank badge. Dimmed when that arm has not run yet. */
function Arm({ rank, tone, dim }: { rank: number; tone: "jade" | "amber"; dim: boolean }) {
  return (
    <span
      className={`mono w-16 shrink-0 text-right text-micro transition-opacity ${
        dim ? "opacity-20" : "opacity-100"
      } ${tone === "jade" ? "text-jade" : "text-amber"}`}
    >
      #{rank}
    </span>
  );
}
