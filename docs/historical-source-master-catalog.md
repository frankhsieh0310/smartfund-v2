# Historical Financial Source Master Catalog

This is the discovery database, not a Production-provider approval list. The
machine-readable source records are in
[`historical-source-registry.json`](../config/historical-source-registry.json).

## Discovery classes

- **Official/Open:** MOPS/TWSE, TPEx, SEC EDGAR, EDINET, OpenDART, SEDAR+, ASX,
  SGXNet, FCA NSM, CNINFO, HKEXnews and filings.xbrl.org.
- **Freemium/API:** Yahoo, Alpha Vantage, Finnhub, Polygon, FMP, Nasdaq Data
  Link, SimFin and OpenBB.
- **Commercial/reference:** CompaniesMarketCap, Macrotrends, FullRatio,
  StockAnalysis, MarketScreener, Investing, TradingView, Koyfin, TIKR,
  Morningstar, Zacks, GuruFocus, QuickFS, WSJ, MarketWatch, SeekingAlpha,
  Google Finance, WRDS/CRSP/Compustat, Bloomberg, LSEG, FactSet and Capital IQ.

Every record identifies metrics, earliest coverage state, cadence, API/CSV/JSON
or HTML access, login state, free-access state, commercial-use state and whether
SmartFund can rebuild the metric from filings plus price. `TO_VERIFY` and
`LICENSE_REVIEW_REQUIRED` are deliberate unresolved states, not permissions.

## P0 discovery target

Taiwan and US are audited in parallel: official filings/XBRL first, then Yahoo
and freemium/reference sources as cross-checks. Other markets enter the same
catalog now but do not begin Financial Layer ingestion.
