"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/util/cn";

export interface DocumentRow {
  id: string;
  title: string;
  source_type: string;
  source_uri: string | null;
  byte_size: number;
  status: string;
  stage: string | null;
  progress: number;
  error: string | null;
  chunk_count: number;
}

export interface CorpusStats {
  documents: number;
  chunks: number;
  tokens: number;
}

const BUSY = new Set(["parsing", "chunking", "contextualizing", "embedding", "indexing", "queued"]);

/** Human-readable name for each ingest stage, in the interface's own voice. */
const STAGE_COPY: Record<string, string> = {
  queued: "Waiting",
  parsing: "Reading",
  chunking: "Splitting",
  contextualizing: "Adding context",
  embedding: "Embedding",
  indexing: "Indexing",
};

export function useCorpus() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [stats, setStats] = useState<CorpusStats>({ documents: 0, chunks: 0, tokens: 0 });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/documents");
      const data = await res.json();
      if (data.error) setError(data.error);
      else setError(null);
      setDocuments(data.documents ?? []);
      setStats(data.stats ?? { documents: 0, chunks: 0, tokens: 0 });
      return data.documents as DocumentRow[];
    } catch (e) {
      setError((e as Error).message);
      return [];
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while something is actually moving, then stop.
  useEffect(() => {
    if (!documents.some((d) => BUSY.has(d.status))) return;
    const timer = setInterval(refresh, 900);
    return () => clearInterval(timer);
  }, [documents, refresh]);

  return { documents, stats, error, refresh };
}

export function CorpusRail({
  documents,
  scope,
  onScopeChange,
  onChanged,
  error,
}: {
  documents: DocumentRow[];
  scope: Set<string>;
  onScopeChange: (next: Set<string>) => void;
  onChanged: () => void;
  error: string | null;
}) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (list.length === 0) return;
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    for (const f of list) form.append("files", f);
    try {
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      const data = await res.json();
      if (data.error) setMessage(data.error);
      else {
        const dupes = (data.results ?? []).filter((r: { duplicate?: boolean }) => r.duplicate).length;
        if (dupes) setMessage(`${dupes} already indexed, skipped`);
      }
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function addUrl() {
    const target = url.trim();
    if (!target) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const data = await res.json();
      if (data.error) setMessage(data.error);
      else setUrl("");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function remove(id: string) {
    await fetch(`/api/documents?id=${id}`, { method: "DELETE" });
    const next = new Set(scope);
    next.delete(id);
    onScopeChange(next);
    onChanged();
  }

  function toggle(id: string) {
    const next = new Set(scope);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onScopeChange(next);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h2 className="label">Sources</h2>
        {scope.size > 0 && (
          <button
            type="button"
            onClick={() => onScopeChange(new Set())}
            className="mono text-micro text-brand-3 hover:underline"
          >
            searching {scope.size} of {documents.length} — clear
          </button>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(e.dataTransfer.files);
        }}
        className={cn(
          "mx-4 border border-dashed px-4 py-7 text-center transition-colors",
          dragging ? "border-brand bg-brand/5" : "border-line-lit hover:border-fg-3",
        )}
      >
        <p className="text-small text-fg-2">
          {busy ? "Working…" : dragging ? "Release to add" : "Drop files here"}
        </p>
        <p className="mt-0.5 text-micro text-fg-3">PDF, DOCX, Markdown, HTML, text</p>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="btn btn-ghost btn-sm mt-3"
        >
          Choose files
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept=".pdf,.docx,.md,.mdx,.markdown,.txt,.html,.htm,.json,.csv"
          onChange={(e) => e.target.files && void upload(e.target.files)}
        />
      </div>

      <div className="mx-4 mt-3 flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void addUrl()}
          placeholder="Or paste a URL"
          className="h-8 min-w-0 flex-1 border border-line bg-card px-3 text-small text-fg transition-colors placeholder:text-fg-3 focus:border-fg-3 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void addUrl()}
          disabled={busy || !url.trim()}
          className="btn btn-ghost btn-sm"
        >
          Add
        </button>
      </div>

      {(message || error) && (
        <p className="mx-4 mt-3 border border-alert/40 bg-alert/5 px-3 py-2 text-small text-alert">
          {error ?? message}
        </p>
      )}

      <ul className="mt-4 min-h-0 flex-1 overflow-y-auto border-t border-line">
        {documents.length === 0 && !error && (
          <li className="px-4 py-8 text-small leading-relaxed text-fg-3">
            Nothing indexed yet. Add a document and Colophon will have something to ground answers in.
          </li>
        )}

        {documents.map((doc) => {
          const busyDoc = BUSY.has(doc.status);
          const failed = doc.status === "failed";
          const selected = scope.has(doc.id);

          return (
            <li key={doc.id} className="group border-b border-hairline transition-colors hover:bg-bg-2">
              <div className="flex items-start gap-2.5 px-4 py-3">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggle(doc.id)}
                  disabled={doc.status !== "ready"}
                  aria-label={`Search only ${doc.title}`}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#0a0a0a] disabled:cursor-not-allowed disabled:opacity-30"
                />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-small text-fg" title={doc.title}>
                    {doc.title}
                  </p>

                  {busyDoc ? (
                    <>
                      <div className="mt-1.5 h-[2px] w-full overflow-hidden  bg-line">
                        <div
                          className="h-full  bg-jade transition-[width] duration-500"
                          style={{ width: `${Math.round(doc.progress * 100)}%` }}
                        />
                      </div>
                      <p className="mono mt-1 text-micro text-fg-3">
                        {STAGE_COPY[doc.status] ?? doc.status}
                      </p>
                    </>
                  ) : failed ? (
                    <p className="mt-0.5 text-micro leading-snug text-alert">
                      {doc.error ?? "Could not be indexed"}
                    </p>
                  ) : (
                    <p className="mono mt-0.5 text-micro text-fg-3">
                      {doc.chunk_count} passages · {doc.source_type}
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => void remove(doc.id)}
                  aria-label={`Remove ${doc.title}`}
                  className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center text-base leading-none text-fg-3 opacity-0 transition-all hover:bg-bg-2 hover:text-alert focus-visible:opacity-100 group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
