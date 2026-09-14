import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { assertGatewayKey } from "@/lib/ai/models";
import type { ColophonMode, ColophonUIMessage } from "@/lib/ai/types";
import { runColophon } from "@/lib/retrieval/orchestrator";

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

  const { messages = [], mode = "agent", documentIds = null } = body;
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
      await runColophon({
        question,
        messages,
        documentIds: documentIds?.length ? documentIds : null,
        mode,
        writer,
      });
    },
    // Surface the real reason in the UI. A RAG pipeline fails in specific,
    // actionable ways (no rerank model on the key, index dimension mismatch,
    // Postgres down) and hiding that behind "An error occurred" wastes the
    // user's time.
    onError: (error) => (error instanceof Error ? error.message : String(error)),
  });

  return createUIMessageStreamResponse({ stream });
}
