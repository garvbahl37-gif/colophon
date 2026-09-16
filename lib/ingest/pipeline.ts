import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { sql, toVector } from "@/lib/db/client";
import { embedDocuments } from "@/lib/ai/models";
import { loadFile, loadUrl, type LoadedDocument } from "./loaders";
import { chunkDocument } from "./chunker";
import { buildIndexedText, contextualizeChunks } from "./contextualize";
import { compareVersions, describeChange, type VersionChange } from "./versions";

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
  opts: { checksum: string; byteSize: number; sourceUri?: string; ownerId: string | null },
  defer?: Defer,
): Promise<IngestResult> {
  /*
    Report the row's real state, and let a broken one be retried.

    This previously selected only id/title/chunk_count and returned a literal
    status of "ready". So a document whose ingest failed, or was killed by a
    function timeout mid-pipeline, would answer every future upload of the same
    file with "already indexed" — while holding zero chunks. The user believed
    it was searchable, the agent correctly reported the corpus did not cover
    it, and nothing short of manually deleting the row could fix it.
  */
  /*
    Scoped to the owner. A global checksum lookup would answer one visitor's
    upload with another visitor's document row -- telling them it was "already
    indexed", handing them its id, and giving them nothing they may read.
  */
  const [existing] = await sql<
    { id: string; title: string; chunk_count: number; status: IngestStage }[]
  >`
    SELECT id, title, chunk_count, status FROM documents
    WHERE checksum = ${opts.checksum}
      AND owner_id IS NOT DISTINCT FROM ${opts.ownerId}
  `;

  if (existing) {
    const usable = existing.status === "ready" && existing.chunk_count > 0;
    if (usable) {
      return {
        documentId: existing.id,
        title: existing.title,
        chunkCount: existing.chunk_count,
        status: existing.status,
        duplicate: true,
      };
    }
    // Failed or half-finished: clear it so this upload actually re-ingests.
    await sql`DELETE FROM documents WHERE id = ${existing.id}`;
  }

  /*
    Is this a new version of something already here?

    Identity is the source it came from, not its bytes: the same URL fetched a
    month later, or the same filename uploaded again, is the same document with
    different content. Matching on checksum can only ever say "identical", which
    is the one case that needs no work.

    The old row is kept and marked superseded rather than updated in place.
    Citations already handed to a reader keep resolving, the previous text stays
    readable, and "what changed" remains answerable -- none of which survives
    overwriting a row.
  */
  /*
    A URL identifies a document. A filename does not.

    Matching on source_uri alone meant two unrelated uploads that happened to
    share a name -- notes.md, README.md, report.pdf, which is most of what people
    upload -- were treated as revisions of each other, and the second silently
    superseded the first. Not deleted: hidden, from search and from the listing,
    with nothing to say it had happened. Measured: uploading a payments runbook
    and then a kubernetes runbook, both named notes.md, left one document.

    So a fetched URL still versions on its address, which genuinely identifies
    it, and a file has to agree on its title as well. The title is derived from
    the content, so an edited document keeps it and an unrelated one does not.
    When that guess is wrong the result is two documents where there should have
    been one -- visible, and fixable by the reader -- rather than one where there
    should have been two, which is invisible and is not.
  */
  const versionsOnUriAlone = doc.sourceType === "url";
  const [previous] = opts.sourceUri
    ? await sql<{ id: string; version: number }[]>`
        SELECT id, version FROM documents
        WHERE source_uri = ${opts.sourceUri}
          AND owner_id IS NOT DISTINCT FROM ${opts.ownerId}
          AND superseded_by IS NULL
          AND status = 'ready'
          AND (${versionsOnUriAlone} OR title = ${doc.title})
        ORDER BY version DESC
        LIMIT 1
      `
    : [];

  const id = nanoid(12);
  await sql`
    INSERT INTO documents
      (id, owner_id, title, source_type, source_uri, byte_size, checksum, status, stage,
       char_count, metadata, version, supersedes)
    VALUES
      (${id}, ${opts.ownerId}, ${doc.title}, ${doc.sourceType}, ${opts.sourceUri ?? null},
       ${opts.byteSize}, ${opts.checksum}, 'parsing', 'parsing', ${doc.text.length},
       ${sql.json(doc.metadata as never)},
       ${(previous?.version ?? 0) + 1}, ${previous?.id ?? null})
  `;

  /*
    Everything past this point is slow, and none of it is anything the caller
    can act on. Contextualising a page is dozens of generations, and this
    provider runs them one at a time however many are issued at once, so a
    50-chunk document is minutes of model time. Holding the HTTP request open
    for it freezes the Sources panel behind a "Working…" label and tells the
    reader nothing.

    The document row already exists and already carries stage and progress, and
    the rail already polls them. So when the caller can defer work past the
    response -- on Vercel, waitUntil -- the row is returned the moment it
    exists and the reader watches it fill in. Without a defer (a script, a
    test) the behaviour is unchanged and the promise is awaited.
  */
  const work = finish();
  if (defer) {
    // The row records its own failure, so a rejection here is already
    // reported; swallowing it only stops an unhandled rejection.
    defer(work.catch(() => {}));
    return { documentId: id, title: doc.title, chunkCount: 0, status: "parsing" };
  }
  return work;

  async function finish(): Promise<IngestResult> {
  try {
    await setStage(id, "chunking", 0.1);
    const chunks = chunkDocument(doc);
    if (chunks.length === 0) {
      throw new Error("Document produced no chunks - is it empty or image-only?");
    }

    await setStage(id, "contextualizing", 0.2);
    const contexts = await contextualizeChunks(chunks, doc.text, doc.title, (done, total) => {
      // Progress is cosmetic; a rejected UPDATE here must not become an
      // unhandled rejection that takes down every other request on the
      // instance. Reported on every callback rather than every tenth chunk:
      // chunks now arrive a whole group at a time, so a modulo test could
      // skip every update a document ever makes.
      void setStage(id, "contextualizing", 0.2 + 0.4 * (done / total)).catch(() => {});
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

    /*
      Retire the predecessor only now, after this version is genuinely
      searchable. Doing it at insert time would leave the corpus with nothing
      at all for this source during the minutes ingestion takes, and with
      nothing permanently if it failed.
    */
    let change: VersionChange | null = null;
    if (previous) {
      const old = await sql<{ heading_path: string[]; content: string }[]>`
        SELECT heading_path, content FROM chunks
        WHERE document_id = ${previous.id} ORDER BY ordinal
      `;
      change = compareVersions(
        old.map((r) => ({ headingPath: r.heading_path, content: r.content })),
        chunks,
      );
      await sql`
        UPDATE documents SET superseded_by = ${id}, updated_at = now()
        WHERE id = ${previous.id}
      `;
    }

    await sql`
      UPDATE documents
      SET status = 'ready', stage = 'ready', progress = 1,
          chunk_count = ${chunks.length}, updated_at = now(),
          metadata = metadata || ${sql.json(
            (change ? { change: { ...change, summary: describeChange(change) } } : {}) as never,
          )}
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
}

/** Hands long-running work to the runtime so it outlives the response. */
export type Defer = (work: Promise<unknown>) => void;

export async function ingestFile(
  buffer: Buffer,
  filename: string,
  mimeType: string | undefined,
  ownerId: string | null,
  defer?: Defer,
): Promise<IngestResult> {
  const doc = await loadFile(buffer, filename, mimeType);
  return ingest(
    doc,
    {
      checksum: createHash("sha256").update(buffer).digest("hex"),
      byteSize: buffer.byteLength,
      sourceUri: filename,
      ownerId,
    },
    defer,
  );
}

export async function ingestUrl(
  url: string,
  ownerId: string | null,
  defer?: Defer,
): Promise<IngestResult> {
  const doc = await loadUrl(url);
  return ingest(
    doc,
    {
      checksum: createHash("sha256").update(`${url} ${doc.text}`).digest("hex"),
      byteSize: Buffer.byteLength(doc.text),
      sourceUri: url,
      ownerId,
    },
    defer,
  );
}

/*
  Visibility, in one place.

  A NULL owner is the sample corpus the instance ships with, readable by
  everyone. Everything else belongs to exactly one browser. Every read, delete
  and search goes through this predicate rather than reimplementing it, because
  a single query that forgets it is a silent leak of someone's documents.
*/
const visibleTo = (ownerId: string) => sql`(owner_id IS NULL OR owner_id = ${ownerId})`;

/*
  Superseded versions are kept, not searched. Leaving them in retrieval is how a
  corpus starts answering with text its own source has already replaced -- and
  worse, answering with both, correctly cited, as a contradiction the reader has
  to adjudicate. They stay addressable so old citations still resolve.
*/
const current = sql`superseded_by IS NULL`;

/** Deletes only what this owner may delete. Silent no-op otherwise, by design:
 *  reporting "not yours" to a stranger confirms the id exists. */
export async function deleteDocument(id: string, ownerId: string) {
  /*
    Removing a document removes its history with it.

    The reader asked to remove a document, not a revision -- leaving earlier
    versions behind would keep the text in the database, out of search, and
    impossible to find or remove through the interface. Anything with the same
    source for the same owner goes, which is exactly the set the version chain
    was built from. A row with no source_uri has no lineage and deletes alone.
  */
  /*
    Follow the actual chain, not the name.

    Deleting everything sharing a source_uri removed unrelated documents that
    merely had the same filename -- the same mistake versioning made, with worse
    consequences, because this one does not hide the row, it destroys it. The
    supersedes links are the real lineage, so they are what gets walked: up from
    the target to its ancestors and down to anything that replaced it.
  */
  await sql`
    WITH RECURSIVE lineage AS (
      SELECT id, supersedes, superseded_by FROM documents
      WHERE id = ${id} AND owner_id = ${ownerId}

      UNION

      SELECT d.id, d.supersedes, d.superseded_by
      FROM documents d
      JOIN lineage l ON d.id = l.supersedes OR d.superseded_by = l.id OR d.id = l.superseded_by
      WHERE d.owner_id = ${ownerId}
    )
    DELETE FROM documents WHERE id IN (SELECT id FROM lineage)
  `;
}

export async function listDocuments(ownerId: string) {
  return sql`
    SELECT id, title, source_type, source_uri, byte_size, status, stage, progress,
           error, chunk_count, char_count, metadata, created_at, version,
           (owner_id IS NULL) AS shared,
           (SELECT count(*)::int FROM documents older
             WHERE older.superseded_by IS NOT NULL
               AND older.source_uri = documents.source_uri
               AND older.owner_id IS NOT DISTINCT FROM documents.owner_id) AS prior_versions
    FROM documents
    WHERE ${visibleTo(ownerId)} AND ${current}
    ORDER BY created_at DESC
    LIMIT 200
  `;
}

/**
 * Every document this owner is allowed to search.
 *
 * Retrieval filters by document id, so resolving the permitted set here keeps
 * the three-arm SQL unchanged and leaves one place where access is decided.
 */
export async function searchableDocumentIds(ownerId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM documents
    WHERE status = 'ready' AND ${visibleTo(ownerId)} AND ${current}
  `;
  return rows.map((r) => r.id);
}

export async function corpusStats(ownerId: string) {
  const [row] = await sql`
    SELECT
      (SELECT count(*)::int FROM documents
        WHERE status = 'ready' AND ${visibleTo(ownerId)} AND ${current}) AS documents,
      (SELECT count(*)::int FROM chunks c
        WHERE EXISTS (SELECT 1 FROM documents d
                       WHERE d.id = c.document_id
                         AND d.superseded_by IS NULL
                         AND ${sql`(d.owner_id IS NULL OR d.owner_id = ${ownerId})`})) AS chunks,
      (SELECT coalesce(sum(c.token_count), 0)::int FROM chunks c
        WHERE EXISTS (SELECT 1 FROM documents d
                       WHERE d.id = c.document_id
                         AND d.superseded_by IS NULL
                         AND ${sql`(d.owner_id IS NULL OR d.owner_id = ${ownerId})`})) AS tokens
  `;
  return row as { documents: number; chunks: number; tokens: number };
}
