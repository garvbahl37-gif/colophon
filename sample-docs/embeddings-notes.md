# Vector Index Operations

## Choosing an Index Type

HNSW is the default for the chunk index. IVFFlat builds faster and uses less memory, but
its recall degrades sharply when the corpus grows past the list count it was built for,
and rebuilding it requires taking the index offline.

HNSW costs more to build and holds the whole graph in memory, but recall stays stable as
rows are added and it never needs a rebuild.

## Tuning ef_search

`hnsw.ef_search` controls how many candidates the graph walk considers. The default of 40
is too low for filtered queries. When a metadata filter is applied, the walk may discard
most of what it finds, so the effective result count falls below `k`.

Raise `ef_search` to at least 100 for unfiltered queries and 400 or higher when filtering
to a small subset. Set it with `SET LOCAL` inside a transaction so it does not leak to
other queries sharing the pooled connection.

## Dimension Limits

The `vector` type supports HNSW indexes up to 2000 dimensions. Above that, use `halfvec`,
which stores 16-bit floats and indexes up to 4000 dimensions. The recall loss from
half precision is negligible for retrieval.

## Rebuild Cost

Reindexing 3 million chunks takes roughly 40 minutes on an 8-core machine with
`maintenance_work_mem` set to 4GB. Lower settings cause the build to spill to disk and
can triple that time.
