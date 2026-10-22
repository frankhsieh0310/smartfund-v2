import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const engine = resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if (process.platform === "win32" && !process.env.PRISMA_QUERY_ENGINE_LIBRARY) process.env.PRISMA_QUERY_ENGINE_LIBRARY = engine;
const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });

const catalog = JSON.parse(await readFile(resolve("runtime/etf-moneydj-public-data/moneydj-etf-universe.json"), "utf8"));
const moneydjItems: Array<{ moneydjId: string; name: string }> = catalog.etfs;
const etfs = await db.$queryRawUnsafe<Array<{ id: string; code: string; dataSource: string | null; exchange: string | null }>>(`SELECT id,code,data_source "dataSource",exchange FROM etfs WHERE is_active=true`);
const byDataSource = new Map<string, typeof etfs>();
const byCode = new Map<string, typeof etfs>();
for (const etf of etfs) {
  const ds = etf.dataSource?.toUpperCase(); if (ds) byDataSource.set(ds, [...(byDataSource.get(ds) ?? []), etf]);
  byCode.set(etf.code.toUpperCase(), [...(byCode.get(etf.code.toUpperCase()) ?? []), etf]);
}
const mdMappedIds = new Set<string>(), mdAmbiguous: string[] = [];
for (const item of moneydjItems) {
  const base = item.moneydjId.replace(/\.(TW|TWO|T|L|HK|AX|TO|V|PA|DE|AS|SW|SI|SH|SZ)$/i, "").toUpperCase();
  const hits = [...new Map([...(byDataSource.get(item.moneydjId.toUpperCase()) ?? []), ...(byCode.get(base) ?? [])].map((row) => [row.id, row])).values()];
  if (hits.length === 1) mdMappedIds.add(hits[0].id); else if (hits.length > 1) mdAmbiguous.push(item.moneydjId);
}
const mdHoldingRows = await db.$queryRawUnsafe<Array<{ etfId: string }>>(`SELECT DISTINCT etf_id "etfId" FROM etf_holding_snapshots WHERE source='MONEYDJ_ETF_PUBLIC' AND canonical_row_count>0`);
const mdHoldingIds = new Set(mdHoldingRows.map((row) => row.etfId));

const rawDir = resolve("runtime/etf-yahoo-product-modules/raw"), latest = new Map<string, any>();
for (const file of await readdir(rawDir)) {
  if (!file.endsWith(".json")) continue;
  const id = file.slice(0, 36); if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
  try { const artifact = JSON.parse(await readFile(resolve(rawDir, file), "utf8")); const old = latest.get(id); if (!old || String(artifact.retrievedAt) > String(old.retrievedAt)) latest.set(id, artifact); } catch {}
}
let yahooResponses = 0, yahooTopHoldings = 0;
for (const artifact of latest.values()) {
  const result = artifact?.payload?.quoteSummary?.result?.[0];
  if (result) yahooResponses++;
  if (Array.isArray(result?.topHoldings?.holdings) && result.topHoldings.holdings.length) yahooTopHoldings++;
}
const yahooHoldingRows = await db.$queryRawUnsafe<Array<{ etfId: string }>>(`SELECT DISTINCT etf_id "etfId" FROM etf_holding_snapshots WHERE upper(source) LIKE '%YAHOO%' AND canonical_row_count>0`);

const [fundStats] = await db.$queryRawUnsafe<any[]>(`SELECT
 (SELECT count(*)::int FROM moneydj_external_products) moneydj_products,
 (SELECT count(*)::int FROM moneydj_external_products WHERE canonical_fund_id IS NOT NULL) moneydj_products_assigned,
 (SELECT count(*)::int FROM funds WHERE is_active=true) funds,
 (SELECT count(*)::int FROM fund_mappings WHERE moneydj_code IS NOT NULL AND moneydj_code<>'1') moneydj_mapped,
 (SELECT count(DISTINCT fund_id)::int FROM holdings WHERE source='MONEYDJ_PUBLIC_DISCLOSURE' AND fund_id IS NOT NULL) moneydj_with_holdings,
 (SELECT count(*)::int FROM fund_provider_mappings WHERE lower(provider)='yahoo') yahoo_mappings
`);
const yahooFundMappings = await db.$queryRawUnsafe<any[]>(`SELECT provider_code "providerCode",status,source,mapping_method "mappingMethod",count(*)::int count FROM fund_provider_mappings WHERE lower(provider)='yahoo' GROUP BY 1,2,3,4 ORDER BY count DESC LIMIT 20`);

console.log(JSON.stringify({
  moneydjEtf: { catalog: moneydjItems.length, exactMapped: mdMappedIds.size, ambiguous: mdAmbiguous.length, withCanonicalHoldings: [...mdMappedIds].filter((id) => mdHoldingIds.has(id)).length, parserWriterGap: [...mdMappedIds].filter((id) => !mdHoldingIds.has(id)).length },
  yahooEtf: { canonicalUniverse: etfs.length, rawIdentityArtifacts: latest.size, quoteSummaryResponses: yahooResponses, topHoldingsPayloads: yahooTopHoldings, canonicalYahooHoldings: yahooHoldingRows.length, mappingGapAgainstUniverse: etfs.length - latest.size, parserWriterGapAgainstArtifacts: latest.size - yahooHoldingRows.length },
  fundStats, yahooFundMappings,
}, null, 2));
await db.$disconnect();
