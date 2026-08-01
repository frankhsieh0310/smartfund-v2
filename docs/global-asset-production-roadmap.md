# SmartFund Global Asset Production Roadmap

This roadmap uses the completed Global Data Audit as its coverage baseline. It does not authorize or trigger another audit.

The fixed production order is:

1. Stocks
2. ETF
3. Fund
4. Government Yield
5. Economic Data
6. Commodity
7. FX
8. Crypto
9. Bond

An asset is complete only when every required gate for that asset reaches 100%. The common lifecycle is Universe, Historical, Incremental, Validation, and Production. Asset-specific required data such as stock financial statements, corporate actions and derived metrics; ETF NAV, distributions and holdings; fund portfolio data; economic revisions; and bond spreads are independent required gates.

Production completion is calculated from actual gate coverage. Unknown or unverified required gates contribute 0 until production evidence exists. A configured job, table, schema, script, or API does not count as completed data.

The current production focus is the first incomplete asset in the fixed order. Existing production workers continue from their durable checkpoints; generating the dashboard does not start, stop, reset, or reprioritize any worker.

The machine-readable roadmap is `config/global-asset-production-roadmap.json`. Current data progress is generated into `docs/global-asset-progress-dashboard.md` and `config/global-asset-progress-dashboard.json` after each existing Production Cron pass.
