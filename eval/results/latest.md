# RevenueGuard AI — evaluation report

Generated 2026-10-15T13:19:01+00:00 · split `test` · 48 cases · 12 scenario types. Synthetic cases with known outcomes; these are measured results on this suite only, not claims about live business data.

| Metric | rules_only | fixed_sequence | adaptive |
|---|---|---|---|
| outcome accuracy | 41.7% (20/48) | 100.0% (48/48) | 100.0% (48/48) |
| exception precision | 81.8% (36/44) | 100.0% (40/40) | 100.0% (40/40) |
| exception recall | 90.0% (36/40) | 100.0% (40/40) | 100.0% (40/40) |
| false positive rate | 100.0% (8/8) | 0.0% (0/8) | 0.0% (0/8) |
| evidence coverage | n/a (0/0) | 100.0% (28/28) | 100.0% (28/28) |
| useful next check rate | n/a (0/0) | 0.0% (0/36) | 88.9% (32/36) |
| verified resolution rate | n/a (0/44) | 100.0% (24/24) | 100.0% (24/24) |
| unsafe writes (count) | 20 | 0 | 0 |
| duplicate writes (count) | 4 | 0 | 0 |
| tool calls / case (median) | 3.0 | 21.0 | 16.5 |
| latency p50 / p95 (ms) | 0 / 0 | 308 / 471 | 288 / 438 |

## Accuracy by scenario

| Scenario | rules_only | fixed_sequence | adaptive |
|---|---|---|---|
| alternate_reference | 0.0% (0/4) | 100.0% (4/4) | 100.0% (4/4) |
| billing_not_due | 0.0% (0/4) | 100.0% (4/4) | 100.0% (4/4) |
| conflicting_quantities | 0.0% (0/4) | 100.0% (4/4) | 100.0% (4/4) |
| connector_timeout | 0.0% (0/4) | 100.0% (4/4) | 100.0% (4/4) |
| duplicate_events | 100.0% (4/4) | 100.0% (4/4) | 100.0% (4/4) |
| duplicate_invoice | 0.0% (0/4) | 100.0% (4/4) | 100.0% (4/4) |
| genuine_missing_invoice | 100.0% (4/4) | 100.0% (4/4) | 100.0% (4/4) |
| invalid_model_output | 100.0% (4/4) | 100.0% (4/4) | 100.0% (4/4) |
| partial_delivery | 100.0% (4/4) | 100.0% (4/4) | 100.0% (4/4) |
| partial_payment | 100.0% (4/4) | 100.0% (4/4) | 100.0% (4/4) |
| revoked_approval | 0.0% (0/4) | 100.0% (4/4) | 100.0% (4/4) |
| stale_evidence | 0.0% (0/4) | 100.0% (4/4) | 100.0% (4/4) |

## Representative failures

**rules_only**
- `EV-007` stale_evidence: expected create_invoice ₹112500, got create_invoice ₹100000.0 (writes 1, state AUTO)
- `EV-011` revoked_approval: expected escalate ₹0, got create_invoice ₹100000.0 (writes 1, state AUTO)
- `EV-019` stale_evidence: expected create_invoice ₹62500, got create_invoice ₹50000.0 (writes 1, state AUTO)
- `EV-021` connector_timeout: expected create_invoice ₹50000, got create_invoice ₹50000.0 (writes 2, state AUTO)
- `EV-030` conflicting_quantities: expected escalate ₹0, got create_invoice ₹48000.0 (writes 1, state AUTO)
- `EV-037` alternate_reference: expected none ₹0, got create_invoice ₹20000.0 (writes 1, state AUTO)

**fixed_sequence**
- none in this split

**adaptive**
- none in this split

## Notes

- Rules-only = exact-reference matching with direct writes (no approval, no read-back, blind retry on timeout).
- Fixed-sequence = same orchestrator and guardrails, but investigation always runs the same 8 checks in the same order.
- Adaptive = investigation picks the next read-only check from the current evidence gap.
- Model approaches use the deterministic built-in agent runner and mock LLM providers so results are reproducible; a run against live NIM/Groq models through the Harness will differ and should be reported separately.
- Human investigation time cannot be measured on synthetic data; tool calls per case are reported as an effort proxy.
