import { corpusStats, deleteDocument, listDocuments } from "@/lib/ingest/pipeline";

export async function GET() {
  try {
    const [documents, stats] = await Promise.all([listDocuments(), corpusStats()]);
    return Response.json({ documents, stats });
  } catch (error) {
    return Response.json(
      { error: (error as Error).message, documents: [], stats: { documents: 0, chunks: 0, tokens: 0 } },
      { status: 503 },
    );
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
  await deleteDocument(id);
  return Response.json({ ok: true });
}
