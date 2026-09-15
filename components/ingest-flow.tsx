"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Ingestion, animated.
 *
 * The page already shows what happens when you ask a question. This shows the
 * half that decides whether that question can be answered at all — and it is
 * the half people skip, because it happens once, offline, and invisibly.
 *
 * The stages are staged so each one visibly changes the SAME chunk rather than
 * being described beside it: you watch a passage get split out, watch a written
 * line appear above it, watch that line become part of what is embedded. The
 * contextual step in particular is impossible to argue for in prose and obvious
 * the moment you see "The limit was raised to 30 seconds" acquire a subject.
 *
 * State advances once per stage (five updates over ~14s), not per frame.
 */

const STAGES = [
  {
    id: "parse",
    label: "parse",
    caption:
      "The document is read and normalised. PDFs get their hard line wraps and hyphen splits rejoined, because a chunk reading “authen-\\ntication” tokenises badly and embeds worse.",
  },
  {
    id: "chunk",
    label: "chunk",
    caption:
      "Split on structure first — headings, code fences, tables — and only fall back to sentence packing inside an oversized block. Every chunk keeps the heading trail that says where it sits.",
  },
  {
    id: "context",
    label: "contextualise",
    caption:
      "A model writes one line situating the chunk in its parent document. This is the step that pays for itself: the passage below is unfindable on its own until it acquires a subject.",
  },
  {
    id: "embed",
    label: "embed",
    caption:
      "The situating line and the chunk are embedded together, so the vector carries the context too — not just the orphaned sentence.",
  },
  {
    id: "index",
    label: "index",
    caption:
      "Three indexes, written once: HNSW over the vector, GIN over the stemmed text, and a trigram index for identifiers stemming would destroy.",
  },
] as const;

const RAW = "The limit was raised to 30 seconds in v2.4.0, up from the previous 10.";
const CONTEXT = "From the Timeouts section of Gateway RFC 0042, on the per-attempt request limit:";
const DWELL = 2800;

export function IngestFlow() {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const region = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = region.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // The motion preference is a browser fact; jumping to the final state is
      // the whole behaviour, and it cannot be decided before mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setI(STAGES.length - 1);
      return;
    }

    let visible = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      timer ??= setInterval(() => setI((v) => (v + 1) % STAGES.length), DWELL);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };

    const observer = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        if (visible && playing) start();
        else stop();
      },
      { threshold: 0.3 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      stop();
    };
  }, [playing]);

  const stage = STAGES[i];
  const shown = (id: (typeof STAGES)[number]["id"]) =>
    STAGES.findIndex((s) => s.id === id) <= i;

  return (
    <div ref={region}>
      <div className="rule-heavy flex flex-wrap items-stretch">
        {STAGES.map((s, n) => (
          <button
            key={s.id}
            onClick={() => {
              setI(n);
              setPlaying(false);
            }}
            aria-current={n === i}
            className={`mono relative -mt-px flex-1 border-t-2 px-3 py-3 text-left text-micro transition-colors ${
              n === i ? "border-t-brand text-brand" : "border-t-transparent text-fg-3 hover:text-fg"
            }`}
          >
            <span className="block">{String(n + 1).padStart(2, "0")}</span>
            <span className="mt-0.5 block font-medium">{s.label}</span>
          </button>
        ))}
      </div>

      <p
        aria-live="polite"
        className="mt-6 min-h-[5.5rem] max-w-[58ch] text-small leading-relaxed text-fg-2 sm:min-h-[4.5rem] sm:text-base"
      >
        {stage.caption}
      </p>

      {/* The document, becoming a searchable passage. */}
      <div className="well mt-8 p-5 sm:p-6">
        <div className="mono flex items-center gap-3 text-micro text-fg-3">
          <span>gateway-rfc-0042.pdf</span>
          <span className="h-3 w-px bg-line-lit" />
          <span
            className="transition-opacity duration-500"
            style={{ opacity: shown("chunk") ? 1 : 0.25 }}
          >
            chunk 04 of 06
          </span>
          <span
            aria-hidden={!shown("index")}
            className="ml-auto transition-opacity duration-500"
            style={{ opacity: shown("index") ? 1 : 0 }}
          >
            indexed
          </span>
        </div>

        {/* The situating line, arriving. */}
        <div
          aria-hidden={!shown("context")}
          className="overflow-hidden transition-all duration-700"
          style={{
            maxHeight: shown("context") ? 88 : 0,
            opacity: shown("context") ? 1 : 0,
            marginTop: shown("context") ? 16 : 0,
          }}
        >
          <p
            className={`border-l-2 pl-3 text-small leading-relaxed transition-colors duration-500 ${
              shown("embed") ? "border-brand text-fg" : "border-line-lit text-fg-2"
            }`}
          >
            {CONTEXT}
          </p>
        </div>

        <p
          className={`mt-4 text-small leading-relaxed transition-colors duration-500 sm:text-base ${
            shown("chunk") ? "text-fg" : "text-fg-3"
          }`}
        >
          {RAW}
        </p>

        {/* What actually gets embedded — the brace makes the scope visible. */}
        <div
          aria-hidden={!shown("embed")}
          className="transition-all duration-700"
          style={{ opacity: shown("embed") ? 1 : 0, maxHeight: shown("embed") ? 60 : 0 }}
        >
          <div className="mt-4 flex items-center gap-3">
            <span className="h-px flex-1 bg-brand/40" />
            <span className="mono shrink-0 text-micro text-brand">embedded together</span>
            <span className="h-px flex-1 bg-brand/40" />
          </div>
        </div>

        {/* The three indexes it lands in. */}
        <div
          className="mt-5 grid grid-cols-3 gap-3 transition-opacity duration-700"
          style={{ opacity: shown("index") ? 1 : 0.15 }}
        >
          {[
            { name: "hnsw", sub: "vector", tone: "text-jade" },
            { name: "gin", sub: "stemmed text", tone: "text-amber" },
            { name: "trigram", sub: "identifiers", tone: "text-brand" },
          ].map((ix) => (
            <div key={ix.name} className="border border-line bg-card px-3 py-2.5">
              <p className={`mono text-micro font-medium ${ix.tone}`}>{ix.name}</p>
              <p className="mono mt-0.5 text-[10px] text-fg-3">{ix.sub}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-4">
        <p className="label">
          {shown("context")
            ? "Anthropic measured this cutting retrieval failures by up to 49%."
            : "One document, five stages, once."}
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
