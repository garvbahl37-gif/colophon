import Link from "next/link";
import { Masthead } from "@/components/masthead";
import { RetrievalAnimation } from "@/components/retrieval-animation";
import { ProductMock } from "@/components/product-mock";

export default function Landing() {
  return (
    <div className="min-h-dvh">
      <Masthead />

      {/* ── 00 Hero ───────────────────────────────────────────────────────────
          Asymmetric by design: the statement takes columns 1-9, the abstract
          sits in 10-12 and aligns to the same baseline grid. */}
      <section className="mx-auto max-w-[1400px] px-6 pt-16 pb-20 sm:px-10 sm:pt-24">
        <div className="grid12 items-end">
          <h1 className="display display-xl col-span-6 md:col-span-9">
            Retrieval you can <span className="text-brand">actually audit</span>
          </h1>

          <div className="col-span-6 mt-10 md:col-span-3 md:mt-0">
            <p className="rule-heavy pt-4 text-small leading-relaxed text-fg-2">
              Colophon searches by meaning and by exact wording at once, reranks with a
              cross-encoder, and shows the passage behind every sentence it writes.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Link href="/app" className="btn btn-primary px-5 py-2.5 text-small">
                Open Colophon
              </Link>
              <a href="#pipeline" className="btn btn-ghost px-5 py-2.5 text-small">
                Read the pipeline
              </a>
            </div>
          </div>
        </div>

        {/* Specification strip — numbers on the grid, separated by rules, not boxed. */}
        <dl className="grid12 rule-heavy mt-16 gap-y-10 pt-6">
          <Spec col="col-span-3" n="2" t="retrieval arms" d="fused in one SQL statement" />
          <Spec col="col-span-3" n="7" t="pipeline stages" d="traced on every answer" />
          <Spec col="col-span-3" n="49%" t="fewer misses" d="from contextual chunking" />
          <Spec col="col-span-3" n="1" t="API key" d="retrieval runs locally" />
        </dl>
      </section>

      {/* ── Product ───────────────────────────────────────────────────────────
          The one dark object on a white page. It needs no frame; the contrast
          is the frame. */}
      <section className="mx-auto max-w-[1400px] px-6 pb-24 sm:px-10">
        <ProductMock />
        <p className="label mt-3">A real answer, with the trace that produced it.</p>
      </section>

      {/* ── 01 Failures ─────────────────────────────────────────────────────── */}
      <Section id="failures" no="01" title="Most RAG fails in ways you cannot see.">
        <div className="grid12 gap-y-0">
          {FAILURES.map((f, i) => (
            <article
              key={f.title}
              className={`col-span-6 md:col-span-4 ${i === 0 ? "rule-hair" : "rule-hair md:border-l md:border-l-line md:pl-8"} py-7`}
            >
              <h3 className="text-h3 leading-tight font-bold tracking-[-0.02em]">{f.title}</h3>
              <p className="mt-3 max-w-[38ch] text-small leading-relaxed text-fg-2">{f.body}</p>
            </article>
          ))}
        </div>
      </Section>

      {/* ── 02 Hybrid ───────────────────────────────────────────────────────── */}
      <Section id="hybrid" no="02" title="Watch eight passages get reordered.">
        <div className="grid12">
          <div className="col-span-6 md:col-span-4">
            <p className="text-lead leading-relaxed text-fg-2">
              A pgvector scan and a Postgres full-text scan run as two arms of the same statement
              and are fused by rank before a single row leaves the database.
            </p>
            <p className="mt-5 max-w-[42ch] text-small leading-relaxed text-fg-2">
              Ranks are fused rather than scores, because cosine distance and{" "}
              <code className="mono text-fg">ts_rank_cd</code> sit on incomparable scales and any
              normalisation between them drifts with corpus size.
            </p>
            <p className="mt-5 max-w-[42ch] text-small leading-relaxed text-fg-2">
              These are real ranks and real scores, from this question against the sample corpus.
            </p>
          </div>

          <div className="col-span-6 mt-10 md:col-span-8 md:mt-0">
            <RetrievalAnimation />
          </div>
        </div>
      </Section>

      {/* ── 03 Pipeline ─────────────────────────────────────────────────────── */}
      <Section id="pipeline" no="03" title="Seven stages, and you watch each one run.">
        <p className="max-w-[52ch] text-lead leading-relaxed text-fg-2">
          Every answer carries its own trace: what each stage did, how long it took, and the real
          numbers it produced. A disappointing answer becomes diagnosable instead of mysterious.
        </p>

        <ol className="mt-12">
          {STAGES.map((stage, i) => (
            <li key={stage.name} className="grid12 rule-hair items-baseline py-6">
              <span className="section-no col-span-1">{String(i + 1).padStart(2, "0")}</span>
              <span className="mono col-span-5 text-small font-medium md:col-span-2">
                {stage.name}
              </span>
              <p className="col-span-6 mt-2 text-small leading-relaxed text-fg-2 md:col-span-9 md:mt-0 md:text-base">
                <span className="font-bold text-fg">{stage.headline}</span> {stage.body}
              </p>
            </li>
          ))}
        </ol>
      </Section>

      {/* ── 04 Agent ────────────────────────────────────────────────────────── */}
      <Section id="agent" no="04" title="The model runs its own searches.">
        <div className="grid12">
          <div className="col-span-6 md:col-span-5">
            <p className="text-lead leading-relaxed text-fg-2">
              In agent mode there is no fixed script. It decomposes the question, reformulates when
              a search comes back thin, reads around a passage that cuts off mid-explanation, and
              stops when it can actually answer.
            </p>
            <p className="mt-5 max-w-[46ch] text-small leading-relaxed text-fg-2">
              Every tool call runs the full hybrid-and-rerank pipeline underneath. An agent holding
              a naive similarity search only produces bad results more slowly.
            </p>
          </div>

          <div className="col-span-6 mt-10 md:col-span-6 md:col-start-7 md:mt-0">
            <div className="well mono p-6 text-small">
              <p className="label mb-4">One run, three tool calls deep</p>
              <div className="space-y-2.5">
                <Call verb="searchCorpus" arg="retry backoff delay and jitter" note="6 passages" />
                <Call verb="searchCorpus" arg="circuit breaker open duration" note="5 passages" />
                <Call verb="readSection" arg="cite 3, after 2" note="past the cutoff" />
                <p className="rule-hair flex flex-wrap gap-x-3 pt-3">
                  <span className="text-fg">answer</span>
                  <span className="text-fg-2">cited [1] [3] [7]</span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── 05 Architecture ─────────────────────────────────────────────────── */}
      <Section id="stack" no="05" title="Every stage picks its own model.">
        <p className="max-w-[54ch] text-lead leading-relaxed text-fg-2">
          No provider is best at all four jobs, and some cannot do all four at all. Each stage names
          its backend in one environment variable — so retrieval runs locally on CPU while
          generation runs hosted, and either moves without touching code.
        </p>

        <div className="mt-12 overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left">
            <thead>
              <tr className="rule-heavy">
                <th className="label py-3 pr-6 font-normal">Stage</th>
                <th className="label py-3 pr-6 font-normal">Runs on</th>
                <th className="label py-3 font-normal">Why</th>
              </tr>
            </thead>
            <tbody>
              {ROUTING.map((row) => (
                <tr key={row.stage} className="rule-hair">
                  <td className="py-4 pr-6 text-small font-bold">{row.stage}</td>
                  <td className="mono py-4 pr-6 text-micro text-brand">{row.runs}</td>
                  <td className="py-4 text-small text-fg-2">{row.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid12 mt-12">
          <Fact col="col-span-6 md:col-span-4" k="Index" v="Postgres + pgvector" n="HNSW and a GIN full-text index in one table" />
          <Fact col="col-span-6 md:col-span-4" k="Fusion" v="Reciprocal Rank Fusion" n="Ranks compare across arms; raw scores do not" />
          <Fact col="col-span-6 md:col-span-4" k="Formats" v="PDF, DOCX, Markdown, HTML" n="Or paste a URL and Colophon fetches it" />
        </div>
      </Section>

      {/* ── Close ───────────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1400px] px-6 py-24 sm:px-10">
        <div className="rule-heavy grid12 items-end pt-10">
          <h2 className="display display-lg col-span-6 md:col-span-8">
            Add a document. Ask it something hard.
          </h2>
          <div className="col-span-6 mt-8 md:col-span-4 md:mt-0">
            <p className="max-w-[34ch] text-small leading-relaxed text-fg-2">
              The first question is the one that tells you whether the retrieval is any good.
            </p>
            <Link href="/app" className="btn btn-primary mt-6 px-6 py-3 text-base">
              Open Colophon
            </Link>
          </div>
        </div>

        <div className="rule-hair mt-20 flex flex-wrap items-baseline justify-between gap-4 pt-5">
          <span className="label">Colophon</span>
          <span className="label">Next.js · AI SDK · Postgres · pgvector</span>
        </div>
      </section>
    </div>
  );
}

function Section({
  id,
  no,
  title,
  children,
}: {
  id: string;
  no: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mx-auto max-w-[1400px] scroll-mt-20 px-6 py-20 sm:px-10">
      <div className="grid12 rule-heavy items-start pt-6">
        <span className="section-no col-span-1">{no}</span>
        <h2 className="display display-lg col-span-5 md:col-span-9">{title}</h2>
      </div>
      <div className="mt-12">{children}</div>
    </section>
  );
}

function Spec({ col, n, t, d }: { col: string; n: string; t: string; d: string }) {
  return (
    <div className={`${col} md:border-l md:border-line md:pl-5 md:first:border-l-0 md:first:pl-0 ${col}`}>
      <dt className="text-[clamp(2rem,4vw,3rem)] leading-none font-extrabold tracking-[-0.04em]">
        {n}
      </dt>
      <dd className="mt-2 text-small font-semibold">{t}</dd>
      <dd className="mt-0.5 max-w-[22ch] text-micro leading-snug text-fg-3">{d}</dd>
    </div>
  );
}

function Fact({ col, k, v, n }: { col: string; k: string; v: string; n: string }) {
  return (
    <div className={`${col} rule-hair py-5 md:border-t-0 md:border-l md:border-l-line md:pt-0 md:pl-6 md:first:border-l-0 md:first:pl-0`}>
      <p className="label">{k}</p>
      <p className="mt-1.5 text-base font-bold">{v}</p>
      <p className="mt-1 max-w-[30ch] text-small leading-snug text-fg-2">{n}</p>
    </div>
  );
}

function Call({ verb, arg, note }: { verb: string; arg: string; note: string }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-brand">{verb}</span>
      <span className="text-fg">&ldquo;{arg}&rdquo;</span>
      <span className="text-fg-3">{note}</span>
    </p>
  );
}

const FAILURES = [
  {
    title: "The answer looked fine.",
    body: "A plausible paragraph with no passage behind it reads exactly like a correct one. Colophon audits every finished answer against its own sources and names any sentence it cannot support.",
  },
  {
    title: "The search never had a chance.",
    body: "“What about the second one?” embeds to nothing useful, and a two-part question retrieves whichever half is better represented. Colophon rewrites follow-ups and splits multi-part questions before searching.",
  },
  {
    title: "The chunk lost its context.",
    body: "“The limit was raised to 30 seconds” is unfindable on its own. At ingest, every passage gets a written line situating it in its document — Anthropic measured this cutting retrieval failures by up to 49%.",
  },
];

const STAGES = [
  {
    name: "plan",
    headline: "Understands the question.",
    body: "Rewrites follow-ups so they stand alone, splits multi-part questions into separately searchable ones, and drafts a hypothetical answer to search with instead of the question.",
  },
  {
    name: "retrieve",
    headline: "Searches both ways at once.",
    body: "A vector scan and a full-text scan run as two arms of one SQL query and are fused by rank before anything leaves the database.",
  },
  {
    name: "rerank",
    headline: "Reads query and passage together.",
    body: "A cross-encoder scores the actual pair rather than comparing two vectors that never met, which is what turns a good top-40 into a good top-8.",
  },
  {
    name: "grade",
    headline: "Decides whether to answer or search again.",
    body: "If a specific fact is missing it says which one, and searches again using the vocabulary the document would use — your phrasing already failed once.",
  },
  {
    name: "compress",
    headline: "Drops the duplicates, keeps the coverage.",
    body: "Eight paraphrases of one paragraph are worth about one. Colophon trades a little relevance for range, then widens each surviving passage with its neighbours.",
  },
  {
    name: "generate",
    headline: "Writes the answer with citations in place.",
    body: "Each citation sits against the clause it supports, not at the end of the paragraph, and points at a passage you can open.",
  },
  {
    name: "verify",
    headline: "Checks its own work afterwards.",
    body: "A separate pass audits the finished answer against its sources and flags any claim they do not support. It runs after streaming, so it costs you no waiting.",
  },
];

const ROUTING = [
  { stage: "Generation", runs: "ollama:gpt-oss:120b", why: "Strong tool calling, which agent mode depends on" },
  { stage: "Plan & grade", runs: "ollama:gpt-oss:20b", why: "Small and fast; these run several times per question" },
  { stage: "Embeddings", runs: "local:bge-base-en-v1.5", why: "Runs in-process on CPU, no key and no network hop" },
  { stage: "Reranking", runs: "local:ms-marco-MiniLM", why: "A real cross-encoder, small enough to run beside the app" },
];
