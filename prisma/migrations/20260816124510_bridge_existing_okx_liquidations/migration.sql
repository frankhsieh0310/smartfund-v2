INSERT INTO crypto_liquidation_events(exchange_id,market_id,asset_id,source_record_id,side,price,quantity,notional,observed_at,known_at,source,payload)
SELECT 'okx',market_id,asset_id,md5(market_id||observed_at::text||metric||payload::text),payload->>'side',(payload->>'price')::numeric,(payload->>'quantity')::numeric,(payload->>'notional')::numeric,observed_at,ingested_at,'OKX_OFFICIAL_PUBLIC_API',payload
FROM crypto_metrics WHERE source='OKX_OFFICIAL_PUBLIC_API' AND metric LIKE 'LIQUIDATION_EVENT_%' AND payload->>'price' IS NOT NULL
ON CONFLICT(exchange_id,source_record_id) DO NOTHING;
