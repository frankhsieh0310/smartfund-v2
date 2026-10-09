# Stock Completion Manifest — Germany

Constitution: `docs/stock-completion-constitution.md`  
Evidence timestamp: 2026-08-04T10:37:53Z  
Market: Germany / FRA + GER + STU + MUN + DUS + HAM + HAN  
Completion Status: `PARTIAL_PRODUCTION`  
Overall %: not reported; validated L1-L22 denominators are unavailable.  
First-round inspection: `COMPLETE` for L1-L22 classification. Layer counts: 1 `COMPLETE`, 6 `PARTIAL`, 1 `NOT_APPLICABLE`, 2 `ADAPTER_NOT_READY`, 3 `BLOCKED_SCHEMA`, 4 `INSUFFICIENT_INPUT`, 4 `EVIDENCE_PENDING`, and 1 `SCOPE_UNCONFIRMED`.  

## Layer ledger

| Layer | Status | Evidence / reason |
|---|---|---|
| L1 Universe | SCOPE_UNCONFIRMED | DB bucket marker is 10,010, but prior real evidence found only 512 stocks with history and 115 with technical data. No complete machine-readable official stock-only registry has been verified across the seven aliases. Production writes are blocked for unverified scope; later-layer inspection continues. |
| L2 Identity | PARTIAL | DB identities and exchange aliases exist, but full official issuer/listing identifiers and cross-alias primary-listing reconciliation are not verified. This does not block later-layer inspection; writes remain bounded by the L1 scope gate. |
| L3 Historical Daily Price | PARTIAL | Existing real rows cover a limited subset; no authorized Germany bounded runner or verified stock-only allowlist. |
| L4 Latest Daily Price | PARTIAL | `latestDate` marker evidence exists for 356 of 10,010 DB buckets, but the denominator is not a verified stock-only universe and marker presence is not calendar-aware freshness proof. |
| L5 Financial Statements | ADAPTER_NOT_READY | No verified Germany official financial adapter in current evidence. |
| L6 Monthly Revenue | NOT_APPLICABLE | No Taiwan-style monthly-revenue requirement identified for Germany. |
| L7 Corporate Actions | BLOCKED_SCHEMA | No verified canonical amendment-preserving event ledger. |
| L8 Point-in-Time Financial | INSUFFICIENT_INPUT | Financial facts and PIT semantics are not verified. |
| L9 Derived Fundamentals | INSUFFICIENT_INPUT | Required financial/PIT inputs are incomplete. |
| L10 Daily Technical | PARTIAL | Prior real evidence found 115 stocks with technical data; full scope and formula lifecycle are unverified. |
| L11 Intraday | BLOCKED_SCHEMA | No verified authorized intraday contract. |
| L12 Risk / Performance | INSUFFICIENT_INPUT | Benchmark, inputs, and formula lifecycle are unverified. |
| L13 Ownership / Trading | BLOCKED_SCHEMA | No verified canonical licensed ownership ledger. |
| L14 Documents / Events | ADAPTER_NOT_READY | Official document/event adapter is not verified. |
| L15 Chart-ready Dataset | INSUFFICIENT_INPUT | PIT-correct upstream inputs are incomplete. |
| L16 Incremental | EVIDENCE_PENDING | Lifecycle evidence not yet inspected. |
| L17 Scheduler | EVIDENCE_PENDING | Constitution compliance not yet inspected. |
| L18 Freshness | PARTIAL | Latest markers exist; market-calendar validation is incomplete. |
| L19 Durable Archive | EVIDENCE_PENDING | Archive completeness and restore contract not inspected. |
| L20 Data Lineage / Quality | PARTIAL | Existing marker/row evidence lacks complete end-to-end lineage. |
| L21 Missing Matrix | COMPLETE | Germany L1-L22 statuses, reasons, Production impact, and return conditions are recorded for the first-round review. |
| L22 Maintenance Mode | EVIDENCE_PENDING | No complete Germany maintenance SLA, regression contract, or safe automatic return gate is verified. Return conditions are recorded in this manifest. |

## L1 gap disposition

Status: `SCOPE_UNCONFIRMED`  
Source evidence: seven DB aliases with a 10,010 marker; prior real coverage 512 historical / 115 technical; complete official stock-only registry not verified.  
BLOCKS_MARKET_COMPLETION: `YES` for new Production writes against unverified symbols; `NO` for L2-L22 evidence inspection.  
Return condition: obtain and reconcile a machine-readable official stock-only German listing registry and validate alias mapping.  
L3 Production impact: existing rows are retained; new writes are blocked by `SCOPE_UNCONFIRMED` and `ADAPTER_NOT_READY`, while L4-L22 inspection continues.  
Next Layer: Germany return queue after official stock-only scope and safe adapters are verified.  
Next Market: United Kingdom / L1 Universe.  
CONTINUING: `YES`.
