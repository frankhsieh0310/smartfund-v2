INSERT INTO "currency_index_observation_meta" (
  "id", "symbol", "observation_date", "observation_type", "source", "source_type",
  "source_record_id", "source_url", "as_of_date", "ingested_at", "retrieved_at",
  "parser_version", "checksum", "checksum_status", "verification_status", "license_status", "quality_status"
)
SELECT
  gen_random_uuid(), md."symbol", md."date",
  CASE WHEN md."open" IS NULL AND md."high" IS NULL AND md."low" IS NULL THEN 'VALUE_ONLY' ELSE 'OHLC' END,
  COALESCE(md."source", 'LEGACY_SOURCE_UNSPECIFIED'),
  CASE WHEN md."symbol" = 'DXY' THEN 'PUBLIC_SUPPLEMENTAL' ELSE 'PUBLIC_OFFICIAL' END,
  CASE md."symbol"
    WHEN 'DXY' THEN 'DX-Y.NYB:' || to_char(md."date", 'YYYY-MM-DD')
    WHEN 'FED_BROAD_DOLLAR' THEN 'DTWEXBGS:' || to_char(md."date", 'YYYY-MM-DD')
    WHEN 'FED_TRADE_WEIGHTED_DOLLAR' THEN 'DTWEXBGS:' || to_char(md."date", 'YYYY-MM-DD')
    WHEN 'BIS_USD_NEER' THEN 'NBUSBIS:' || to_char(md."date", 'YYYY-MM-DD')
    WHEN 'BIS_USD_REER' THEN 'RBUSBIS:' || to_char(md."date", 'YYYY-MM-DD')
    WHEN 'EUR_INDEX' THEN 'NBXMBIS:' || to_char(md."date", 'YYYY-MM-DD')
    WHEN 'JPY_INDEX' THEN 'NBJPBIS:' || to_char(md."date", 'YYYY-MM-DD')
  END,
  CASE md."symbol"
    WHEN 'DXY' THEN 'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB'
    WHEN 'FED_BROAD_DOLLAR' THEN 'https://fred.stlouisfed.org/series/DTWEXBGS'
    WHEN 'FED_TRADE_WEIGHTED_DOLLAR' THEN 'https://fred.stlouisfed.org/series/DTWEXBGS'
    WHEN 'BIS_USD_NEER' THEN 'https://fred.stlouisfed.org/series/NBUSBIS'
    WHEN 'BIS_USD_REER' THEN 'https://fred.stlouisfed.org/series/RBUSBIS'
    WHEN 'EUR_INDEX' THEN 'https://fred.stlouisfed.org/series/NBXMBIS'
    WHEN 'JPY_INDEX' THEN 'https://fred.stlouisfed.org/series/NBJPBIS'
  END,
  md."date", md."created_at", md."created_at", 'provenance-reconciler-v3',
  md5(concat_ws('|', md."symbol", md."date"::text, md."open"::text, md."high"::text, md."low"::text, md."close"::text, md."volume"::text, COALESCE(md."source", ''))),
  'COMPUTED_MD5_CANONICAL_FIELDS',
  CASE WHEN md."symbol" = 'DXY' THEN 'SUPPLEMENTAL_RECONCILED' ELSE 'VERIFIED' END,
  CASE WHEN md."symbol" = 'DXY' THEN 'LICENSE_REQUIRED' WHEN md."symbol" IN ('BIS_USD_NEER','BIS_USD_REER','EUR_INDEX','JPY_INDEX') THEN 'PUBLIC_CITATION_REQUIRED' ELSE 'PUBLIC' END,
  'VALID'
FROM "market_data" md
WHERE md."close" > 0
  AND md."symbol" IN ('DXY','FED_BROAD_DOLLAR','FED_TRADE_WEIGHTED_DOLLAR','BIS_USD_NEER','BIS_USD_REER','EUR_INDEX','JPY_INDEX')
ON CONFLICT ("symbol", "observation_date") DO UPDATE SET
  "observation_type" = EXCLUDED."observation_type", "source" = EXCLUDED."source",
  "source_type" = EXCLUDED."source_type", "source_record_id" = EXCLUDED."source_record_id",
  "source_url" = EXCLUDED."source_url", "as_of_date" = EXCLUDED."as_of_date",
  "retrieved_at" = EXCLUDED."retrieved_at", "parser_version" = EXCLUDED."parser_version",
  "checksum" = EXCLUDED."checksum", "checksum_status" = EXCLUDED."checksum_status",
  "verification_status" = EXCLUDED."verification_status", "license_status" = EXCLUDED."license_status",
  "quality_status" = EXCLUDED."quality_status";
