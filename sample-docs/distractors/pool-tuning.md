# Database Connection Pool Tuning

How the service layer sizes and tunes its Postgres pools. Shares vocabulary with
the gateway's retry documentation and describes an unrelated mechanism.

## Pool Sizing

Pool size is `min(cpu_count * 2, 24)` per instance. Larger pools do not increase
throughput once Postgres is saturated; they move the queue from the application
into the database, where it is harder to see and impossible to shed.

`maintenance_work_mem` is raised to 256MB on the primary for index builds only.
It is not a per-connection setting despite appearing in per-connection docs.

## Acquire Timeout

A caller waiting for a connection blocks for at most **5 seconds** before
`ERR_POOL_ACQUIRE_TIMEOUT` is raised. This is a queueing limit, not a query
limit: it says nothing about how long a statement may run once acquired.

Statement duration is governed separately by `statement_timeout`, which is
**15 seconds** for interactive traffic and disabled for migrations.

## Backoff on Exhaustion

When the pool is exhausted the acquire path backs off before re-queueing. The
delay is `50ms * attempt` — linear, capped at **400 milliseconds**, with no
jitter and at most **4** attempts.

Linear was chosen over exponential deliberately. Pool exhaustion is usually a
short burst rather than a failing dependency, and an exponential curve spends
most of its budget waiting after the contention has already cleared.

## Health Probing

Idle connections are validated with `SELECT 1` every **30 seconds**. A
connection failing validation is closed and replaced rather than retried, since
a broken connection does not become unbroken.

Probe failures are counted per host. Twenty consecutive failures mark the
replica unhealthy and remove it from the read pool until three consecutive
probes succeed.
