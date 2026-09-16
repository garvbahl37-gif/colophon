# Platform HTTP Client Library

Guidance for services calling *out* through the shared client library. This is
the caller side. It is not the gateway, and its settings do not affect gateway
behaviour — a common source of confusion during incidents.

## Client Timeouts

`HttpClient` exposes two timeouts. `connectTimeout` defaults to **2 seconds**
and covers TCP plus TLS establishment. `readTimeout` defaults to **20 seconds**
and starts when the request body has been flushed.

Both are per-connection, not per-request. A request that is retried inside the
client gets a fresh `readTimeout` on each attempt, so the worst case a caller
can observe is `readTimeout * maxAttempts` plus connect overhead.

Setting `readTimeout` above the gateway's own per-attempt limit is pointless:
the gateway will have given up first and the client will simply wait to be told.

## Client Retry Semantics

The client retries on connection refused, connection reset, and on `503` with a
`Retry-After` header. It does **not** retry `500`, `502` or `504`, because by
the time those arrive the gateway has already exhausted its own attempts and
retrying multiplies load on a system that is already failing.

`maxAttempts` defaults to **2** — that is one initial request and one retry.
Raising it is almost always wrong. The gateway retries on the caller's behalf,
so client retries compound: three client attempts against five gateway attempts
is fifteen requests to the upstream for one logical call.

## Client Backoff

Between client attempts the delay is a flat **500 milliseconds**. There is
deliberately no exponential term and no jitter here. The client is expected to
make at most one retry, so a curve has nothing to express, and jitter across a
single retry does not spread load in any useful way.

Callers wanting exponential behaviour with jitter should let the gateway do it
rather than reimplementing it one layer up.

## Connection Reuse

Connections are pooled per host with an idle timeout of **90 seconds** and a
maximum of **64** per host. Keep-alive is negotiated; if the upstream sends
`Connection: close` the pool entry is discarded rather than reused.

A pool that is exhausted blocks the caller for up to `acquireTimeout`, default
**1 second**, and then throws `ERR_CLIENT_POOL_EXHAUSTED`. That error means the
caller is issuing more concurrent requests than the pool allows; it does not
mean the upstream is down.

## Instrumentation

Every attempt emits `client.attempt` with `host`, `attempt_number` and
`outcome`. The metric to alert on is `client.attempt{outcome="exhausted"}`,
which means the client gave up — not `client.attempt{outcome="retry"}`, which
is normal and expected under load.
