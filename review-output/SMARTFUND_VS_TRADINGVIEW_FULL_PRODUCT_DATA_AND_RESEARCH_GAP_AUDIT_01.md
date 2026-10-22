# SMARTFUND_VS_TRADINGVIEW_FULL_PRODUCT_DATA_AND_RESEARCH_GAP_AUDIT_01

**STATUS:** COMPLETE  
**AUDIT_DATE / CHECKED_AT:** 2026-08-16 (Asia/Taipei)  
**MODE:** Public-product research + repository/runtime readback. Audit and roadmap only.  
**Mutation declaration:** IMPLEMENTATION_RUN=NO; DATABASE_WRITTEN=NO; DATABASE_SCHEMA_CHANGED=NO; PRISMA_CHANGED=NO; MIGRATION_RUN=NO; PRODUCTION_WORKERS_TOUCHED=NO; MASTER_SCHEDULER_TOUCHED=NO.

## Executive decision

TradingView is the stronger current product. It has a coherent, mature loop—find a symbol, chart it, apply technical/fundamental tools, screen, alert, share, and optionally trade—across web, desktop, and mobile. SmartFund has substantially more research-oriented backend structure than its current UI exposes, especially for canonical identity, holdings, ownership, industry-chain evidence, fixed income, macro, commodities, revisions/PIT, and provenance. That backend depth is not yet a user advantage at product scale.

The winning strategy is therefore **not “build a smaller TradingView.”** SmartFund must meet a modest chart/search/screener/watchlist baseline, then win on questions TradingView is not organized to answer:

1. Who owns this security, and how did ownership change?
2. What funds, ETFs, indices, bonds, futures, themes, and industry chains expose me to it?
3. What changed since the last disclosure or vintage?
4. What can I buy to express a research view, with look-through and overlap evidence?
5. Can I reproduce the answer using data known at the time, with source and derivation visible?

**Winning thesis:** TradingView helps users **see and trade markets**. SmartFund should help users **understand, connect, search, compare, and find investment products across markets**, with evidence and point-in-time discipline.

**Launch readiness:** `PRIVATE_BETA_READY`, not public-beta or paid-launch ready. Gating reasons: major datasets remain partial or auto-continuing; several runtime snapshots report `QUOTE_STATUS=NOT_READY`; ETF history has a large failed subset; FX/index/futures/crypto breadth is incomplete; cross-asset graph workflows are not exposed end-to-end; alert, saved-research, portfolio X-ray, natural-language research, and data-provenance UI are incomplete; current charting is below a credible research baseline.

## Evidence and method

### TradingView official evidence

- [Supercharts overview](https://www.tradingview.com/support/solutions/43000746464-getting-started-with-supercharts/): charts, layouts, compare, drawings, replay, watchlists, news, alerts, screeners, Pine Editor, calendars, portfolio, fundamental graphs, yield curves, options, macro maps, and community.
- [Screener walkthrough](https://www.tradingview.com/support/solutions/43000718885-tradingview-screeners-walkthrough/) and [Screener census](https://www.tradingview.com/support/categories/screener/): Stock, ETF, Bond, Crypto Coins, CEX, DEX, and Pine screeners; saved/custom screens and fundamental/technical filters.
- [Features](https://www.tradingview.com/features/): Pine, strategy testing, alerts, drawing tools, indicators, community scripts, and Pine Screener.
- [Alerts](https://www.tradingview.com/support/solutions/43000520149-introduction-to-tradingview-alerts/): price, technical, drawing, strategy, Pine, and watchlist conditions.
- [Portfolio](https://www.tradingview.com/support/solutions/43000760937-tradingview-portfolios-track-your-assets-know-your-trades/): transaction import, holdings, allocation, benchmark comparison, performance, beta, Sharpe, and Sortino. It is portfolio tracking/analytics, not disclosed-holdings look-through.
- [Bond Screener](https://www.tradingview.com/support/solutions/43000743951-tradingview-bond-screener-simplify-your-fixed-income-research/): government/corporate bonds, issuer, coupon, maturity, ratings, terms, amounts, saved screens, export, and yield curves.
- [Macro Maps](https://www.tradingview.com/support/solutions/43000764925-macro-maps-explore-global-economy/), [Economic Calendar](https://www.tradingview.com/support/solutions/43000759911-economic-calendar-track-all-major-market-events/), and [Seasonality](https://www.tradingview.com/support/solutions/43000723025-seasonality/).
- [Current pricing/features](https://www.tradingview.com/pricing/): Basic plus Essential/Plus/Premium/Ultimate; plan limits cover charts, indicators, history, connections, alerts, watchlists, portfolios, exports, Pine, and market-data subscriptions. Checked 2026-08-16; displayed annual-billing prices were approximately US$12.95, $29.95, $59.95, and $199.95 per month, subject to region/promotion/tax.

### SmartFund production evidence

Repository truth was prioritized over roadmaps. Primary evidence:

- [`prisma/schema.prisma`](../prisma/schema.prisma): canonical models for stocks, ETFs, funds/share classes, securities, ownership/holdings, indices/constituents, industry chains/evidence, futures/options, FX, crypto, bonds/yield curves, macro, physical commodities, alerts, portfolios, rankings, revisions/events, coverage, sources, and dataset health.
- [`runtime-status/`](../runtime-status): live/current status snapshots for the ten domains.
- [`app/`](../app): actual user routes and API surface.
- [`docs/production-readiness.md`](../docs/production-readiness.md): explicit warning that scope/coverage is not the same as production readiness.
- [`config/global-asset-progress-dashboard.json`](../config/global-asset-progress-dashboard.json) and domain coverage/source manifests in [`config/`](../config).

Conflict rule: newer runtime snapshots override old plans. Schema without populated/runtime evidence is `DATA_ONLY` or `BACKEND_READY`, never `PRODUCTION_READY`. A worker without a complete user workflow is not a product feature. Runtime labels such as `RUNNING` were read as snapshot claims, not independently process-verified uptime.

## TradingView current public product census

**PUBLIC_PRODUCT_AREAS:** Supercharts; stock/ETF/bond/crypto/CEX/DEX/Pine screeners; stock/ETF/crypto heatmaps; economic/earnings/dividend calendars; alerts; symbol watchlists; portfolio tracking; news; ideas/Minds/community scripts; Pine Script and strategy testing; Fundamental Graphs; Yield Curves; Options; Macro Maps; seasonality; broker/paper-trading integration; web, desktop, and mobile.

**ASSET_CLASSES:** Stocks, ETFs/funds, indices, government/corporate bonds, futures, FX, economic data, commodities, crypto CEX/DEX pairs, and options where supported. Coverage, delay, real-time entitlement, history, and fields vary by exchange/provider and plan.

**SCREENERS:** Strong domain-specific current-state screening; not confirmed as a native multi-domain relational/PIT query engine.  
**CHARTING:** Category leader; 20+ chart types, 110+ drawing tools and 400+ built-ins are advertised, with multi-chart layouts, replay, overlays, custom intervals and advanced profiles plan-dependent.  
**TECHNICAL:** Strong; built-ins, technical ratings, community indicators, Pine, strategy testing, and Pine Screener.  
**ALERTS:** Strong price/technical/drawing/Pine/watchlist alerts; plan-limited.  
**COMMUNITY:** Strong public ideas, scripts, comments, Minds, and creator distribution.  
**PINE:** Core moat: programmable indicators/strategies/screens tightly integrated with charts and community.  
**PORTFOLIO:** Strong tracking/performance/risk baseline; public evidence does not establish deep fund/ETF disclosed-holdings look-through, PIT ownership, or industry-chain exposure analysis.  
**AI:** No official evidence found in this audit for a general, citation-first natural-language cross-asset research answer layer comparable to the proposed SmartFund concept. Classify as `NOT_CONFIRMED`, not absent.  
**PRICING:** Powerful free acquisition funnel; paid tiers monetize capacity, history, indicators, alerts, layouts, exports, professional data access, and support. Exchange data can require separate entitlement.

## SmartFund current production readback

| Domain | Classification | Current evidence | Material limit |
|---|---|---|---|
| Stock | `PARTIAL`, price layer production-like | 80,944/80,944 orchestrator completion marker; current/auto-updating quote claim; deep schema for financials, guidance, events, institutional/insider, lending, technical, chain | Global financial/corporate-action depth and user workflows remain uneven; older readiness report says global financials not ready |
| ETF | `AUTO_CONTINUING`, partial | 12,449 universe/history jobs processed; ETF holdings/flows/distributions/issuer models | Last cycle: 2,364 updated, 4,453 current, 5,632 failed; quote not ready; 14 blocked gaps |
| Fund | `AUTO_CONTINUING`, partial | NAV and holdings labeled current/auto-updating; share-class, manager, AUM, distribution, holdings-change, documents, risk models | MoneyDJ layer only 57 mapped assignments in current cycle; disclosure/lifecycle zero in that cycle; style drift input-constrained |
| Index | `AUTO_CONTINUING`, partial | Canonical index candles, constituents, events, methodology, analytics | Runtime latest coverage 19/51 (37.3%); quote not ready |
| Futures | `AUTO_CONTINUING`, partial | Contract, observation, curve, metrics, positioning, options-on-futures; five commodity canary families | Narrow canary coverage; quote not ready; many depth gaps/blocked dependencies |
| Fixed income | `PRODUCTION_READY` core, depth partial | 64/64 markets, 1,104 links; quotes ready; 57 curve series/373,907 rows; 3,949 spread rows; sovereign/credit/mortgage layers | 29 depth gaps; comprehensive evaluated pricing/rating/terms remain source/license dependent |
| FX | `AUTO_CONTINUING`, partial | Canonical currencies/pairs, candles, fixing/reference, forward points, coverage | 2,531/6,336 processed (~39.9%); quote not ready |
| Macro | `PRODUCTION_READY` calendar/core, PIT partial | 339/339 verified events (211 historical, 128 upcoming); series/values, money, fiscal, sovereign, liquidity, ALFRED migration | Current cycle reports zero revisions; vintage breadth and cross-asset sensitivity product incomplete |
| Commodity | `PRODUCTION_READY` reference core, depth partial | 29/29 identities, 33/33 price series, 112,284 preserved rows; physical energy/minerals/carbon/shipping schema | Quotes not ready; only 5/25 layers complete without gaps; 41 depth gaps |
| Crypto | `AUTO_CONTINUING`, partial | Price production claim; network/asset/exchange/market/candles, market-cap/supply, metrics/analytics | Derivatives building; on-chain auto-continuing; quote not ready; bounded funding/OI rather than broad coverage |

**PRODUCTION_READY:** Stock price core; fixed-income core; macro calendar/core; commodity reference-price core.  
**PARTIAL:** Every domain at full professional/research-product scope.  
**AUTO_CONTINUING:** Stock, ETF, Fund, Index, Futures, Fixed Income, FX, Macro, Commodity, Crypto have worker/scheduler evidence, but freshness and coverage differ.  
**SOURCE_LIMITED / LICENSE_CONSTRAINED:** real-time exchange quotes; consolidated/professional feeds; evaluated OTC bond pricing; broad credit ratings/estimates/ownership; complete commercial fund holdings; some index constituent history; premium news; granular on-chain/vendor analytics.  
**NOT_CONFIGURED / PRODUCT-NOT-READY:** universal relational research UI, robust saved research, multi-holding query, portfolio look-through/X-ray, cited AI answer layer, event-conditioned research, and full chart baseline.

## Ten-asset scorecard

Scores are 1–10 for current user-visible product and evidence-backed 12-month potential, not raw row count.

| Asset | TradingView | SmartFund current | 12m potential | Current winner | Potential winner | Key gap | SmartFund advantage |
|---|---:|---:|---:|---|---|---|---|
| Stock | 9 | 5 | 8 | TradingView | Split / SmartFund research | Chart/technical/screener polish, complete financial coverage | Guidance, ownership, lending, events, industry-chain and evidence graph |
| ETF | 8 | 5 | 9 | TradingView | SmartFund | Reliable holdings/NAV/flows UI and breadth | Reverse ownership, overlap, multi-holding, historical holdings, look-through |
| Fund | 6 | 5 | 9 | TradingView narrowly | SmartFund | Mapping/disclosure completeness and product UX | Share-class/manager/holdings/PIT research and Taiwan fund depth |
| Index | 8 | 4 | 8 | TradingView | Split | Coverage and detail pages | PIT constituents, rebalance events, benchmark graph |
| Futures | 9 | 4 | 7 | TradingView | TradingView / niche SmartFund | Broad contracts, quotes, charting, continuous-series confidence | COT, curve, physical commodity and macro linkage |
| Fixed income | 8 | 6 | 9 | TradingView user product | SmartFund research | Bond screener UX and licensed fields | Curves/spreads/sovereign/capital-structure/owner relationship graph |
| FX | 9 | 4 | 7 | TradingView | TradingView / niche SmartFund | Coverage, live quotes, charting, screener | Fixings, forwards/carry, reserves, macro sensitivity |
| Macro | 8 | 6 | 9 | TradingView product polish | SmartFund | Visual discovery and broad release UI | Vintage/PIT, revisions, liquidity/fiscal/sovereign and asset linkage |
| Commodity | 8 | 6 | 9 | TradingView market layer | SmartFund research | Quotes, contracts and product surface | Physical supply/demand, inventory, reserves, carbon/shipping/COT linkage |
| Crypto | 10 | 3 | 6 | TradingView | TradingView | CEX/DEX breadth, 24/7 quote/technical/product polish | Evidence-led supply/on-chain/derivatives research if completed |

### Coverage matrix summary

| Domain | Market/current | History | Fundamentals/reference | Technical | Relationships/PIT | Product status |
|---|---|---|---|---|---|---|
| TradingView | Very strong, entitlement-dependent | Strong, plan/provider-limited | Strong for supported symbols | Category-leading | Mostly symbol/current-market oriented; relational/PIT depth not confirmed | User-ready |
| SmartFund | Uneven; several quote layers not ready | Strong pockets, incomplete breadth | Deep schema and specialist datasets | Stock technical backend, weak product layer | Structurally strong and differentiating, incompletely productized | Backend-heavy private beta |

## Platform capability audit

| Capability | TradingView | SmartFund current | Decision |
|---|---|---|---|
| Charting | Dominant | Basic/partial | **Must match only the research baseline:** responsive candle/line, volume, compare/overlay, events, fundamentals/macro overlays, common indicators, saved layout |
| Screening | Mature per asset and Pine | Screener route exists; relational/historical depth not user-ready | Match common stock/ETF/fund/bond filters, then differentiate with relationship/PIT filters |
| Search | Excellent symbol/tool navigation | Search route/API exists; canonical entities rich | Build universal entity + intent search; do not try to out-search every ticker before identity quality is reliable |
| Relationships | Limited official evidence of deep cross-domain graph | Strong schema/data potential | Primary offensive bet |
| PIT | Chart history exists; point-in-time relationship research not confirmed | Revision/event/known-at structures exist unevenly | Make PIT semantics and no-lookahead behavior explicit |
| Portfolio | Mature tracking, benchmark, risk | Portfolio page/models exist | Build exposure X-ray/look-through, not a clone of transaction tracking |
| Alerts | Mature technical/price/watchlist | Extensive watchlist-alert schema; product proof limited | Build research-change alerts first |
| AI | Not confirmed as citation-first cross-asset research | Not product-ready | Build constrained, cited query compiler/explainer after graph/query APIs are deterministic |
| Cross-asset | Overlay/compare and broad symbol coverage | Deep data model, fragmented UI | Key differentiation |
| Transparency | Provider/venue shown in places; derivation/PIT not uniformly exposed | Provenance/source/evidence models | Turn source/as-of/known-at/derived method into visible trust feature |

## Moats and competitive boundary

### TRADINGVIEW_CORE_MOAT

1. Best-in-class interactive charting and drawing workflow.
2. Pine Script + strategy testing + Pine Screener.
3. Huge symbol/data integration surface with plan/entitlement monetization.
4. Alerts, watchlists, multi-device synchronization, and broker integration.
5. Community ideas/scripts and creator distribution flywheel.

### SMARTFUND_CURRENT_CORE_MOAT

1. Canonical multi-asset identity and relationship-oriented schema.
2. Fund/ETF holdings, ownership, changes, and look-through building blocks.
3. Industry-chain evidence and security-to-product relationships.
4. Specialist fixed-income, macro, physical commodity, fiscal, sovereign, and revision datasets.
5. Provenance/coverage/runtime-health structures that can support auditable research.

### SMARTFUND_12M_POTENTIAL_CORE_MOAT

1. Historical cross-asset research graph with effective-as-of/known-at semantics.
2. Investment Product Finder and reverse ownership across ETFs, funds, indices, and bonds.
3. Multi-holding and relationship/PIT super screener.
4. Portfolio X-ray with recursive look-through and exposure evidence.
5. Citation-first natural-language research answers compiled to deterministic queries.

**WE MUST MATCH:** reliable entity search; readable responsive charts; common indicators; compare/overlay; core per-asset screening; watchlists/saved screens; economic/earnings/dividend calendar; credible detail pages; exports; freshness/error states.  
**WE CAN DIFFERENTIATE:** graph search, reverse ownership, multi-holding, look-through, what-changed, PIT, cross-asset events, physical+financial commodities, fund research, fixed-income relative value, evidence-first AI.  
**WE SHOULD IGNORE:** advanced drawing parity; broker execution/DOM; a Pine-compatible language; social publishing network; DEX trading-terminal breadth; tick/second chart arms race.

## Top gaps and opportunities

### TOP_10_GAPS

1. Core workflows do not expose the backend data graph end-to-end.
2. Charting/technical baseline is below user expectation for a market research product.
3. Universal search and canonical entity resolution UX are incomplete.
4. Current per-asset screeners lack TradingView-level polish and breadth.
5. No production-grade cross-asset/relationship/PIT screener.
6. No complete portfolio X-ray/look-through workflow.
7. Research-change alerts and saved research are not user-ready.
8. Data freshness/coverage is uneven; multiple runtime snapshots say quote not ready.
9. Provenance/as-of/known-at/source-vs-derived are not consistently visible in UI.
10. No constrained, citation-first natural-language answer layer.

### TOP_10_OPPORTUNITIES

1. Security → all ETF/fund/index owners, with changes over time.
2. Multi-security → products holding all/any/weighted combinations.
3. Fund/ETF overlap and recursive look-through.
4. “What changed?” feed for holdings, managers, benchmarks, guidance, ratings, macro revisions, and portfolio exposure.
5. Asset-to-investment-product discovery across stocks, ETFs, funds, indices, futures, and related bonds.
6. PIT/no-lookahead research builder.
7. Fixed-income issuer/curve/spread/duration/owner/capital-structure workspace.
8. Macro/commodity shock → affected assets/products and historical reactions.
9. Taiwan fund/ETF/industry-chain research wedge.
10. Evidence-first AI that explains every join, date, source, and derivation.

## Public data opportunity register

Public availability does not imply unrestricted redistribution or commercial-use rights. Terms, rate limits, attribution, archival rules, identifier mapping, and derived-data rights require legal review before production use.

| Source | Domain / fields | Identity method | Adapter state inferred from repo | Expected coverage | Terms/risk | Priority |
|---|---|---|---|---|---|---|
| [SEC EDGAR APIs](https://data.sec.gov/) | US company facts, filings, 13F, N-PORT/N-CEN, insider, events | CIK + series/class IDs + CUSIP mapping | Many SEC models/adapters exist; consolidate | US stocks/funds/ETFs | Public/fair-access; redistribution and identifier mapping review | P0 |
| Exchange/issuer ETF files | holdings, NAV, shares, distributions | ticker/ISIN/CUSIP + issuer product ID | Partial registry/adapters | Issuer-dependent | Format churn; website terms vary | P0 |
| [FRED/ALFRED](https://fred.stlouisfed.org/docs/api/fred/series/series_vintagedates.html) | macro values, release dates, vintages | series ID | FRED/ALFRED structures present | Strong US, selected global | API key/series-specific source terms | P0 |
| Central banks/statistical agencies | rates, fixings, reserves, money, calendars | official series code + country/currency | Many registries/providers present | Country-dependent | Generally public; attribution/format variance | P0 |
| [CFTC COT](https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm) | futures positioning/OI by category | CFTC contract market code → root contract | Positioning models/adapters present | US-reportable futures | Public API/static files; mapping needed | P0 |
| Treasury/FiscalData | auctions, debt, fiscal flows, yield data | security/series IDs | Treasury models present | US sovereign | Public API; definitions/revisions | P1 |
| EIA | energy inventory, production, consumption, reserves | EIA series ID + commodity geography | Energy physical models present | US/global selected | Public API/key and attribution | P1 |
| USDA | crops, supply/demand, production, exports | commodity/geography/marketing year | Commodity adapters partial | Agriculture | API/terms and dimensional normalization | P1 |
| USGS | minerals production/reserves | mineral/country/year | Bootstrap/config exists | Annual minerals | Publication parsing and revisions | P1 |
| [World Bank Indicators API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392) | development/macro indicators | country + indicator | Provider present | Nearly 16,000 series advertised | Public API; indicator-specific source notes | P1 |
| [IMF Data APIs](https://data.imf.org/en/Resource-Pages/IMF-API) | macro, fiscal, balance of payments | SDMX codes | Provider present | Broad global | Portal/account/API evolution; attribution | P1 |
| OECD SDMX | macro/industry indicators | SDMX keys | Provider present | OECD and partners | Dataset licensing/attribution review | P2 |
| Official index provider publications | constituents, weights, rebalances | index code + security identifiers | Partial registry/adapters | Provider-dependent | Often delayed, copyrighted, or licensed | P2 / constrained |
| Crypto chain/exchange public APIs | spot, funding, OI, supply/on-chain facts | chain/address + venue pair | Partial | Fragmented | Rate limits, ToS, reliability, delistings | P2 |

**ENGINEERING_ONLY_GAPS:** normalize existing public regulatory filings; unify identifier crosswalks; calculate overlap/look-through; derive change events; expose graph query APIs; build universal search; add provenance UI; compile natural language to a typed query DSL.  
**LICENSE_CONSTRAINED_GAPS:** consolidated real-time exchange data; professional tick history; evaluated OTC bond prices/OAS; broad credit ratings; comprehensive sell-side estimates/targets; premium news/transcripts; complete proprietary index history; some fund holdings and on-chain vendor metrics.

## Priority registers

Scoring: user value (UV), differentiation (D), availability (A), revenue (R), and time-to-ship (T) are 1–5 where 5 is favorable; engineering cost (C) is 1–5 where 5 is expensive. Priority reflects dependencies and product coherence, not a mechanical sum.

### GAP_REGISTER

| ID | Asset/domain | TradingView feature / expectation | SmartFund current | Public data | License risk | Dependency | UV/D/A/R/C/T | Priority | Recommendation |
|---|---|---|---|---|---|---|---|---|---|
| G01 | Platform/chart | Research-grade charts/compare | Partial | n/a | Medium market data | stable series APIs | 5/1/5/4/3/4 | P0 | Build minimum baseline, not parity |
| G02 | Search | Fast universal symbol search | Partial | n/a | Low | identity index | 5/4/5/5/3/4 | P0 | Universal entity + intent search |
| G03 | Screeners | Mature per-asset screeners | Partial | Mixed | Medium | normalized fields | 5/2/4/4/3/4 | P0 | Stock/ETF/Fund/Bond baseline |
| G04 | Data trust | Freshness and failure transparency | Backend-only | n/a | Low | coverage/health API | 5/4/5/5/2/5 | P0 | Productize health/provenance |
| G05 | Relationships | Cross-asset graph search | Backend-ready | Mostly yes | Medium | canonical edges | 5/5/4/5/4/3 | P1 | Flagship query workflow |
| G06 | ETF/Fund | Reverse ownership/multi-holding | Partial backend | Yes, lagged | Medium | holdings normalization | 5/5/4/5/3/4 | P1 | Build after quality gates |
| G07 | Alerts | Research-change alerts | Backend schema | Yes | Low/medium | event normalization | 5/5/4/5/3/4 | P1 | Holdings/manager/guidance first |
| G08 | Portfolio | Tracking and analysis | Partial | n/a | Medium quotes | portfolio valuation | 4/2/5/4/4/3 | P1 | Match basics; emphasize X-ray |
| G09 | PIT | Historical screen/replay | Partial backend | Source-dependent | Medium | knownAt/effectiveAsOf | 5/5/3/5/5/2 | P2 | No-lookahead research builder |
| G10 | AI | Natural-language research | Not ready | n/a | Low | deterministic query layer | 4/5/5/5/4/3 | P2 | Citation-first, fail closed |
| G11 | Crypto | CEX/DEX breadth | Partial | Yes/mixed | Medium/high | 24/7 ops | 3/1/3/2/5/1 | P3 | Selective research only |
| G12 | Social/Pine | Community + scripting moat | None | n/a | n/a | ecosystem | 2/1/5/2/5/1 | Do not build | Use formulas/no-code queries instead |

### ADVANTAGE_REGISTER

| ID | Domain | Capability | TradingView equivalent | State | User value | Moat | Productization gap | Priority |
|---|---|---|---|---|---|---|---|---|
| A01 | Relationships | Canonical cross-asset graph | Not confirmed at same depth | Current backend | Very high | High | Query API/UI | P1 |
| A02 | Ownership | Security↔ETF/Fund/Index owners | Current screeners/details | Partial | Very high | High | Mapping quality + UX | P1 |
| A03 | Multi-holding | Products holding A+B+C | Not confirmed | Potential | Very high | High | Set/weight/PIT query | P1 |
| A04 | PIT | Holdings/constituents/revisions known at time | Not confirmed | Partial | Very high professional | Very high | Temporal consistency | P2 |
| A05 | Fund | Share class, manager, holdings, changes | Shallower product emphasis | Partial | High | High | Disclosure breadth | P1 |
| A06 | Fixed income | Issuer→bond→curve/spread→owners | Bond screener/yield curves | Partial/current core | High | High | Unified workspace | P2 |
| A07 | Commodity | Physical + futures + COT + assets | Market/chart first | Partial | High | High | Cross-link UI | P2 |
| A08 | Macro | Vintage/revision→asset/product | Macro maps/calendar | Partial | High | High | Sensitivity/event engine | P2 |
| A09 | Taiwan | Local funds/ETFs/chains | Broad markets | Partial | High wedge | Medium/high | completeness/localization | P1 |
| A10 | Trust | Source/as-of/known-at/derivation | Provider display in places | Backend-ready | High | Medium/high | consistent UI contract | P0 |

### DO_NOT_BUILD_REGISTER

| Feature | Why not | TradingView has | SmartFund need | Cost | Distraction risk |
|---|---|---|---|---|---|
| 110+ drawing-tool parity | Little fit with research-search thesis | Yes | Basic annotations only | Very high | Very high |
| Pine-compatible language/ecosystem | Network/community moat takes years | Yes | Typed formulas/no-code query | Extreme | Extreme |
| Broker execution/DOM | Regulatory, integration, support burden | Yes | Export/handoff links | Very high | Very high |
| Social idea publishing network | Cold-start/moderation problem | Yes | Private/shared research initially | High | High |
| DEX trading terminal | Commodity feature, operational risk | Yes | Selective crypto research | High | High |
| Tick/second data arms race | Licensed and not core | Yes | EOD/intraday fit-for-purpose | Extreme | High |
| Generic news firehose | Licensed, undifferentiated | Yes | Event-linked evidence | High | High |
| Uncited open-ended AI analyst | Trust and hallucination risk | Unconfirmed | Constrained cited answers | Medium | High |

## Roadmap

Roadmap items are bounded handoffs, not authorization to implement.

### THREE_MONTH_ROADMAP

**P0 — broad-launch gates**

1. Data truth surface: every result shows source, as-of, known-at where applicable, derived/source-reported, coverage, and stale/error state.
2. Universal search MVP: Stock/ETF/Fund/Index/Bond/Futures/FX/Macro/Commodity/Crypto canonical results, aliases, typeahead, and ambiguous-identity resolution.
3. Minimum chart baseline: responsive candle/line, volume, compare/overlay, 8–12 common indicators, corporate/macro events, date ranges, export, saved view.
4. Four credible screeners: Stock, ETF, Fund, Bond with normalized common filters, saved screen, share/export, and “data unavailable” fail-closed semantics.
5. Runtime/data quality closeout for user-facing universe: resolve ETF failures; define freshness SLAs; gate quote-not-ready domains; publish coverage rather than implying completeness.

**P1 — differentiation slice**

6. Security → ETF/Fund/Index owners, with current weights and disclosure dates.
7. Multi-holding search for up to five securities, current snapshot only.
8. “What changed?” feed for ETF/fund holdings, manager, benchmark/index constituent, guidance, and macro revisions where reliable.
9. Research watchlist and saved queries across entity types.
10. Taiwan-focused Investment Product Finder pilot.

### SIX_MONTH_ROADMAP

- Recursive ETF/fund look-through and overlap with cycle/unknown handling.
- Portfolio X-ray: direct + underlying sector/country/currency/issuer/chain exposure, confidence, and duplicate exposure.
- Cross-asset comparison and benchmark-aware relative performance/risk.
- Research alerts: holdings/manager/benchmark/guidance/rating/macro revision/flow.
- Unified investment calendar connecting events to affected assets and products.
- Fixed-income workspace MVP: issuer, terms, curve/spread/duration, related securities, owners.
- Macro/commodity relationship pages with official-source evidence.
- Packaging: free search/basic charts; Pro multi-holding/history/alerts/export; Professional PIT/API/workspace/reporting.

### TWELVE_MONTH_ROADMAP

- Historical relationship graph with effective dates, known-at dates, revisions, and reproducible snapshots.
- PIT/no-lookahead screener and research backtesting—not order-execution strategy backtesting.
- Natural-language research compiler to deterministic graph/screener queries with citations and explicit uncertainty.
- Scenario/event-reaction analytics linking macro/commodity shocks to assets/products.
- Professional workspace: saved research, notes, comparison snapshots, reports, team sharing, API/export.
- Broaden identity/holdings/constituents/terms only where quality and legal rights meet product SLA.
- Data flywheel: more sources → better identities → more reliable edges → better search/answers → saved queries/alerts → observed unmet research demand.

## Founder decision summary

### IF ONLY 5 THINGS CAN BE BUILT

1. Universal canonical search with visible freshness/provenance.
2. Security-to-product finder and reverse ownership.
3. Multi-holding search + ETF/fund overlap/look-through.
4. What-changed feed and research alerts.
5. Minimum chart/screener baseline sufficient to keep research in one workflow.

### IF ONLY 3 DATA DOMAINS CAN BE EXPANDED

1. ETF/Fund holdings, disclosure history, identity mapping, fees/flows/managers.
2. Cross-asset relationship/PIT graph (including index constituents and industry chains).
3. Fixed-income + macro/commodity linkage, focusing on public official data and transparent limitations.

### IF ONLY 1 MOAT CAN BE BUILT

Build the **historical, evidence-bearing relationship graph** and expose it through product finder, reverse ownership, multi-holding, look-through, what-changed, alerts, and cited AI. These are multiple products sharing one compounding asset.

### Reason to switch / reason to pay

Concrete reasons to use SmartFund alongside TradingView:

1. Find every investable product exposing a security/theme and see why it matches.
2. Search multiple holdings simultaneously across funds/ETFs.
3. See ownership, constituent, manager, benchmark, and exposure changes.
4. X-ray portfolios through funds and ETFs instead of stopping at wrapper tickers.
5. Reproduce research with source, as-of, known-at, and derivation evidence.

Charge for workflow leverage, not raw rows: deeper relationship traversal, historical/PIT queries, alerts, portfolio X-ray, exports/API, saved workspaces, and reports. Keep basic search/current ownership/basic charts free enough to demonstrate the graph.

## Product and information architecture

Recommended primary navigation: **Markets · Search · Screeners · Research · Compare · Portfolio · Watchlist · Discover · AI Research**. The home page should lead with global search, What Changed, Product Finder, cross-asset discovery, research ideas, and a compact market overview—not a TradingView-like chart wall.

Daily habit loop: My Research Feed → watchlist changes → portfolio exposure changes → fund/ETF changes → macro revisions → market snapshot. Weekly loop: portfolio X-ray delta → top holding changes → flows/COT → manager/benchmark/industry-chain changes → research report export.

First-use target: within 30 seconds resolve an entity; within 2 minutes answer “who owns it / what can I buy”; within 5 minutes save a multi-holding or portfolio-exposure workflow and subscribe to changes.

## Follow-up ticket handoff (audit only)

- **STOCK:** close user-facing financial/event coverage gates; productize guidance, institutional/insider, lending and industry-chain evidence separately.
- **ETF:** holdings quality + disclosure timestamp; NAV/premium-discount; flows/distributions; reverse ownership; overlap/look-through.
- **FUND:** canonical share-class mapping; manager/fees/AUM/distributions; holdings history; allocation and style drift; Taiwan wedge.
- **INDEX:** latest breadth; constituent weights/history; rebalance events; benchmark links.
- **FUTURES:** contract/root identity; continuous series; curve and calendar spreads; COT; options-on-futures; contract specifications.
- **FIXED_INCOME:** security master/terms; evaluated-price licensing classification; rating history; issuer/capital structure; curve/spread/duration/carry/rolldown; owner links.
- **FX:** spot freshness; official fixings; forwards/carry; currency indices; reserves; macro sensitivity.
- **MACRO:** series catalog/calendar; ALFRED/PIT revisions; central banks; liquidity/money/fiscal/sovereign; release-to-asset reactions.
- **COMMODITY:** reference/spot and futures linkage; inventory/production/consumption/reserves; COT; carbon/shipping; producer/product relationships.
- **CRYPTO:** selective canonical CEX/DEX coverage; 24/7 freshness; funding/OI; supply/on-chain provenance; explicitly avoid exchange-terminal parity.
- **PLATFORM_UI:** universal search; research chart baseline; screeners; source/as-of UI; saved research; unified calendar; responsive/mobile workflows.
- **AI_SEARCH:** typed research DSL; citation contract; ambiguity resolution; deterministic execution; fail-closed missing-data behavior; answer modes for compare/explain/find/trace/what-changed.

No mixed implementation ticket should combine unrelated asset adapters and UI. Each ticket must define input, output, source rights, identity method, as-of/known-at semantics, coverage gate, failure behavior, API contract, UI consumer, and acceptance evidence.

## Evidence quality and limitations

**HIGH_CONFIDENCE:** TradingView chart/screener/alert/Pine/portfolio/bond/macro/pricing claims supported by current official pages; SmartFund schema and visible routes; the quoted runtime fields and model existence; conclusion that current UI under-productizes backend breadth.  
**MEDIUM_CONFIDENCE:** SmartFund data completeness beyond explicit runtime counts; current worker health (snapshots were read, processes not mutated or independently observed); TradingView depth for every country/asset/plan; SmartFund 12-month potential.  
**LOW_CONFIDENCE / NOT_CONFIRMED:** feature absence when official public documentation did not prove it (especially TradingView AI, historical holdings relationships, deep fund look-through, and supplier/customer graphs); commercial-use rights of source-specific fields until legal review; any runtime claim whose snapshot heartbeat is stale or internally inconsistent.

This audit does not claim TradingView lacks a feature merely because it was not found. `NOT_CONFIRMED` means exactly that. It also does not count planned schema, migrations, or worker code as user-ready SmartFund functionality.

**PUBLIC_SOURCE_DISCOVERY_RUN:** YES  
**TRADINGVIEW_OFFICIAL_SOURCE_RESEARCH:** YES  
**SMARTFUND_PRODUCTION_READBACK:** YES  
**IMPLEMENTATION_RUN:** NO  
**DATABASE_WRITTEN:** NO  
**DATABASE_SCHEMA_CHANGED:** NO  
**PRISMA_CHANGED:** NO  
**MIGRATION_RUN:** NO  
**PRODUCTION_WORKERS_TOUCHED:** NO  
**MASTER_SCHEDULER_TOUCHED:** NO

## Final recommendation

Do not interpret “TradingView has it” as “SmartFund must build it.” Match only the capabilities required to complete a research workflow. Treat missing adapters to public sources as engineering gaps; classify licensed data honestly; do not force coverage with brittle scraping. Most importantly, convert SmartFund’s deeper data and unique relationships into search, discovery, comparison, alerts, portfolio exposure, and reproducible research.

**WHY SMARTFUND EXISTS WHEN TRADINGVIEW ALREADY EXISTS:** because a chart shows what an instrument did, while a trustworthy research graph can explain what it is connected to, who owns it, what changed, which products express the exposure, and what was knowable at the time.

