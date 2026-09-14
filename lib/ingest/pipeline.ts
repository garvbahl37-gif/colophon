import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { sql, toVector } from "@/lib/db/client";
import { embedDocuments } from "@/lib/ai/models";
import { loadFile, loadUrl, type LoadedDocument } from "./loaders";
import { chunkDocument } from "./chunker";
import { buildIndexedText, contextualizeChunks } from "./contextualize";

export type IngestStage =
  | "queued"
  | "parsing"
  | "chunking"
  | "contextualizing"
  | "embedding"
  | "indexing"
  | "ready"
  | "failed";

export interface IngestResult {
  documentId: string;
  title: string;
  chunkCount: number;
  status: IngestStage;
  duplicate?: boolean;
}

async function setStage(id: string, stage: IngestStage, progress: number) {
  await sql`
    UPDATE documents
    SET stage = ${stage}, status = ${stage}, progress = ${progress}, updated_at = now()
    WHERE id = ${id}
  `;
}

async function ingest(
  doc: LoadedDocument,
  opts: { checksum: string; byteSize: number; sourceUri?: string },
): Promise<IngestResult> {
  const existing = await sql`
    SELECT id, title, chunk_count FROM documents WHERE checksum = ${opts.checksum}
  `;
  if (existing.length > 0) {
    return {
      documentId: existing[0].id,
      title: existing[0].title,
      chunkCount: existing[0].chunk_count,
      status: "ready",
      duplicate: true,
    };
  }

  const id = nanoid(12);
  await sql`
    INSERT INTO documents
      (id, title, source_type, source_uri, byte_size, checksum, status, stage, char_count, metadata)
    VALUES
      (${id}, ${doc.title}, ${doc.sourceType}, ${opts.sourceUri ?? null}, ${opts.byteSize},
       ${opts.checksum}, 'parsing', 'parsing', ${doc.text.length}, ${sql.json(doc.metadata as never)})
  `;

  try {
    await setStage(id, "chunking", 0.1);
    const chunks = chunkDocument(doc);
    if (chunks.length === 0) {
      throw new Error("Document produced no chunks - is it empty or image-only?");
    }

    await setStage(id, "contextualizing", 0.2);
    const contexts = await contextualizeChunks(chunks, doc.text, doc.title, (done, total) => {
      if (done % 10 === 0) void setStage(id, "contextualizing", 0.2 + 0.4 * (done / total));
    });

    await setStage(id, "embedding", 0.65);
    const indexedTexts = chunks.map((c, i) => buildIndexedText(c, contexts[i], doc.title));
    const embeddings = await embedDocuments(indexedTexts);

    await setStage(id, "indexing", 0.9);
    // postgres.js turns each slice into a single multi-row INSERT.
    const BATCH = 100;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const rows = chunks.slice(i, i + BATCH).map((c, j) => {
        const idx = i + j;
        return {
          id: `${id}:${c.ordinal}`,
          document_id: id,
          ordinal: c.ordinal,
          content: c.content,
          context: contexts[idx] || null,
          indexed_text: indexedTexts[idx],
          heading_path: c.headingPath,
          page: c.page,
          char_start: c.charStart,
          char_end: c.charEnd,
          token_count: c.tokenCount,
          embedding: toVector(embeddings[idx]),
        };
      });
      await sql`INSERT INTO chunks ${sql(rows)}`;
    }

    await sql`
      UPDATE documents
      SET status = 'ready', stage = 'ready', progress = 1,
          chunk_count = ${chunks.length}, updated_at = now()
      WHERE id = ${id}
    `;

    return { documentId: id, title: doc.title, chunkCount: chunks.length, status: "ready" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE documents
      SET status = 'failed', stage = 'failed', error = ${message}, updated_at = now()
      WHERE id = ${id}
    `;
    throw error;
  }
}

export async function ingestFile(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
): Promise<IngestResult> {
  const doc = await loadFile(buffer, filename, mimeType);
  return ingest(doc, {
    checksum: createHash("sha256").update(buffer).digest("hex"),
    byteSize: buffer.byteLength,
    sourceUri: filename,
  });
}

export async function ingestUrl(url: string): Promise<IngestResult> {
  const doc = await loadUrl(url);
  return ingest(doc, {
    checksum: createHash("sha256").update(`${url} ${doc.text}`).digest("hex"),
    byteSize: Buffer.byteLength(doc.text),
    sourceUri: url,
  });
}

export async function deleteDocument(id: string) {
  await sql`DELETE FROM documents WHERE id = ${id}`;
}

export async function listDocuments() {
  return sql`
    SELECT id, title, source_type, source_uri, byte_size, status, stage, progress,
           error, chunk_count, char_count, metadata, created_at
    FROM documents
    ORDER BY created_at DESC
  `;
}

export async function corpusStats() {
  const [row] = await sql`
    SELECT
      (SELECT count(*)::int FROM documents WHERE status = 'ready') AS documents,
      (SELECT count(*)::int FROM chunks) AS chunks,
      (SELECT coalesce(sum(token_count), 0)::int FROM chunks) AS tokens
  `;
  return row as { documents: number; chunks: number; tokens: number };
}
