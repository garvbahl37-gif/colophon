"use client";

import { useState } from "react";
import { claimsIn } from "@/lib/util/citations";
import { plainText } from "@/lib/util/plain-text";
import type { Citation } from "@/lib/retrieval/types";

/**
 * Which claim rests on which source.
 *
 * The citation list answers "what was used". It cannot answer the two questions
 * that actually tell you whether to trust an answer: is any sentence resting on
 * nothing, and is one passage carrying the whole thing. Both are invisible in
 * prose — a paragraph with [2] after every clause looks as well-supported as one
 * drawing on four independent passages, and an uncited sentence reads exactly
 * like a cited one.
 *
 * Built by parsing the markers, not by asking a model. It is a fact about the
 * text, it is free, and it cannot itself hallucinate — which matters for a view
 * whose entire job is to be checkable.
 */
export function Coverage({
  answer,
  citations,
  onCite,
}: {
  answer: string;
  citations: Citation[];
  onCite?: (marker: number) => void;
}) {
  const [open, setOpen] = useState(false);

  const markers = citations.map((c) => c.marker);
  if (markers.length === 0) return null;

  const claims = claimsIn(answer, Math.max(...markers));
  if (claims.length === 0) return null;

  const uncited = claims.filter((c) => c.markers.length === 0).length;

  // How many claims each source carries. A single source at the top of this is
  // the shape of an answer that only looked well-sourced.
  const load = new Map<number, number>();
  for (const claim of claims) for (const m of claim.markers) load.set(m, (load.get(m) ?? 0) + 1);
  const heaviest = [...load.entries()].sort((a, b) => b[1] - a[1])[0];
  const concentration = heaviest ? heaviest[1] / claims.length : 0;

  return (
    <div className="border-t border-hairline pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mono flex w-full items-center gap-2 text-micro text-fg-3 transition-colors hover:text-fg"
      >
        <span className="text-line-lit">{open ? "−" : "+"}</span>
        coverage
        <span className="text-fg-3/70">
          {claims.length - uncited}/{claims.length} claims cited
        </span>
        {uncited > 0 && <span className="text-amber">{uncited} resting on nothing</span>}
        {concentration >= 0.8 && claims.length > 2 && (
          <span className="text-amber">[{heaviest[0]}] carries {Math.round(concentration * 100)}%</span>
        )}
      </button>

      {open && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-micro">
            <thead>
              <tr>
                <th className="label py-1 pr-3 text-left font-normal">claim</th>
                {markers.map((m) => (
                  <th key={m} className="px-1 pb-1 text-center font-normal">
                    <button
                      type="button"
                      onClick={() => onCite?.(m)}
                      className="mono text-micro text-brand-3 hover:underline"
                    >
                      {m}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {claims.map((claim, i) => (
                <tr key={i} className="border-t border-hairline align-top">
                  <td
                    className={`max-w-[26rem] py-1.5 pr-3 leading-snug ${
                      claim.markers.length === 0 ? "text-amber" : "text-fg-2"
                    }`}
                  >
                    {/* The answer is Markdown; this cell is a label. Printing
                        the source would put ** and [2] into a table whose
                        entire purpose is to be scanned quickly. */}
                    {(() => {
                      const t = plainText(claim.text.replace(/\[\d{1,3}\]/g, ""));
                      return t.length > 120 ? `${t.slice(0, 120)}…` : t;
                    })()}
                  </td>
                  {markers.map((m) => (
                    <td key={m} className="px-1 py-1.5 text-center">
                      {/* A filled square, not a tick: the column is scanned
                          vertically to spot a source doing all the work. */}
                      <span
                        aria-label={claim.markers.includes(m) ? `cites ${m}` : undefined}
                        className={`inline-block h-2 w-2 ${
                          claim.markers.includes(m) ? "bg-fused" : "bg-line"
                        }`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
