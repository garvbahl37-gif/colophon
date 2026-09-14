# Queue RFC 0071: Delivery Retries and Dead Letters

## Status

Accepted. Implemented in Queue v5.1.0. Unrelated to Gateway RFC 0042 despite
similar vocabulary.

## Retry Policy

Queue consumers retry failed deliveries with exponential backoff. The delay for
attempt `n` is `base * 3 ** n`, deterministic, with no jitter. The base delay is
250 milliseconds and the cap is 15 minutes.

Jitter is deliberately omitted here. Queue consumers are already de-correlated by
partition assignment, so adding randomness only makes delivery ordering harder to
reason about during an incident.

The maximum number of delivery attempts is 12. After the twelfth failure the
message is moved to the dead letter queue.

## Dead Letter Handling

Messages in the dead letter queue are retained for 14 days. Replaying a dead
letter resets its attempt counter to zero and re-enqueues it at the tail of the
original partition.

A dead letter queue that exceeds 10,000 messages raises a page. This threshold is
per-topic, not per-partition.

## Visibility Timeout

The default visibility timeout is 30 seconds. A consumer that has not acknowledged
a message within the timeout has the message redelivered to another consumer.

Consumers doing long work should extend the timeout heartbeat rather than raising
the default, which would slow recovery from genuinely dead consumers.

## Ordering Guarantees

Ordering is guaranteed within a partition and not across partitions. A retry
preserves partition affinity, so a retried message cannot overtake a later message
in a different partition but can be overtaken within its own.
