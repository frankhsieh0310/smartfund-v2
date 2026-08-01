# SmartFund Global Missing Matrix

> Generated with the Asset Layer Dashboard at **2026-08-01T12:02:28.461Z**. Missing items are reported by layer and are never hidden inside an asset average.

| Order | Asset | Layer | Coverage | Production | Missing | Evidence |
| ---: | --- | --- | ---: | --- | --- | --- |
| 1 | Stocks | Universe | 100.0000% | PRODUCTION | Official identifier mapping is incomplete for non-US/non-Taiwan markets | 80,944 registered stocks |
| 1 | Stocks | Historical Price | 99.9951% | PARTIAL_PRODUCTION | 4 stocks lack completed historical-price status; Exact earliest date timed out in the completed audit | 80940/80944 stocks |
| 1 | Stocks | Daily Price | 42.6159% | PARTIAL_PRODUCTION | 46449 stocks were not completed in their latest market run | 34495/80944 stocks in latest per-market runs |
| 1 | Stocks | Financial Statements | 3.1689% | DATA_ONLY | Revenue coverage; EPS coverage; Cash coverage; Debt coverage; Assets/Liabilities/Equity coverage; Cash-flow coverage; Incremental filing scheduler; Production validation | 2565/80944 stocks; 3,896,271 canonical facts |
| 1 | Stocks | Corporate Actions | 0.0000% | NOT_STARTED | Dividend; Split/Reverse Split; Rights Issue; Bonus Share; Capital Reduction; Ticker/Company Name Change; Listing/Delisting | No canonical stock corporate-action production ledger |
| 1 | Stocks | Derived Metrics | 0.1235% | PROTOTYPE | Market Cap; Enterprise Value; PE/PB/PS; Dividend Yield; ROE/ROA/ROIC; Margins; Debt Ratios; EV/EBITDA; Point-in-time validation; Incremental calculation | 100/80944; lower-bound financial-ratio evidence |
| 1 | Stocks | Validation | 39.1304% | PARTIAL_PRODUCTION | Canada: NOT_RUN; Hong Kong: FAIL; Italy: NOT_RUN; Japan: FAIL; Netherlands: NOT_RUN; Other:CH:EBS: NOT_RUN; Other:CN:SHH: NOT_RUN; Other:CN:SHZ: NOT_RUN; Other:SE:STO: NOT_RUN; Other:SG:SES: NOT_RUN; Other:US:BTS: NOT_RUN; Other:US:PNK: NOT_RUN; Spain: NOT_RUN; United Kingdom: NOT_RUN | 9/23 market latest runs validated PASS |
| 1 | Stocks | Scheduler | 69.5652% | PARTIAL_PRODUCTION | Other:CH:EBS; Other:CN:SHH; Other:CN:SHZ; Other:SE:STO; Other:SG:SES; Other:US:BTS; Other:US:PNK | 16/23 stock markets scheduler-enabled |
| 2 | ETF | Historical Price | 99.0861% | PARTIAL_PRODUCTION | 117 ETFs have no completed history | 12685/12802 |
| 2 | ETF | Daily Price | 0.0000% | PARTIAL_PRODUCTION | Complete the resumable Global ETF universe; Regional Daily counts are not isolated | IN_PROGRESS |
| 2 | ETF | NAV | UNKNOWN | DATA_ONLY | Per-ETF NAV coverage; Global NAV incremental scheduler; NAV validation | 695 NAV rows; product coverage is unverified |
| 2 | ETF | Distribution | 0.0000% | NOT_STARTED | Distribution history; Incremental distribution updates | 0 canonical ETF distribution products |
| 2 | ETF | Holdings | 0.0000% | NOT_STARTED | Holdings; Holding weights; Sector/Country/Asset allocation; Portfolio date | 0 canonical ETF holding products |
| 2 | ETF | Corporate Actions | 0.0000% | NOT_STARTED | Split; Distribution; Listing/Delisting; Incremental updates | No complete ETF corporate-action production evidence |
| 2 | ETF | Validation | 0.0000% | NOT_STARTED | Price validation; NAV validation; Holdings validation; Distribution validation | No regional ETF validation run passed in the completed audit |
| 2 | ETF | Scheduler | 83.3333% | PARTIAL_PRODUCTION | Taiwan ETF | 5/6 ETF regions scheduler-enabled |
| 3 | Fund | Universe | 100.0000% | PARTIAL_PRODUCTION | Domicile; Share class; Reliable regional classification | 12035 funds; 5321 mapped |
| 3 | Fund | Historical NAV | 98.1720% | DATA_ONLY | 220 funds lack historical NAV; Row-level provenance | 11815/12035 |
| 3 | Fund | Daily NAV | 97.4823% | DATA_ONLY | Railway production scheduler; Checkpoint/Resume evidence; Daily validation ledger | 11732/12035 have latest NAV |
| 3 | Fund | Distribution | 0.0000% | NOT_STARTED | Distribution history; Incremental distribution updates | 0 canonical fund distribution products |
| 3 | Fund | Portfolio | 0.0000% | NOT_STARTED | Holdings; Asset/Country/Sector allocation; Credit quality; Duration/Yield; Expense ratio | 0 canonical fund holding products |
| 3 | Fund | Validation | 0.0000% | NOT_STARTED | Historical NAV validation; Latest NAV validation; Portfolio validation; Distribution validation | NO_PRODUCTION_RUN_LEDGER |
| 4 | Government Yield | Universe | UNKNOWN | PARTIAL_PRODUCTION | Global country registry; Complete tenor registry | 5 configured series; global country/tenor target is not registered |
| 4 | Government Yield | Yield Curve | UNKNOWN | PARTIAL_PRODUCTION | Overnight/1M/3M/6M/1Y/2Y/3Y/5Y/7Y/10Y/20Y/30Y by country | Only 5 configured yield series; complete country/tenor curve is not registered |
| 5 | Economic Data | Revision | 0.0000% | NOT_STARTED | Initial release; Revised value; Revision date; Vintage observations | 0/74588 rows retain revisions |
| 5 | Economic Data | Incremental | 17.4194% | PARTIAL_PRODUCTION | IMF incremental; OECD incremental; World Bank incremental | COMPLETED |
| 6 | Commodity | Universe | UNKNOWN | DATA_ONLY | Complete canonical universe | 12 configured instruments; full target universe is not registered |
| 6 | Commodity | Historical | 66.6667% | DATA_ONLY | 4 configured instruments lack history | 8/12 |
| 6 | Commodity | Latest | 0.0000% | NOT_STARTED | Production incremental updater | No Railway production incremental run |
| 6 | Commodity | Scheduler | 0.0000% | NOT_STARTED | Production scheduler | Provider registry exists, but runner does not dispatch this asset class |
| 6 | Commodity | Validation | 0.0000% | NOT_STARTED | Production validation | NOT_RUN |
| 7 | FX | Universe | UNKNOWN | DATA_ONLY | Complete canonical universe | 21 configured instruments; full target universe is not registered |
| 7 | FX | Historical | 52.3810% | DATA_ONLY | 10 configured instruments lack history | 11/21 |
| 7 | FX | Latest | 0.0000% | NOT_STARTED | Production incremental updater | No Railway production incremental run |
| 7 | FX | Scheduler | 0.0000% | NOT_STARTED | Production scheduler | Provider registry exists, but runner does not dispatch this asset class |
| 7 | FX | Validation | 0.0000% | NOT_STARTED | Production validation | NOT_RUN |
| 8 | Crypto | Universe | UNKNOWN | DATA_ONLY | Complete canonical universe | 15 configured instruments; full target universe is not registered |
| 8 | Crypto | Historical | 46.6667% | DATA_ONLY | 8 configured instruments lack history | 7/15 |
| 8 | Crypto | Latest | 0.0000% | NOT_STARTED | 24/7 latest updater | No Railway production incremental run |
| 8 | Crypto | 24/7 Scheduler | 0.0000% | NOT_STARTED | 24/7 scheduler | Provider registry exists, but runner does not dispatch this asset class |
| 8 | Crypto | Validation | 0.0000% | NOT_STARTED | Production validation | NOT_RUN |
| 9 | Bond | Universe | UNKNOWN | NOT_STARTED | Government bonds; Corporate bonds; Municipal/Agency bonds; Convertible bonds | No canonical individual bond universe |
| 9 | Bond | Historical | UNKNOWN | NOT_STARTED | Historical price; Historical yield; Duration; Spread | No canonical bond history |
| 9 | Bond | Daily | UNKNOWN | NOT_STARTED | Latest price; Latest yield; Incremental scheduler | No incremental bond lifecycle |
| 9 | Bond | Corporate | UNKNOWN | NOT_STARTED | Issuer; Coupon; Maturity; Rating; Call/Put features | No corporate bond universe |
| 9 | Bond | Yield | UNKNOWN | NOT_STARTED | YTM; YTW; OAS; Credit spread | No individual bond yield layer |
| 9 | Bond | Validation | 0.0000% | NOT_STARTED | Bond validation | NOT_RUN |
