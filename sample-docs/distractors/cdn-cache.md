# Edge Cache Configuration

Rules for the CDN in front of the gateway. Uses the words timeout, stale, purge
and TTL heavily, and governs none of the gateway's retry behaviour.

## Edge TTLs

Default edge TTL is **300 seconds**. Responses carrying `Cache-Control: private`
or `Set-Cookie` are never stored regardless of TTL.

`stale-while-revalidate` is **60 seconds**: an expired object continues to be
served while a single background request refreshes it. Only one revalidation is
in flight per key, so a popular expired object does not stampede the origin.

`stale-if-error` is **86400 seconds**. If the origin returns 5xx, the edge keeps
serving the last good object for up to a day rather than propagating the error.

## Origin Timeouts

The edge waits **45 seconds** for origin response headers before returning 504
of its own. This is longer than the gateway's own limits by design: the edge
should never be the component that gives up first, or gateway errors become
indistinguishable from edge errors in the logs.

The edge does not retry the origin. A failed origin fetch either serves stale or
fails, because a retry at the edge duplicates every retry the gateway is already
performing underneath it.

## Purge Semantics

Purge by key is effective within **5 seconds** globally. Purge by tag is
eventually consistent and may take up to **60 seconds** across all POPs.

A purge is not a delete: it marks the object stale, so `stale-if-error` can
still serve it during an origin outage. Use `purge --hard` when the object must
genuinely stop being served, for example after a content takedown.

## Vary and Key Composition

The cache key is method, host, path, query, and the headers named in `Vary`.
Adding a high-cardinality header to `Vary` — `User-Agent` is the classic
mistake — fragments the cache and collapses hit rate without any error
appearing anywhere.
