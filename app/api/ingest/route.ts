import { ingestFile, ingestUrl } from "@/lib/ingest/pipeline";
import { assertGatewayKey } from "@/lib/ai/models";
import { assertWithinRate, guardResponse } from "@/lib/util/guard";
import { assertWithinIngestBudget } from "@/lib/util/budget";

/** Contextualising a large document is many small LLM calls; allow for it. */
export const maxDuration = 300;

/** One document can produce one LLM call per chunk, so this is a cost ceiling. */
const MAX_FILES = 5;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    assertWithinRate(req, 10, "ingest");
    await assertWithinIngestBudget();
  } catch (error) {
    const refused = guardResponse(error);
    if (refused) return refused;
    throw error;
  }

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
    if (files.length > MAX_FILES) {
      return Response.json({ error: `At most ${MAX_FILES} files per request` }, { status: 413 });
    }
    const tooBig = files.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) {
      return Response.json(
        { error: `${tooBig.name} is larger than ${MAX_FILE_BYTES / 1e6}MB` },
        { status: 413 },
      );
    }

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
