# InvestingPro Global Financial Data — observed inventory

Audit timestamp: 2026-07-31 (Asia/Taipei)
Target: Toyota Motor Corp — InvestingPro trading item `TSE:7203`
Observed page: `https://hk.investing.com/pro/TSE:7203/explorer`

## Evidence boundary

This is an evidence log, not a provider capability claim. The browser session available to this audit displayed **登入** (Sign in), so it did not expose Frank's subscribed InvestingPro session. No cookies, session storage, tokens, credentials, or protected browser profile were inspected. Consequently, an item is marked `OBSERVED`, `VISUAL_ONLY`, or `NOT_VERIFIED`; it is never inferred from a marketing page.

## Explorer categories actually visible

| Category | State |
| --- | --- |
| 熱門 (Popular) | OBSERVED |
| 估值 (Valuation) | OBSERVED |
| 股息 (Dividend) | OBSERVED |
| 風險 (Risk) | OBSERVED |
| 增長 (Growth) | OBSERVED |
| 效率 (Efficiency) | OBSERVED |
| 財務狀況 (Financial condition) | OBSERVED |
| 預測 (Forecast) | OBSERVED |
| 穩健度 (Stability) | OBSERVED |
| 技術面 (Technical) | OBSERVED |
| ETF | OBSERVED |
| 其他指標 (Other metrics) | OBSERVED |

## Directly observed Toyota historical field

| InvestingPro field | Canonical field | Category | Current | Historical series | Periods | Currency / unit | Earliest / latest observed | Data state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 市盈率 (`pe_ltm`) | `trailing_pe` | Valuation | 9.6x | Yes | FY and LTM supported; visible five-row FY trend | multiple | FY 2022-03-31 through FY 2026-03-31 | `OBSERVED_STRUCTURED_UI` |

The visible P/E trend rows were: 2022-03-31 9.9; 2023-03-31 10.5; 2024-03-31 11.4; 2025-03-31 6.7; 2026-03-31 9.6. The page displayed Toyota price `3,067.00 JPY`, and its P/E formula used market cap `37,015.1 B` divided by net income `3,848.1 B`. The metric metadata visibly stated data type “number”, default period “current”, supported periods “FY, LTM”, and plan “free”. This does **not** establish annual/quarterly depth beyond the five rendered fiscal years, a bulk interface, an export schema, or a point-in-time filing date.

## Fields discovered in the actual Explorer UI

The following items were exposed as concrete metric links on the Toyota Explorer. Discovery proves the metric page exists for this trading item only; it does not prove a downloadable time series.

| Explorer field / slug | SmartFund canonical field | Category | Current / history | Annual / quarterly / LTM / forecast | State |
| --- | --- | --- | --- | --- | --- |
| `asset_price_latest` | `price_close` | Market data | Current page link | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `asset_price_close_unadj` | `price_close_unadjusted` | Market data | Page link | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `asset_price_return_1w`, `asset_price_return_6m`, `asset_price_return_1y` | `total_return_*` | Market data | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `marketcap_adj` | `market_cap_adjusted` | Valuation | Page link | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `enterprise_value` | `enterprise_value` | Valuation | Page link | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `pe_ltm`, `pe_fwd` | `trailing_pe`, `forward_pe` | Valuation | P/E directly observed; forward P/E link | FY/LTM only observed for `pe_ltm`; others NOT_VERIFIED | `pe_ltm` OBSERVED; `pe_fwd` DISCOVERED |
| `price_to_book` | `price_to_book` | Valuation | Page link | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `peg_ltm` | `peg_ratio` | Valuation | Page link | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `ev_to_ebitda_ltm` | `ev_to_ebitda` | Valuation | Page link | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `ev_to_revenue_ltm_growth_ratio` | `ev_to_revenue_growth_ratio` | Valuation | Page link | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `total_rev`, `total_rev_growth`, `total_rev_cagr_5y`, `revenue_proj` | `revenue`, `revenue_growth`, `revenue_cagr_5y`, `revenue_forecast` | Income / growth / forecast | Page links | Forecast status only implied by label; NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `ebitda`, `ebitda_proj` | `ebitda`, `ebitda_forecast` | Income / forecast | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `ni_avail_excl`, `ni_proj`, `ni_margin` | `net_income_common`, `net_income_forecast`, `net_margin` | Income / forecast / profitability | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `eps_basic_growth`, `eps_proj` | `basic_eps_growth`, `eps_forecast` | Per-share / forecast | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `equity_common` | `common_equity` | Balance sheet | Page link | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `fcf_levered`, `fcf_yield_ltm`, `owner_earnings` | `levered_free_cash_flow`, `fcf_yield`, `owner_earnings` | Cash flow | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `capex_margin`, `capex_proj` | `capex_margin`, `capex_forecast` | Cash flow / forecast | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `div_share`, `div_share_growth`, `div_share_cagr_5y`, `div_yield` | `dividend_per_share`, `dividend_growth`, `dividend_cagr_5y`, `dividend_yield` | Dividend | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `roe`, `roa`, `roic`, `croic` | `roe`, `roa`, `roic`, `croic` | Profitability / efficiency | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `gp_margin` | `gross_margin` | Profitability | Page link | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `current_ratio`, `quick_ratio` | `current_ratio`, `quick_ratio` | Liquidity | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `total_debt`, `debt_to_equity`, `debt_to_capital`, `net_debt_to_capital`, `current_port_debt_leases` | `total_debt`, `debt_to_equity`, `debt_to_capital`, `net_debt_to_capital`, `current_debt_and_leases` | Solvency | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `beta`, `altman_z_score`, `beneish_mscore`, `piotroski_score`, `rsi_14d` | `beta_5y`, `altman_z_score`, `beneish_m_score`, `piotroski_score`, `rsi_14d` | Risk / stability / technical | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |
| `shares_float_pct`, `volume_dollar_avg_3m`, `short_ratio` | `float_percentage`, `avg_dollar_volume_3m`, `short_ratio` | Market data | Page links | NOT_VERIFIED | DISCOVERED_IN_EXPLORER |

## Required Toyota fields: audit state

| Canonical field | Observed provider evidence | Historical verified | Period / date verified | State |
| --- | --- | --- | --- | --- |
| Revenue | `total_rev` Explorer link | No | No | VISUAL_ONLY |
| Gross profit | No direct observed field in this session | No | No | NOT_VERIFIED |
| Operating income | No direct observed field in this session | No | No | NOT_VERIFIED |
| EBITDA | `ebitda` Explorer link | No | No | VISUAL_ONLY |
| Net income | `ni_avail_excl` Explorer link; P/E formula showed a current net-income input | No | No | VISUAL_ONLY |
| Basic / diluted EPS | `eps_basic_growth`, `eps_proj` Explorer links | No | No | VISUAL_ONLY |
| Cash / assets / liabilities | No direct observed field in this session | No | No | NOT_VERIFIED |
| Shareholders' equity | `equity_common` Explorer link | No | No | VISUAL_ONLY |
| Operating cash flow | No direct observed field in this session | No | No | NOT_VERIFIED |
| CapEx | `capex_margin`, `capex_proj` Explorer links | No | No | VISUAL_ONLY |
| Free cash flow | `fcf_levered` Explorer link | No | No | VISUAL_ONLY |
| Shares outstanding | No direct observed field in this session | No | No | NOT_VERIFIED |
| P/E | `pe_ltm` | Yes | FY 2022–2026; FY/LTM support stated | OBSERVED_STRUCTURED_UI |
| P/B / P/S | `price_to_book` observed; P/S not directly observed | No | No | VISUAL_ONLY / NOT_VERIFIED |
| EV / EV-EBITDA | `enterprise_value`, `ev_to_ebitda_ltm` Explorer links | No | No | VISUAL_ONLY |
| ROE / ROA / ROIC | `roe`, `roa`, `roic` Explorer links | No | No | VISUAL_ONLY |
| Margins | `gp_margin`, `ni_margin` Explorer links | No | No | VISUAL_ONLY |
| Debt/equity / current ratio | Corresponding Explorer links | No | No | VISUAL_ONLY |
| Dividend yield | `div_yield` Explorer link | No | No | VISUAL_ONLY |

## Export result

No Toyota financial export or CSV/XLSX was observed in the available unauthenticated session. “導出清單” linked to a public metric-list Google Spreadsheet, not a Toyota export. The visible `計算範例` control on the P/E page emitted no browser download event within five seconds. No raw data file was created or archived.
