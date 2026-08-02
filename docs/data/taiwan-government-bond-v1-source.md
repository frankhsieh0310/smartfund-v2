# Taiwan Government Bond V1 source contract

Snapshot: 2026-08-02 (Asia/Taipei)

## Official source

- Provider: Taipei Exchange (TPEx / 證券櫃檯買賣中心)
- OpenAPI catalog: `https://www.tpex.org.tw/openapi/`
- Endpoint: `https://www.tpex.org.tw/openapi/v1/bond_ISSBD1_data`
- Catalog description: 公債發行資料下載
- Identifier: `BondCode`
- Current denominator: 197 unique BondCodes (146 central-government issuer code `G001`; 51 other government issuer codes)
- Authentication: none
- Retrieved format: JSON over HTTPS
- Use condition: official OpenAPI usage terms remain controlling; raw and normalized lineage must retain the source URL and retrieval timestamp.

## Field coverage at V1 start

| Field | Coverage |
| --- | ---: |
| BondCode | 197 / 197 |
| Issuer | 197 / 197 |
| Issue date | 197 / 197 |
| Maturity date | 197 / 197 |
| Coupon rate | 197 / 197 |
| Issue amount | 197 / 197 |
| Outstanding amount | 197 / 197 |
| Currency code | 197 / 197 |

The endpoint also supplies series/tranche, listing date/status, tenor, coupon/payment frequency and repayment metadata. SmartFund stores the complete source payload and normalized record in the durable archive; the existing `securities` table safely carries identity only.

## Scope boundary

- The endpoint is an official current issuance master. It is sufficient for the current individual government-bond universe, identity, terms and latest official snapshot.
- Issue dates span 2001-07-17 through 2026-07-28 and maturity dates span 2026-09-07 through 2056-05-29 in the 2026-08-02 snapshot.
- The endpoint does not expose prior point-in-time versions of each master record. SmartFund therefore begins its own reproducible snapshot history from V1 ingestion; older point-in-time history remains `PARTIAL`.
- Individual secondary-market price/yield history is a separate layer. It must not be inferred from an index or aggregate yield curve.
- Detailed terms, market observations and source-document canonical tables remain a schema gap requiring owner-approved migration. This does not block identity ingestion, durable archive, freshness or incremental maintenance.

## Secondary-market V1 evidence

- Official current report index: `https://www.tpex.org.tw/web/bond/tradeinfo/govbond/GovBondDaily.php?l=zh-tw`
- Official legacy report index: `https://hist.tpex.org.tw/HIST/BOND_TRADING_INFO/GOV_BOND/30/DYS01.HTML`
- Report code: `BDdys01a` / legacy `DYS01` (individual-bond outright-purchase-and-sale observations).
- Historical range archived: 2001-11-20 through 2026-07-31.
- Reports completed: 6,127 / 6,127 checked official report dates.
- Normalized individual-government-bond observations: 69,254.
- Historical individual-security universe discovered: 347 unique government-bond codes.
- Current issuance-master universe: 197; it is intentionally not used as the historical denominator.
- Open failure queue: 0.
- Durable archive replay: PASS.
- Latest actual official report at the 2026-08-02 weekend snapshot: 2026-07-31; seven government bonds traded.
- Non-government rows in the shared official daily files are excluded before normalization; 8,743 such rows were isolated in the modern segment.
- Canonical DB writes: 0. Production has no bond market-observation table, so raw and normalized V1 history remains in the durable archive pending an owner-approved schema decision.
