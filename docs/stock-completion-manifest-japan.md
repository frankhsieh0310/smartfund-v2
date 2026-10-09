# Stock Completion Manifest — Japan

Constitution: `docs/stock-completion-constitution.md`  
Evidence timestamp: 2026-08-04T05:07:48Z  
Market: Japan / JPX  
Completion Status: `PARTIAL_PRODUCTION`  
Overall %: not reported; use layer-status counts until validated denominators exist.
First-round inspection: `COMPLETE` for L1-L22 classification. Layer counts: 1 `COMPLETE`, 8 `PARTIAL`, 1 `NOT_APPLICABLE`, 2 `ADAPTER_NOT_READY`, 3 `BLOCKED_SCHEMA`, 4 `INSUFFICIENT_INPUT`, and 3 `EVIDENCE_PENDING`.  

The first-round verdict does not require unavailable data to be fabricated. Each gap is classified and the engine continues to the next safe layer.

## Layer ledger

| Layer | Status | Coverage / evidence |
|---|---|---|
| L1 Universe | PARTIAL | DB bucket evidence is 3,845; the current bounded runner resolves 3,843 active JPX stocks. Official stock-only reconciliation remains incomplete. |
| L2 Identity | PARTIAL | Active JPX stock IDs and source symbols are validated for each bounded plan; full identifier-field coverage is unknown. |
| L3 Historical Price | PARTIAL | Latest bounded run safely paused with last symbol `456A`: 1,368 processed, 1,319 succeeded, 49 individual failures, 5,509,307 cumulative worker inserts. Resume remains required; successful symbols are not rescanned. DB read connectivity is temporarily unavailable, so ownership verification is `EVIDENCE_PENDING`. |
| L4 Latest Price | PARTIAL | `latestDate` marker exists for 2,101 / 3,845 DB buckets. This is `MARKER_ONLY`, not freshness coverage. |
| L5 Financial Statements | ADAPTER_NOT_READY | EDINET/JPX official-source ingestion is not verified as a production-ready Japan adapter. |
| L6 Monthly Revenue | NOT_APPLICABLE | Taiwan monthly-revenue reporting is not a Japan market requirement. |
| L7 Corporate Actions | BLOCKED_SCHEMA | No verified complete event ledger with effective dates, raw source, amendments, and lineage. Non-blocking for continued L8-L22 inspection. |
| L8 Point-in-Time Financial | INSUFFICIENT_INPUT | No verified Japan PIT version ledger; validated Japan financial facts and first-available/version semantics are required. Non-blocking for later-layer inspection. |
| L9 Derived Fundamentals | INSUFFICIENT_INPUT | Required Japan financial inputs, PIT semantics, and formula-version evidence are incomplete. Non-blocking for later-layer inspection. |
| L10 Technical Daily | PARTIAL | Current eligible bounded scan completed 73 / 73; known evidence includes 1,546,969 technical rows and 291 covered stocks, but the Constitution indicator set is not complete. |
| L11 Intraday | BLOCKED_SCHEMA | No authorized Japan intraday storage and complete source contract in current evidence. Non-blocking for continued L12-L22 inspection. |
| L12 Risk Metrics | INSUFFICIENT_INPUT | No verified Japan benchmark contract, complete input history, formula-version evidence, or production lifecycle. Non-blocking for later-layer inspection. |
| L13 Ownership | BLOCKED_SCHEMA | No complete, source-licensed ownership ledger is verified. Non-blocking for continued L14-L22 inspection. |
| L14 Documents | ADAPTER_NOT_READY | EDINET/JPX document archive and checksum lifecycle are not production-ready. |
| L15 Chart-ready Dataset | INSUFFICIENT_INPUT | PIT-correct financial, derived-fundamental, and complete technical inputs are not verified. Non-blocking for later-layer inspection. |
| L16 Incremental | EVIDENCE_PENDING | Incremental ownership exists outside this historical writer, but Constitution coverage and validation have not been audited. |
| L17 Scheduler | EVIDENCE_PENDING | Existing scheduling does not yet have a Japan Constitution compliance verdict. |
| L18 Freshness | PARTIAL | Latest markers exist, but expected trading date, stale days, suspensions, and market-calendar validation are incomplete. |
| L19 Durable Archive | PARTIAL | Bounded historical runs persist raw Yahoo payload archives, but archive completeness, retention, checksum inventory, and restore validation have not been audited. |
| L20 Lineage | PARTIAL | Some source lineage exists; full per-row source, parser version, amendments, and conflict state are incomplete. |
| L21 Missing Matrix | COMPLETE | L1-L22 statuses, reason codes, Production impact, and return conditions are recorded for the first-round Japan review; unresolved gaps remain tracked rather than hidden. |
| L22 Maintenance Mode | EVIDENCE_PENDING | No complete maintenance SLA or regression contract is verified. Return conditions are recorded in this manifest; DB connectivity must recover before unattended L3 resume can be authorized. |

## Required manifest metrics

- Historical Rows: 5,509,307 cumulative worker inserts at the evidence timestamp; total distinct table rows are `EVIDENCE_PENDING` without an expensive scan.
- Latest Rows: `EVIDENCE_PENDING`; 2,101 stocks have a `latestDate` marker.
- Financial Rows: `EVIDENCE_PENDING`.
- Technical Rows: 1,546,969 known rows from existing bounded evidence.
- Corporate Actions: `SCHEMA_GAP`.
- Point-in-Time: `NOT_STARTED`.
- Incremental: `EVIDENCE_PENDING`.
- Scheduler: `EVIDENCE_PENDING`.
- Maintenance: `NOT_STARTED`.

## Gaps and continuation

Blocking Gaps: official Japan L1 reconciliation; EDINET/JPX L5/L14 adapters; L7/L11/L13 Schema gaps; unverified L16-L20 operational contracts.  
Non-blocking Gaps: 27 retryable and 22 `PARTIAL_SOURCE_DATA` ledger entries at the evidence timestamp.  
Current checkpoint: Last Symbol=`456A`; Processed=1,368; Succeeded=1,319; Failed=49.  
Active owner: `EVIDENCE_PENDING` because DB read connectivity is unavailable; no resume is authorized until the ownership gate passes.  
Next Layer: resume L3 from checkpoint when the single-writer gate passes; all Japan L1-L22 layers have completed their first-round inspection.  
Next Market: Germany / L1 Universe first-round inspection; Japan remains on the return queue for its safe L3 resume and executable gaps.  
CONTINUING: `YES`.

## First-round gap disposition

| Layer / gap | Reason code | Blocks market inspection | Blocks safe Production | Return condition |
|---|---|---:|---:|---|
| L1 official stock-only reconciliation | SCOPE_UNCONFIRMED | NO | YES for unverified symbols | Obtain and reconcile an official JPX stock-only registry. |
| L3 resume ownership verification | EVIDENCE_PENDING | NO | YES for L3 writes | DB read connectivity returns and JPX/Japan Daily locks and lifecycle runs are zero. |
| L5 financial statements | ADAPTER_NOT_READY | NO | NO for existing price Production | Validate a market-scoped EDINET/JPX ingestion adapter. |
| L7 corporate actions | BLOCKED_SCHEMA | NO | NO for existing price Production | Authorize and implement an amendment-preserving event ledger. |
| L8-L9 PIT / derived inputs | INSUFFICIENT_INPUT | NO | NO for existing price Production | L5 facts and PIT version semantics become available. |
| L11 intraday | BLOCKED_SCHEMA | NO | NO for daily-price Production | Authorize intraday storage and a legal source contract. |
| L13 ownership | BLOCKED_SCHEMA | NO | NO for existing price Production | Verify a licensed source and canonical ownership ledger. |
| L14 documents | ADAPTER_NOT_READY | NO | NO for existing price Production | Validate EDINET/JPX archive, checksum, and lifecycle handling. |
| L16-L20 operational contracts | EVIDENCE_PENDING | NO | YES only for the affected unattended workflow | Complete bounded lifecycle, freshness, archive-restore, and lineage audits. |

While the L3 write gate is unavailable, Japan continues through low-cost L4-L22 evidence inspection. These classifications do not authorize Schema, Migration, Scheduler, or Production writes.
