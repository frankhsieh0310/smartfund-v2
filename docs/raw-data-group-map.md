# Raw Data Group Map

The 246 raw fields are normalized into **50 canonical groups**. A group contains
synonyms or closely related disclosure facts, but never replaces the original
source tag, unit, period, currency or restatement version.

| Domain | Canonical groups |
| --- | --- |
| Market | session prices; adjusted price; volume; VWAP; turnover; order book; session range; 52-week range; trading currency; FX conversion |
| Share capital | issued shares; outstanding shares; weighted-average shares; authorized shares; treasury shares; restricted shares; preferred shares; convertibles; awards; float; short/loaned shares; issuance/cancellation; repurchase |
| Income | revenue; revenue adjustments; cost of revenue; gross profit; R&D; SGA; operating expenses; operating income; D&A; impairment/restructuring; interest/investment/FX; other non-operating; pretax; tax; net income; comprehensive income; minority/preferred/discontinued attribution |
| Assets | cash; short-term investments; restricted cash; receivables and allowance; inventory; prepaids/other current; current assets; PPE; right-of-use assets; goodwill/intangibles; deferred tax; associates/long-term investments; other non-current; total assets |
| Liabilities & equity | payables/accruals; short-term debt; current debt/lease; contracts/deferred revenue; current liabilities; long-term debt/lease; tax/pension/provisions; other non-current; total liabilities; contributed capital; retained earnings; OCI; treasury value; parent equity; minority interest; total equity |
| Cash flow | non-cash operating adjustments; working capital; CFO; capex; acquisition/disposal; investment purchases/sales; CFI; debt financing; equity financing; dividends; lease principal; CFF; FX effect; cash reconciliation |
| Distribution & events | EPS; book value/share; ordinary/special dividends; dividend dates; withholding; split; rights; merger/spin-off; listing/delisting; offerings/buybacks; index events; earnings/calendar events |
| Ownership & analyst | holder identity/position/change; insider identity/transaction; short interest; analyst identity; estimates; targets; rating/action; estimate range/count; actual/surprise |
| Provenance | entity identity; listing/classification; reporting standard/currency; fiscal period; filing/publication date; restatement; source document; source fact ID |

### Normalization rules

1. Preserve reported values; map synonyms into a `canonical_group` without
   discarding the original XBRL tag or document line label.
2. Never merge `shares_outstanding` and weighted-average shares; they solve
   different formulas.
3. Never derive `EBITDA`, `free_cash_flow`, debt or equity silently from a
   vendor value; retain the raw components and formula version.
4. Values with a different reporting period, currency, share class or
   restatement version are separate observations.
