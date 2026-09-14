"use client";

import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/util/cn";
import { breadcrumb } from "@/lib/util/breadcrumb";
import type { ColophonMode, ColophonUIMessage, RetrievalRound, RetrievedPassage } from "@/lib/ai/types";
import type { Citation, GroundingIssue, TraceSpan } from "@/lib/retrieval/types";
import { Answer, GroundingBadge } from "./answer";
import { Boot } from "./boot";
import { CorpusRail, useCorpus } from "./corpus";
import { RetrievalRoundView } from "./passages";
import { ChannelLegend, TraceStrip } from "./trace";

interface Extracted {
  text: string;
  trace: TraceSpan[];
  rounds: RetrievalRound[];
  citations: Citation[];
  grounding: { supported: boolean; issues: GroundingIssue[]; citationDensity: number } | null;
  notice: { level: string; message: string } | null;
}

/** Pulls the pipeline's data parts back out of a streamed message. */
function extract(message: ColophonUIMessage): Extracted {
  const out: Extracted = {
    text: "",
    trace: [],
    rounds: [],
    citations: [],
    grounding: null,
    notice: null,
  };

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        out.text += part.text;
        break;
      case "data-trace":
        out.trace.push(part.data);
        break;
      case "data-retrieval":
        out.rounds.push(part.data);
        break;
      case "data-citations":
        out.citations = part.data;
        break;
      case "data-grounding":
        out.grounding = part.data;
        break;
      case "data-notice":
        out.notice = part.data;
        break;
    }
  }
  return out;
}

export function Console() {
  const { documents, stats, error: corpusError, refresh } = useCorpus();
  const [mode, setMode] = useState<ColophonMode>("agent");
  const [scope, setScope] = useState<Set<string>>(new Set());
  const [input, setInput] = useState("");
  const [showRail, setShowRail] = useState(false);
  const [showInstrument, setShowInstrument] = useState(false);
  /*
    Always starts true so the server and the first client render agree. Reading
    sessionStorage in the initialiser instead produces a hydration mismatch for
    anyone who has already seen the boot screen this session. Boot decides for
    itself whether to play or dismiss immediately.
  */
  const [booting, setBooting] = useState(true);

  // Read through refs so the transport always sends the current settings
  // without tearing down and rebuilding the chat on every toggle.
  const modeRef = useRef(mode);
  const scopeRef = useRef(scope);
  modeRef.current = mode;
  scopeRef.current = scope;

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ColophonUIMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: {
            ...body,
            messages,
            mode: modeRef.current,
            documentIds: [...scopeRef.current],
          },
        }),
      }),
    [],
  );

  const { messages, sendMessage, status, stop, error } = useChat<ColophonUIMessage>({ transport });

  const streaming = status === "streaming" || status === "submitted";
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const instrument = lastAssistant ? extract(lastAssistant) : null;

  function submit() {
    const question = input.trim();
    if (!question || streaming) return;
    setInput("");
    // The auto-grow handler writes an inline height; clearing the value does
    // not undo it, so the composer would stay tall after every send.
    if (composerRef.current) composerRef.current.style.height = "auto";
    void sendMessage({ text: question });
    // Ingest can finish while a question is in flight; keep the counters honest.
    void refresh();
  }

  return (
    <div className="shell-app flex h-dvh flex-col bg-bg">
      {booting && (
        <Boot onDone={() => setBooting(false)} />
      )}
      {/* ── Top bar ──────────────────────────────────────────────────────────
          Swiss masthead rather than an app chrome bar: a wordmark, a hairline
          rule, and telemetry set in mono. No logo mark — the typography is the
          identity, and an icon beside a wordmark this heavy only competes with
          it. The bar reports live state instead of decorating: the indicator
          tracks whether a query is actually running. */}
      <header className="relative z-30 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-card px-4 sm:gap-5 sm:px-6">
        <button
          type="button"
          onClick={() => setShowRail((v) => !v)}
          className="btn btn-ghost btn-sm lg:hidden"
        >
          Sources
        </button>

        <Link
          href="/"
          className="group flex shrink-0 items-baseline gap-2"
          aria-label="Colophon home"
          title="Back to the overview"
        >
          <span className="text-lead font-extrabold tracking-[-0.045em] text-fg transition-colors group-hover:text-brand">
            COLOPHON
          </span>
        </Link>

        {/* Hairline, not a bullet: it separates without adding a glyph. */}
        <span aria-hidden className="hidden h-5 w-px shrink-0 bg-line sm:block" />

        <dl className="mono hidden items-baseline gap-4 text-micro sm:flex">
          <div className="flex items-baseline gap-1.5">
            <dt className="sr-only">Documents</dt>
            <dd className="text-fg">{stats.documents}</dd>
            <span className="text-fg-3">documents</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="sr-only">Passages</dt>
            <dd className="text-fg">{stats.chunks.toLocaleString()}</dd>
            <span className="text-fg-3">passages</span>
          </div>
        </dl>

        <div className="flex-1" />

        {/* Reports whether the pipeline is running right now. */}
        <span className="mono hidden items-center gap-2 text-micro text-fg-3 md:flex">
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 transition-colors",
              streaming ? "bg-brand" : "bg-jade",
            )}
          />
          {streaming ? "retrieving" : "ready"}
        </span>

        {/*
          Two genuinely different retrieval strategies, not a cosmetic setting —
          so each option carries what it actually does.
        */}
        <div role="radiogroup" aria-label="Retrieval strategy" className="segmented shrink-0">
          {(
            [
              ["agent", "Agent", "The model runs its own searches and decides when it has enough"],
              ["pipeline", "Pipeline", "One fixed plan, retrieve, rerank, grade, answer sequence"],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              role="radio"
              aria-checked={mode === value}
              title={hint}
              onClick={() => setMode(value)}
              className="segment"
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setShowInstrument((v) => !v)}
          className="btn btn-ghost btn-sm xl:hidden"
        >
          Trace
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── Sources rail ───────────────────────────────────────────────── */}
        <aside
          className={cn(
            "w-[300px] shrink-0 border-r border-line bg-bg",
            showRail
              ? "absolute inset-y-14 left-0 z-20 bg-bg shadow-2xl"
              : "hidden lg:block",
          )}
        >
          <CorpusRail
            documents={documents}
            scope={scope}
            onScopeChange={setScope}
            onChanged={refresh}
            error={corpusError}
          />
        </aside>

        {/* ── Conversation ───────────────────────────────────────────────── */}
        <main className="flex min-w-0 flex-1 flex-col bg-card">
          <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[48rem] px-6 py-10">
              {messages.length === 0 && <EmptyState hasCorpus={stats.chunks > 0} />}

              <div className="space-y-12">
                {messages.map((message) => {
                  if (message.role === "user") {
                    const text = message.parts
                      .filter((p) => p.type === "text")
                      .map((p) => (p.type === "text" ? p.text : ""))
                      .join("");
                    return (
                      <div key={message.id}>
                        <p className="text-h3 leading-tight font-extrabold tracking-[-0.03em] text-fg">{text}</p>
                      </div>
                    );
                  }

                  const data = extract(message);
                  const isLast = message.id === lastAssistant?.id;
                  const meta = message.metadata;

                  return (
                    <div key={message.id} className="space-y-3">
                      {data.notice && (
                        <p className="rounded border border-amber/30 bg-amber/5 px-3 py-2 text-small text-amber">
                          {data.notice.message}
                        </p>
                      )}

                      {data.trace.length > 0 && (
                        <TraceStrip spans={data.trace} totalMs={meta?.latencyMs} />
                      )}

                      {data.text && (
                        <Answer
                          text={data.text}
                          citations={data.citations}
                          streaming={isLast && streaming}
                          onCite={() => setShowInstrument(true)}
                        />
                      )}

                      {data.grounding && <GroundingBadge grounding={data.grounding} />}

                      {data.citations.length > 0 && (
                        <CitationList citations={data.citations} />
                      )}
                    </div>
                  );
                })}

                {streaming && !lastAssistant?.parts.some((p) => p.type === "text") && (
                  <p className="text-small text-fg-3">Searching…</p>
                )}

                {error && (
                  <div className="rounded-md border border-alert/30 bg-alert/5 px-3 py-2.5">
                    <p className="text-small text-alert">{error.message}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Composer ─────────────────────────────────────────────────── */}
          <div className="shrink-0 border-t border-line bg-card py-4">
            <div className="mx-auto w-full max-w-[48rem] px-6">
              {/*
                One surface, not a field inside a box. The textarea sits flush
                and the action row sits beneath it, which gives the button room
                to breathe and makes space for the keyboard hint.
              */}
              <div className="panel flex flex-col transition-colors focus-within:border-fg-3">
                <textarea
                  ref={composerRef}
                  rows={1}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={
                    scope.size > 0
                      ? `Ask about the ${scope.size} selected ${scope.size === 1 ? "document" : "documents"}`
                      : "Ask about your documents"
                  }
                  className="max-h-[200px] min-h-[28px] w-full resize-none bg-transparent px-4 pt-3.5 text-base leading-relaxed text-fg placeholder:text-fg-3"
                />

                <div className="flex items-center justify-between gap-3 px-3 pb-3 pt-2">
                  <p className="label hidden truncate pl-1 sm:block">
                    {streaming
                      ? "Searching your documents…"
                      : "Enter to send · Shift + Enter for a new line"}
                  </p>
                  {streaming ? (
                    <button type="button" onClick={stop} className="btn btn-ghost btn-md ml-auto">
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={submit}
                      disabled={!input.trim()}
                      className="btn btn-primary btn-md ml-auto"
                    >
                      Ask
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* ── Instrument ─────────────────────────────────────────────────── */}
        <aside
          className={cn(
            "w-[380px] shrink-0 border-l border-line bg-bg",
            showInstrument
              ? "absolute inset-y-14 right-0 z-20 bg-bg shadow-2xl"
              : "hidden xl:block",
          )}
        >
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3.5">
              <h2 className="label">Retrieved</h2>
              <ChannelLegend />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {!instrument || instrument.rounds.length === 0 ? (
                <p className="px-4 py-8 text-small leading-relaxed text-fg-3">
                  Every search Colophon runs shows up here, with the passages it kept and the score
                  each one earned.
                </p>
              ) : (
                instrument.rounds.map((round) => (
                  <RetrievalRoundView key={round.id} round={round} />
                ))
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function CitationList({ citations }: { citations: Citation[] }) {
  return (
    <ol className="space-y-1 border-t border-white/6 pt-2.5">
      {citations.map((c) => (
        <li key={c.marker} className="flex gap-2 text-micro">
          <span className="mono shrink-0 text-brand-3">[{c.marker}]</span>
          <span className="min-w-0 flex-1 truncate text-fg-2">
            {breadcrumb(c.documentTitle, c.headingPath, " › ")}
            {c.page != null && <span className="text-fg-3"> · p.{c.page}</span>}
          </span>
          <span className="mono shrink-0 text-fg-3">{c.score.toFixed(3)}</span>
        </li>
      ))}
    </ol>
  );
}

function EmptyState({ hasCorpus }: { hasCorpus: boolean }) {
  return (
    <div className="max-w-[36rem] py-10">
      <h1 className="text-h2 leading-[1.08] font-extrabold tracking-[-0.03em] text-fg">
        Ask your documents something specific.
      </h1>
      <p className="mt-3 text-base leading-relaxed text-fg-2">
        Colophon searches by meaning and by exact wording at the same time, reranks what comes back
        with a cross-encoder, and cites the passage behind every claim. Open the trace panel to
        watch each search as it runs.
      </p>
      {!hasCorpus && (
        <p className="card mt-5 px-4 py-3 text-small text-fg-2">
          Add a document first — drop a file into the Sources panel, or paste a URL.
        </p>
      )}
    </div>
  );
}
