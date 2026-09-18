/**
 * Schema DDL, parameterised by embedding dimension.
 *
 * The dimension is discovered at setup time by actually calling the embedding
 * model (see scripts/db-setup.ts) rather than trusted from config, because a
 * mismatch between the column width and the model output is a failure that
 * otherwise only surfaces on the first insert.
 */

/** pgvector's HNSW index tops out at 2000 dims for `vector`; `halfvec` reaches 4000. */
export function vectorType(dimensions: number) {
  return dimensions > 2000
    ? { column: `halfvec(${dimensions})`, ops: "halfvec_cosine_ops" }
    : { column: `vector(${dimensions})`, ops: "vector_cosine_ops" };
}

export function schemaSql(dimensions: number, schema = "public"): string {
  const { column, ops } = vectorType(dimensions);
  // Identifier, not a value, so it cannot be parameterised - hence the guard.
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`Invalid schema name: ${schema}`);
  }
  return /* sql */ `
SET LOCAL search_path TO ${schema}, extensions, public;

CREATE TABLE IF NOT EXISTS documents (
  id            text PRIMARY KEY,
  -- Which browser added this. NULL is the shared sample corpus that ships with
  -- the instance; everything else is private to one owner. See lib/util/owner.
  owner_id      text,
  title         text NOT NULL,
  source_type   text NOT NULL,
  source_uri    text,
  byte_size     integer NOT NULL DEFAULT 0,
  checksum      text,
  -- Version lineage. Re-ingesting the same source with different content makes
  -- a new row rather than mutating this one, so the old text stays readable and
  -- citations already given out keep resolving. See lib/ingest/versions.ts.
  version       integer NOT NULL DEFAULT 1,
  supersedes    text,
  superseded_by text,
  status        text NOT NULL DEFAULT 'queued',
  stage         text,
  progress      real NOT NULL DEFAULT 0,
  error         text,
  chunk_count   integer NOT NULL DEFAULT 0,
  char_count    integer NOT NULL DEFAULT 0,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documents_owner ON documents (owner_id);

-- Uniqueness is per owner, not global. A global unique checksum means the
-- second person to upload a common file is refused because someone else
-- already has it -- which breaks their ingest and confirms, to a stranger,
-- that the document exists in a corpus they cannot read. coalesce() is
-- load-bearing: NULLs compare distinct in a unique index, so the shared
-- sample corpus would otherwise admit duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS documents_owner_checksum
  ON documents (coalesce(owner_id, ''), checksum);

-- Finding the current version of a source is the hot path for re-ingestion.
CREATE INDEX IF NOT EXISTS documents_current_source
  ON documents (coalesce(owner_id, ''), source_uri)
  WHERE superseded_by IS NULL;

CREATE TABLE IF NOT EXISTS chunks (
  id            text PRIMARY KEY,
  document_id   text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal       integer NOT NULL,

  -- What a human reads / what we cite.
  content       text NOT NULL,
  -- Anthropic-style situating context, written by an LLM at ingest.
  context       text,
  -- context || content. This is what gets embedded AND full-text indexed,
  -- so both retrieval arms see the disambiguating prefix.
  indexed_text  text NOT NULL,

  heading_path  text[] NOT NULL DEFAULT '{}',
  page          integer,
  char_start    integer NOT NULL DEFAULT 0,
  char_end      integer NOT NULL DEFAULT 0,
  token_count   integer NOT NULL DEFAULT 0,

  embedding     ${column},
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english', indexed_text)) STORED,

  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (document_id, ordinal)
);

-- Dense arm.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding ${ops}) WITH (m = 16, ef_construction = 96);

-- Lexical arm. GIN over the generated tsvector column.
CREATE INDEX IF NOT EXISTS chunks_tsv_gin ON chunks USING gin (tsv);

-- Fuzzy fallback for typo'd / rare identifiers that stemming destroys.
CREATE INDEX IF NOT EXISTS chunks_content_trgm
  ON chunks USING gin (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks (document_id);
CREATE INDEX IF NOT EXISTS chunks_doc_ordinal ON chunks (document_id, ordinal);

-- Every answered query, with its full pipeline trace, for offline analysis.
CREATE TABLE IF NOT EXISTS query_log (
  id            text PRIMARY KEY,
  query         text NOT NULL,
  plan          jsonb,
  trace         jsonb,
  citations     jsonb,
  answer        text,
  latency_ms    integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS query_log_created ON query_log (created_at DESC);

-- Answers already produced, matched by meaning rather than by string.
-- Scoped by owner, mode and the exact set of documents that were searchable,
-- so a corpus change invalidates it without a sweeper. No HNSW index: a single
-- owner's cache is small enough that a scan beats index maintenance.
CREATE TABLE IF NOT EXISTS answer_cache (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL,
  question    text NOT NULL,
  embedding   ${column},
  answer      text NOT NULL,
  citations   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The verdict travels with the answer: a cached answer without its audit is
  -- the one answer here nobody can check, and looks exactly like one that passed.
  grounding   jsonb,
  mode        text NOT NULL,
  scope_key   text NOT NULL,
  hits        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS answer_cache_lookup
  ON answer_cache (owner_id, mode, scope_key);

-- Conversations, owned by the browser that had them.
--
-- Deliberately not query_log. That table records the SHAPE of a run for
-- measurement and holds no question or answer, because it is a table nobody
-- can see or clear and one person's questions would sit in it beside
-- another's. This one is the reader's own history: scoped to their owner id,
-- listed back to them, and deletable by them. The distinction that matters is
-- not whether text is stored, it is whether the person who wrote it can see
-- and remove it.
CREATE TABLE IF NOT EXISTS conversations (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL,
  title       text NOT NULL,
  messages    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_owner
  ON conversations (owner_id, updated_at DESC);

-- Records the dimension the tables were actually built for.
CREATE TABLE IF NOT EXISTS index_meta (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
`;
}
