import { PrismaClient } from "@prisma/client";
import { boundedDbRetry, futuresDatabaseUrl } from "../../../lib/data-platform/runtime/boundedFuturesDb.ts";

const db=new PrismaClient({datasources:{db:{url:futuresDatabaseUrl()}}});
try{
  const [census]=await boundedDbRetry(()=>db.$queryRawUnsafe<any[]>(`SELECT
    (SELECT count(*)::int FROM futures_product_roots WHERE asset_class='COMMODITY_FUTURES') products,
    (SELECT count(*)::int FROM futures_contracts WHERE asset_class='COMMODITY_FUTURES') contracts,
    (SELECT count(*)::int FROM futures_observations WHERE asset_class='COMMODITY_FUTURES') history_rows,
    (SELECT count(DISTINCT c.root_id)::int FROM futures_contracts c JOIN futures_observations o ON o.contract_id=c.id WHERE c.asset_class='COMMODITY_FUTURES' AND o.open IS NOT NULL AND o.high IS NOT NULL AND o.low IS NOT NULL AND o.close IS NOT NULL) ohlc_products,
    (SELECT count(DISTINCT c.root_id)::int FROM futures_contracts c JOIN futures_observations o ON o.contract_id=c.id WHERE c.asset_class='COMMODITY_FUTURES' AND o.volume IS NOT NULL) volume_products,
    (SELECT count(DISTINCT c.root_id)::int FROM futures_contracts c JOIN futures_observations o ON o.contract_id=c.id WHERE c.asset_class='COMMODITY_FUTURES' AND o.open_interest IS NOT NULL) open_interest_products,
    (SELECT count(DISTINCT c.root_id)::int FROM futures_contracts c JOIN futures_observations o ON o.contract_id=c.id WHERE c.asset_class='COMMODITY_FUTURES' AND o.settlement IS NOT NULL) settlement_products,
    (SELECT count(*)::int FROM futures_settlements s JOIN futures_contracts c ON c.id=s.contract_id WHERE c.asset_class='COMMODITY_FUTURES') settlement_rows,
    (SELECT min(o.observed_at)::text FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id WHERE c.asset_class='COMMODITY_FUTURES') earliest,
    (SELECT max(o.observed_at)::text FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id WHERE c.asset_class='COMMODITY_FUTURES') latest,
    (SELECT count(DISTINCT c.root_id)::int FROM futures_contracts c JOIN futures_observations o ON o.contract_id=c.id WHERE c.asset_class='COMMODITY_FUTURES' AND o.source='CME Group') cme_source_products`));
  const roots=await boundedDbRetry(()=>db.$queryRawUnsafe<any[]>(`SELECT r.root_symbol,r.exchange,r.official_product_name,r.verification_status,count(DISTINCT c.id)::int contracts,count(o.id)::int observations,array_agg(DISTINCT o.source) FILTER(WHERE o.source IS NOT NULL) sources FROM futures_product_roots r LEFT JOIN futures_contracts c ON c.root_id=r.id LEFT JOIN futures_observations o ON o.contract_id=c.id WHERE r.asset_class='COMMODITY_FUTURES' GROUP BY r.id ORDER BY r.root_symbol,r.exchange`));
  console.log(JSON.stringify({census,roots}));
}finally{await db.$disconnect()}
