import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { assertGatewayKey } from "@/lib/ai/models";
import { databaseHint } from "@/lib/db/client";
import { assertWithinRate, guardResponse } from "@/lib/util/guard";
import type { ColophonMode, ColophonUIMessage } from "@/lib/ai/types";
import { runColophon } from "@/lib/retrieval/orchestrator";
import { searchableDocumentIds } from "@/lib/ingest/pipeline";
import { currentOwner } from "@/lib/util/owner";

/** Agentic runs can chain several retrievals; give them room. */
export const maxDuration = 300;

interface Body {
  messages: ColophonUIMessage[];
  mode?: ColophonMode;
  documentIds?: string[] | null;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    assertWithinRate(req, 20, "chat");
  } catch (error) {
    const refused = guardResponse(error);
    if (refused) return refused;
    throw error;
  }

  const { messages = [], mode = "agent", documentIds = null } = body;
  const owner = await currentOwner();

  /*
    The caller supplies the whole conversation, so it is untrusted input, not
    just state we handed them. Without a ceiling this is an open LLM proxy
    billed to our key.
  */
  if (messages.length > 40) {
    return Response.json({ error: "Conversation is too long" }, { status: 413 });
  }
  const totalChars = messages.reduce(
    (n, m) =>
      n +
      (m.parts ?? []).reduce(
        (c, p) => c + (p.type === "text" ? (p as { text: string }).text.length : 0),
        0,
      ),
    0,
  );
  if (totalChars > 60_000) {
    return Response.json({ error: "Conversation is too large" }, { status: 413 });
  }
  if (messages.at(-1)?.role !== "user") {
    return Response.json({ error: "The last message must be from the user" }, { status: 400 });
  }
  const last = messages.at(-1);
  const question =
    last?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim() ?? "";

  if (!question) return Response.json({ error: "No question provided" }, { status: 400 });

  try {
    assertGatewayKey();
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }

  const stream = createUIMessageStream<ColophonUIMessage>({
    execute: async ({ writer }) => {
      /*
        Access is resolved here, once, and passed down as an explicit list.

        Retrieval already filters by document id, so the permitted set is the
        natural place to enforce who may read what -- every arm of the hybrid
        query, every agent tool call and every neighbour expansion inherits it
        without each having to remember. The selection the reader made in the
        rail narrows that set and can never widen it: an id they do not own is
        dropped rather than honoured.

        An empty result is passed through as an empty list, not as null. Null
        means "the whole corpus" one layer down, which is exactly the wrong
        answer for a visitor entitled to nothing.
      */
      const searchable = await searchableDocumentIds(owner);
      const permitted = new Set(searchable);
      const scoped = documentIds?.length
        ? documentIds.filter((id) => permitted.has(id))
        : searchable;

      await runColophon({
        question,
        messages,
        documentIds: scoped,
        ownerId: owner,
        mode,
        writer,
      });
    },
    // Surface the real reason in the UI. A RAG pipeline fails in specific,
    // actionable ways (no rerank model on the key, index dimension mismatch,
    // Postgres down) and hiding that behind "An error occurred" wastes the
    // user's time.
    onError: (error) => databaseHint(error),
  });

  return createUIMessageStreamResponse({ stream });
}
