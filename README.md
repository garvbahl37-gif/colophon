# Colophon

A retrieval system you can audit. It searches by meaning and by exact wording at
the same time, reranks with a cross-encoder, cites the passage behind every
claim, and shows you each stage as it runs.

```bash
pnpm install
pnpm db:setup                      # creates the schema, probing the embedder for its width
pnpm ingest sample-docs/*.md       # or drop files into the UI
pnpm dev                           # http://localhost:3000
```

`.env.local` needs one key: `OLLAMA_API_KEY`. Embeddings and reranking run
locally, so there is no second provider to sign up for.

---

A colophon is the note at the end of a book stating how it was made — the press,
the paper, the typeface. That is this product's thesis: not just the answer, but
how it was produced.

---

## What it does differently

**Hybrid retrieval in one SQL statement.** A pgvector HNSW scan and a Postgres
full-text scan run as two arms of the same query and are fused by Reciprocal
Rank Fusion before any row leaves the database. Each arm gets its own `LIMIT`
inside the query, so Postgres can use the right index for each and only
materialise the union.

RRF rather than blended scores: cosine distance and `ts_rank_cd` are on
incomparable scales, and any normalisation between them is a guess that drifts
with corpus size. Rank position is stable; scores are not.

**The lexical arm uses OR, not AND.** `websearch_to_tsquery` ANDs every term, so
a five-word question becomes a query no single chunk can satisfy and the lexical
arm silently returns nothing — leaving "hybrid" search running on one leg. Colophon
stems the query with `to_tsvector` and ORs the lexemes, the way BM25 scores
partial matches. On the sample corpus that is the difference between 0 hits and
7.

**Contextual Retrieval at ingest.** Every chunk gets an LLM-written line
situating it in its document, prepended before both embedding and full-text
indexing, so both arms see it. "The limit was raised to 30 seconds" becomes
findable. Anthropic measured this cutting retrieval failures by up to 49%.

**Agentic retrieval, on top of good retrieval.** In agent mode the model runs its
own searches: it decomposes, reformulates when a search comes back thin, reads
around a passage that cuts off mid-explanation, and stops when it can answer.
Each of its tool calls runs the full hybrid-and-rerank pipeline underneath — an
agent holding a naive similarity search just produces bad results more slowly.

**A groundedness audit after the fact.** A separate pass checks the finished
answer against its own sources and names any sentence they do not support. It
runs after streaming, so it costs the reader nothing.

---

## Pipeline

```
plan ──▶ retrieve ──▶ rerank ──▶ grade ──▶ compress ──▶ generate ──▶ verify
 │          │           │          │          │            │           │
 rewrite    hybrid      cross-     suffic-    MMR +        cited       ground-
 decompose  dense+BM25  encoder    iency      neighbour    answer      edness
 HyDE       RRF in SQL             ↺ re-hop   expansion                audit
```

Every stage streams a trace part into the same message as the answer, so the
trace is part of the conversation record rather than ephemeral telemetry.

| Stage | What it fixes |
|---|---|
| `plan` | Follow-ups that embed to nothing; multi-part questions where top-k is dominated by the better-represented half |
| `retrieve` | Vector search missing exact identifiers; lexical search missing paraphrase |
| `rerank` | Bi-encoders comparing two vectors that never met |
| `grade` | Answering confidently from a bad first retrieval |
| `compress` | Eight paraphrases of one paragraph crowding out coverage; chunks too small to generate from |
| `verify` | Plausible sentences with no passage behind them |

---

## Model routing

Every stage names its own backend in one environment variable:

```
ollama:gpt-oss:120b              Ollama Cloud
gateway:anthropic/claude-sonnet-5 Vercel AI Gateway
local:Xenova/bge-base-en-v1.5     in-process ONNX, no key
```

This exists because no provider is best at all four jobs and some cannot do all
four at all — Ollama Cloud serves strong tool-calling chat models but exposes no
embedding or reranking endpoint. The default routing runs generation on Ollama
and retrieval locally on CPU.

| Stage | Default | Why |
|---|---|---|
| Generation | `ollama:gpt-oss:120b` | Strong tool calling, which agent mode depends on |
| Plan / grade / contextualise | `ollama:gpt-oss:20b` | Small and fast; these run several times per question |
| Embeddings | `local:Xenova/bge-base-en-v1.5` | 768d, competitive on MTEB retrieval, no key or network hop |
| Reranking | `local:Xenova/ms-marco-MiniLM-L-6-v2` | A real cross-encoder small enough to run beside the app |

To move the whole thing to hosted frontier models, set `AI_GATEWAY_API_KEY` and
the six `MODEL_*` variables in `.env.example`, then `pnpm db:reset` (the vector
column is rebuilt to the new embedder's width).

Two provider quirks are handled in code rather than worked around by the caller:

- **gpt-oss spends its output budget on reasoning before emitting content**, so a
  stage capped at 150 tokens returns an empty string. `fastStageOptions()` sets
  low reasoning effort and the budgets stay generous.
- **Ollama accepts `response_format: json_schema` and ignores it** — a request for
  a plan object comes back as a Markdown table. `lib/ai/structured.ts` expresses
  the schema as a single forced tool call there instead, and validates the result
  through Zod either way.

---

## Evaluation

```bash
pnpm eval             # retrieval metrics across four configurations
pnpm eval --answers   # also generate answers and score faithfulness
```

The harness runs one golden set through vector-only, lexical-only, hybrid, and
hybrid+rerank so the architecture is measured rather than asserted.

Current result on the 19-chunk sample corpus:

| configuration | hit@1 | hit@3 | MRR | nDCG@3 | ms |
|---|---|---|---|---|---|
| vector only | 0.91 | 1.00 | 0.955 | 0.952 | 22 |
| lexical only | 0.91 | 0.91 | 0.909 | 0.909 | 8 |
| hybrid | 0.91 | **1.00** | 0.939 | **0.955** | 8 |
| hybrid + rerank | 0.82 | 1.00 | 0.909 | 0.926 | 108 |

Read this honestly: **hybrid beats both single arms, and the cross-encoder
currently does not earn its 86ms.** Two things are going on. The corpus is far
too small — hit@3 is already saturated at 1.00, so there is no headroom for
reranking to recover anything, and it can only shuffle results that were already
right. And `ms-marco-MiniLM-L-6-v2` is a 6-layer model trained on web passages;
on short technical sections its scores are noisier than the bi-encoder's.

Reranking is left on by default because its value appears at a scale this corpus
cannot demonstrate — reordering 40 candidates drawn from tens of thousands of
chunks, not 3 drawn from 19. If you ingest a real corpus and this table still
shows no lift, turn it off: `MODEL_RERANK=` with a gateway model, or drop
`RETRIEVAL_RERANK_TOP_N` to bypass the stage. Do not take the default on faith;
that is what the harness is for.

---

## Design system

**Swiss Modernism 2.0 × Exaggerated Minimalism**, selected from the
ui-ux-pro-max style catalogue. The rules, and why each is a rule:

- **A strict 12-column grid** (`.grid12`). Every element starts and ends on a
  column line. Alignment does the work that borders and shadows do elsewhere.
- **Type carries the page.** Archivo 400-900, set tight and large, sized against
  the viewport (`clamp(2.75rem, 9vw, 8.5rem)`). Archivo rather than Inter
  because a headline at 8rem has to hold the page on its own.
- **One accent, load-bearing.** Swiss red `#E5341E` marks the single most
  important thing in a view and nothing else. No gradients anywhere.
- **Zero radius, no shadows** on the marketing site. Depth is rules, inversion
  and negative space.

The landing page and the console run the same system — same grid, same rules,
same red, same type. The console is the landing page's language applied to a
working tool, which is why the hero screenshot needs no styling of its own: it
is a faithful miniature of the real thing.

A dark scope (`.shell-dark` in `app/globals.css`) is defined and unused. Every
component is written against tokens, so putting that class on the console shell
flips the whole app to dark without touching a component.

**The retrieval animation** (`components/retrieval-animation.tsx`) is the one
piece of real motion. It keeps a single set of eight passages on screen and
lets each stage reorder them, because watching "Timeouts" climb from sixth to
second the moment the cross-encoder runs explains what a cross-encoder is *for*
in a way an arrow diagram cannot. Rows translate between slots rather than
re-rendering, it pauses off-screen, and every rank and score in it is real
output from the sample corpus.

**Channel colours are data, not decoration.** Jade always means "found by
meaning", amber always means "found by exact wording", everywhere they appear.
They darken on paper (`#00875A` / `#B45309`) and brighten on the console
(`#34D399` / `#FBBF24`) to hold contrast in both scopes.

### Separators

Four weights, and picking the right one is most of what makes a dense interface
feel expensive. Pure black at every boundary is what an editorial page does once
per section; an app doing it thirty times reads as a wireframe.

| Token | Value | Used for |
|---|---|---|
| `--color-hairline` | `#F0F0F2` | rows inside a list |
| `--color-line` | `#E4E4E7` | panel edges, inputs |
| `--color-line-lit` | `#D0D0D6` | emphasis, hover borders |
| `--color-rule` | `#0A0A0A` | editorial rules — the landing page only |

The console adds `.shell-app`, which drops the ground to `#FAFAFA` so white
panels separate themselves by tone rather than by a hard line at every edge.

### Buttons

`.btn` plus a size (`.btn-sm` 32px, `.btn-md` 38px, `.btn-lg` 46px) and an
intent (`.btn-primary`, `.btn-accent`, `.btn-ghost`, `.btn-bare`). Every state
is defined — hover, active, focus, disabled — and press feedback is colour plus
half a pixel of travel rather than a scale transform, so nothing around the
button moves. `.segmented` / `.segment` is the mode switch.

### Contrast

Every foreground colour is set to clear **WCAG AA at 12px**, because the muted
greys and both channel colours carry 12px labels, not just bar fills. The
obvious brighter values all fail at that size:

| Token | Ratio | |
|---|---|---|
| `fg` `#0A0A0A` | 19.80:1 | AAA |
| `fg-2` `#52525B` | 7.73:1 | AAA |
| `fg-3` `#75757D` | 4.57:1 | AA |
| `brand` `#E0331D` | 4.51:1 | AA |
| `jade` `#008458` | 4.53:1 | AA |
| `amber` `#B45309` | 4.81:1 | AA |

The focus ring is neutral black, not the accent. A red outline on a focused text
field reads as "invalid value" to every user regardless of what the design
system means by it.

Text fields opt out of the global ring entirely (`textarea:focus-visible` and
friends in `globals.css`). The composer is one surface with its own border, and
a second outline drawn around the textarea inside it produces a box in a box.
That rule cannot be a `focus:outline-none` utility: everything Tailwind emits is
inside a layer, and **unlayered CSS beats layered CSS regardless of
specificity**, so the global ring would win.

Component classes live inside `@layer components` in `app/globals.css`. This is
load-bearing: defined at the top level, `.btn { display: inline-flex }` wins
against Tailwind's `lg:hidden` and mobile-only controls leak onto desktop.

## Layout

```
app/
  page.tsx              landing (hero, bento grid, pipeline, architecture)
  app/page.tsx          the console
  globals.css           design tokens + component layer
  api/chat              streaming RAG endpoint
  api/ingest            file + URL ingestion
lib/
  ai/          providers, per-stage routing, local ONNX, prompts, structured output
  agent/       tool definitions, the evidence ledger, the ToolLoopAgent
  ingest/      loaders, structure-aware chunker, contextualiser, pipeline
  retrieval/   hybrid SQL, rerank, query planner, MMR, grading, orchestrator
  db/          client and schema
evals/         golden set and harness
```

## Tuning

Everything is in `lib/config.ts`, read from the environment, and documented in
`.env.example`. The knobs worth reaching for first:

| Variable | Default | Effect |
|---|---|---|
| `RETRIEVAL_CANDIDATES` | 40 | Candidates per arm before fusion. Raise for recall, at rerank cost |
| `RETRIEVAL_DENSE_WEIGHT` / `_SPARSE_WEIGHT` | 0.5 / 0.5 | Shift toward paraphrase or toward exact identifiers |
| `RETRIEVAL_MAX_HOPS` | 2 | Agentic re-retrieval budget. 1 disables self-correction |
| `RETRIEVAL_MMR_LAMBDA` | 0.72 | 1.0 pure relevance, 0.0 pure diversity |
| `RETRIEVAL_EF_SEARCH` | 120 | HNSW breadth. Automatically quadrupled when a document filter is applied |
| `CONTEXTUAL_RETRIEVAL` | true | Situating context per chunk. Off makes ingestion much faster and retrieval worse |

## Requirements

PostgreSQL 17 with `pgvector` and `pg_trgm`, Node 20+. On macOS:

```bash
brew install postgresql@17 pgvector && brew services start postgresql@17
createdb colophon
```
