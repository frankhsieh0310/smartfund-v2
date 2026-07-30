# SmartFund Data Platform — Master Build Plan

> **唯一真實來源（SSOT）**  
> As of: **2026-07-30 (Asia/Taipei)**  
> Evidence: Production Supabase tables, `production_scheduler_runs`, failure queue, Railway manifest/logs, Prisma schema, provider registry, deployed API routes, and the read-only coverage audit of 2026-07-29. This plan is a **build inventory**, not a claim that all data is current.

## 1. Operating rules

- **Historical** means a canonical time-series table has rows for the instrument. A Master record alone never counts as Historical.
- **Daily Active** means a Production lifecycle job has a real Run Ledger record and is invoked by Railway Cron. It does **not** mean every instrument is already current at this instant.
- **Product Ready** requires Historical Ready, Production Daily Active, a deployed website API, and no blocking data-quality failure.
- Non-blocking individual exceptions remain in the Failure Queue; they do not stop Daily.
- Status is deliberately limited to: `NOT_STARTED`, `MASTER_ONLY`, `PARTIAL_HISTORICAL`, `HISTORICAL_READY`, `DAILY_ACTIVE`, `PRODUCT_READY`.

### Shared production lifecycle

`Railway Cron (*/5) → Coordinator → distributed lock → run ledger → checkpoint/resume → provider adapter → incremental upsert → failure queue/retry → validation → daily summary → API`

The shared coordinator currently dispatches stock Daily first, then Yahoo non-stock Daily, then Macro Daily, then bounded NYSE Historical. The lifecycle tables are `production_scheduler_runs`, `production_scheduler_locks`, and `production_scheduler_failures`.

## 2. Executive scorecard

The platform is **37% complete** against the target of every listed asset class being product-ready. This is a readiness score, not a row-count score: it gives weight to Universe, Historical, Production Daily, and Website API together. Historical rows alone do not make a product.

| Product Priority | Meaning | Current classes |
|---|---|---|
| **A** | Can be productized now or completed by finishing the existing Production Daily lifecycle. | TWSE, TPEx, NASDAQ, Global ETF, Macro (FRED/ECB subset), market-master Index, Bond/Yield, Volatility, S&P 500 |
| **B** | Material historical base exists; needs a dedicated Daily lifecycle and/or coverage completion. | NYSE, Taiwan ETF, Funds, Global Index, Commodity, Precious Metals, Energy, FX, Crypto, Insurance |
| **C** | No usable dedicated master/history lifecycle yet. | AMEX, Japan, HKEX, KRX, SSE, SZSE, SGX, Europe, Canada, Australia, India, emerging exchanges, REITs |

## 3. Master build checklist

### Stocks

- ☑ TWSE — Historical; ☑ Daily; ☑ API; ◐ Product (latest web evidence still requires a final freshness audit)
- ☑ TPEx — Historical; ☑ Daily; ☑ API; ◐ Product (latest web evidence still requires a final freshness audit)
- ☑ NASDAQ — Historical Ready with recorded exceptions; ☑ Daily lifecycle; ☑ API; ◐ Product (run currently has in-progress lifecycle records)
- ◐ NYSE — Historical backfill; ◐ Daily lifecycle; ☑ API; □ Product
- □ AMEX — Master only; □ Historical; □ Daily; ☑ shared API route; □ Product
- ☑ S&P 500 membership — Historical Ready with 3 mapping exceptions; □ dedicated Daily job; ☑ shared API route; □ Product
- □ Japan / HKEX / KRX / SSE / SZSE / SGX / LSE / Xetra / Euronext / SIX / TSX / ASX / NSE / BSE / B3 / BMV / Tadawul / JSE / IDX / SET / Bursa / HOSE — no production stock Universe or lifecycle evidence.

### Other asset classes

- ◐ Taiwan ETF — partial Historical; no dedicated Production Daily
- ◐ Global ETF — 100% Historical; Production Daily currently resumes in bounded Cron slices; API deployed
- ◐ Funds — 98.17% Historical; no Production Daily or deployed fund API proof
- ☑ Macro — 100% Historical; FRED/ECB Production Daily active; API deployed; IMF/OECD/World Bank remain Provider Pending
- ◐ Global Stock Index — 25/26 historical series; separate historical table; no Production lifecycle proof
- ☑ market_master Index — 29/29 Historical; Production Daily completed; API deployed
- ☑ Bond/Yield — 5/5 Historical; Production Daily completed; API deployed
- ◐ Commodity / Precious Metal / Energy / FX / Crypto — partial Historical; no Production Daily/API lifecycle
- ☑ Volatility — 1/1 Historical; Production Daily completed; API deployed
- □ REIT — no dedicated master/history lifecycle
- ◐ Insurance — 96.93% Historical; no Production Daily/API lifecycle

## 4. Detailed build inventory

`Lifecycle` lists **Coordinator / Scheduler / Checkpoint / Resume / Failure Queue / Validation / Summary** in that order. `✓` is evidenced in Production; `◐` exists but has not reached a final whole-class validation; `—` is not evidenced. Dates are actual maximum rows seen by the latest audit/run evidence and may be stale relative to today.

| Asset / market | Priority | Universe / master | Historical (coverage; earliest → latest) | Provider / provenance | Daily / Production | Website API | Lifecycle | Current status | Blocking issue |
|---|---:|---:|---|---|---|---|---|---|---|
| TWSE stocks | A | 1,088 | 1,088 rebuilt Yahoo series; date range varies by listing | Yahoo; `stock_history` row provenance | `twse-yahoo-daily` completed runs | `/api/stocks`, `/api/stocks/[symbol]` | ✓/✓/✓/✓/✓/◐/✓ | DAILY_ACTIVE | Final web freshness and whole-market validation not yet recorded in this plan |
| TPEx stocks | A | 889 | 889 rebuilt Yahoo series; date range varies by listing | Yahoo; row provenance | `tpex-yahoo-daily` completed runs | shared stock API | ✓/✓/✓/✓/✓/◐/✓ | DAILY_ACTIVE | Final web freshness and whole-market validation not yet recorded |
| NASDAQ stocks | A | 3,562 | Historical main run completed with ~40 recorded exceptions | Yahoo; row provenance | `nasdaq-yahoo-daily`; current in-progress run exists | shared stock API | ✓/✓/✓/✓/✓/◐/✓ | DAILY_ACTIVE | Close current Daily run and retain exceptions as classified background work |
| NYSE stocks | B | 2,597 | Production bounded slices are `PAUSED`; full coverage not evidenced | Yahoo; row provenance | `nyse-yahoo-daily` has an in-progress record | shared stock API | ✓/✓/✓/✓/✓/—/— | PARTIAL_HISTORICAL | Historical coverage and Daily validation are incomplete |
| AMEX stocks | C | 285 | No historical rows/lifecycle evidenced | Yahoo planned | None | shared stock API only | —/—/—/—/—/—/— | MASTER_ONLY | Start only after Priority-A daily work is stable |
| S&P 500 membership | A | 504 | 501/504 historical (3 mapping exceptions: BRKB, BFB, HOLX) | Yahoo; mapping registry | No dedicated S&P500 Daily job evidenced | shared stock API | ✓/—/✓/✓/✓/◐/✓ | HISTORICAL_READY | Create Daily job; exceptions are non-blocking |
| Japan / HKEX / KRX / SSE / SZSE and remaining global exchanges | C | No formal stock universe evidenced | None | Yahoo planned | None | —/—/—/—/—/—/— | NOT_STARTED | Build official Master + Yahoo symbol mapping only after A/B scope |
| Taiwan ETF | B | 349 | 232/349 (66.48%); 343,173 rows; 2008-01-02 → 2026-07-24 | Master-level metadata only; no per-row provenance | None | `/api/etfs` (deployed) | —/—/—/—/—/—/— | PARTIAL_HISTORICAL | Complete coverage and add provenance/Daily lifecycle |
| Global ETF | A | 12,453 | 12,453/12,453; 12,996,735 rows; 1993-01-29 → 2026-07-23 | Yahoo adapter; history lacks per-row provider field | `global_etf-production-daily`: 43 paused slices + active resume; 287 retryable failures | `/api/etfs` (HTTP 200) | ✓/✓/✓/✓/✓/◐/◐ | DAILY_ACTIVE | Let bounded daily resume reach full universe; then run final validation/summary |
| Mutual funds | B | 12,035 | 11,815/12,035 (98.17%); 19,470,537 rows; 2003-11-01 → 2026-07-28 | Master-level source only | None | Route source exists but no production verification in this plan | —/—/—/—/—/—/— | PARTIAL_HISTORICAL | Provider mapping/provenance and Production Daily |
| Macro — FRED/ECB | A | 27 enabled available series (24 FRED + 3 ECB) | All have history; Macro total 155/155; 74,508 rows; 1947-01-01 → 2026-07-28 | Official FRED / ECB; per-row lineage exists | `macro-production-daily` completed after FRED key deployment | `/api/economic-series` (HTTP 200) | ✓/✓/✓/✓/✓/✓/✓ | DAILY_ACTIVE | None for available adapters |
| Macro — IMF/OECD/World Bank | B | 128 enabled series | Historical rows exist; included in 155/155 total | Provider recorded per series | `PROVIDER_PENDING`, intentionally non-blocking | API returns stored latest values | —/—/—/—/—/—/— | HISTORICAL_READY | Add/reuse adapters only after A daily work; no current Production fetch |
| Global stock indices (`index_history`) | B | 26 | 25/26 (96.15%); 188,767 rows; 1965-01-05 → 2026-07-29 | Yahoo HTML/Chart with row provenance | None | No dedicated production index API linked to this table | —/—/—/—/—/—/— | PARTIAL_HISTORICAL | One missing series and no lifecycle bridge |
| market_master Index | A | 29 | 29/29; 255,363 rows; 1970-01-02 → 2026-07-10 | Yahoo adapter/master provider; no per-row provider | `market_index-production-daily` completed | `/api/market-indices` (HTTP 200) | ✓/✓/✓/✓/✓/◐/✓ | DAILY_ACTIVE | Reconcile stale latest-date evidence and record final validation |
| Bond / Yield | A | 5 | 5/5; 54,819 rows; 1970-01-02 → 2026-07-10 | FRED mapping (DGS3MO/DGS2/DGS5/DGS10/DGS30); master provenance | `bond_yield-production-daily` completed | `/api/bond-yields` (HTTP 200) | ✓/✓/✓/✓/✓/◐/✓ | DAILY_ACTIVE | Reconcile stale latest-date evidence; 5 permanent classified failures recorded |
| Commodity | B | 12 | 8/12 (66.67%); 52,556 rows; 2000-01-03 → 2026-07-10 | Yahoo / legacy master provider | None | None | —/—/—/—/—/—/— | PARTIAL_HISTORICAL | Complete 4 series and attach Yahoo daily job/API |
| Precious metals | B | 8 | 4/8 (50.00%); 26,021 rows; 1997-10-29 → 2026-07-10 | Yahoo / legacy master provider | None | None | —/—/—/—/—/—/— | PARTIAL_HISTORICAL | Complete 4 series and attach Daily/API |
| Energy / oil | B | 8 | 5/8 (62.50%); 30,649 rows; 2000-08-23 → 2026-07-10 | Yahoo / legacy master provider | None | None | —/—/—/—/—/—/— | PARTIAL_HISTORICAL | Complete 3 series and attach Daily/API |
| FX | B | 21 | 11/21 (52.38%); 68,221 rows; 1971-01-04 → 2026-07-11 | Yahoo / legacy master provider | None | None | —/—/—/—/—/—/— | PARTIAL_HISTORICAL | Complete 10 pairs and attach Daily/API |
| Crypto | B | 15 | 7/15 (46.67%); 22,435 rows; 2014-09-17 → 2026-07-11 | Yahoo / legacy master provider | None | None | —/—/—/—/—/—/— | PARTIAL_HISTORICAL | Complete 8 symbols and attach Daily/API |
| Volatility | A | 1 | 1/1; 9,198 rows; 1990-01-02 → 2026-07-10 | Yahoo adapter/master provider | `volatility-production-daily` completed | `/api/volatility` (HTTP 200) | ✓/✓/✓/✓/✓/◐/✓ | DAILY_ACTIVE | Record fresh production validation with current latest date |
| REIT | C | 0 dedicated records | No dedicated time series | None | None | None | —/—/—/—/—/—/— | NOT_STARTED | Define a REIT Master and canonical history table/lifecycle |
| Insurance products | B | 456 | 442/456 (96.93%); 19,230 rows; 2016-11-06 → 2026-07-07 | No row-level provenance | None | No dedicated production API | —/—/—/—/—/—/— | PARTIAL_HISTORICAL | 14 products, provenance, and Daily/API lifecycle |

## 5. Provider and API inventory

| Asset families | Active adapter | Production API | Notes |
|---|---|---|---|
| Stocks, ETF, market index, volatility, commodity, FX, crypto | `YAHOO_CHART` | Stocks, ETFs, market indices, volatility | Yahoo is the V1 market-price provider |
| Macro and bond/yield | `FRED`, `ECB` | Economic series, bond yields | FRED production key is present; 24 FRED + 3 ECB series are available |
| IMF, OECD, World Bank | Registry entries only | Economic API exposes existing stored values | Marked `PROVIDER_PENDING`; no active adapter run |

## 6. Production evidence and remaining engineering

### Proven in Production

- Railway uses server-side Cron every five minutes; it is independent of Windows.
- The run ledger, distributed lock, checkpoints, resumable bounded slices, failure queue, and summaries are used by stock and non-stock production runners.
- Production APIs currently respond HTTP 200 for ETF, economic series, bond yields, market indices, and volatility.
- Macro available-adapter run passed: **27/27 processed, 0 failures** (24 FRED + 3 ECB); 128 series are `PROVIDER_PENDING` rather than failures.

### Do not treat as complete yet

- `etf_history`, `fund_history`, and `market_history` lack row-level provenance fields. Master-level provider metadata is not a complete provenance proof.
- Global ETF Daily is operating as bounded resumable slices, not yet a completed whole-universe validation for the current New York day.
- Bond, Index, and Volatility have completed daily runs but their latest dates in the audit remain July 2026-07-10; this must be reconciled before a `PRODUCT_READY` claim.
- No production lifecycle evidence exists for Funds, commodities, precious metals, energy, FX, crypto, REIT, or insurance.

## 7. Next one real task

**Finish and validate the existing Global ETF Production Daily run to terminal `COMPLETED` for its 12,453-instrument universe, then persist its Market Validation and Daily Summary.**

This is the highest-leverage next task because it is already in Production, has 100% Historical coverage, has an API, and must be made demonstrably current before adding more asset classes or markets.

## 8. Completion gates by class

- [ ] Universe/Master known and versioned
- [ ] Historical coverage measured from canonical time series
- [ ] Historical provider/provenance verifiable
- [ ] Provider adapter selected
- [ ] Production Daily run executes incremental-only
- [ ] Distributed lock, checkpoint/resume, failure queue/retry proven
- [ ] Validation and Summary persisted
- [ ] Website API returns latest canonical date/value
- [ ] Latest-date freshness is within the asset's trading/release calendar
- [ ] Status can advance to `PRODUCT_READY`

## Data Freshness Policy (permanent)

Daily freshness is measured against the **latest valid observation currently
published by the configured provider**, never against the local calendar date.
Every production provider adapter implements `latestAvailableDate()` and the
Daily lifecycle compares that value with the database's latest value per
instrument or series.

- `databaseLatest >= providerLatestAvailable` records `UP_TO_PROVIDER_LATEST`,
  exits successfully, and does not retry.
- A retry is permitted only when a provider has a newer available observation
  than the database or when the fetch/write itself had a transient failure.
- Provider publication lag, different exchange sessions, weekends, holidays,
  and monthly/quarterly macro releases are valid states—not stale data.
- Each Daily Summary persists the freshness policy and the count confirmed
  `UP_TO_PROVIDER_LATEST` so production evidence remains auditable.
