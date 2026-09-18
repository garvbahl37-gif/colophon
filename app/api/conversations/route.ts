import { currentOwner } from "@/lib/util/owner";
import { assertWithinRate, guardResponse } from "@/lib/util/guard";
import { databaseHint } from "@/lib/db/client";
import {
  deleteConversation,
  listConversations,
  loadConversation,
  saveConversation,
} from "@/lib/history";

/**
 * A reader's conversations. Every route here is scoped to their owner id, and
 * an id belonging to someone else behaves exactly like one that does not exist
 * — the same rule the documents API follows, for the same reason: a different
 * answer for "not yours" and "no such thing" is a way to enumerate other
 * people's threads.
 */

export async function GET(req: Request) {
  try {
    assertWithinRate(req, 60, "conversations");
  } catch (error) {
    const refused = guardResponse(error);
    if (refused) return refused;
    throw error;
  }

  try {
    const owner = await currentOwner();
    const id = new URL(req.url).searchParams.get("id");
    if (id) {
      const messages = await loadConversation(id, owner);
      if (!messages) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ id, messages });
    }
    return Response.json({ conversations: await listConversations(owner) });
  } catch (error) {
    return Response.json({ error: databaseHint(error), conversations: [] }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    assertWithinRate(req, 120, "conversations-write");
  } catch (error) {
    const refused = guardResponse(error);
    if (refused) return refused;
    throw error;
  }

  let body: { id?: string | null; messages?: unknown[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return Response.json({ error: "Nothing to save" }, { status: 400 });
  /*
    A ceiling, because this is a caller-supplied blob written to our database.
    Long conversations are legitimate; a megabyte of them in one request is not.
  */
  if (JSON.stringify(messages).length > 400_000) {
    return Response.json({ error: "Conversation is too large to save" }, { status: 413 });
  }

  try {
    const saved = await saveConversation({
      id: body.id ?? null,
      ownerId: await currentOwner(),
      messages: messages as never,
    });
    return Response.json(saved);
  } catch (error) {
    return Response.json({ error: databaseHint(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
  try {
    await deleteConversation(id, await currentOwner());
  } catch (error) {
    return Response.json({ error: databaseHint(error) }, { status: 500 });
  }
  return Response.json({ ok: true });
}
