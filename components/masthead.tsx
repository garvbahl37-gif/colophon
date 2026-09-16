"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The masthead.
 *
 * "Premium" here is earned by telling the reader things they actually want to
 * know, not by blurring the background. It reports where you are in the
 * document (active section), how far through it you are (the progress rule),
 * and it gets out of the way once you start reading (it condenses on scroll).
 *
 * Deliberately not a floating glass pill: that is the default treatment on
 * every AI-built landing page, and it reports nothing.
 */

const SECTIONS = [
  { id: "ingest", label: "Ingest" },
  { id: "hybrid", label: "Retrieve" },
  { id: "pipeline", label: "Pipeline" },
  { id: "agent", label: "Agent" },
  { id: "stack", label: "Architecture" },
];

export function Masthead() {
  const [progress, setProgress] = useState(0);
  const [condensed, setCondensed] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        setProgress(max > 0 ? Math.min(1, window.scrollY / max) : 0);
        setCondensed(window.scrollY > 120);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const nodes = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (n): n is HTMLElement => n != null,
    );
    if (nodes.length === 0) return;

    // Track the section occupying the upper third of the viewport — the part a
    // reader is actually looking at, not whatever is technically on screen.
    const observer = new IntersectionObserver(
      (entries) => {
        const onscreen = entries.filter((e) => e.isIntersecting);
        if (onscreen.length > 0) {
          setActive(onscreen.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0].target.id);
        }
      },
      { rootMargin: "-72px 0px -66% 0px", threshold: 0 },
    );

    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg">
      <div
        className={`mx-auto flex max-w-[1400px] items-center justify-between px-6 transition-[padding] duration-300 sm:px-10 ${
          condensed ? "py-2.5" : "py-4"
        }`}
      >
        <Link href="/" className="group flex items-baseline gap-3" aria-label="Colophon home">
          <span className="text-lead font-extrabold tracking-[-0.04em] transition-colors group-hover:text-brand">
            COLOPHON
          </span>
          <span
            className={`label hidden transition-opacity duration-300 sm:inline ${
              condensed ? "opacity-0" : "opacity-100"
            }`}
          >
            retrieval, audited
          </span>
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              aria-current={active === s.id ? "true" : undefined}
              className="group relative hidden px-3 py-1.5 text-small transition-colors md:block"
            >
              <span className={active === s.id ? "font-semibold text-fg" : "text-fg-2 group-hover:text-fg"}>
                {s.label}
              </span>
              {/* The rule under the active item slides between sections rather
                  than blinking on and off. */}
              <span
                className={`absolute inset-x-3 -bottom-px h-0.5 origin-left bg-brand transition-transform duration-300 ${
                  active === s.id ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"
                }`}
              />
            </a>
          ))}

          {/* A separate page rather than an anchor: it is a different kind of
              claim from the rest of the page, and it is the one that can be
              checked. */}
          <Link
            href="/evals"
            className="mono hidden text-micro text-fg-3 transition-colors hover:text-brand lg:block"
          >
            Evaluation
          </Link>

          <Link href="/app" className="btn btn-primary ml-2 px-4 py-2 text-small">
            Open Colophon
          </Link>
        </nav>
      </div>

      {/* Reading progress. One hairline, the accent colour, no chrome. */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-brand"
        style={{ transform: `scaleX(${progress})`, transition: "transform 120ms linear" }}
      />
    </header>
  );
}
