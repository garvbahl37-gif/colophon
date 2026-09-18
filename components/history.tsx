"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/util/cn";

/**
 * Conversations this browser has had.
 *
 * Threads were kept in localStorage, which loses everything the moment site
 * data is cleared and could only ever hold the one conversation it kept
 * overwriting. They are in the database now, scoped to the same owner as the
 * documents, so closing the tab is not the same as throwing the thread away.
 *
 * The list shows the first thing asked rather than a generated title. Naming a
 * conversation is not worth a model call on a provider that serialises them,
 * and a paraphrase is harder to find again than the question itself.
 */

export interface Conversation {
  id: string;
  title: string;
  turns: number;
  updatedAt: string;
}

/** Relative where it helps and absolute where it does not. */
function when(iso: string): string {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 90) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h ago`;
  if (secs < 604_800) return `${Math.round(secs / 86_400)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const data = await res.json();
      setConversations(data.conversations ?? []);
    } catch {
      /* the list is a convenience; failing to load it must not break the chat */
    }
  }, []);

  useEffect(() => {
    // Fetching the list is the "subscribe to an external system" case the rule
    // exists to allow; the state lands in the async callback, not in the body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return { conversations, refresh, setConversations };
}

export function HistoryRail({
  conversations,
  activeId,
  onOpen,
  onNew,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-3">
        <button type="button" onClick={onNew} className="btn btn-ghost btn-sm w-full">
          New conversation
        </button>
      </div>

      <ul className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-line">
        {conversations.length === 0 && (
          <li className="px-4 py-8 text-small leading-relaxed text-fg-3">
            Nothing yet. Conversations are kept here after the first answer, and stay when you
            come back.
          </li>
        )}

        {conversations.map((c) => (
          <li
            key={c.id}
            className={cn(
              "group border-b border-hairline transition-colors hover:bg-bg-2",
              activeId === c.id && "bg-bg-2",
            )}
          >
            <div className="flex items-start gap-2 px-4 py-3">
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                className="min-w-0 flex-1 text-left"
              >
                <p
                  className={cn(
                    "truncate text-small",
                    activeId === c.id ? "font-semibold text-fg" : "text-fg-2",
                  )}
                  title={c.title}
                >
                  {c.title}
                </p>
                <p className="mono mt-0.5 text-micro text-fg-3">
                  {Math.ceil(c.turns / 2)} {Math.ceil(c.turns / 2) === 1 ? "exchange" : "exchanges"} ·{" "}
                  {when(c.updatedAt)}
                </p>
              </button>

              <button
                type="button"
                onClick={() => onDelete(c.id)}
                aria-label={`Delete conversation: ${c.title}`}
                className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center text-base leading-none text-fg-3 opacity-0 transition-all hover:bg-bg-2 hover:text-alert focus-visible:opacity-100 group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
