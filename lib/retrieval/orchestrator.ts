import {
  convertToModelMessages,
  streamText,
  type UIMessageStreamWriter,
} from "ai";
import { nanoid } from "nanoid";
import { config } from "@/lib/config";
import { sql } from "@/lib/db/client";
import { embedQuery, generateModel } from "@/lib/ai/models";
import { ANSWER_SYSTEM, answerPrompt, countSuspicious } from "@/lib/ai/prompts";
import type {
  ColophonMode,
  ColophonUIMessage,
  RetrievedPassage,
} from "@/lib/ai/types";
import { createRagAgent } from "@/lib/agent/rag-agent";
import { chooseStrategy, type Strategy } from "./router";
import { probeCache, storeAnswer, type CacheHit } from "./cache";
import { EvidenceLedger } from "@/lib/agent/ledger";
import type { ToolEvent } from "@/lib/agent/tools";
import { diversify, fitBudget, orderForAttention } from "./compress";
import { checkGroundedness, gradeSufficiency } from "./grade";
import { expandNeighbours, fuseAcrossQueries, hybridSearch } from "./hybrid";
import { lexicalQuery, planQuery } from "./query-planner";
import { rerankCandidates } from "./rerank";
import type { Candidate, TraceSpan, TraceStage } from "./types";

type Writer = UIMessageStreamWriter<ColophonUIMessage>;

export interface RunOptions {
  question: string;
  messages: ColophonUIMessage[];
  documentIds: string[] | null;
  /** Whose corpus this run may read, and whose cache it may use. */
  ownerId: string;
  /**
   * Hands work to the runtime so it outlives the response.
   *
   * Storing the answer happens after the last token has streamed, and a
   * serverless instance is suspended the moment the response closes -- so a
   * fire-and-forget insert is simply dropped, and the cache stays permanently
   * empty while appearing to work. Measured: every repeat missed.
   */
  defer?: (work: Promise<unknown>) => void;
  mode: ColophonMode;
  writer: Writer;
}

/** Emits a trace span that starts as `running` and is reconciled on completion. */
function tracer(writer: Writer) {
  const spans: TraceSpan[] = [];

  const emit = (span: TraceSpan) => {
    const index = spans.findIndex((s) => s.id === span.id);
    if (index >= 0) spans[index] = span;
    else spans.push(span);
    writer.write({ type: "data-trace", id: span.id, data: span });
  };

  return {
    spans,
    async span<T>(
      stage: TraceStage,
      label: string,
      fn: (update: (patch: Partial<TraceSpan>) => void) => Promise<T>,
      options: { summary?: boolean } = {},
    ): Promise<T> {
      const id = `${stage}-${nanoid(5)}`;
      const started = Date.now();
      let current: TraceSpan = {
        id,
        stage,
        label,
        status: "running",
        ...options,
      };
      emit(current);

      const update = (patch: Partial<TraceSpan>) => {
        current = { ...current, ...patch };
        emit(current);
      };

      try {
        const result = await fn(update);
        emit({ ...current, status: "done", ms: Date.now() - started });
        return result;
      } catch (error) {
        emit({
          ...current,
          status: "error",
          ms: Date.now() - started,
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    skip(stage: TraceStage, label: string, detail: string) {
      emit({
        id: `${stage}-${nanoid(5)}`,
        stage,
        label,
        status: "skipped",
        detail,
      });
    },
  };
}

function toPassage(c: Candidate, marker: number): RetrievedPassage {
  return {
    marker,
    chunkId: c.id,
    documentId: c.documentId,
    documentTitle: c.documentTitle,
    headingPath: c.headingPath,
    page: c.page,
    snippet: c.content,
    context: c.context,
    denseScore: c.denseScore,
    sparseScore: c.sparseScore,
    denseRank: c.denseRank,
    sparseRank: c.sparseRank,
    identRank: c.identRank,
    rrfScore: c.rrfScore,
    rerankScore: c.rerankScore ?? null,
  };
}

/** Flattens recent turns into a transcript the planner can resolve pronouns against. */
function transcript(messages: ColophonUIMessage[], limit = 6): string {
  return messages
    .slice(-limit - 1, -1)
    .map((m) => {
      const text = m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .slice(0, 1200);
      return text ? `${m.role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export async function runColophon(opts: RunOptions): Promise<void> {
  const { question, messages, documentIds, mode, writer } = opts;
  const startedAt = Date.now();
  const trace = tracer(writer);
  const ledger = new EvidenceLedger();
  const history = transcript(messages);

  /*
    Scoped to what this reader may search. Counting every chunk in the table
    told someone with no documents that the corpus was fine because somebody
    else had one — and told them a little about that somebody in passing.
  */
  const corpusSize = documentIds?.length ?? 0;
  if (corpusSize === 0) {
    writer.write({
      type: "data-notice",
      data: {
        level: "warning",
        message:
          "The corpus is empty. Add a document and I will have something to ground answers in.",
      },
      transient: true,
    });
  }

  /*
    Ask whether this has already been answered before answering it.

    The probe costs one embedding — no model call, no retrieval — against a
    pipeline whose cheapest path is many seconds of generation. It runs on the
    raw question rather than the planner's rewrite because the planner is
    itself a model call, and waiting for it to decide whether we can skip the
    work would spend most of what a hit is worth. The cost of that shortcut is
    that a follow-up leaning on the conversation ("what about the second one?")
    must not be matched against a cache that cannot see the history, so a
    question with history behind it is never served from cache.
  */
  const cached: CacheHit | null = history
    ? null
    : await trace.span("cache", "semantic lookup", async (update) => {
        const hit = await probeCache({
          question,
          ownerId: opts.ownerId,
          mode,
          documentIds: documentIds ?? [],
        });
        update({
          detail: hit
            ? `matched "${hit.question}"`
            : "no sufficiently similar question answered before",
          metrics: hit
            ? {
                similarity: Number(hit.similarity.toFixed(3)),
                age: `${Math.round(hit.ageSeconds)}s`,
              }
            : { similarity: "—" },
        });
        return hit;
      });

  if (cached) {
    writer.write({ type: "text-start", id: "cached" });
    writer.write({ type: "text-delta", id: "cached", delta: cached.answer });
    writer.write({ type: "text-end", id: "cached" });
    writer.write({ type: "data-citations", data: cached.citations });
    writer.write({
      type: "data-notice",
      data: {
        level: "info",
        message:
          `Answered from cache — the same question, asked ${Math.round(cached.ageSeconds)}s ago ` +
          `against the same documents. Rephrase or add a document to force a fresh run.`,
      },
    });
    writer.write({
      type: "message-metadata",
      messageMetadata: { latencyMs: Date.now() - startedAt, mode, model: "cache" },
    });
    return;
  }

  const answer =
    mode === "agent"
      ? await runAgentic({
          question,
          messages,
          documentIds,
          writer,
          trace,
          ledger,
        })
      : await runPipeline({
          question,
          history,
          documentIds,
          writer,
          trace,
          ledger,
        });

  // Citations resolve against the ledger, so a marker means the same passage
  // whether it came from search 1 or search 4.
  const citations = ledger.citationsFor(answer);
  writer.write({ type: "data-citations", data: citations });

  // Groundedness runs after the answer has streamed, so the audit costs the
  // reader no latency - it arrives as a verdict on text they are already reading.
  if (ledger.size > 0 && answer.trim()) {
    await trace.span("verify", "groundedness audit", async (update) => {
      const verdict = await checkGroundedness(question, answer, ledger.all());
      update({
        detail: verdict.supported
          ? "all claims supported"
          : `${verdict.issues.length} unsupported`,
        metrics: {
          supported: verdict.supported ? "yes" : "no",
          "cite density": `${Math.round(verdict.citationDensity * 100)}%`,
        },
      });
      writer.write({ type: "data-grounding", data: verdict });
    });
  }

  /*
    Kept only if it is worth repeating: a single-turn question, over a known
    document set, that actually produced cited prose. An answer saying the
    sources do not cover something is cheap to regenerate and expensive to be
    wrong about later, once the corpus has grown the passage it was missing.
  */
  if (!history) {
    const write = storeAnswer({
      question,
      answer,
      citations,
      ownerId: opts.ownerId,
      mode,
      documentIds: documentIds ?? [],
    });
    if (opts.defer) opts.defer(write.catch(() => {}));
    else await write;
  }

  const latencyMs = Date.now() - startedAt;
  writer.write({
    type: "message-metadata",
    messageMetadata: { latencyMs, mode, model: config.models.generate },
  });

  /*
    What gets written down, and what deliberately does not.

    This table exists to make the pipeline measurable offline -- which stages
    are slow, how often grounding fails. None of that needs the question or the
    answer, and on a shared instance storing them is a straightforward leak:
    the conversation is the most sensitive thing here, it is written to a table
    no reader can see or clear, and one person's questions would sit beside
    another's indefinitely.

    So the content stays in the reader's browser and only the shape of the run
    is recorded. An operator who wants full transcripts for evaluation on their
    own machine opts in explicitly; a public deployment never should.
  */
  const keepTranscripts = process.env.COLOPHON_LOG_QUERIES === "1";
  await sql`
    INSERT INTO query_log (id, query, plan, trace, citations, answer, latency_ms)
    VALUES (${nanoid(12)},
            ${keepTranscripts ? question : ""},
            ${sql.json({ mode, citations: citations.length })},
            ${sql.json(trace.spans as never)},
            ${keepTranscripts ? sql.json(citations as never) : null},
            ${keepTranscripts ? answer : null},
            ${latencyMs})
  `.catch(() => {});
}

/* ───────────────────────────── agentic mode ───────────────────────────── */

/**
 * The model drives retrieval itself: it decomposes, searches, reads around a
 * passage, reformulates when a search comes back thin, and decides when it has
 * enough. Each of its tool calls runs the full hybrid + rerank pipeline, so
 * agency is layered on top of good retrieval rather than substituted for it.
 */
async function runAgentic(args: {
  question: string;
  messages: ColophonUIMessage[];
  documentIds: string[] | null;
  writer: Writer;
  trace: ReturnType<typeof tracer>;
  ledger: EvidenceLedger;
}): Promise<string> {
  const { messages, documentIds, writer, trace, ledger } = args;

  const onEvent = (event: ToolEvent) => {
    if (event.type === "search:start") {
      writer.write({
        type: "data-retrieval",
        id: event.id,
        data: {
          id: event.id,
          query: event.query,
          scope: event.scope,
          status: "running",
          passages: [],
        },
      });
      writer.write({
        type: "data-trace",
        id: `tool-${event.id}`,
        data: {
          id: `tool-${event.id}`,
          stage: "retrieve",
          label: `search "${truncate(event.query, 48)}"`,
          status: "running",
        },
      });
    }

    if (event.type === "search:done") {
      writer.write({
        type: "data-retrieval",
        id: event.id,
        data: {
          id: event.id,
          query: event.query,
          scope: event.scope ?? null,
          status: "done",
          ms: event.ms,
          dense: event.dense,
          sparse: event.sparse,
          fused: event.fused,
          method: event.method,
          passages: event.candidates.map((c) => toPassage(c, c.marker)),
        },
      });
      writer.write({
        type: "data-trace",
        id: `tool-${event.id}`,
        data: {
          id: `tool-${event.id}`,
          stage: "retrieve",
          label: `search "${truncate(event.query, 48)}"`,
          status: "done",
          ms: event.ms,
          metrics: {
            dense: event.dense,
            lexical: event.sparse,
            fused: event.fused,
            kept: event.kept,
          },
        },
      });
    }

    if (event.type === "search:error") {
      writer.write({
        type: "data-trace",
        id: `tool-${event.id}`,
        data: {
          id: `tool-${event.id}`,
          stage: "retrieve",
          label: `search "${truncate(event.query, 44)}"`,
          status: "error",
          detail: event.message,
        },
      });
      writer.write({
        type: "data-notice",
        data: { level: "error", message: `Search failed: ${event.message}` },
      });
    }

    if (event.type === "read:done") {
      writer.write({
        type: "data-trace",
        id: `tool-${event.id}`,
        data: {
          id: `tool-${event.id}`,
          stage: "compress",
          label: "read surrounding passages",
          status: "done",
          ms: event.ms,
        },
      });
    }

    if (event.type === "list:done") {
      writer.write({
        type: "data-trace",
        id: `tool-${event.id}`,
        data: {
          id: `tool-${event.id}`,
          stage: "plan",
          label: "survey corpus",
          status: "done",
          metrics: { documents: event.count },
        },
      });
    }
  };

  const agent = createRagAgent({ ledger, documentIds, onEvent });

  return trace.span(
    "generate",
    `agent · ${config.models.generate}`,
    async (update) => {
      const result = await agent.stream({
        messages: await convertToModelMessages(messages),
      });

      writer.merge(
        result.toUIMessageStream({ sendStart: false, sendFinish: false }),
      );

      const [text, steps, usage] = await Promise.all([
        result.text,
        result.steps,
        result.usage,
      ]);
      const searches = steps
        .flatMap((s) => s.toolCalls)
        .filter((c) => c.toolName === "searchCorpus").length;

      update({
        metrics: {
          steps: steps.length,
          searches,
          passages: ledger.size,
          ...(usage.totalTokens ? { tokens: usage.totalTokens } : {}),
        },
      });

      return text;
    },
    { summary: true },
  );
}

/* ──────────────────────────── deterministic mode ──────────────────────────── */

/**
 * Fixed-order pipeline. Lower latency and fully predictable cost, at the price
 * of no self-direction: the query plan is made once, up front, and the only
 * adaptivity is the sufficiency loop.
 */
async function runPipeline(args: {
  question: string;
  history: string;
  documentIds: string[] | null;
  writer: Writer;
  trace: ReturnType<typeof tracer>;
  ledger: EvidenceLedger;
}): Promise<string> {
  const { question, history, documentIds, writer, trace, ledger } = args;

  const plan = await trace.span(
    "plan",
    "query understanding",
    async (update) => {
      const p = await planQuery(question, history);
      update({
        detail: p.needsRetrieval ? p.standalone : "no retrieval needed",
        metrics: {
          intent: p.intent,
          "sub-queries": p.subQueries.length,
          keywords: p.keywords.length,
          hyde: p.hypotheticals.filter(Boolean).length,
        },
      });
      writer.write({ type: "data-plan", data: p });
      return p;
    },
  );

  if (!plan.needsRetrieval) {
    trace.skip("retrieve", "retrieval", "conversational turn");
    return trace.span("generate", config.models.generate, async () => {
      const result = streamText({
        model: generateModel(),
        system: ANSWER_SYSTEM,
        prompt: history ? `${history}\nuser: ${question}` : question,
      });
      writer.merge(
        result.toUIMessageStream({ sendStart: false, sendFinish: false }),
      );
      return result.text;
    });
  }

  /*
    Decide how hard to search before searching, and say so in the trace.

    This is a visible stage rather than a hidden optimisation on purpose: it
    changes which passages reach the answer, so a reader debugging a
    disappointing result needs to see that a lookup skipped the reranker as
    readily as they can see what the reranker did.
  */
  const strategy: Strategy = await trace.span("route", "adaptive strategy", async (update) => {
    const chosen = chooseStrategy(plan, plan.standalone);
    update({
      detail: chosen.because,
      metrics: {
        route: chosen.route,
        candidates: chosen.candidates,
        rerank: chosen.rerank ? "yes" : "skipped",
        hyde: chosen.hyde ? "yes" : "off",
      },
    });
    return chosen;
  });

  let searchQueries = plan.subQueries;
  let selected: Candidate[] = [];

  for (let hop = 0; hop < config.retrieval.maxHops; hop++) {
    const label =
      hop === 0 ? "hybrid retrieval" : `hybrid retrieval · hop ${hop + 1}`;

    const fused = await trace.span("retrieve", label, async (update) => {
      const rounds = await Promise.all(
        searchQueries.map(async (subQuery, qi) => {
          const roundId = nanoid(6);
          writer.write({
            type: "data-retrieval",
            id: roundId,
            data: {
              id: roundId,
              query: subQuery,
              scope: null,
              status: "running",
              passages: [],
            },
          });

          // HyDE only helps the dense arm; the lexical arm keeps the literal
          // question, because a fabricated passage dilutes exact-term matching.
          // Each sub-query uses its OWN hypothetical — sharing one across all
          // of them collapses decomposition back to a single dense query, and
          // cross-query RRF then doubles the identical rows it returns.
          const hyde = hop === 0 && strategy.hyde ? (plan.hypotheticals[qi] ?? "") : "";
          const vectorText = hyde || subQuery;
          const embedding = await embedQuery(vectorText);
          const candidates = await hybridSearch({
            embedding,
            text: lexicalQuery(plan, subQuery),
            identifiers: plan.keywords,
            documentIds,
            candidates: strategy.candidates,
            denseWeight: strategy.denseWeight,
            sparseWeight: strategy.sparseWeight,
          });
          return { roundId, query: subQuery, candidates };
        }),
      );

      const merged = fuseAcrossQueries(
        rounds.map(({ query, candidates }) => ({ query, candidates })),
      );
      update({
        metrics: {
          queries: rounds.length,
          dense: merged.filter((c) => c.denseRank != null).length,
          lexical: merged.filter((c) => c.sparseRank != null).length,
          fused: merged.length,
        },
      });
      return { merged, rounds };
    });

    const reranked = await trace.span(
      "rerank",
      strategy.rerank ? "cross-encoder" : "skipped",
      async (update) => {
        if (!strategy.rerank) {
          // Fusion already ordered these. Reporting the skip with its reason
          // keeps the trace honest about why no scores appear downstream.
          const kept = fused.merged.slice(0, config.retrieval.rerankTopN);
          update({
            detail: strategy.because,
            metrics: { in: fused.merged.length, out: kept.length, top: "n/a" },
          });
          return kept;
        }

        const { candidates, method, model } = await rerankCandidates(
          plan.standalone,
          fused.merged,
        );
        update({
          detail: method.endsWith("cross-encoder")
            ? model
            : `fallback · ${method}`,
          metrics: {
            in: fused.merged.length,
            out: candidates.length,
            top: Number((candidates[0]?.rerankScore ?? 0).toFixed(3)),
          },
        });
        return candidates;
      },
    );

    // Publish the reranked set against the first round so the UI shows scores.
    const registered = ledger.register(reranked);
    writer.write({
      type: "data-retrieval",
      id: fused.rounds[0].roundId,
      data: {
        id: fused.rounds[0].roundId,
        query: plan.standalone,
        scope: null,
        status: "done",
        fused: fused.merged.length,
        passages: registered.map((c) => toPassage(c, c.marker)),
      },
    });
    for (const round of fused.rounds.slice(1)) {
      writer.write({
        type: "data-retrieval",
        id: round.roundId,
        data: {
          id: round.roundId,
          query: round.query,
          scope: null,
          status: "done",
          passages: [],
        },
      });
    }

    /*
      Accumulate across hops rather than replacing.

      The grader fires precisely when PART of the answer is missing, so hop 2
      searches for the missing half. Overwriting `selected` then throws away
      the half hop 1 had already found, turning a partial answer into a
      different partial answer. Union the pools and let the reranker choose.
    */
    selected = hop === 0 ? reranked : dedupeById([...selected, ...reranked]);

    if (hop === config.retrieval.maxHops - 1) break;

    const verdict = await trace.span(
      "grade",
      "context sufficiency",
      async (update) => {
        const v = await gradeSufficiency(plan.standalone, reranked);
        update({
          detail: v.sufficient ? "sufficient" : (v.missing ?? "insufficient"),
          metrics: {
            verdict: v.sufficient ? "pass" : "re-query",
            confidence: v.confidence.toFixed(2),
          },
        });
        return v;
      },
    );

    if (verdict.sufficient || !verdict.refinedQuery) break;
    searchQueries = [verdict.refinedQuery];
  }

  const context = await trace.span(
    "compress",
    "diversify + expand",
    async (update) => {
      const diverse = await diversify(selected);
      const expanded = await expandNeighbours(diverse);
      const budgeted = fitBudget(expanded);
      update({
        metrics: {
          in: selected.length,
          mmr: diverse.length,
          final: budgeted.length,
          tokens: budgeted.reduce(
            (n, c) =>
              n + Math.ceil((c.expandedContent ?? c.content).length / 4),
            0,
          ),
        },
      });
      return orderForAttention(budgeted);
    },
  );

  // Re-register post-MMR so markers match what the generator actually saw.
  const finalLedger = ledger.register(context);
  const renumbered = finalLedger.map((c) => ({ ...c }));

  /*
    Say so when a passage tried to give orders.

    The model is told to treat source text as quoted material, and the prompt
    neutralises the delimiters, but neither of those is visible to the person
    reading the answer. A corpus is only auditable if the reader learns that
    something in it was arguing with the system -- that is a fact about their
    documents worth knowing, whoever put it there.
  */
  const suspicious = countSuspicious(renumbered);
  if (suspicious > 0) {
    writer.write({
      type: "data-notice",
      data: {
        level: "warning",
        message:
          `${suspicious} of ${renumbered.length} passages contain instruction-like text. ` +
          `They were passed to the model as quoted evidence, not as instructions.`,
      },
    });
  }

  return trace.span("generate", config.models.generate, async (update) => {
    const result = streamText({
      model: generateModel(),
      system: ANSWER_SYSTEM,
      prompt: answerPrompt(plan.standalone, renumbered, history),
      temperature: 0.2,
    });
    writer.merge(
      result.toUIMessageStream({ sendStart: false, sendFinish: false }),
    );
    const [text, usage] = await Promise.all([result.text, result.usage]);
    update({
      metrics: { sources: renumbered.length, tokens: usage.totalTokens ?? 0 },
    });
    return text;
  });
}

/** Keeps the highest-scoring instance of each chunk across hops. */
function dedupeById(candidates: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    const seen = best.get(c.id);
    if (!seen || (c.rerankScore ?? 0) > (seen.rerankScore ?? 0)) best.set(c.id, c);
  }
  return [...best.values()].sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
