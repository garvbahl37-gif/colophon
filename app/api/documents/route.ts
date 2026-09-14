import { databaseHint } from "@/lib/db/client";
import { assertWithinRate, guardResponse } from "@/lib/util/guard";
import { corpusStats, deleteDocument, listDocuments } from "@/lib/ingest/pipeline";

export async function GET() {
  try {
    const [documents, stats] = await Promise.all([listDocuments(), corpusStats()]);
    return Response.json({ documents, stats });
  } catch (error) {
    return Response.json(
      { error: databaseHint(error), documents: [], stats: { documents: 0, chunks: 0, tokens: 0 } },
      { status: 503 },
    );
  }
}

export async function DELETE(req: Request) {
  // Deleting costs nothing and re-ingesting is always possible, so this is
  // rate-limited rather than gated: enough to stop a script emptying the
  // corpus in a loop, without a password in front of the operator's own tool.
  try {
    assertWithinRate(req, 30, "delete");
  } catch (error) {
    const refused = guardResponse(error);
    if (refused) return refused;
    throw error;
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  try {
    await deleteDocument(id);
  } catch (error) {
    return Response.json({ error: databaseHint(error) }, { status: 500 });
  }
  return Response.json({ ok: true });
}
