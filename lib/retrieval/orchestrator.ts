import {
  convertToModelMessages,
  streamText,
  type UIMessageStreamWriter,
} from "ai";
import { nanoid } from "nanoid";
import { config } from "@/lib/config";
import { sql } from "@/lib/db/client";
import { embedQuery, generateModel } from "@/lib/ai/models";
import { ANSWER_SYSTEM, answerPrompt } from "@/lib/ai/prompts";
import type {
  ColophonMode,
  ColophonUIMessage,
  RetrievedPassage,
} from "@/lib/ai/types";
import { createRagAgent } from "@/lib/agent/rag-agent";
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

  const [{ count: corpusSize }] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM chunks
  `;
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

  const latencyMs = Date.now() - startedAt;
  writer.write({
    type: "message-metadata",
    messageMetadata: { latencyMs, mode, model: config.models.generate },
  });

  await sql`
    INSERT INTO query_log (id, query, plan, trace, citations, answer, latency_ms)
    VALUES (${nanoid(12)}, ${question}, ${sql.json({ mode })}, ${sql.json(trace.spans as never)},
            ${sql.json(citations as never)}, ${answer}, ${latencyMs})
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
          hyde: p.hypothetical ? "yes" : "no",
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

  let searchQueries = plan.subQueries;
  let selected: Candidate[] = [];

  for (let hop = 0; hop < config.retrieval.maxHops; hop++) {
    const label =
      hop === 0 ? "hybrid retrieval" : `hybrid retrieval · hop ${hop + 1}`;

    const fused = await trace.span("retrieve", label, async (update) => {
      const rounds = await Promise.all(
        searchQueries.map(async (subQuery) => {
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

          // HyDE only helps the dense arm. The lexical arm keeps the literal
          // question, because a fabricated passage dilutes exact-term matching.
          const vectorText =
            hop === 0 && plan.hypothetical ? plan.hypothetical : subQuery;
          const embedding = await embedQuery(vectorText);
          const candidates = await hybridSearch({
            embedding,
            text: lexicalQuery(plan, subQuery),
            documentIds,
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
      "cross-encoder",
      async (update) => {
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

    selected = reranked;

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

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
