import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve("runtime", "fixed-income", "bond-etf-research-v23");
const now = () => new Date().toISOString();
const tags = [
  ["FIXED_INCOME:BOND_ETF", "債券 ETF", "Bond ETF"],
  ["FIXED_INCOME:AGGREGATE", "綜合債券", "Aggregate Bond"],
  ["FIXED_INCOME:GOVERNMENT", "政府債券", "Treasury / Government"],
  ["FIXED_INCOME:CORPORATE_IG", "投資級公司債", "Investment Grade Corporate"],
  ["FIXED_INCOME:HIGH_YIELD", "高收益債", "High Yield"],
  ["FIXED_INCOME:EMERGING_MARKETS", "新興市場債", "Emerging Market Bond"],
  ["FIXED_INCOME:INFLATION_LINKED", "抗通膨債券", "Inflation Linked"],
  ["FIXED_INCOME:MBS", "房貸抵押證券", "Mortgage-Backed Securities"],
  ["FIXED_INCOME:MUNICIPAL", "市政債券", "Municipal Bond"],
  ["FIXED_INCOME:FLOATING_RATE", "浮動利率債券", "Floating Rate"],
  ["FIXED_INCOME:CLO_LOAN", "CLO／貸款", "CLO / Loan"],
  ["FIXED_INCOME:CONVERTIBLE", "可轉換債券", "Convertible Bond"],
  ["FIXED_INCOME:INTERNATIONAL", "國際債券", "International Bond"],
];
async function atomic(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, file); }
function dbUrl() { if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED"); const url = new URL(process.env.DATABASE_URL); url.searchParams.set("connection_limit", "1"); url.searchParams.set("pgbouncer", "true"); return url.toString(); }

const base = `(coalesce(e.name,'')||' '||coalesce(e.name_en,'')||' '||coalesce(e.category,'')||' '||coalesce(e.benchmark,'')||' '||coalesce(e.sector,''))`;
const include = `${base} ~* '(bond|fixed[ -]?income|treasury|government debt|gilts?|gilt |corporate debt|high[ -]?yield|municipal|inflation[ -]?(linked|protected)|mortgage[ -]?backed|\\bMBS\\b|emerging market debt|floating rate|senior loan|bank loan|\\bCLO\\b|convertible|aggregate debt|債券|公債|公司債|金融債|高收益債|投資級債|可轉債|國債)'`;
const exclude = `${base} !~* '(equity|stock|preferred stock|crypto|bitcoin|commodity|gold|silver)'`;

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl() } } });
  await atomic(path.join(ROOT, "checkpoint.json"), { state: "RUNNING", pid: process.pid, checkpoint: "CLASSIFY", maxDbConcurrency: 1, heartbeat: now() });
  try {
    let databaseRowsAdded = 0;
    for (const [key, zh, en] of tags) databaseRowsAdded += await prisma.$executeRawUnsafe(`INSERT INTO knowledge_tags(id,tag_type,tag_key,label_zh,label_en,sort_order,description) VALUES(gen_random_uuid()::text,'ASSET_CLASS',$1,$2,$3,0,'Deterministic Fixed Income ETF research taxonomy') ON CONFLICT(tag_key) DO NOTHING`, key, zh, en);
    const tagRules = [
      ["FIXED_INCOME:BOND_ETF", "TRUE"],
      ["FIXED_INCOME:AGGREGATE", `${base} ~* '(aggregate|universal|總體|綜合債)'`],
      ["FIXED_INCOME:GOVERNMENT", `${base} ~* '(treasury|government|sovereign|gilt|公債|國債)'`],
      ["FIXED_INCOME:CORPORATE_IG", `${base} ~* '(investment[ -]?grade|corporate bond|corporate debt|公司債|投資級)' AND ${base} !~* '(high[ -]?yield|junk|非投資)'`],
      ["FIXED_INCOME:HIGH_YIELD", `${base} ~* '(high[ -]?yield|junk bond|非投資|高收益)'`],
      ["FIXED_INCOME:EMERGING_MARKETS", `${base} ~* '(emerging market|em bond|新興市場)'`],
      ["FIXED_INCOME:INFLATION_LINKED", `${base} ~* '(inflation|tips|抗通膨)'`],
      ["FIXED_INCOME:MBS", `${base} ~* '(mortgage|mbs|房貸抵押)'`],
      ["FIXED_INCOME:MUNICIPAL", `${base} ~* '(municipal|muni|市政債)'`],
      ["FIXED_INCOME:FLOATING_RATE", `${base} ~* '(floating|浮動利率)'`],
      ["FIXED_INCOME:CLO_LOAN", `${base} ~* '(clo|senior loan|bank loan|貸款)'`],
      ["FIXED_INCOME:CONVERTIBLE", `${base} ~* '(convertible|可轉)'`],
      ["FIXED_INCOME:INTERNATIONAL", `${base} ~* '(international|global bond|world bond|全球債|國際債)'`],
    ];
    for (const [key, rule] of tagRules) databaseRowsAdded += await prisma.$executeRawUnsafe(`INSERT INTO asset_knowledge_tags(id,asset_type,etf_id,tag_id,confidence,tagged_by,created_at) SELECT gen_random_uuid()::text,'ETF',e.id,t.id,0.95,'DETERMINISTIC_BOND_ETF_V23',NOW() FROM etfs e JOIN knowledge_tags t ON t.tag_key=$1 WHERE e.is_active=true AND ${include} AND ${exclude} AND (${rule}) AND NOT EXISTS(SELECT 1 FROM asset_knowledge_tags a WHERE a.asset_type='ETF' AND a.etf_id=e.id AND a.tag_id=t.id)`, key);
    const [summary] = await prisma.$queryRawUnsafe(`WITH b AS (SELECT DISTINCT a.etf_id FROM asset_knowledge_tags a JOIN knowledge_tags t ON t.id=a.tag_id WHERE a.asset_type='ETF' AND t.tag_key='FIXED_INCOME:BOND_ETF') SELECT count(*)::int bond_etfs_found,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM etf_history h WHERE h.etf_id=b.etf_id))::int with_history,count(*) FILTER(WHERE e.latest_nav IS NOT NULL OR EXISTS(SELECT 1 FROM etf_history h WHERE h.etf_id=b.etf_id AND h.nav IS NOT NULL))::int with_nav,count(*) FILTER(WHERE e.dividend_yield IS NOT NULL OR EXISTS(SELECT 1 FROM etf_history h WHERE h.etf_id=b.etf_id AND h.dividend_yield IS NOT NULL))::int with_yield,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM holdings h WHERE h.etf_id=b.etf_id AND h.asset_type='ETF'))::int with_holdings,count(*) FILTER(WHERE e.benchmark IS NOT NULL AND trim(e.benchmark)<>'')::int with_benchmark,coalesce((SELECT count(*) FROM etf_history h WHERE h.etf_id IN(SELECT etf_id FROM b)),0)::bigint history_rows FROM b JOIN etfs e ON e.id=b.etf_id`);
    const [classification] = await prisma.$queryRawUnsafe(`SELECT count(*)::int rows FROM asset_knowledge_tags WHERE asset_type='ETF' AND tagged_by='DETERMINISTIC_BOND_ETF_V23'`);
    const report = { status: "COMPLETE", bondEtfsFound: summary.bond_etfs_found, bondEtfsWithHistory: summary.with_history, bondEtfsWithNav: summary.with_nav, bondEtfsWithYield: summary.with_yield, bondEtfsWithYtm: 0, bondEtfsWithDuration: 0, bondEtfsWithSpread: 0, bondEtfsWithRating: 0, bondEtfsWithHoldings: summary.with_holdings, bondEtfsWithBenchmark: summary.with_benchmark, historyRows: String(summary.history_rows), databaseRowsAdded: classification.rows, databaseWritten: classification.rows > 0, autoContinuing: true, owners: ["EXISTING_YAHOO_ETF_HISTORY", "EXISTING_ETF_YAHOO_PRODUCT_MODULES", "EXISTING_ETF_HOLDINGS"], updatedAt: now() };
    await atomic(path.join(ROOT, "report.json"), report);
    await atomic(path.join(ROOT, "checkpoint.json"), { state: "SCHEDULED_WAIT", pid: null, checkpoint: `BOND_ETFS:${report.bondEtfsFound}`, autoContinuing: true, nextOwner: report.owners, maxDbConcurrency: 1, heartbeat: now() });
    console.log(JSON.stringify(report, null, 2));
  } finally { await prisma.$disconnect(); }
}
main().catch(async error => { await atomic(path.join(ROOT, "checkpoint.json"), { state: "BLOCKED", pid: null, lastError: error instanceof Error ? error.message : String(error), autoContinuing: false, maxDbConcurrency: 1, heartbeat: now() }); console.error(error); process.exitCode = 1; });
