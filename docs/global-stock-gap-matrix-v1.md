# SmartFund Global Stock Gap Matrix V1

- Canonical completion contract: `docs/stock-completion-constitution.md`.
- First-round rule effective 2026-08-04: a classified source, auth, license, adapter, input, or Schema gap does not stop inspection of later layers or later markets. Every gap records whether it blocks safe Production; executable work continues independently.
- Permanent Production rule effective 2026-08-04: Historical completion is followed by `HISTORICAL_LOCKED`; market completion additionally requires classified Incremental, Scheduler, Retry/Checkpoint/Resume, Health/Freshness/Monitoring, Maintenance, and Missing Matrix evidence. `STOCK_PRODUCTION_COMPLETE` is reserved for the final Global Stock Production Asset, after which the Desktop worker stops.
- Japan first-round L1-L22 classification completed at 2026-08-04T05:07:48Z with verdict `PARTIAL_PRODUCTION`. Its L3 resume remains queued at checkpoint `456A` pending restoration of DB read connectivity and a clean ownership gate; the governed inspection cursor advances to Germany L1 without discarding the Japan return condition.
- Germany L1 first-round inspection classified `SCOPE_UNCONFIRMED`: the seven-alias 10,010 DB marker is not a verified official stock-only universe. New Germany writes remain fail-closed, while the inspection cursor advances to L2 Identity.
- Germany first-round L1-L22 classification completed at 2026-08-04T10:37:53Z with verdict `PARTIAL_PRODUCTION`; new writes remain blocked by unverified stock-only scope and missing safe adapters. Germany is retained on the return queue and the governed cursor advances to United Kingdom L1.
- United Kingdom L1 first-round inspection classified `SCOPE_UNCONFIRMED`: LSE/TLO/IOB DB marker 6,538 conflicts with legacy marker 5,948 and lacks official stock-type reconciliation. New writes remain fail-closed; the cursor advances to L2 Identity.
- This file is an evidence matrix under the older L1-L20 layout. It is not a Stock Completion verdict. Market completion is determined only by the L1-L22 Constitution and the market Stock Completion Manifest.
- Generated from production read-only evidence: 2026-08-02T16:09:36Z
- Scope: stocks only. Bond, ETF, Fund, Government Yield, Economic, Commodity, FX, and Crypto are excluded.
- This matrix measures the full V1 layer definition. A successful narrow pipeline does not make a layer complete when required fields, history, or validation are still missing.
- `history_backfilled_at` and `latest_date` are marker evidence only. They are never treated as proof that historical rows are complete.

## Status legend

| Code | Meaning |
|---|---|
| C | Completed against the full V1 layer definition with production evidence |
| P | Partial: real rows or a production lifecycle exist, but coverage/fields/validation remain incomplete |
| B | Blocked: source, ownership, legal/licensing, or fail-closed market-scope blocker |
| N | Not started: no verified production implementation/evidence for this market/layer |
| S | SCHEMA_GAP: the full V1 layer cannot be represented safely in the current schema |
| — | Not applicable to that market |

No layer is marked `C` merely from a marker. At this snapshot no market satisfies every required field and validation rule of an entire V1 layer.

## Layers 1-10

| Market | L1 Universe | L2 Profile | L3 Daily history | L4 Latest/freshness | L5 Corp actions | L6 Financials | L7 TW revenue | L8 PIT | L9 Completeness | L10 Fundamentals |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TWSE | P | P | P | P | S | P | N | P | N | P |
| TPEx | P | P | P | P | S | P | N | P | N | P |
| NASDAQ | P | P | P | P | S | P | — | P | N | N |
| NYSE | P | P | P | P | S | B | — | P | N | N |
| AMEX | P | P | P | P | S | P | — | P | N | N |
| Japan | P | P | P | P | S | B | — | N | N | N |
| Korea | P | P | P | P | S | B | — | N | N | N |
| Hong Kong | P | P | P | P | S | B | — | N | N | N |
| China Shanghai | P | P | P | P | S | B | — | N | N | N |
| China Shenzhen | P | P | P | P | S | B | — | N | N | N |
| Singapore | P | P | P | P | S | B | — | N | N | N |
| Canada | P | P | P | P | S | B | — | N | N | N |
| Australia | P | P | P | P | S | B | — | N | N | N |
| United Kingdom | P | P | P | P | S | B | — | N | N | N |
| Germany | P | P | P | P | S | B | — | N | N | N |
| France | P | P | P | P | S | B | — | N | N | N |
| Netherlands | P | P | P | P | S | B | — | N | N | N |
| Spain | P | P | P | P | S | B | — | N | N | N |
| Italy | P | P | P | P | S | B | — | N | N | N |
| Switzerland | P | P | P | P | S | B | — | N | N | N |
| Sweden | P | P | P | P | S | B | — | N | N | N |

## Layers 11-20

| Market | L11 Daily technical | L12 Intraday | L13 Multi-TF | L14 Risk/return | L15 Dividend | L16 Ownership | L17 Events/docs | L18 Calendar | L19 Quality/lineage | L20 Chart-ready |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TWSE | N | S | S | N | N | S | S | N | P | N |
| TPEx | N | S | S | N | N | S | S | N | P | N |
| NASDAQ | N | S | S | N | N | S | S | N | P | N |
| NYSE | N | S | S | N | N | S | S | N | P | N |
| AMEX | N | S | S | N | N | S | S | N | P | N |
| Japan | P | S | S | N | N | S | S | N | P | N |
| Korea | P | S | S | N | N | S | S | N | P | N |
| Hong Kong | P | S | S | N | N | S | S | N | P | N |
| China Shanghai | P | S | S | N | N | S | S | N | P | N |
| China Shenzhen | P | S | S | N | N | S | S | N | P | N |
| Singapore | P | S | S | N | N | S | S | N | P | N |
| Canada | P | S | S | N | N | S | S | N | P | N |
| Australia | B | S | S | N | N | S | S | N | P | N |
| United Kingdom | B | S | S | N | N | S | S | N | P | N |
| Germany | B | S | S | N | N | S | S | N | P | N |
| France | P | S | S | N | N | S | S | N | P | N |
| Netherlands | N | S | S | N | N | S | S | N | P | N |
| Spain | N | S | S | N | N | S | S | N | P | N |
| Italy | N | S | S | N | N | S | S | N | P | N |
| Switzerland | N | S | S | N | N | S | S | N | P | N |
| Sweden | N | S | S | N | N | S | S | N | P | N |

## Current market evidence

`Universe` is the current DB stock bucket count. `History marker` and `latestDate` are non-row markers. Market aliases are shown where one V1 market spans several DB exchanges.

| Market | DB exchanges | Universe | History marker | latestDate | Real lifecycle / principal gap |
|---|---|---:|---:|---:|---|
| TWSE | TWSE | 1,088 | 1,088 | 1,088 | MOPS L6 historical `162/162`, 2,098,170 inserted, PASS; incremental `18/18`, PASS. L7 has no canonical Schema model or repository runner (`SCHEMA_GAP` / `ADAPTER_NOT_READY`). L11 has real rows for 1,088/1,088 active stocks, but the only bounded technical runner rejects TWSE as unsupported and there are no `stock-technical-twse-historical` lifecycle runs; provenance, formula version, checkpoint and freshness therefore remain unverified. |
| TPEx | TPEx | 889 | 889 | 889 | MOPS L6 historical `162/162`, 1,612,704 inserted, PASS; incremental `18/18`, PASS. L7 has no canonical Schema model or repository runner (`SCHEMA_GAP` / `ADAPTER_NOT_READY`). L11 has real rows for 888/889 active stocks, but the only bounded technical runner rejects TPEx as unsupported and there are no `stock-technical-tpex-historical` lifecycle runs; the single uncovered stock could not be isolated by the relation query before statement timeout, so no write is authorized. |
| NASDAQ | NASDAQ | 3,562 | 3,561 | 3,552 | SEC L6 historical `3,380 succeeded / 182 failed`, 7,065,516 inserted, PASS. Read-only `EXISTS` coverage found 3,552/3,562 active stocks with at least one L3 row and 3,379/3,562 with at least one L11 row. The repository has no NASDAQ-capable bounded historical or technical runner, and no NASDAQ historical/technical lifecycle runs were found; exact depth, freshness, provenance and safe resume remain unverified, so no write is authorized. |
| NYSE | NYSE | 2,610 | 2,608 | 2,241 | `official-financial-nyse-historical` is `IN_PROGRESS`; L6 is blocked by active ownership even though its lock row is presently absent. |
| AMEX | AMEX | 287 | 286 | 269 | SEC L6 historical `237 succeeded / 50 failed`, 459,589 inserted, PASS. Live read-only evidence found L3 rows for 269/287 active stocks and L11 rows for 268/287. The repository has an AMEX universe/Daily validation surface and SEC financial runners, but no AMEX-capable bounded historical or technical runner and no matching L3/L11 lifecycle runs; depth, freshness, provenance and safe resume are unverified, so L3/L11 are `ADAPTER_NOT_READY` and no write is authorized. |
| Japan | JPX | 3,845 | 3,845 | 2,101 | L3 checkpoint has last symbol `4516`: cumulative 1,343 processed / 1,294 succeeded / 49 individual failures / 5,363,870 inserted. Run `eaa5cd66-e38a-4afb-a14d-2da964ca9012` completed its bounded 25-symbol plan with 25 succeeded, 0 new failures and 58,857 new rows; status `PAUSED`, exit code 0, error null, and JPX lock released. The post-run snapshot returned zero JPX/Japan Daily active locks or runs, so any subsequent L3 batch must repeat the fresh ownership gate and stock-only dry-run. The previously verified `2370.T` Stock/Fund namespace isolation remains valid. Open failure ledger is 27 retryable plus 22 partial-source-data entries. L11 current eligible scan completed PASS at checkpoint `599A / 73`: 73/73 succeeded, 296,858 cumulative inserts, 1,546,969 total technical rows, 291 covered stocks, 0 failures, `remainingEligibleTargets=0`; lock released. L11 remains partial against the broader Constitution indicator specification. |
| Korea | KSC + KOE | 2,672 | 2,672 | 2,672 | L3 dry-runs exposed non-standard structured/warrant-like codes in both KSC and KOE planned sets while `officialUniverseSource=null`; L3 is fail-closed as `MARKET_SCOPE_UNCONFIRMED`. L11 has real rows but only 8 verified bounded symbols in recent lifecycle; OpenDART/DART L6 adapter or credentials are not verified. |
| Hong Kong | HKG | 9,586 | 9,580 | 6,022 | Daily lifecycle ended FAILED with 5,896 succeeded / 3,154 failed. L3 dry-run planned five-digit derivative-range codes from a 9,583-item scoped DB set with no official allowlist, so new L3 writes are fail-closed. HKEX/HKEXnews L6 adapter not ready. |
| China Shanghai | SHH | 3,425 | 3,425 | 3,336 | Prefix-regex stock scope resolves to 2,349 records. Current L3 and L11 dry-runs both returned `plannedCount=0`, with zero active locks/runs and zero writes. Official filing adapter not ready. |
| China Shenzhen | SHZ | 3,938 | 3,938 | 3,680 | Prefix-regex stock scope resolves to 2,931 records. Current L3 and L11 dry-runs both returned `plannedCount=0`, with zero active locks/runs and zero writes. Official filing adapter not ready. |
| Singapore | SES | 570 | 570 | 569 | Current stock-filtered scope resolves to 539 records. L3 and L11 dry-runs both returned `plannedCount=0`, with zero active locks/runs and zero writes. SGX filing adapter not ready. |
| Canada | TOR + NEO + VAN + CNQ | 4,797 | 4,797 | 4,677 | Real L3/L11 lifecycle evidence exists for TOR, VAN and CNQ; NEO L3 canary failed 25/25 and remains source-blocked. |
| Australia | ASX + CXA | 3,607 | 3,607 | 3,607 | L11 fail-closed: ASX official CSV rejected automated access and CXA reference data is auth-gated. |
| United Kingdom | LSE + TLO + IOB | 6,538 | 6,538 | 4,281 | Current DB bucket count differs from legacy market-universe marker (5,948); official stock-type scope is unresolved, so new bounded historical/technical writes fail closed. |
| Germany | FRA + GER + STU + MUN + DUS + HAM + HAN | 10,010 | 10,010 | 356 | Marker is not row coverage. Prior real check found only 512 stocks with history and 115 with technical; official list is not machine-readable as a complete stock scope. |
| France | ENX + PAR | 9,661 | 9,661 | 9,368 | Legacy buckets include scope ambiguity. Official XPAR stock-only scope is 308. PAR L3 current eligible scan completed PASS at checkpoint `XFAB / 288`: 288 succeeded, 0 failures, 1,690,751 cumulative inserts, `remaining=0`; the final 13-symbol batch added 61,882 rows and released its lock. PAR L11 current eligible scan completed PASS at checkpoint `VIRI / 278`: 277 succeeded, 1 isolated numeric-overflow failure queued, 1,639,310 cumulative inserts, 1,741,904 total technical rows, 294 covered stocks, `remainingEligibleTargets=0`; lock released. Both layers remain partial against the broader V1 completeness definitions. |
| Netherlands | AMS + AQS + DXE | 2,503 | 2,503 | 2,339 | Euronext XAMS official CSV is reachable (`HTTP 200`, `text/csv`) and parsed 138 rows / 135 stock candidates after explicit non-stock exclusions. The 2,503 DB buckets are therefore not a safe stock universe; an official-symbol allowlist adapter and mapping validation are required before any write. |
| Spain | MCE | 200 | 200 | 34 | BME's official Listed Companies page states that it provides the current Spanish listed-company table, and the BME Download Center advertises an `Equity Securities List`. The table is dynamically loaded and this validation did not obtain a stable machine-readable symbol allowlist or direct equity-list file, so the 200 DB buckets remain marker evidence only and all writes fail closed pending an official BME adapter. |
| Italy | MIL | 7,898 | 7,898 | 7,146 | Borsa Italiana exposes official Share Selector and A-Z equity-list pages, but this validation did not confirm a stable bulk symbol allowlist suitable for a fail-closed adapter. The 7,898 MIL DB buckets are far broader than a plausible domestic-stock universe and also differ from the legacy 10,055 marker, so no write is allowed until official symbol/type mapping is verified. |
| Switzerland | EBS | 559 | 559 | 275 | SIX's official `equity_issuers.csv` is publicly reachable (`HTTP 200`, `text/csv`) and contains 241 unique XSWX symbols: 231 primary listings and 205 Swiss-country primary listings. Sponsored/secondary foreign lines remain explicitly separable through `Primary listing` and `Country`. The current historical runner does not support EBS and no verified symbol-to-DB allowlist adapter exists, so the 559 DB buckets remain marker evidence and writes fail closed with `ADAPTER_NOT_READY`. |
| Sweden | STO | 1,146 | 1,146 | 287 | Nasdaq's official Nordic Equity Reference Data Files contain ISIN/ticker/listing data for Stockholm and other Nordic markets, but delivery is a separately entitled FDS product rather than a verified public bulk allowlist. Nasdaq reports 362 Stockholm main-market companies at 2025-12-31, while the 1,146 STO DB buckets are materially broader. The current historical runner does not support STO, so writes fail closed with `BLOCKED_SOURCE_AUTH` / `ADAPTER_NOT_READY`. |

## Cross-layer schema and source gaps

- L1/L2: `stocks` lacks listing/delisting history, primary/secondary listing, official issuer IDs, ISIN/CUSIP/CIK/SEDOL/LEI, reporting currency, fiscal year end, accounting standard, addresses, auditor, parent, and several classification fields.
- L4/L18: `stocks.latest_date` exists, but full calendar-aware freshness state, expected trading day, stale reason, suspension, half-day, DST, and emergency-closure representation is incomplete.
- L5: no canonical stock corporate-action event table. Adjusted close is not an event ledger.
- L7: repository/schema search found neither a Taiwan monthly-revenue model nor a monthly-revenue runner; an amendment-preserving ledger requires Schema work, so both TWSE and TPEx are `SCHEMA_GAP` / `ADAPTER_NOT_READY` and no write is authorized.
- L8: `stock_financial_facts` has period, filing/publication dates and restatement version, but not full first-available, `valid_from`, `valid_to`, and amendment-chain semantics.
- L9: no formal per-stock financial-completeness ledger; a single fact must not be treated as complete.
- L10/L11: current facts/technical models cover only a subset of requested formulas and indicators. The bounded technical runner supports JPX/Korea/HKG/China/Singapore/Canada/PAR only and fail-closes TWSE/TPEx as unsupported; existing Taiwan technical rows lack verified production lifecycle evidence.
- L12/L13: no compliant intraday bar storage or multi-timeframe technical schema; daily data must never be used to simulate intraday.
- L14-L17/L20: canonical ledgers/models required by the full V1 definitions are absent or incomplete. Raw archives and marker rows do not satisfy those layers.
- L19: row-level source fields exist for price/financial data, but raw archive link, checksum, normalization time, parser/formula version, amendment, duplicate, conflict, and quality score are not uniformly modeled.

## Ownership and execution queue

- Active stock locks at snapshot: none.
- Active stock lifecycle collision: `official-financial-nyse-historical` (`IN_PROGRESS`), so NYSE L6 is not writable by Worker-02.
- Japan / L3 Historical Daily Price checkpoint has last symbol `4516` and 1,343 processed; the latest bounded run completed 25/25 successfully with no new failures and inserted 58,857 new rows. JPX and Japan Daily had zero active locks/runs in the post-run snapshot; the next batch still requires a fresh gate and stock-only dry-run.
- While Japan L3 is blocked by Daily ownership, Japan L11 is the next same-market candidate only if the technical runner preflight confirms a distinct table, zero technical writer/lock, and a stable market-scoped input set.
- France / L3 remains safely resumable from `VIRI / 275` after earlier queue items are completed or blocked.
- Any new writer still requires immediate preflight, dry-run, zero active writer/lock for the same market/layer, and a process-scoped `LIVE_WRITE_AUTHORIZED=true`.
