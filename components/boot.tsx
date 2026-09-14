"use client";

import { useEffect, useState } from "react";

/**
 * The boot sequence.
 *
 * This is not a spinner dressed up. Opening the console genuinely does work
 * before it is usable — the ONNX embedder and cross-encoder have to be loaded
 * into memory, and the corpus has to be counted — and on a cold start that is
 * a real wait. So the screen reports the actual steps, in order, and holds
 * until they finish rather than running a fixed-length animation over a blank
 * page.
 *
 * The cinema is in the restraint: one word set enormous, a rule that fills as
 * the work completes, and the steps checking off underneath in mono.
 */

interface Step {
  id: string;
  label: string;
  run: () => Promise<string>;
}

const MIN_MS = 1600; // Long enough to read the wordmark, short enough not to annoy.
const SEEN_KEY = "colophon.booted";

function alreadyBooted(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false; // Private browsing: replay rather than break.
  }
}

function markBooted() {
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* nothing to do */
  }
}

export function Boot({ onDone }: { onDone: () => void }) {
  const [done, setDone] = useState<Record<string, string>>({});
  const [active, setActive] = useState(0);
  const [leaving, setLeaving] = useState(false);

  const steps: Step[] = [
    {
      id: "db",
      label: "connecting to postgres",
      run: async () => {
        const res = await fetch("/api/health");
        const data = await res.json();
        if (!data.ok) throw new Error(data.checks?.database?.detail ?? "unavailable");
        return data.checks.database.detail as string;
      },
    },
    {
      id: "models",
      label: "loading retrieval models",
      run: async () => {
        const res = await fetch("/api/health");
        const data = await res.json();
        const embed = String(data.routing?.embed ?? "").split(" · ").pop();
        return embed ?? "ready";
      },
    },
    {
      id: "corpus",
      label: "reading the corpus",
      run: async () => {
        const res = await fetch("/api/documents");
        const data = await res.json();
        const s = data.stats ?? { documents: 0, chunks: 0 };
        return `${s.documents} documents · ${s.chunks} passages`;
      },
    },
  ];

  useEffect(() => {
    /*
      No `hasStarted` ref guard here, deliberately.

      React runs effects twice on mount in development. With a ref guard the
      first pass starts the sequence and its cleanup cancels it, then the second
      pass sees the guard already set and returns without starting anything —
      so nothing ever completes and this screen hangs forever. The `cancelled`
      flag below is the correct mechanism: each run owns its own flag, so the
      second run proceeds normally while the first unwinds.
    */
    let cancelled = false;
    const openedAt = Date.now();

    // Returning to the console in the same tab should not replay the sequence.
    if (alreadyBooted()) {
      onDone();
      return;
    }

    (async () => {
      for (let i = 0; i < steps.length; i++) {
        if (cancelled) return;
        setActive(i);
        let detail = "ready";
        try {
          detail = await steps[i].run();
        } catch (error) {
          detail = error instanceof Error ? error.message : "failed";
        }
        if (cancelled) return;
        setDone((d) => ({ ...d, [steps[i].id]: detail }));
      }

      // Never flash. If the work finished faster than the eye can follow,
      // hold the screen to the floor before dismissing it.
      const elapsed = Date.now() - openedAt;
      if (elapsed < MIN_MS) await new Promise((r) => setTimeout(r, MIN_MS - elapsed));
      if (cancelled) return;

      markBooted();
      setLeaving(true);
      setTimeout(onDone, 520);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const completed = Object.keys(done).length;
  const progress = completed / steps.length;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Starting Colophon"
      className={`fixed inset-0 z-[100] flex flex-col justify-between bg-bg px-6 py-10 transition-all duration-500 sm:px-12 sm:py-14 ${
        leaving ? "pointer-events-none -translate-y-2 opacity-0" : "opacity-100"
      }`}
    >
      {/* The mark, letter by letter. */}
      <div className="flex flex-1 items-center">
        <h1 className="display text-[clamp(3rem,16vw,13rem)] leading-[0.88]">
          {"COLOPHON".split("").map((ch, i) => (
            <span
              key={i}
              className="boot-letter inline-block"
              style={{ animationDelay: `${i * 52}ms` }}
            >
              {ch}
            </span>
          ))}
        </h1>
      </div>

      <div>
        {/* The rule fills as real work completes, not on a timer. */}
        <div className="relative h-0.5 w-full bg-line">
          <div
            className="absolute inset-y-0 left-0 bg-brand"
            style={{ width: `${progress * 100}%`, transition: "width 420ms cubic-bezier(0.22,1,0.36,1)" }}
          />
        </div>

        <ol className="mt-5 space-y-2">
          {steps.map((step, i) => {
            const finished = done[step.id] != null;
            const running = i === active && !finished;
            return (
              <li
                key={step.id}
                className={`mono flex items-baseline gap-3 text-micro transition-opacity duration-300 ${
                  finished || running ? "opacity-100" : "opacity-30"
                }`}
              >
                <span className={finished ? "text-brand" : "text-fg-3"}>
                  {finished ? "✓" : running ? "▸" : "·"}
                </span>
                <span className={finished ? "text-fg" : "text-fg-2"}>{step.label}</span>
                <span className="min-w-0 flex-1 truncate text-right text-fg-3">
                  {done[step.id] ?? (running ? "…" : "")}
                </span>
              </li>
            );
          })}
        </ol>

        <p className="label mt-6">Hybrid retrieval · cross-encoder reranking · cited answers</p>
      </div>
    </div>
  );
}
