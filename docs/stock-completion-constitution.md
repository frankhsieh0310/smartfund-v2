# SmartFund Stock Completion Constitution

Status: ACTIVE  
Effective date: 2026-08-03  
First-round deadline: 2026-08-09  
Scope: stocks only

Permanent objective: deliver Global Stock as a self-maintaining Production Asset, not merely as a historical database.

This document is the canonical completion contract for the Global Stock Completion Engine. Historical, latest, or financial ingestion success alone is never a market-completion verdict.

## 1. Non-negotiable rules

- A running writer is protected: do not stop, restart, duplicate, bypass, or clear its lock, checkpoint, lifecycle, or failure ledger.
- Resume from the durable checkpoint. Never rescan a symbol already recorded as successfully completed by the same market/layer job.
- Every writer must be market-scoped, stock-ID-scoped, single-owner, and fail-closed before any production write.
- Bond, ETF, Fund, Government Yield, Economic, Commodity, FX, and Crypto are outside this Constitution.
- No layer may be declared complete from a marker, non-null date, one fact, a successful canary, or a completed narrow pipeline.
- Schema or migration requirements are recorded as `SCHEMA_GAP`; this Constitution does not authorize Schema, Migration, Database Structure, Railway, or Scheduler changes.
- A missing source, restricted entitlement, unavailable adapter, or Schema gap never stops the rest of a market or the Global Stock Engine. Record evidence, classify the gap, decide whether it blocks Production, and continue to the next safe layer.
- First-round completion means every L1-L22 layer has been inspected, all safely executable public/legal/reliable work is complete, and every unavailable item has a durable reason code and return condition.
- Once a market's governed Historical layer is complete, record `HISTORICAL_LOCKED`. Successful historical symbols are immutable completion evidence and are never scheduled or rescanned again except through an explicitly authorized repair item in the failure ledger.
- This Constitution may verify or use existing scheduling infrastructure, but it does not authorize Railway, Migration, Schema, or database-structure changes.

## 2. Canonical layer order

1. L1 Universe
2. L2 Identity
3. L3 Historical Price
4. L4 Latest Price
5. L5 Financial Statements
6. L6 Monthly Revenue, when applicable
7. L7 Corporate Actions
8. L8 Point-in-Time Financial
9. L9 Derived Fundamentals
10. L10 Technical Daily
11. L11 Intraday
12. L12 Risk Metrics
13. L13 Ownership
14. L14 Documents
15. L15 Chart-ready Dataset
16. L16 Incremental
17. L17 Scheduler
18. L18 Freshness
19. L19 Durable Archive
20. L20 Lineage
21. L21 Missing Matrix
22. L22 Maintenance Mode

The current Japan L3 writer continues unchanged. After L3 reaches its governed end, Japan advances through L4-L22. Existing evidence may satisfy a layer without re-running successful data, but the evidence must meet this Constitution.

## 3. Layer status vocabulary

Each layer must have exactly one status and evidence timestamp:

- `COMPLETE`: all required, applicable coverage and validation gates pass with production evidence.
- `IN_PROGRESS`: an authorized process is actively advancing a durable checkpoint.
- `PARTIAL`: real data exists, but applicable coverage or validation is incomplete.
- `NOT_STARTED`: no verified implementation or production evidence exists.
- `NOT_APPLICABLE`: the layer does not apply to the market, with a documented reason.
- `SOURCE_NOT_PROVIDED`: no reliable public source provides the required data.
- `BLOCKED_LICENSE`: source use is not legally or contractually authorized.
- `BLOCKED_AUTH`: required source credentials or entitlement are unavailable.
- `ADAPTER_NOT_READY`: a suitable source exists but no verified market-scoped adapter is ready.
- `SCHEMA_GAP`: the current Schema cannot safely represent the required data.
- `BLOCKED_SOURCE_ACCESS`: a public source exists but cannot currently be accessed reliably.
- `BLOCKED_SCHEMA`: the current Schema cannot safely represent the required data; legacy `SCHEMA_GAP` evidence maps to this status.
- `INSUFFICIENT_INPUT`: required upstream evidence or data is unavailable.
- `EVIDENCE_PENDING`: low-cost evidence is currently insufficient; this is temporary and must have a return condition.
- `OWNERSHIP_COLLISION`: another active owner controls the same market/layer/table scope.
- `SCOPE_UNCONFIRMED`: the stock-only market universe cannot be proven.
- `UNKNOWN`: legacy-only status. New manifests must use `PARTIAL` or `EVIDENCE_PENDING` with evidence and a return condition.

Every non-complete status must record source evidence, missing reason, `BLOCKS_MARKET_COMPLETION = YES / NO`, and a return condition. Regardless of the value, the engine completes all other safe layers before leaving the market.

## 4. Coverage and percentage rules

- Numeric coverage is reported only as an exact `covered / eligible` result from a validated denominator and timestamped evidence.
- `0` is permitted only when a bounded query proves zero against a validated denominator. It is never a placeholder.
- Estimates are prohibited in Completion Manifests. Marker counts must be labeled `MARKER_ONLY` and cannot become coverage.
- If the denominator, field completeness, period depth, freshness, or source lineage cannot be verified cheaply and safely, coverage is `EVIDENCE_PENDING` or a reason-code classification; it does not stop other layers.
- `Overall %` is reported only from validated layer denominators. When unavailable, the manifest reports layer counts by status instead of inventing a percentage.
- `NOT_APPLICABLE` layers are excluded from numeric coverage. Blocked and partial layers can still produce a `PRODUCTION_COMPLETE_WITH_GAPS` market verdict after all executable work and L1-L22 inspection are complete.

## 5. Market completion gate

Every market receives exactly one first-round verdict after all L1-L22 layers are inspected:

- `PRODUCTION_COMPLETE`: all applicable public/legal/reliable work and production contracts are complete.
- `PRODUCTION_COMPLETE_WITH_GAPS`: all executable work is complete; remaining unavailable items are classified with evidence and return conditions and do not block safe Production.
- `PARTIAL_PRODUCTION`: useful production data exists, but executable work remains.
- `BLOCKED`: a system, integrity, ownership, scope, or authorization risk prevents safe Production.

For each blocked layer: record status, source evidence, missing reason, `BLOCKS_MARKET_COMPLETION`, and return condition; then continue to the next safe layer. A single layer or market gap never stops the Global Stock Engine.

Only cross-market write risk, database-integrity risk, duplicate ownership/lock collision, credential leakage, unauthorized Migration, or unconfirmed market scope may stop the affected writer. Single-symbol/date/document/parser/upsert failures are queued and checkpoint progress continues.

The governed market order begins Japan, Germany, United Kingdom, France, Italy, Spain, Netherlands, Switzerland, Sweden, Canada, Australia, Korea, Hong Kong, Shanghai, Shenzhen, Singapore, then remaining Registry markets. Existing successful data is evidence and must not be rerun.

## 6. Stock Completion Manifest

Every market must maintain a manifest containing:

- Market and evidence timestamp
- Completion Status and validated Overall % or layer-status counts
- L1-L22 status, exact coverage or classification, evidence, missing reason, `BLOCKS_MARKET_COMPLETION`, and return condition
- Blocking Gaps and Non-blocking Gaps
- Historical Rows, Latest Rows, Financial Rows, and Technical Rows
- Corporate Actions and Point-in-Time state
- Incremental, Scheduler, Freshness, Durable Archive, Lineage, Missing Matrix, and Maintenance state
- Current checkpoint, active owner, next layer, and return conditions

Rows are reported as exact table rows only when already available from bounded evidence. Cumulative inserted counts must be labeled as cumulative worker inserts rather than total distinct rows.

## 7. Heartbeat contract

Every 15 minutes or 100 stocks, whichever occurs first, use Compact Mode with at most ten lines: Worker status, Current Market, Current Layer, named Checkpoint, new symbols/rows, Failure Queue, new blocker, Next Layer, Next Market, and `CONTINUING`.

Unchanged coverage is omitted. A fuller report is emitted only for layer completion, market completion, a major blocker, worker crash, or system risk. Heartbeats never interrupt, restart, or duplicate a protected writer.

## 8. Engine stopping conditions

The Global Stock Engine continues until all markets complete their first L1-L22 inspection, all executable data work is complete, and all remaining gaps are classified. It stops early only for System Risk or an explicit owner instruction.

## 9. Production Asset gate

A market is not Production Ready merely because Historical is complete. Its final Production gate inspects and classifies:

1. Universe and Identity
2. Historical and `HISTORICAL_LOCKED`
3. Latest daily price
4. Corporate Actions
5. Financial Statements and Point-in-Time semantics
6. Daily Technical
7. Durable Archive and Lineage
8. Daily Incremental
9. Weekly reconciliation incremental
10. Quarterly financial update
11. IPO detection
12. Delisting detection
13. Corporate-actions update
14. Existing Production Scheduler ownership and cadence
15. Retry Queue, Checkpoint, and Resume
16. Health Check, Freshness, and Monitoring
17. Maintenance and Missing Matrix

Every unavailable or unauthorized item receives a reason code, Production impact, evidence, and return condition. Existing scheduler functionality may be verified and exercised only inside its authorized market-scoped interface; Railway configuration is out of scope.

Global Stock may emit `STOCK_PRODUCTION_COMPLETE` only after every governed stock market has a final Production verdict, all executable maintenance paths are active, successful Historical work is locked, and all remaining gaps are durably classified. At that point the Desktop worker stops. Before that point, it continues.
