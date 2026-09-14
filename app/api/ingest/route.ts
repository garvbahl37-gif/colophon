import { ingestFile, ingestUrl } from "@/lib/ingest/pipeline";
import { assertGatewayKey } from "@/lib/ai/models";

/** Contextualising a large document is many small LLM calls; allow for it. */
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    assertGatewayKey();
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }

  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const { url } = (await req.json()) as { url?: string };
      if (!url) return Response.json({ error: "Missing url" }, { status: 400 });
      return Response.json(await ingestUrl(url));
    }

    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) return Response.json({ error: "No files provided" }, { status: 400 });

    const results = [];
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      results.push(await ingestFile(buffer, file.name, file.type));
    }
    return Response.json({ results });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
