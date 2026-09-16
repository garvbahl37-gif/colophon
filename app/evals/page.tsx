import { readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";

/**
 * The evaluation dashboard.
 *
 * These numbers existed before this page did, printed once to a terminal and
 * then gone — which is how the suite spent a release reporting that every
 * configuration scored identically without that ever becoming a decision. A
 * result only counts as measured if someone can trip over it.
 *
 * Rendered from the artifact `pnpm eval` writes, at build time. No database, no
 * per-owner anything: these are measurements of the sample corpus, identical
 * for every visitor, and the page is honest about being a snapshot rather than
 * pretending to be live.
 *
 * It leads with the comparison that can embarrass the project. A dashboard that
 * can only show its author winning is decoration.
 */

interface CaseResult {
  id: string;
  question: string;
  firstHit: number | null;
  ndcg: number;
  ms: number;
  top: { title: string; heading: string; score: number }[];
}

interface Variant {
  name: string;
  shipped: boolean;
  scores: { hitAt1: number; hitRate: number; mrr: number; ndcg: number; ms: number };
  misses: string[];
  cases: CaseResult[];
}

interface Results {
  generatedAt: string;
  k: number;
  chunks: number;
  questions: number;
  models: { embed: string; rerank: string };
  variants: Variant[];
}

function load(): Results | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "evals/results.json"), "utf8")) as Results;
  } catch {
    return null;
  }
}

export const metadata = {
  title: "Colophon — evaluation",
  description: "What the retrieval pipeline actually measures against its own baselines.",
};

export default function EvalsPage() {
  const data = load();

  if (!data) {
    return (
      <main className="shell-app min-h-dvh bg-bg px-6 py-16 sm:px-12">
        <div className="mx-auto max-w-[60rem]">
          <p className="label">Evaluation</p>
          <h1 className="mt-3 text-h2 font-extrabold tracking-[-0.03em] text-fg">
            No results recorded.
          </h1>
          <p className="mt-4 max-w-[54ch] text-base leading-relaxed text-fg-2">
            Run <code className="mono text-small">pnpm eval</code> to produce them.
          </p>
        </div>
      </main>
    );
  }

  const baseline = data.variants.find((v) => v.name === "vector only");
  const shipped = data.variants.find((v) => v.shipped);
  const lift =
    baseline && shipped
      ? ((shipped.scores.ndcg - baseline.scores.ndcg) / (baseline.scores.ndcg || 1)) * 100
      : 0;
  const best = data.variants.reduce((a, b) => (b.scores.ndcg > a.scores.ndcg ? b : a));

  // Cases the shipped configuration ranks worse than the best configuration
  // does. These are the ones worth reading, and the reason for a per-case view.
  const regressions = shipped && best !== shipped
    ? shipped.cases
        .map((c, i) => ({ c, other: best.cases[i] }))
        .filter(({ c, other }) => other && other.ndcg - c.ndcg > 0.01)
    : [];

  return (
    <main className="shell-app min-h-dvh bg-bg">
      <header className="flex h-16 items-center gap-4 border-b border-line bg-card px-6">
        <Link href="/" className="text-lead font-extrabold tracking-[-0.045em] text-fg">
          COLOPHON
        </Link>
        <span aria-hidden className="h-5 w-px bg-line" />
        <span className="label">Evaluation</span>
        <div className="flex-1" />
        <Link href="/app" className="btn btn-ghost btn-sm">
          Open console
        </Link>
      </header>

      <div className="mx-auto max-w-[64rem] px-6 py-12">
        <h1 className="max-w-[24ch] text-h2 leading-[1.06] font-extrabold tracking-[-0.03em] text-fg">
          What the pipeline actually measures.
        </h1>
        <p className="mt-4 max-w-[58ch] text-base leading-relaxed text-fg-2">
          The same {data.questions} questions run through five configurations against the same{" "}
          {data.chunks} passages. The point is to make the architecture a measurement rather than a
          preference — including when the measurement is unflattering.
        </p>

        <dl className="mono mt-6 flex flex-wrap gap-x-6 gap-y-1 text-micro text-fg-3">
          <div className="flex gap-1.5">
            <dt>k</dt>
            <dd className="text-fg">{data.k}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>embed</dt>
            <dd className="text-fg">{data.models.embed}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>rerank</dt>
            <dd className="text-fg">{data.models.rerank}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>recorded</dt>
            <dd className="text-fg">{new Date(data.generatedAt).toISOString().slice(0, 16).replace("T", " ")}</dd>
          </div>
        </dl>

        {/* The headline, stated whichever way it falls. */}
        <div
          className={`mt-8 border px-5 py-4 ${
            lift >= 0 ? "border-jade/40 bg-jade/5" : "border-amber/40 bg-amber/5"
          }`}
        >
          <p className="text-base leading-relaxed text-fg">
            The shipped configuration scores{" "}
            <strong className={lift >= 0 ? "text-jade" : "text-amber"}>
              {lift >= 0 ? "+" : ""}
              {lift.toFixed(1)}% nDCG
            </strong>{" "}
            against vector-only
            {shipped && baseline && (
              <>
                , for {Math.round(shipped.scores.ms - baseline.scores.ms)}ms more per query
              </>
            )}
            .
          </p>
          {lift < 0 && (
            <p className="mt-2 max-w-[62ch] text-small leading-relaxed text-fg-2">
              That is the honest reading and it is left in place. On a corpus this size the
              baseline is hard to beat: {data.chunks} passages at k={data.k} means a third of a
              relevant document is returned by almost anything. The number that would settle it is
              the same suite over a corpus large enough for a wrong answer to be available.
            </p>
          )}
        </div>

        <h2 className="mt-14 text-h3 font-extrabold tracking-[-0.02em] text-fg">Configurations</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-small">
            <thead>
              <tr className="border-b-2 border-rule text-left">
                <th className="label py-2 pr-4 font-normal">configuration</th>
                <th className="label py-2 pr-4 text-right font-normal">hit@1</th>
                <th className="label py-2 pr-4 text-right font-normal">hit@{data.k}</th>
                <th className="label py-2 pr-4 text-right font-normal">MRR</th>
                <th className="label py-2 pr-4 text-right font-normal">nDCG@{data.k}</th>
                <th className="label py-2 pr-4 text-right font-normal">ms</th>
                <th className="label py-2 font-normal">quality</th>
              </tr>
            </thead>
            <tbody>
              {data.variants.map((v) => (
                <tr key={v.name} className="border-b border-hairline">
                  <td className="py-2.5 pr-4">
                    <span className={v.shipped ? "font-bold text-fg" : "text-fg-2"}>{v.name}</span>
                    {v.shipped && <span className="mono ml-2 text-micro text-brand">shipped</span>}
                    {v === best && !v.shipped && (
                      <span className="mono ml-2 text-micro text-jade">best</span>
                    )}
                  </td>
                  <td className="mono py-2.5 pr-4 text-right text-fg">{v.scores.hitAt1.toFixed(2)}</td>
                  <td className="mono py-2.5 pr-4 text-right text-fg-2">{v.scores.hitRate.toFixed(2)}</td>
                  <td className="mono py-2.5 pr-4 text-right text-fg-2">{v.scores.mrr.toFixed(3)}</td>
                  <td className="mono py-2.5 pr-4 text-right font-bold text-fg">{v.scores.ndcg.toFixed(3)}</td>
                  <td className="mono py-2.5 pr-4 text-right text-fg-3">{Math.round(v.scores.ms)}</td>
                  <td className="py-2.5">
                    <div className="h-1.5 w-full max-w-[9rem] bg-line">
                      <div
                        className={v === best ? "h-full bg-jade" : "h-full bg-fg-3"}
                        style={{ width: `${Math.round(v.scores.ndcg * 100)}%` }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {regressions.length > 0 && (
          <>
            <h2 className="mt-14 text-h3 font-extrabold tracking-[-0.02em] text-fg">
              Where the shipped pipeline loses
            </h2>
            <p className="mt-3 max-w-[58ch] text-small leading-relaxed text-fg-2">
              {regressions.length} of {data.questions} questions rank worse under the shipped
              configuration than under {best.name}. An aggregate that hides these is a scoreboard,
              not an evaluation.
            </p>
            <ul className="mt-5 border-t border-line">
              {regressions.map(({ c, other }) => (
                <li key={c.id} className="border-b border-hairline py-3.5">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="mono text-micro text-brand-3">{c.id}</span>
                    <span className="min-w-0 flex-1 text-small text-fg">{c.question}</span>
                    <span className="mono text-micro text-fg-3">
                      {other.ndcg.toFixed(2)} → <span className="text-amber">{c.ndcg.toFixed(2)}</span>
                    </span>
                  </div>
                  <p className="mono mt-1.5 text-micro leading-relaxed text-fg-3">
                    returned:{" "}
                    {c.top.map((t, i) => (
                      <span key={i}>
                        {i > 0 && " · "}
                        {t.heading || t.title}
                      </span>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}

        {shipped && shipped.misses.length > 0 && (
          <>
            <h2 className="mt-14 text-h3 font-extrabold tracking-[-0.02em] text-fg">
              Found nothing relevant
            </h2>
            <p className="mt-3 max-w-[58ch] text-small leading-relaxed text-fg-2">
              No passage from a section that genuinely answers these appeared in the top{" "}
              {data.k}. These are the cases worth reading a trace for.
            </p>
            <ul className="mono mt-4 space-y-1 text-small text-amber">
              {shipped.misses.map((id) => {
                const c = shipped.cases.find((x) => x.id === id);
                return (
                  <li key={id}>
                    {id}
                    {c && <span className="ml-3 text-fg-3">{c.question}</span>}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <p className="mt-16 max-w-[62ch] border-t border-line pt-6 text-micro leading-relaxed text-fg-3">
          A snapshot, not a live reading: regenerated by <code className="mono">pnpm eval</code> and
          committed with the code it measures, so a change to retrieval and the numbers it produced
          arrive in the same diff.
        </p>
      </div>
    </main>
  );
}
