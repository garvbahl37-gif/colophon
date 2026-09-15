"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The hero mockup, running.
 *
 * Driven entirely by CSS keyframes on a shared 8.2s loop, not by React state.
 * The first version ran a requestAnimationFrame loop that called setState on
 * every frame, re-rendering forty-odd nodes sixty times a second for an effect
 * the compositor can do on its own — which is exactly what made the page feel
 * heavy. Now nothing here re-renders at all: each element carries an
 * animation-delay marking its place in the sequence, and the browser animates
 * opacity and transform off the main thread.
 *
 * The one genuinely stateful part, the typing, is isolated in its own
 * component so its updates cannot touch anything else.
 *
 * Every number is real output from the sample corpus.
 */

const STAGES = [
  { id: "retrieve", label: "hybrid search", ms: "94ms", delay: 0.3 },
  { id: "rerank", label: "cross-encoder", ms: "105ms", delay: 0.9 },
  { id: "generate", label: "gpt-oss:120b", ms: "2.6s", delay: 1.5 },
  { id: "verify", label: "groundedness", ms: "1.2s", delay: 4.8 },
];

const PASSAGES = [
  { n: 1, title: "Circuit Breaking", score: 0.994, dense: 72, lex: 28, delay: 0.98 },
  { n: 2, title: "Retry Policy", score: 0.929, dense: 55, lex: 45, delay: 1.12 },
  { n: 3, title: "Timeouts", score: 0.845, dense: 80, lex: 20, delay: 1.26 },
  { n: 4, title: "Rejected Alternatives", score: 0.609, dense: 40, lex: 60, delay: 1.4 },
];

const ANSWER =
  "Retry backoff is exponential with full jitter, drawn from 0…min(30s, 100ms × 2ⁿ)[1], capped at five attempts. The circuit breaker is unrelated: it opens after 20 consecutive failures in 10 seconds and stays open for 5 seconds[2].";

export function ProductMock() {
  return (
    <div className="mock border-2 border-rule bg-bg">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <span className="mono text-micro font-medium text-fg">COLOPHON</span>
        <span className="h-3 w-px bg-line-lit" />
        <span className="mono truncate text-micro text-fg-3">
          gateway-rfc-0042.md, queue-rfc-0071.md, search-ops.md
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="mock-busy h-1.5 w-1.5 bg-brand" />
          <span className="mono hidden text-micro text-fg-3 sm:inline">working</span>
        </span>
      </div>

      <div className="grid gap-0 md:grid-cols-[1fr_300px]">
        <div className="min-w-0 p-6 sm:p-8">
          <p className="text-base font-bold text-fg sm:text-lead">
            How does the retry backoff differ from the circuit breaker timing?
          </p>

          <div className="well mt-4 divide-y divide-hairline">
            {STAGES.map((row) => (
              <div
                key={row.id}
                className="mock-step flex items-center gap-3 px-3 py-2"
                style={{ animationDelay: `${row.delay}s` }}
              >
                <span className="mono w-16 shrink-0 text-micro text-fg">{row.id}</span>
                <span className="min-w-0 flex-1 truncate text-micro text-fg-2">{row.label}</span>
                <span className="mono shrink-0 text-micro text-fg-3">{row.ms}</span>
              </div>
            ))}
          </div>

          <div className="mt-4 min-h-[6rem] text-small leading-relaxed text-fg-2">
            <TypedAnswer />
          </div>

          <div className="mock-verdict mt-3 flex items-center gap-2">
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
            {PASSAGES.map((p) => (
              <li key={p.n} className="mock-step" style={{ animationDelay: `${p.delay}s` }}>
                <div className="flex items-baseline gap-2">
                  <span className="mono shrink-0 text-micro text-brand">[{p.n}]</span>
                  <span className="min-w-0 flex-1 truncate text-micro text-fg-2">{p.title}</span>
                  <span className="mono shrink-0 text-micro text-fg">{p.score.toFixed(3)}</span>
                </div>

                {/* Bars scale on the compositor rather than animating width,
                    which would force layout on every frame. */}
                <div className="mt-1.5 h-[3px] overflow-hidden bg-line">
                  <div
                    className="mock-bar h-full origin-left bg-fused"
                    style={{ width: `${p.score * 100}%`, animationDelay: `${p.delay + 0.1}s` }}
                  />
                </div>
                <div className="mt-1 flex h-[3px] overflow-hidden bg-line">
                  <div
                    className="mock-bar h-full origin-left bg-jade"
                    style={{ width: `${p.dense}%`, animationDelay: `${p.delay + 0.18}s` }}
                  />
                  <div
                    className="mock-bar h-full origin-left bg-amber"
                    style={{ width: `${p.lex}%`, animationDelay: `${p.delay + 0.18}s` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * The typing effect, isolated.
 *
 * Owns its own state so its 25fps updates re-render one paragraph instead of
 * the whole mockup, and pauses entirely when the section is off screen.
 */
function TypedAnswer() {
  const [n, setN] = useState(0);
  const host = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const node = host.current;
    if (!node) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Same: show the finished state rather than typing it out. Only knowable
      // in the browser, so it necessarily happens after the first render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setN(ANSWER.length);
      return;
    }

    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      timer ??= setInterval(() => {
        setN((v) => (v >= ANSWER.length ? 0 : Math.min(ANSWER.length, v + 7)));
      }, 40);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };

    const observer = new IntersectionObserver(
      ([e]) => (e.isIntersecting ? start() : stop()),
      { threshold: 0.2 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      stop();
    };
  }, []);

  const text = ANSWER.slice(0, n);
  const typing = n > 0 && n < ANSWER.length;

  return (
    <p ref={host}>
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
      {typing && <span className="caret" aria-hidden />}
    </p>
  );
}
