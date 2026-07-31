# Data Quality Coverage

Snapshot: 2026-07-31. This report distinguishes database-enforced controls from controls that exist only in a worker/harness and from controls not yet proven in Production.

| Validation | Current coverage | Production state | Evidence / gap |
| --- | --- | --- | --- |
| Missing OHLC | Worker-level | Partial | Price series schema has non-null close; global OHLC gate not demonstrated |
| Duplicate records | Price history | Complete | Unique `(stockId, date)` constraint |
| Future date | Worker-level | Partial | Not demonstrated as a global database gate |
| Negative price / volume | Worker-level | Partial | No audited global rejection evidence |
| Currency validation | Master/diagnostics | Partial | Currency exists on stock master, but no per-row validation proof |
| Timezone validation | Job configuration | Partial | Timezone is not stored on `stock_history` |
| Adjusted-close validation | Price storage | Partial | Field is stored; split reconciliation is not global |
| Split validation | Corporate-action roadmap | Not started | No global event ledger |
| Dividend validation | Corporate-action roadmap | Not started | No global event ledger |
| Financial-statement validation | Prototype | Prototype | Point-in-time and source work is limited |
| Ratio validation | Prototype | Prototype | PE comparison work is limited, not a global gate |
| Historical gap detection | Backfill/lifecycle | Partial | Canonical backfill flag exists; row-level gap audit is not global |
| Corporate-action consistency | Not implemented | Not started | Requires canonical event model |
| Provenance validation | Price and financial facts | Partial | Source fields exist; global source completeness report is not yet automated |
| Failure/retry/lock/checkpoint | Daily lifecycle | Complete | Separate job lifecycle tables, isolated by market job ID |

## Immediate quality conclusion

Price-write integrity and worker recoverability have usable production controls. Corporate-action, global financial-statement, and global derived-ratio quality gates remain the primary gaps. No failure has been reclassified as success in this report.
