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
CREATE SCHEMA IF NOT EXISTS ${schema};
SET LOCAL search_path TO ${schema}, extensions, public;

CREATE TABLE IF NOT EXISTS documents (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  source_type   text NOT NULL,
  source_uri    text,
  byte_size     integer NOT NULL DEFAULT 0,
  checksum      text UNIQUE,
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

-- Records the dimension the tables were actually built for.
CREATE TABLE IF NOT EXISTS index_meta (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
`;
}
