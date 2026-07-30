# Global Historical Financial Source Catalog

This catalog records **candidate and validation sources**, not approval to
ingest or redistribute their data. `REVIEW_REQUIRED` means commercial/licence
status is intentionally unresolved.

| Source | Region | Official | API | Free access | Commercial use | Best use | Earliest historical coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEC EDGAR XBRL | US | Yes | Yes | Yes | Review required | Statements, filing dates, shares, insider forms | Issuer/taxonomy specific; audit required |
| TWSE OpenAPI | TWSE | Yes | Yes | Yes | Review required | Statements, dividends, governance, ownership/events | Endpoint specific; audit required |
| TPEx Open Data | TPEx | Yes | To verify | To verify | Review required | Statements, dividends, ownership/events | To audit |
| Yahoo Quote Summary | TW/US | No | Unofficial surface | To verify | Review required | Minimum Yahoo profile/statistics/financial scope | Issuer specific |
| Yahoo Chart | TW/US | No | Current adapter | Current use | Review required | Prices, volume, adjusted close, available events | Symbol specific |
| CompaniesMarketCap / Macrotrends / FullRatio / StockAnalysis | Reference | No | To verify | To verify | Review required | Formula sanity checks only | To audit |

Official source evidence: [SEC developer resources](https://www.sec.gov/about/developer-resources)
and [TWSE OpenAPI](https://openapi.twse.com.tw/). No commercial or
redistribution claim is made until a separate licence review passes.
