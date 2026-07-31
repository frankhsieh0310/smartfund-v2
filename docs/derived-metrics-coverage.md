# Derived Metrics Coverage

Snapshot: 2026-07-31. The canonical fact store can retain raw or derived metrics with provenance, but there is not yet a globally scheduled derived-metrics production pipeline.

| Metric | Required raw dependencies | Actual production evidence | Status | Validation expectation |
| --- | --- | --- | --- | --- |
| Market cap | Close × point-in-time shares | No global series | Not started | Price basis + shares basis |
| Enterprise value | Market cap + debt - cash | No global series | Not started | Raw fact reconciliation |
| PE / trailing PE | Close + point-in-time TTM EPS | Taiwan: 97 stocks; US proof: 3 stocks | Partial / Prototype | Filing availability, split-consistent price/EPS |
| Forward PE / PEG | Price + forward estimates | No global series | Not started | Estimate-provider provenance |
| PB / PS | Price + book value / sales per share | No global series | Not started | Same period and share basis |
| Dividend yield / payout | Dividend events + price / earnings | No global series | Not started | Corporate-action event validation |
| ROE / ROA / ROIC | Net income + average equity/assets/invested capital | No global series | Prototype | Period alignment |
| Gross / operating / net / EBIT / EBITDA margin | Statement line item ÷ revenue | No global series | Prototype | Same fiscal period |
| Current / quick ratio | Current assets ÷ current liabilities | No global series | Prototype | Balance-sheet period alignment |
| Debt/equity / debt/assets | Debt ÷ equity/assets | No global series | Prototype | Raw fact normalization |
| Interest coverage | EBIT ÷ interest expense | No global series | Not started | Raw fact coverage |
| Asset / inventory turnover | Revenue or COGS ÷ average assets/inventory | No global series | Not started | Average balance policy |
| EV/revenue / EV/EBITDA | Point-in-time EV ÷ trailing financial value | No global series | Not started | Price/fact as-of alignment |
| Free-cash-flow yield / price-to-FCF | FCF + market cap / price | No global series | Not started | FCF definition and period alignment |
| Book value per share | Equity ÷ shares | No global series | Prototype | Point-in-time shares policy |

## Present facts versus calculated metric

`valuation.pe` exists as official Taiwan observations (84,905 rows for 97 stocks). `valuation.pe.ttm.point_in_time` exists as a three-stock US validation proof. These are the only ratio/valuation series that this audit can demonstrate; they must not be treated as a global ratios product.

## Production rule

Every derived metric requires: normalized raw inputs, a versioned formula, point-in-time availability, source provenance, input-period compatibility, and a validation result. Metrics without all five remain prototype data.
