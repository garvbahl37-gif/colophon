"use client";

import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/util/cn";
import { breadcrumb } from "@/lib/util/breadcrumb";
import { plainText } from "@/lib/util/plain-text";
import type { ColophonMode, ColophonUIMessage, RetrievalRound } from "@/lib/ai/types";
import type { Citation, Contradiction, GroundingIssue, TraceSpan } from "@/lib/retrieval/types";
import { Answer, GroundingBadge } from "./answer";
import { Boot } from "./boot";
import { CorpusRail, useCorpus, type CorpusStats, type DocumentRow } from "./corpus";
import { RetrievalRoundView } from "./passages";
import { ChannelLegend, TraceStrip } from "./trace";

/** Where a conversation is kept: this browser, and nothing else. */
const THREAD_KEY = "colophon.thread";
/** Enough to keep the thread useful without pushing at the storage quota. */
const THREAD_LIMIT = 30;

interface Extracted {
  text: string;
  trace: TraceSpan[];
  rounds: RetrievalRound[];
  citations: Citation[];
  grounding: {
    supported: boolean;
    issues: GroundingIssue[];
    contradictions: Contradiction[];
    citationDensity: number;
  } | null;
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
    Collapse is a separate idea from the narrow-viewport drawers above.

    Below their breakpoints the rails have nowhere to live and open OVER the
    conversation; these two say whether a rail takes a column at all on a screen
    wide enough to hold one. Reading a long grounded answer beside two dense
    instrument panels is a lot to hold at once, and the panels are reference
    material -- worth having, not worth staring at.

    Both start expanded so the server and first client render agree; the stored
    preference is applied immediately after, which is a frame of correction
    rather than a hydration mismatch.
  */
  const [railOpen, setRailOpen] = useState(true);
  const [instrumentOpen, setInstrumentOpen] = useState(true);
  /*
    Always starts true so the server and the first client render agree. Reading
    sessionStorage in the initialiser instead produces a hydration mismatch for
    anyone who has already seen the boot screen this session. Boot decides for
    itself whether to play or dismiss immediately.
  */
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    // Reading a browser-only store after mount is the point: the first render
    // must match the server's, so the preference cannot be known any earlier.
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRailOpen(localStorage.getItem("colophon.railOpen") !== "0");
      setInstrumentOpen(localStorage.getItem("colophon.instrumentOpen") !== "0");
    } catch {
      /* private browsing: both stay open, which is the safe default */
    }
  }, []);

  function toggleRail() {
    setRailOpen((open) => {
      try {
        localStorage.setItem("colophon.railOpen", open ? "0" : "1");
      } catch {
        /* preference simply will not persist */
      }
      return !open;
    });
  }

  function toggleInstrument() {
    setInstrumentOpen((open) => {
      try {
        localStorage.setItem("colophon.instrumentOpen", open ? "0" : "1");
      } catch {
        /* preference simply will not persist */
      }
      return !open;
    });
  }

  // Bracket keys frame the conversation the way they frame the layout. Ignored
  // while typing, or a question containing a bracket would fold the panels.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "[") toggleRail();
      else if (event.key === "]") toggleInstrument();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /*
    The transport carries no settings of its own.

    It used to read mode and scope through refs assigned during render, so that
    toggling either did not tear down and rebuild the chat. That works and is
    unsound: mutating a ref while rendering is a write React may discard, and a
    render that is thrown away leaves the ref holding a value no state matches.
    Sending them with the message instead reads them from current state inside
    an event handler, which is when they are actually known.
  */
  const transport = useMemo(
    () => new DefaultChatTransport<ColophonUIMessage>({ api: "/api/chat" }),
    [],
  );

  const { messages, setMessages, sendMessage, status, stop, error } = useChat<ColophonUIMessage>({
    transport,
  });

  const streaming = status === "streaming" || status === "submitted";

  /*
    The conversation lives in this browser and nowhere else.

    The server records the shape of a run for measurement -- stage timings,
    whether grounding held -- and deliberately not the question or the answer,
    because a shared instance with no accounts has nowhere to put a transcript
    that the person who wrote it can see and no one else can. Keeping it here
    means a reload no longer throws the thread away, and clearing it is the
    reader's own decision rather than a request to a server.

    Restored after mount rather than in the initial state, so the server and
    first client render agree. Written back only when a turn is finished: no
    point storing a half-streamed answer, and it keeps the writes to one per
    exchange.
  */
  const restored = useRef(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(THREAD_KEY);
      if (saved) setMessages(JSON.parse(saved) as ColophonUIMessage[]);
    } catch {
      /* unreadable or from an older shape: start clean rather than crash */
    }
    restored.current = true;
  }, [setMessages]);

  useEffect(() => {
    if (!restored.current || streaming) return;
    try {
      if (messages.length === 0) localStorage.removeItem(THREAD_KEY);
      else localStorage.setItem(THREAD_KEY, JSON.stringify(messages.slice(-THREAD_LIMIT)));
    } catch {
      /* quota, or private browsing: the thread simply will not survive a reload */
    }
  }, [messages, streaming]);

  function clearThread() {
    setMessages([]);
    try {
      localStorage.removeItem(THREAD_KEY);
    } catch {
      /* nothing to remove */
    }
  }

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
    void sendMessage(
      { text: question },
      { body: { mode, documentIds: [...scope] } },
    );
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

        {messages.length > 0 && (
          <button
            type="button"
            onClick={clearThread}
            title="Delete this conversation from this browser"
            className="btn btn-bare btn-sm hidden shrink-0 sm:inline-flex"
          >
            Clear
          </button>
        )}

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

      {/* `relative` is load-bearing: the two rails become absolute overlays on
          narrow viewports, and without a positioned ancestor they resolve
          against the page instead of this row — sliding over the masthead and
          pushing the conversation under whichever rail is open. */}
      <div className="relative flex min-h-0 flex-1">
        {/* Below xl the conversation and both rails cannot all fit, so a rail
            opens over the conversation. A drawer without a scrim reads as a
            layout fault rather than a choice — the text simply disappears
            under something. The scrim says the panel is temporary and gives
            the obvious way out. */}
        {(showRail || showInstrument) && (
          <button
            type="button"
            aria-label="Close panel"
            onClick={() => {
              setShowRail(false);
              setShowInstrument(false);
            }}
            className={cn(
              "absolute inset-0 z-10 cursor-default bg-fg/15 backdrop-blur-[1px]",
              // Disappears at whichever width the open panel rejoins the
              // layout, so a scrim never dims a panel that is simply a column.
              showInstrument ? "xl:hidden" : "lg:hidden",
            )}
          />
        )}
        {/* Collapsed, the rail keeps its edge and its name. A bare icon button
            would say a panel exists but not which, and the count is the one
            fact worth keeping visible when the contents are not. */}
        {!railOpen && (
          <button
            type="button"
            onClick={toggleRail}
            title="Show sources  ["
            aria-label="Show sources"
            aria-expanded={false}
            className="edge hidden shrink-0 border-r border-line lg:flex"
          >
            <span aria-hidden className="edge-caret">
              ›
            </span>
            <span className="edge-label">Sources</span>
            <span aria-hidden className="mono text-micro text-fg-3">
              {documents.length}
            </span>
          </button>
        )}

        {/* ── Sources rail ───────────────────────────────────────────────── */}
        <aside
          className={cn(
            "w-[300px] shrink-0 border-r border-line bg-bg",
            // Overlay only where it is not already in flow. Going absolute at a
            // width that has room for it drops 300px out of the layout and the
            // conversation lurches sideways to fill the gap.
            showRail
              ? "absolute inset-y-0 left-0 z-20 max-w-[85vw] shadow-2xl lg:static lg:z-auto lg:max-w-none lg:shadow-none"
              : railOpen
                ? "hidden lg:block"
                : "hidden",
          )}
        >
          <CorpusRail
            onCollapse={toggleRail}
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
              {messages.length === 0 && (
                <EmptyState
                  hasCorpus={stats.chunks > 0}
                  documents={documents}
                  stats={stats}
                  onPick={(question) => {
                    setInput(question);
                    composerRef.current?.focus();
                  }}
                />
              )}

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

                      {data.grounding && (
                        <GroundingBadge
                          grounding={data.grounding}
                          onCite={() => setShowInstrument(true)}
                        />
                      )}

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
            // Same rule, and it matters more here: clicking a citation opens
            // this panel at any width, so on a wide screen the old version
            // turned an in-flow column into an overlay mid-read and shifted
            // the whole conversation under it.
            showInstrument
              ? "absolute inset-y-0 right-0 z-20 max-w-[92vw] shadow-2xl xl:static xl:z-auto xl:max-w-none xl:shadow-none"
              : instrumentOpen
                ? "hidden xl:block"
                : "hidden",
          )}
        >
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleInstrument}
                  title="Hide trace  ]"
                  aria-label="Hide trace"
                  aria-expanded
                  className="collapse-handle hidden xl:block"
                >
                  ›
                </button>
                <h2 className="label">Retrieved</h2>
              </div>
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

        {/* Mirror of the Sources strip, on the other edge. The passage count is
            the fact worth keeping: it says whether there is anything in there. */}
        {!instrumentOpen && (
          <button
            type="button"
            onClick={toggleInstrument}
            title="Show trace  ]"
            aria-label="Show trace"
            aria-expanded={false}
            className="edge hidden shrink-0 border-l border-line xl:flex"
          >
            <span aria-hidden className="edge-caret rotate-180">
              ›
            </span>
            <span className="edge-label">Retrieved</span>
            <span aria-hidden className="mono text-micro text-fg-3">
              {instrument?.rounds.reduce((n, r) => n + r.passages.length, 0) || ""}
            </span>
          </button>
        )}
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

/**
 * The conversation before there is one.
 *
 * This was a headline and a paragraph in an otherwise empty column, which is
 * the emptiest an interface ever looks and the first thing anyone sees. The
 * replacement is not decoration: it answers the two questions actually being
 * asked at that moment -- what is in here, and what can I ask it.
 *
 * Openers are built from the corpus rather than written in advance, so they
 * name documents that genuinely exist, and clicking one fills the composer
 * instead of sending, because the value is in showing the shape of a good
 * question, not in answering a question nobody asked.
 */
function EmptyState({
  hasCorpus,
  documents,
  stats,
  onPick,
}: {
  hasCorpus: boolean;
  documents: DocumentRow[];
  stats: CorpusStats;
  onPick: (question: string) => void;
}) {
  const ready = documents.filter((d) => d.status === "ready");
  // Largest first: the document with the most passages has the most to answer.
  const named = [...ready].sort((a, b) => b.chunk_count - a.chunk_count).slice(0, 3);

  /*
    Three different SHAPES of question, not the same sentence three times.

    A list of "what does X say" repeated per document teaches nothing and reads
    as filler. These each exercise something the system does that a plain
    keyword search does not: grounded summary with per-claim citations,
    reasoning across two documents at once, and the verbatim-wording path that
    the trigram index exists to serve.
  */
  const clean = (t: string) =>
    plainText(t).replace(/\s*[-–—|·]\s*(Wikipedia|Medium|Blog).*$/i, "").trim();

  const titles = named.map((d) => clean(d.title)).filter(Boolean);
  const openers: string[] = [];
  if (titles[0]) openers.push(`Summarise "${titles[0]}", with a citation for each point.`);
  if (titles[1]) {
    openers.push(`Where do "${titles[0]}" and "${titles[1]}" overlap or disagree?`);
  }
  if (titles[0]) {
    openers.push(`Quote the exact wording in "${titles[titles.length - 1]}" about limits or defaults.`);
  }

  const HOW = [
    ["01", "Search", "Meaning and exact wording at once, fused into one ranking."],
    ["02", "Rerank", "A cross-encoder reads query and passage together and reorders."],
    ["03", "Cite", "Every claim carries the passage it came from, with its score."],
  ] as const;

  return (
    <div className="py-10">
      <h1 className="max-w-[20ch] text-h2 leading-[1.06] font-extrabold tracking-[-0.03em] text-fg">
        Ask your documents something specific.
      </h1>
      <p className="mt-4 max-w-[54ch] text-base leading-relaxed text-fg-2">
        Colophon searches by meaning and by exact wording at the same time, reranks what comes back
        with a cross-encoder, and cites the passage behind every claim.
      </p>

      {hasCorpus ? (
        <>
          {openers.length > 0 && (
            <div className="mt-9">
              <p className="label">Start with</p>
              <ul className="mt-3 border-t border-line">
                {openers.map((o) => (
                  <li key={o}>
                    <button
                      type="button"
                      onClick={() => onPick(o)}
                      className="group flex w-full items-baseline gap-3 border-b border-hairline py-3 text-left transition-colors hover:bg-bg-2"
                    >
                      <span
                        aria-hidden
                        className="mono shrink-0 text-micro text-line-lit transition-colors group-hover:text-brand"
                      >
                        →
                      </span>
                      <span className="min-w-0 flex-1 text-small leading-snug text-fg-2 transition-colors group-hover:text-fg">
                        {o}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-8 max-w-[54ch] text-micro leading-relaxed text-fg-3">
            Documents you add are private to this browser. This conversation is kept here too —
            never on the server — and Clear removes it.
          </p>

          <dl className="mono mt-4 flex flex-wrap gap-x-6 gap-y-1 text-micro text-fg-3">
            <div className="flex gap-1.5">
              <dt>documents</dt>
              <dd className="text-fg">{stats.documents}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>passages</dt>
              <dd className="text-fg">{stats.chunks}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>indexes</dt>
              <dd className="text-fg">3</dd>
            </div>
          </dl>
        </>
      ) : (
        <div className="card mt-8 px-4 py-3.5">
          <p className="text-small text-fg">Nothing indexed yet.</p>
          <p className="mt-1 text-small leading-relaxed text-fg-2">
            Drop a file into the Sources panel, or paste a URL. Colophon will read it, write a
            situating line for each passage, and index it three ways.
          </p>
        </div>
      )}

      {/* What happens to a question, stated once, where it is relevant. */}
      <div className="mt-12 grid gap-px border-t border-line bg-line sm:grid-cols-3">
        {HOW.map(([no, name, detail]) => (
          <div key={no} className="bg-card pt-4 sm:px-4 sm:first:pl-0">
            <p className="mono text-micro text-brand">{no}</p>
            <p className="mt-1 text-small font-bold text-fg">{name}</p>
            <p className="mt-1 text-micro leading-relaxed text-fg-3">{detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
