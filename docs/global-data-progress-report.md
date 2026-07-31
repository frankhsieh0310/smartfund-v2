# SmartFund Global Data Progress Report

Snapshot: 2026-07-31 22:13 Asia/Taipei. This is a read-only production audit of the `stocks`, `stock_history`, `stock_financial_facts`, scheduler lifecycle tables, and the committed daily-job configuration. No worker, backfill, migration, or production data was changed to produce this report.

## Executive status

| Area | Actual completion | Evidence-based status |
| --- | ---: | --- |
| Stock universe master | 100% of the 16 requested markets are present (71,304 active / 71,304 total) | Present |
| Historical price eligibility | 71,300 / 71,304 = **99.994%** have canonical `historyBackfilledAt` evidence | Near complete; 4 recorded exceptions |
| Independent daily-job configuration | 15 / 16 = **93.75%** | Spain is not yet configured as its own daily job |
| Daily execution proof | 3 markets have a completed run with `validation=PASS`, and TPEx was actively progressing during the audit | Not yet globally validated |
| Raw corporate-action lineage | 3 dividend symbols and 2 split symbols in fact storage | Prototype only |
| Financial statements | 670 stocks, 140,796 facts, 257 metrics | Partial/prototype; not global |
| Global derived ratios | PE is partially populated; other global ratios are not yet production-wide | Prototype |

The platform is strong in price-universe and historical-price coverage. It must not yet be described as having production-daily proof for all global exchanges, or as having a global financial / corporate-action database.

## 1. Universe and price-market coverage

`Historical` below means the canonical `stocks.history_backfilled_at` flag, not a claim about each symbol's earliest available trade date. `Latest stored` is the maximum `stocks.latest_date` for that market. Daily evidence comes from the actual run ledger and checkpoint tables at the snapshot time.

| Market | Universe | Active / inactive | Historical evidence | Latest stored | Daily job | Latest daily evidence | Checkpoint / open failures | Operational reading |
| --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| TWSE | 1,088 | 1,088 / 0 | 1,088 (100%) | 2026-07-31 | Configured | COMPLETED; 1,088/1,088; validation PASS; exit 0 | 9958.TW; 0 | Daily verified |
| TPEx | 889 | 889 / 0 | 889 (100%) | 2026-07-31 | Configured | IN_PROGRESS; 76/889 at snapshot | 3085.TWO; 0 | Active; final outcome pending |
| NASDAQ | 3,581 | 3,581 / 0 | 3,580 (99.97%) | 2026-07-29 | Configured | COMPLETED completion-skip; validation PASS; exit 0 | ZYME; 0 | Previously validated; fresh daily proof should recur |
| NYSE | 2,635 | 2,635 / 0 | 2,633 (99.92%) | 2026-07-29 | Configured | COMPLETED completion-skip; validation PASS; exit 0 | ZWS; 0 | Previously validated; fresh daily proof should recur |
| AMEX | 288 | 288 / 0 | 287 (99.65%) | 2026-07-28 | Configured | No run ledger yet | none; 0 | Configured, execution not yet proven |
| Japan | 3,845 | 3,845 / 0 | 3,845 (100%) | 2026-07-28 | Configured | No run ledger yet | none; 0 | Configured, execution not yet proven |
| Korea | 2,672 | 2,672 / 0 | 2,672 (100%) | 2026-07-28 | Configured | No run ledger yet | none; 0 | Configured, execution not yet proven |
| Hong Kong | 9,586 | 9,586 / 0 | 9,586 (100%) | 2026-07-28 | Configured | No run ledger yet | none; 0 | Configured, execution not yet proven |
| Canada | 4,797 | 4,797 / 0 | 4,797 (100%) | 2026-07-28 | Configured | No run ledger yet | none; 0 | Configured, execution not yet proven |
| Australia | 3,607 | 3,607 / 0 | 3,607 (100%) | 2026-07-28 | Configured | No run ledger yet | none; 0 | Configured, execution not yet proven |
| Germany | 10,010 | 10,010 / 0 | 10,010 (100%) | 2026-07-28 | Configured | No run ledger yet | none; 0 | Configured, execution not yet proven |
| France | 9,661 | 9,661 / 0 | 9,661 (100%) | 2026-07-28 | Configured | No run ledger yet | none; 0 | Configured, execution not yet proven |
| United Kingdom | 5,948 | 5,948 / 0 | 5,948 (100%) | 2026-07-28 | Configured | No run ledger yet | none; 0 | Configured, execution not yet proven |
| Spain | 200 | 200 / 0 | 200 (100%) | 2026-07-28 | **Not configured** | No run ledger | none; 0 | Historical only |
| Italy | 10,055 | 10,055 / 0 | 10,055 (100%) | 2026-07-28 | Configured | No run ledger yet | none; 0 | Configured, execution not yet proven |
| Netherlands | 2,442 | 2,442 / 0 | 2,442 (100%) | 2026-07-28 | Configured | No run ledger yet | none; 0 | Configured, execution not yet proven |
| **Total** | **71,304** | **71,304 / 0** | **71,300 (99.994%)** | — | **15 / 16** | 3 completed-proof markets; 1 running at snapshot | 0 open failures in these market jobs | Global daily rollout still requires runtime validation |

All 15 configured jobs have separate job IDs. Their run ledger, distributed lock, checkpoint, and failure-queue records are keyed by job ID; one market does not share a global daily job with another.

## 2. Price data: persisted fields versus execution telemetry

### Persisted in production

| Group | Persisted fields | Status |
| --- | --- | --- |
| Stock master | `id`, `ticker`, `yahooSymbol`, `companyName`, `companyNameZh`, `exchange`, `country`, `currency`, `sector`, `industry`, `status`, `isActive`, `latestClose`, `latestDate`, `historyBackfilledAt` | Complete for the price master |
| Price series | `stockId`, `date`, `open`, `high`, `low`, `close`, `adjustedClose`, `volume`, `source`, `sourceSymbol`, `providerMethod`, `importedAt`, `updatedAt` | Complete price-series schema; actual historical coverage shown above |
| Idempotency | unique `(stockId, date)` | Enforced in schema |
| Lifecycle | job/run status, lock, checkpoint, retry/failure queue, validation status, exit code | Present in production scheduler tables, keyed by daily job |

### Not stored as a first-class price-row column

| Requested field | Actual state |
| --- | --- |
| Original symbol separate from `ticker` / `yahooSymbol` | Not a separate canonical field |
| Market and timezone | Market is inferred from exchange/country; timezone is job configuration, not stored on `stock_history` |
| Request method, HTTP status, response type, parser version | Stored in run artifacts/diagnostic evidence where generated, not per `stock_history` row |
| Per-row parser validation and stale status | Validation is run-level; no permanent per-row columns |
| Run ID, job ID, failure reason, retry count, checkpoint | Stored in lifecycle tables, not per price row |

## 3. Corporate actions

### Actual state

- `adjustedClose` is stored alongside every price row and already expresses Yahoo's adjusted-price series.
- There is **no dedicated** production table for splits, dividends, symbol changes, delistings, rights issues, listings, or historical revisions.
- The financial-fact table contains only a narrow proof of ingestion: `yahoo.event.cashDividend` for 3 symbols / 225 rows and `yahoo.event.splitRatio` for 2 symbols / 15 rows.

### Data roadmap (not implemented in this sprint)

| Phase | Deliverable | Required fields | Refresh |
| --- | --- | --- | --- |
| 1 | Canonical corporate-action event storage | `stockId`, `actionType`, `effectiveDate`, `announcementDate`, `recordDate`, `paymentDate`, `ratio`, `cashAmount`, `currency`, `oldSymbol`, `newSymbol`, `source`, `sourceEventId`, `sourceDocumentUrl`, raw-payload reference, timestamps | Daily incremental |
| 2 | Yahoo event adapter and official-market reconciliation | Splits, cash dividends, symbol/company rename, listing/delisting | Daily + repair queue |
| 3 | Market-specific actions | Rights issues, bonus shares, capital reduction, merger, spin-off, historical revision | Provider-specific |
| 4 | Validation | Split-adjusted price continuity, duplicate event detection, date ordering, dividend amount/currency checks | Every ingestion run |

No migration or production-schema change was made by this reporting sprint.

## 4. Financial statements: actual coverage

The generic `stock_financial_facts` table supports point-in-time raw facts (`periodStart`, `periodEnd`, fiscal period, form, filing/publication dates, unit/currency, source key/document URL, restatement version). This is a useful canonical schema, but actual data coverage is not global.

| Raw financial area | Actual evidence | Status |
| --- | --- | --- |
| Revenue | 571 stocks, 40,818 facts; 2007-12-31 to 2026-07-04; SEC EDGAR | Partial historical ingestion |
| Diluted EPS quarter | 3 stocks, 220 facts; 2007-09-30 to 2026-06-30; SEC companyfacts | Prototype |
| Diluted EPS TTM | 3 stocks, 208 derived facts; 2008-06-30 to 2026-06-30 | Prototype |
| Income statement other fields (cost of revenue, gross profit, operating income, EBIT, EBITDA, pretax, net income) | Fact table can hold them; no global coverage evidence in this audit | Prototype / not global |
| Cash flow (operating, investing, financing, free cash flow) | Fact table can hold them; no global coverage evidence | Prototype / not global |
| Balance sheet (cash, investments, assets, liabilities, debt, equity) | Fact table can hold them; no global coverage evidence | Prototype / not global |
| Shares / book value per share / weighted-average shares | Fact table can hold them; no global coverage evidence | Prototype / not global |

Total fact-store snapshot: **140,796 rows, 670 stocks, 257 metric names**, earliest 1987-05-11, latest 2026-07-30. Those totals include financial, valuation, and event facts; they do not mean all 670 stocks have a complete statement set.

## 5. Financial ratios and valuation

| Metric family | Actual evidence | Status |
| --- | --- | --- |
| PE (Taiwan official) | 97 stocks, 84,905 rows; 2021-08-02 to 2026-07-30; TWSE/TPEx BWIBBU | Partial production data |
| Point-in-time US TTM PE | 3 stocks, 10,977 rows; 2010-04-21 to 2026-07-29; SEC facts + Yahoo price | Prototype validation data |
| PB, PS, PEG, dividend yield, payout ratio | No global production coverage evidence | Not started globally |
| ROE, ROA, ROIC, margins, liquidity/leverage/turnover | Formula/canonical work exists outside this audit; no global derived-data production evidence | Prototype / not started globally |
| EV, market cap history, EV/revenue, EV/EBITDA, FCF yield | No global production coverage evidence | Not started globally |

## 6. Quality and lifecycle controls

| Control | Actual state |
| --- | --- |
| Duplicate daily price prevention | Enforced by unique `(stockId, date)` |
| Required close | `stock_history.close` is non-null in schema |
| Provider provenance | `source`, `sourceSymbol`, and `providerMethod` are stored for prices; source data exists for financial facts |
| Checkpoint/resume | Implemented in scheduler lifecycle; visible for TWSE/TPEx/NASDAQ/NYSE at snapshot |
| Failure classification/retry | Scheduler failure queue exists; no open failures in the 16 audited market jobs at snapshot |
| Distributed lock | Production lifecycle supports isolated job locks |
| Provider-latest freshness policy | Daily summaries/validation use provider-latest semantics where run |
| Negative OHLC, future-date, invalid currency/timezone, split/dividend reconciliation | Not proven as global production gates by this audit |
| Financial-statement and ratio cross-source validation | Prototype only; not a global production gate |

## 7. Production status scorecard

These percentages are explicit scope measures, not a claim that every domain is production complete.

| Domain | Completion | Basis |
| --- | ---: | --- |
| Universe master | 100% | 71,304/71,304 requested-market stocks are present and active |
| Historical price | 99.994% | 71,300/71,304 canonical backfill markers |
| Daily-job configuration | 93.75% | 15/16 requested markets; Spain remains unconfigured |
| Daily runtime validation | 18.75% completed proof; 25.00% including the TPEx run in progress | TWSE, NASDAQ, NYSE completed/validated; TPEx actively running at snapshot |
| Corporate action lineage | <1% | Adjusted prices exist, but raw split/dividend events cover only 2–3 symbols and no dedicated event model |
| Financial statements | ~1% global-stock reach | Broadest evidenced metric is revenue for 571/71,304 stocks (0.80%) |
| Financial ratios | <1% global-stock reach | PE currently reaches 97 stocks via official Taiwan source; US point-in-time PE is 3-stock prototype |
| Quality controls | 45% | Core uniqueness/provenance/lifecycle controls exist; global financial and corporate-action validation gates are not proven |

## Next data-only sprint

**Verify the first daily execution of every one of the 12 newly isolated exchange jobs, then add Spain as the 16th isolated job.** This is the shortest path to the product promise: every stock in each supported market receives a daily incremental attempt, with isolated failure handling. It does not add a new provider, schema, UI, or asset class.

## Reproducible audit command

```powershell
node.exe --import tsx --env-file=.env scripts/data/production/audit-global-data-progress.ts
```

Use `--detail` only for the full metric inventory. The audit intentionally serializes read queries so it does not compete with live daily workers.
