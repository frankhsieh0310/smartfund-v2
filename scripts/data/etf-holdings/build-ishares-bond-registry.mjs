import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("config", "ishares-bond-etf-products.json");
const HTML = path.resolve("runtime", "fixed-income", "bond-etf-research-v24", "ishares-products.html");
function dbUrl() { const u = new URL(process.env.DATABASE_URL); u.searchParams.set("connection_limit", "1"); u.searchParams.set("pgbouncer", "true"); return u.toString(); }
function decode(value) { return value.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&reg;", "®").replace(/<[^>]+>/g, "").trim(); }
async function main() {
  const html = await readFile(HTML, "utf8");
  const official = new Map();
  const re = /<tr>[\s\S]*?<td class="links"><a href="(\/us\/products\/(\d+)\/([^"]+))">([^<]+)<\/a><\/td>[\s\S]*?<td class="links"><a[^>]*>([^<]+)<\/a><\/td>[\s\S]*?<\/tr>/g;
  for (const match of html.matchAll(re)) official.set(match[4].trim().toUpperCase(), { productId: match[2], slug: match[3], code: match[4].trim().toUpperCase(), name: decode(match[5]), productUrl: `https://www.ishares.com${match[1]}` });
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl() } } });
  try {
    const bond = await prisma.$queryRawUnsafe(`SELECT DISTINCT e.id,e.code,e.name FROM etfs e JOIN asset_knowledge_tags a ON a.etf_id=e.id AND a.asset_type='ETF' JOIN knowledge_tags t ON t.id=a.tag_id AND t.tag_key='FIXED_INCOME:BOND_ETF'`);
    const products = bond.flatMap(row => { const hit = official.get(String(row.code).toUpperCase()); return hit ? [{ ...hit, etfId: row.id, canonicalName: row.name, sourceUrl: `${hit.productUrl}/latest-holdings.csv`, researchUrl: hit.productUrl }] : []; });
    const payload = { version: 1, source: "ISHARES_OFFICIAL_PRODUCT_DIRECTORY", fetchedFile: path.relative(process.cwd(), HTML), exactTickerMappingOnly: true, generatedAt: new Date().toISOString(), products };
    await mkdir(path.dirname(OUT), { recursive: true }); const temp = `${OUT}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`); await rename(temp, OUT);
    console.log(JSON.stringify({ officialProducts: official.size, exactBondEtfMappings: products.length, output: OUT }, null, 2));
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
