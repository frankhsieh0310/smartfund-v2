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

Progress is reported only by data layer. The common lifecycle is Universe, Historical, Incremental, Validation, and Production. Asset-specific data such as stock financial statements, corporate actions and derived metrics; ETF NAV, distributions and holdings; fund portfolio data; economic revisions; and bond spreads remain independent layers.

Asset-level and global composite production percentages are prohibited because they hide which data layer is incomplete. Unknown or unverified layer coverage remains `UNKNOWN`; it is not converted to zero and is never averaged. A configured job, table, schema, script, or API does not count as completed data.

The current production focus is the first incomplete asset in the fixed order. Existing production workers continue from their durable checkpoints; generating the dashboard does not start, stop, reset, or reprioritize any worker.

The machine-readable roadmap is `config/global-asset-production-roadmap.json`. Current data progress is generated into `docs/asset-layer-dashboard.md` and `config/asset-layer-dashboard.json`; missing fields are generated into `docs/global-missing-matrix.md` and `config/global-missing-matrix.json` after each existing Production Cron pass.
