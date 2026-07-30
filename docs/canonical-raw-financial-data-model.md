# SmartFund Canonical Raw Financial Data Model v1

## Rule of record

This model supersedes metric-centred discovery for Financial ingestion. A value is
canonical only when it is a raw, attributable fact. Ratios, valuations, scores,
growth rates, returns and rankings are formula outputs, never source-of-truth
financial facts.

Every raw fact must retain: `entity`, `canonical_field`, `value`, `unit`,
`currency`, `period_start`, `period_end`, `fiscal_period`, `filing_date`,
`publication_date`, `restatement_version`, `source`, `source_document_url`,
`source_fact_id`, `imported_at` and quality status.

## Canonical domains

`config/raw-financial-data.json` defines eleven extensible raw-data domains:

1. market price and trading facts;
2. share capital and float facts;
3. income statement facts;
4. balance-sheet assets;
5. balance-sheet liabilities and equity;
6. cash-flow facts;
7. per-share and distribution facts;
8. corporate-event facts;
9. ownership disclosure facts;
10. analyst disclosure facts; and
11. entity, filing and period metadata.

The canonical list is deliberately extensible: a newly discovered disclosure is
added as a raw field rather than forcing it into a pre-existing ratio.

## Point-in-time rule

For a market date *D*, formulas may use only prices from *D* and raw filing
facts whose `publication_date <= D`. Restatements are stored as new versions;
they must not overwrite the version that was knowable historically.

## Source capability rule

Source records describe raw fact domains, not derived metrics. SEC EDGAR,
MOPS/TWSE, TPEx and XBRL filing archives are candidate raw-statement sources;
Yahoo Chart is a price/event source. Commercial eligibility remains separately
governed by the source-license matrix.

## Explicit non-goals

This is a specification only. It creates no database table, API, crawler or
historical ingestion process.
