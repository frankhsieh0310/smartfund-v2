# U.S. Treasury Individual Security Secondary-Market Source Matrix

Snapshot: 2026-08-02

This matrix keeps auction observations, benchmark curves, quotes, and executed transactions separate. SmartFund must not relabel an auction price or a benchmark yield curve as an individual-security secondary-market close.

| Source | Coverage | Identifier | Available fields | Historical depth / frequency | Authentication / rate limit | Use and redistribution | Production decision |
|---|---|---|---|---|---|---|---|
| U.S. Treasury FiscalData / TreasuryDirect Auction Query | Bills, notes, bonds, TIPS and FRNs offered by Treasury | CUSIP | Terms, announcement, auction result, price per 100, type-specific yield/rate/margin fields | TIPS from 1997; other types from 1998; event-driven auction updates | Public HTTPS API; bounded polling and retry are implemented | Official public auction data; preserve source attribution | **PRODUCTION** for universe, terms, auction history, latest official auction observation and lifecycle. **Not** secondary-market history. |
| FINRA TRACE Treasury End-of-Day Transaction File | Individual transactions only for on-the-run nominal coupon Treasuries | CUSIP / FINRA symbol | Execution time, price, price type, size and transaction metadata | Next-day end-of-day data from March 25, 2024 | Professional subscription and delivery setup | Free website access is limited to non-professional personal, non-commercial use; professional product is paid and licensed | **BLOCKED_PENDING_LICENSE** for SmartFund production; scope does not cover the full Treasury universe. |
| FINRA TRACE Enhanced Historical Treasuries | Reported Treasury transactions, released after a delay | CUSIP and non-CUSIP variants | Price, execution time, size, yield, side/counterparty fields | Six-month delay; quarterly files | Paid agreement and electronic delivery | Historical Data Agreement and fees apply | **BLOCKED_PENDING_LICENSE**; potentially useful for licensed backfill, not a free production source. |
| FINRA TRACE Treasury Security Master / Daily List API | TRACE Treasury reference universe | CUSIP / FINRA symbol / Bloomberg identifier | Reference terms and benchmark flags | Current master plus daily changes | TRACE API credentials/access terms | Reference-data delivery terms apply | **SOURCE_RESEARCH_REQUIRED** as a secondary identity cross-check; no secondary transaction price by itself. |
| Federal Reserve H.15 / Treasury yield-curve series | Constant-maturity and benchmark yields by tenor | Series / tenor, not CUSIP | Benchmark yields | Daily series | Public | Official public macro/reference data | **NOT_APPLICABLE** to individual bond price; may be stored under Government Yield only. |
| Dealer quotes / evaluated pricing vendors | Vendor-dependent; potentially full universe | Usually CUSIP / ISIN | Bid, ask, evaluated price, yield, duration and spread | Daily or intraday | Commercial credentials | Contract and redistribution restrictions | **PROVIDER_REQUIRED**; no licensed provider is connected. |

Current formal status:

- `SECONDARY_MARKET_HISTORY_BLOCKED_BY_SOURCE`
- `SECONDARY_MARKET_LATEST_BLOCKED_BY_SOURCE`
- Auction and lifecycle production continue independently.

Primary references:

- TreasuryDirect Auction Query: https://www.treasurydirect.gov/auctions/auction-query/
- Treasury auction announcements and results: https://www.treasurydirect.gov/auctions/announcements-data-results/
- FINRA Regulatory Notice 24-06: https://www.finra.org/rules-guidance/notices/24-06
- FINRA TRACE historical data: https://www.finra.org/industry/trace-historic-academic-data
- FINRA TRACE Treasury API documentation: https://www.finra.org/filing-reporting/trace/documentation
