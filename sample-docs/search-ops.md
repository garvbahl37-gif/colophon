# Search Cluster Operations

## Choosing Shard Counts

Shard count is fixed at index creation and cannot be changed without a reindex.
Aim for shards between 10GB and 50GB. Smaller shards waste coordination overhead;
larger ones slow recovery and rebalancing.

A common mistake is over-sharding a small index. Thirty shards holding 200MB each
is strictly worse than three shards holding 2GB each.

## Tuning Refresh Interval

The default refresh interval is one second, which makes documents searchable
almost immediately but forces frequent segment creation.

For bulk indexing, raise the refresh interval to 30 seconds or disable refresh
entirely and restore it afterwards. This routinely doubles bulk indexing
throughput.

## Query Latency Budget

The p99 query latency budget is 200 milliseconds at the coordinating node. Queries
exceeding it are logged with their shard-level breakdown.

Most latency regressions trace to a single slow shard rather than a uniformly slow
cluster, so always read the per-shard timings before tuning cluster-wide settings.

## Snapshot Cadence

Snapshots run hourly to object storage and are retained for 30 days. A full
restore of a 2TB cluster takes approximately 90 minutes, dominated by network
throughput rather than by the search nodes themselves.
