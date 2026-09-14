"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The hero mockup, running.
 *
 * A static screenshot of a retrieval tool shows you a finished answer, which is
 * the least interesting moment. This plays the actual sequence — stages
 * resolving with their real latencies, passages arriving and their score bars
 * growing, the answer typing in, citations landing as chips — so what a visitor
 * watches is the machine working rather than a picture of it afterwards.
 *
 * Every number is real output from the sample corpus. It pauses when scrolled
 * out of view and holds the finished state under prefers-reduced-motion.
 */

const STAGES = [
  { id: "retrieve", label: "hybrid search", ms: 94, at: 300 },
  { id: "rerank", label: "cross-encoder", ms: 105, at: 900 },
  { id: "generate", label: "gpt-oss:120b", ms: 2640, at: 1500 },
  { id: "verify", label: "groundedness", ms: 1180, at: 4800 },
];

const PASSAGES = [
  { n: 1, title: "Circuit Breaking", score: 0.994, dense: 72, lex: 28, at: 980 },
  { n: 2, title: "Retry Policy", score: 0.929, dense: 55, lex: 45, at: 1120 },
  { n: 3, title: "Timeouts", score: 0.845, dense: 80, lex: 20, at: 1260 },
  { n: 4, title: "Rejected Alternatives", score: 0.609, dense: 40, lex: 60, at: 1400 },
];

const ANSWER =
  "Retry backoff is exponential with full jitter, drawn from 0…min(30s, 100ms × 2ⁿ)[1], capped at five attempts. The circuit breaker is unrelated: it opens after 20 consecutive failures in 10 seconds and stays open for 5 seconds[2].";

const TYPE_START = 1900;
const TYPE_MS = 13;
const TOTAL = 8200;

export function ProductMock() {
  const [t, setT] = useState(0);
  const region = useRef<HTMLDivElement>(null);
  const raf = useRef(0);

  useEffect(() => {
    const node = region.current;
    if (!node) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setT(TOTAL);
      return;
    }

    let running = false;
    let startedAt = 0;

    const tick = (now: number) => {
      if (!startedAt) startedAt = now;
      setT((now - startedAt) % TOTAL);
      raf.current = requestAnimationFrame(tick);
    };

    // An animation looping in a scrolled-past section is wasted battery.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !running) {
          running = true;
          startedAt = 0;
          raf.current = requestAnimationFrame(tick);
        } else if (!entry.isIntersecting && running) {
          running = false;
          cancelAnimationFrame(raf.current);
        }
      },
      { threshold: 0.2 },
    );

    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf.current);
    };
  }, []);

  const typed = Math.max(0, Math.floor((t - TYPE_START) / TYPE_MS));
  const typing = t > TYPE_START && typed < ANSWER.length;
  const answered = typed >= ANSWER.length;

  return (
    <div ref={region} className="border-2 border-rule bg-bg">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <span className="mono text-micro font-medium text-fg">COLOPHON</span>
        <span className="h-3 w-px bg-line-lit" />
        <span className="mono truncate text-micro text-fg-3">
          gateway-rfc-0042.md, queue-rfc-0071.md, search-ops.md
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 bg-brand transition-opacity duration-500"
            style={{ opacity: answered ? 0.2 : 1 }}
          />
          <span className="mono hidden text-micro text-fg-3 sm:inline">
            {answered ? "idle" : "working"}
          </span>
        </span>
      </div>

      <div className="grid gap-0 md:grid-cols-[1fr_300px]">
        <div className="min-w-0 p-6 sm:p-8">
          <p className="text-base font-bold text-fg sm:text-lead">
            How does the retry backoff differ from the circuit breaker timing?
          </p>

          <div className="well mt-4 divide-y divide-hairline">
            {STAGES.map((row) => {
              const spin = Math.min(row.ms, 850);
              const running = t >= row.at && t < row.at + spin;
              const complete = t >= row.at + spin;
              return (
                <div
                  key={row.id}
                  className="flex items-center gap-3 px-3 py-2 transition-opacity duration-300"
                  style={{ opacity: t >= row.at ? 1 : 0.25 }}
                >
                  <span className="mono w-16 shrink-0 text-micro text-fg">{row.id}</span>
                  <span className="min-w-0 flex-1 truncate text-micro text-fg-2">{row.label}</span>
                  {running ? (
                    <span className="scanning relative h-[2px] w-10 shrink-0 overflow-hidden bg-line" />
                  ) : (
                    <span className="mono shrink-0 text-micro text-fg-3">
                      {complete
                        ? row.ms >= 1000
                          ? `${(row.ms / 1000).toFixed(1)}s`
                          : `${row.ms}ms`
                        : ""}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-4 min-h-[6rem] text-small leading-relaxed text-fg-2">
            <Typed text={ANSWER.slice(0, typed)} />
            {typing && <span className="caret" aria-hidden />}
          </div>

          <div
            className="mt-3 flex items-center gap-2 transition-opacity duration-500"
            style={{ opacity: answered ? 1 : 0 }}
          >
            <span className="h-1.5 w-1.5 bg-jade" />
            <span className="mono text-micro text-fg-3">Every claim traces to a source</span>
          </div>
        </div>

        <div className="border-t border-line p-5 md:border-t-0 md:border-l">
          <div className="mono mb-3 flex items-center gap-3 text-micro text-fg-3">
            <span className="flex items-center gap-1.5">
              <span className="h-[3px] w-4 bg-jade" />
              vector
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-[3px] w-4 bg-amber" />
              lexical
            </span>
          </div>

          <ul className="space-y-3">
            {PASSAGES.map((p) => {
              const shown = t >= p.at;
              return (
                <li
                  key={p.n}
                  className="transition-all duration-500"
                  style={{ opacity: shown ? 1 : 0, transform: shown ? "none" : "translateY(6px)" }}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="mono shrink-0 text-micro text-brand">[{p.n}]</span>
                    <span className="min-w-0 flex-1 truncate text-micro text-fg-2">{p.title}</span>
                    <span className="mono shrink-0 text-micro text-fg">{p.score.toFixed(3)}</span>
                  </div>

                  {/* Bars grow into place rather than appearing pre-filled. */}
                  <div className="mt-1.5 h-[3px] overflow-hidden bg-line">
                    <div
                      className="h-full bg-fused"
                      style={{
                        width: shown ? `${p.score * 100}%` : "0%",
                        transition: "width 700ms cubic-bezier(0.22,1,0.36,1)",
                      }}
                    />
                  </div>
                  <div className="mt-1 flex h-[3px] overflow-hidden bg-line">
                    <div
                      className="h-full bg-jade"
                      style={{
                        width: shown ? `${p.dense}%` : "0%",
                        transition: "width 700ms 80ms cubic-bezier(0.22,1,0.36,1)",
                      }}
                    />
                    <div
                      className="h-full bg-amber"
                      style={{
                        width: shown ? `${p.lex}%` : "0%",
                        transition: "width 700ms 80ms cubic-bezier(0.22,1,0.36,1)",
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Renders the typed answer, turning [n] markers into citation chips as they land. */
function Typed({ text }: { text: string }) {
  return (
    <p>
      {text.split(/(\[\d\])/g).map((part, i) => {
        const m = part.match(/^\[(\d)\]$/);
        if (!m) return <span key={i}>{part}</span>;
        return (
          <span
            key={i}
            className="mono mx-[2px] inline-flex h-[16px] min-w-[16px] items-center justify-center bg-brand/15 px-1 text-[10px] leading-none text-brand"
          >
            {m[1]}
          </span>
        );
      })}
    </p>
  );
}
