# Incident Response Runbook

On-call procedure. Describes thresholds, escalation and breakers in the
operational sense, which is not the gateway's circuit breaker implementation.

## Alert Thresholds

Page on error rate above **2%** sustained for **5 minutes**, or p99 latency
above **3 seconds** sustained for **10 minutes**. Both windows are deliberately
long: shorter ones page on deploys and on single slow upstreams.

Warn — do not page — on error rate above **0.5%**, on queue depth above
**10000**, and on any single upstream exceeding **20** consecutive failures.

## Escalation Ladder

First responder has **15 minutes** to acknowledge. Unacknowledged pages escalate
to the secondary, then after a further **10 minutes** to the engineering
manager.

Declare an incident when customer impact is confirmed or when two services are
degraded simultaneously. Do not wait for certainty; a stood-down incident costs
far less than a late one.

## Breaker Runbook

When the gateway's breaker is open, the dashboard shows `breaker_state=open`
per upstream. Do not force it closed to "test" recovery — that is what the
half-open probe exists for, and forcing it discards the only signal you have.

If an upstream is known-good and the breaker is stuck, the correct action is to
restart the gateway instance holding the state, not to change thresholds during
an incident.

## Post-Incident

A written review is due within **3 working days**. It names contributing
factors, not a root cause, and it never names a person. Action items without an
owner and a date are not action items.
