# Stock Completion Manifest — United Kingdom

Constitution: `docs/stock-completion-constitution.md`  
Evidence timestamp: 2026-08-04T10:52:54Z  
Market: United Kingdom / LSE + TLO + IOB  
Completion Status: `PARTIAL_PRODUCTION`  
Overall %: not reported; validated L1-L22 denominators are unavailable.  
First-round inspection cursor: `L11 Intraday`.  

## Layer ledger

| Layer | Status | Evidence / reason |
|---|---|---|
| L1 Universe | SCOPE_UNCONFIRMED | DB bucket marker is 6,538 while the legacy universe marker is 5,948. A complete official stock-type scope across LSE/TLO/IOB is not verified. New writes are blocked for unverified symbols; later-layer inspection continues. |
| L2 Identity | PARTIAL | DB identities and aliases exist, but official issuer/listing identifiers, primary/secondary listing state, and cross-alias reconciliation are not verified. |
| L3 Historical Daily Price | PARTIAL | Marker evidence exists, but official stock-only scope, real depth, and a safe bounded runner are unverified. |
| L4 Latest Daily Price | PARTIAL | `latestDate` marker exists for 4,281 DB buckets; this is not calendar-aware freshness proof. |
| L5 Financial Statements | ADAPTER_NOT_READY | UK official financial ingestion is not verified. |
| L6 Monthly Revenue | NOT_APPLICABLE | No Taiwan-style monthly-revenue requirement identified. |
| L7 Corporate Actions | BLOCKED_SCHEMA | No verified amendment-preserving canonical event ledger. |
| L8 Point-in-Time Financial | INSUFFICIENT_INPUT | PIT financial facts and version semantics are not verified. |
| L9 Derived Fundamentals | INSUFFICIENT_INPUT | Required upstream facts and formulas are incomplete. |
| L10 Daily Technical | ADAPTER_NOT_READY | No verified UK-capable bounded technical runner or stock-only allowlist is available; new writes remain fail-closed while later Production-gate inspection continues. |
| L11 Intraday | BLOCKED_SCHEMA | No verified authorized intraday contract. |
| L12 Risk / Performance | INSUFFICIENT_INPUT | Benchmark and formula lifecycle are unverified. |
| L13 Ownership / Trading | BLOCKED_SCHEMA | No verified canonical licensed ownership ledger. |
| L14 Documents / Events | ADAPTER_NOT_READY | Official document/event adapter not verified. |
| L15 Chart-ready Dataset | INSUFFICIENT_INPUT | PIT-correct inputs are incomplete. |
| L16 Incremental | EVIDENCE_PENDING | Not yet inspected. |
| L17 Scheduler | EVIDENCE_PENDING | Not yet inspected. |
| L18 Freshness | PARTIAL | Marker evidence exists; calendar-aware validation is incomplete. |
| L19 Durable Archive | EVIDENCE_PENDING | Not yet inspected. |
| L20 Data Lineage / Quality | PARTIAL | Marker evidence lacks full lineage. |
| L21 Missing Matrix | IN_PROGRESS | This manifest begins the UK first-round matrix. |
| L22 Maintenance Mode | EVIDENCE_PENDING | Not yet inspected. |

## L1 gap disposition

Status: `SCOPE_UNCONFIRMED`  
Source evidence: LSE/TLO/IOB DB marker 6,538 versus legacy marker 5,948; official stock-type reconciliation is absent.  
BLOCKS_MARKET_COMPLETION: `YES` for new writes against unverified symbols; `NO` for L2-L22 evidence inspection.  
Return condition: reconcile a machine-readable official UK stock-only universe and alias mapping.  
L3 Production impact: existing rows are retained; new historical writes remain blocked by `SCOPE_UNCONFIRMED` and the absence of a verified bounded UK runner.  
Next Layer: L11 Intraday.  
CONTINUING: `YES`.
