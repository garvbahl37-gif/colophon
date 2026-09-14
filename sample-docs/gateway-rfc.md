# Gateway RFC 0042: Request Retry and Backoff

## Status

Accepted. Supersedes RFC 0019. Implemented in Gateway v2.4.0.

## Motivation

Under partial upstream failure, the v1 gateway retried immediately and in lockstep across
all workers. This produced synchronised retry storms that turned a recoverable 3-second
upstream blip into a 90-second outage.

## Retry Policy

The gateway retries idempotent requests only. A request is idempotent when the method is
GET, HEAD, PUT or DELETE, or when the client supplies an `Idempotency-Key` header.

Retries use exponential backoff with full jitter. The delay for attempt `n` is drawn from
a uniform distribution:

```
delay = random_between(0, min(cap, base * 2 ** n))
```

The base delay is 100 milliseconds. The cap is 30 seconds. Full jitter is used rather than
equal jitter because it de-correlates retries across workers most aggressively, which is
the entire point of the change.

The maximum number of attempts is 5, including the original request. After the fifth
failure the gateway returns 503 with a `Retry-After` header.

## Circuit Breaking

Each upstream has an independent circuit breaker. The breaker opens after 20 consecutive
failures within a 10-second window and stays open for 5 seconds before allowing a single
probe request through.

While the breaker is open the gateway returns 503 immediately without contacting the
upstream. This is deliberate: queuing requests against a known-dead upstream is how the
v1 gateway ran out of file descriptors.

## Timeouts

The default per-attempt timeout is 10 seconds. The total request deadline, across all
retries, is 60 seconds. The deadline is absolute: if attempt 4 would begin after the
deadline has passed, the gateway fails immediately rather than starting it.

## Rejected Alternatives

Equal jitter was rejected. It de-correlates retries less than full jitter and the
reduction in worst-case latency did not justify the weaker herd protection.

Retrying non-idempotent requests behind a deduplication cache was rejected as too
expensive to operate for the benefit.
