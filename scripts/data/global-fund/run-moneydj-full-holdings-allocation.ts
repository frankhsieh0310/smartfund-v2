import { PrismaClient } from "@prisma/client";
import { load } from "cheerio";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deterministicMasterKey } from "./services/fund-holdings-resolution.ts";

const dbUrl = process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER ?? process.env.DATABASE_URL;
const engine = resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if (process.platform === "win32" && !process.env.PRISMA_QUERY_ENGINE_LIBRARY) process.env.PRISMA_QUERY_ENGINE_LIBRARY = engine;
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
const runtimeDir = resolve("runtime/global-fund/moneydj-full-extraction");
const source = "MONEYDJ_PUBLIC_DISCLOSURE";
const parserVersion = "MONEYDJ_YP013000_V1";
const excludedFromHoldingsIngestion = /貨幣市場|money.?market|(?:單日)?正向(?:二|2)倍|(?:二|2)倍基金|\b2x\b|反向/i;

async function atomic(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}

function tableRows($: ReturnType<typeof load>, label: string, domain: string) {
  const table = $("table").filter((_, element) => $(element).text().includes(label)).first();
  const date = table.text().replace(/\s+/g, " ").match(/資料日期：\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]?.replaceAll("/", "-");
  const output: Array<{domain:string;rawCategory:string;amount:number|null;amountUnit:string;percentage:number;date:string}> = [];
  table.find("tr").each((_, row) => {
    const cells = $(row).children("td").map((__, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
    if (!date || cells.length < 3) return;
    const percentage = Number(cells.at(-1)?.replace("%", ""));
    const amount = Number(cells.at(-2)?.replaceAll(",", ""));
    if (!cells[0] || !Number.isFinite(percentage) || percentage < 0) return;
    output.push({ domain, rawCategory: cells[0], amount: Number.isFinite(amount) ? amount : null, amountUnit: "TEN_THOUSAND_SOURCE_CURRENCY", percentage, date });
  });
  return [...new Map(output.map((row) => [`${row.rawCategory}|${row.date}`, row])).values()];
}

function topHoldings($: ReturnType<typeof load>) {
  const table = $("table").filter((_, element) => $(element).text().includes("投資明細") && $(element).text().includes("資料月份")).first();
  const fallback = table.length ? table : $("table").filter((_, element) => $(element).text().includes("投資明細") && $(element).text().includes("資料日期")).first();
  const dateMatch = fallback.text().match(/資料(?:月份|日期|時間)\s*[：:]\s*(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
  const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}` : undefined;
  const output: Array<{name:string;weight:number;date:string}> = [];
  fallback.find("tr").each((_, row) => {
    const cells = $(row).children("td").map((__, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
    const match = cells[1]?.replaceAll(",", "").match(/^(\d+(?:\.\d+)?)\s*%?$/);
    if (date && cells.length === 2 && match && !cells[0].includes("投資標的")) output.push({ name: cells[0], weight: Number(match[1]), date });
  });
  if (!output.length) fallback.find("table").filter((_, element) => $(element).text().includes("投資名稱") && $(element).text().includes("比例")).first().find("tr").each((_, row) => {
    const cells = $(row).children("td").map((__, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get();
    for (const start of [0, 3, 4]) {
      const name = cells[start]?.trim();
      const weightCell = [cells[start + 2], cells[start + 1]].find((value) => /\d/.test(value ?? ""));
      const rawWeight = weightCell?.trim().replaceAll(",", "").replace(/\s*%$/, ""), weight = Number(rawWeight);
      if (date && name && !name.includes("投資名稱") && Number.isFinite(weight) && weight >= 0) output.push({ name, weight, date });
    }
  });
  return [...new Map(output.map((row) => [`${row.name}|${row.date}`, row])).values()].slice(0, 20);
}

async function main() {
  const limit = Number(process.argv.find((value) => value.startsWith("--limit="))?.slice(8) ?? "100");
  const offset = Number(process.argv.find((value) => value.startsWith("--offset="))?.slice(9) ?? "0");
  const concurrency = Number(process.argv.find((value) => value.startsWith("--concurrency="))?.slice(14) ?? "8");
  const onlyMissing = process.argv.includes("--only-missing-holdings");
  const masterOnly = process.argv.includes("--master-only");
  let items: Array<{fundId:string;code:string;shareClassId:null}>;
  if (masterOnly) {
    const mapped = await db.$queryRawUnsafe<Array<{fundId:string;code:string;company:string;name:string;legal_name:string|null;name_en:string|null}>>(
      `SELECT m.fund_id "fundId",m.moneydj_code code,f.company,f.name,f.legal_name,f.name_en FROM fund_mappings m JOIN funds f ON f.id=m.fund_id WHERE m.moneydj_code IS NOT NULL AND m.moneydj_code<>'1' AND f.is_active=true AND ($1::boolean=false OR NOT EXISTS(SELECT 1 FROM holdings h WHERE h.fund_id=m.fund_id)) ORDER BY m.fund_id`, onlyMissing,
    );
    const representatives = new Map<string,{fundId:string;code:string;shareClassId:null}>();
    for (const item of mapped) {
      if (excludedFromHoldingsIngestion.test(item.name) || excludedFromHoldingsIngestion.test(item.legal_name ?? "") || excludedFromHoldingsIngestion.test(item.name_en ?? "")) continue;
      const key = deterministicMasterKey(item);
      if (!representatives.has(key)) representatives.set(key,{fundId:item.fundId,code:item.code,shareClassId:null});
    }
    items = [...representatives.values()].slice(offset,offset+limit);
  } else items = await db.$queryRawUnsafe<Array<{fundId:string;code:string;shareClassId:null}>>(
    `SELECT m.fund_id "fundId",m.moneydj_code code,NULL::text "shareClassId" FROM fund_mappings m WHERE m.moneydj_code IS NOT NULL AND m.moneydj_code <> '1' AND ($3::boolean=false OR (NOT EXISTS(SELECT 1 FROM holdings h WHERE h.fund_id=m.fund_id) AND NOT EXISTS(SELECT 1 FROM fund_holdings h WHERE h.fund_id=m.fund_id))) ORDER BY m.fund_id OFFSET $1 LIMIT $2`, offset, onlyMissing ? 2000 : limit, onlyMissing,
  );
  if (onlyMissing && !masterOnly) {
    const archiveFiles = await import("node:fs/promises").then((fs) => fs.readdir(resolve("runtime/global-fund/moneydj-full-extraction/archive")));
    items = items.filter((item) => archiveFiles.some((file) => file.startsWith(`${item.code}-`) && file.endsWith(".html"))).slice(0, limit);
  }
  const done: Array<Record<string, unknown>> = [];
  const terminal: Array<Record<string, unknown>> = [];
  const failed: Array<Record<string, unknown>> = [];
  async function processItem(item: {fundId:string;code:string;shareClassId:null}) {
    if (item.code === "1") {
      terminal.push({ code: item.code, fundId: item.fundId, disposition: "UNMAPPED_PROVIDER_ID" });
      return;
    }
    try {
      const url = `https://www.moneydj.com/funddj/yp/yp013000.djhtm?a=${encodeURIComponent(item.code)}&topc=`;
      const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 SmartFund Fund Research/1.0" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const html = new TextDecoder("big5").decode(await response.arrayBuffer());
      const $ = load(html);
      const allocations = [
        ...tableRows($, "基金投資分佈(依區域)", "REGION_ALLOCATION"),
        ...tableRows($, "基金投資分佈(依產業)", "SECTOR_ALLOCATION"),
        ...tableRows($, "基金投資分佈(依持有類股)", "HOLDING_CLASS_ALLOCATION"),
      ];
      const holdings = topHoldings($);
      const hash = createHash("sha256").update(html).digest("hex");
      const artifact = `runtime/global-fund/moneydj-full-extraction/archive/${item.code}-${hash.slice(0, 12)}.html`;
      await atomic(resolve(artifact), html);
      await db.$transaction(async (tx) => {
        for (const row of allocations) await tx.$executeRawUnsafe(
          `INSERT INTO fund_source_allocation_observations(id,fund_id,share_class_id,domain,raw_category,canonical_category,amount,amount_unit,percentage,as_of_date,source,provider_product_id,artifact_id,retrieved_at,parser_version,created_at,updated_at) VALUES($1::uuid,$2,NULL,$3,$4,NULL,$5,$6,$7,$8::date,$9,$10,$11,CURRENT_TIMESTAMP,$12,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`,
          randomUUID(), item.fundId, row.domain, row.rawCategory, row.amount, row.amountUnit, row.percentage, row.date, source, item.code, artifact, parserVersion,
        );
        for (const [index, holding] of holdings.entries()) await tx.$executeRawUnsafe(
          `INSERT INTO holdings(id,asset_type,fund_id,share_class_id,as_of_date,rank,holding_name,weight,source,source_record_id,filing_id,weight_method,created_at) VALUES($1,'FUND',$2,NULL,$3::date,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP) ON CONFLICT(fund_id,source,filing_id,source_record_id) WHERE fund_id IS NOT NULL AND source IS NOT NULL AND filing_id IS NOT NULL AND source_record_id IS NOT NULL DO UPDATE SET rank=EXCLUDED.rank,weight=EXCLUDED.weight,holding_name=EXCLUDED.holding_name`,
          randomUUID(), item.fundId, holding.date, index + 1, holding.name, holding.weight, source, `${holding.date}:${index + 1}:${holding.name}`, `moneydj:${item.code.toLowerCase()}:${holding.date}`, holdings.length === 10 ? "TOP_10_DISCLOSED" : holdings.length === 5 ? "TOP_5_DISCLOSED" : "OTHER_PARTIAL_DISCLOSURE",
        );
      }, { maxWait: 10_000, timeout: 60_000 });
      done.push({ code: item.code, allocation: allocations.length, top: holdings.length, domains: [...new Set(allocations.map((row) => row.domain))], dates: [...new Set([...allocations.map((row) => row.date), ...holdings.map((row) => row.date)])] });
    } catch (error) {
      failed.push({ code: item.code, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (let index = 0; index < items.length; index += concurrency) {
    await Promise.all(items.slice(index, index + concurrency).map(processItem));
  }
  const stats = await db.$queryRawUnsafe(`SELECT domain,count(*)::int rows,count(DISTINCT fund_id)::int funds,count(DISTINCT share_class_id) FILTER(WHERE share_class_id IS NOT NULL)::int classes,min(as_of_date) earliest,max(as_of_date) latest FROM fund_source_allocation_observations WHERE source=$1 GROUP BY domain ORDER BY domain`, source);
  const [holdingsStats] = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT sum(n)::int rows,count(*)::int disclosures,count(DISTINCT fund_id)::int funds,min(as_of_date) earliest,max(as_of_date) latest,min(n)::int min_displayed,max(n)::int max_displayed FROM(SELECT fund_id,filing_id,as_of_date,count(*)::int n FROM holdings WHERE source=$1 GROUP BY fund_id,filing_id,as_of_date)x`, source);
  const now = new Date().toISOString();
  const checkpoint = { version: 1, ownerPid: 23196, moneydjPid: 25504, childProcessId: process.pid, state: failed.length ? "PARTIAL" : "SCHEDULED_WAIT", heartbeat: now, lastSuccess: done.length ? now : null, nextRunAt: new Date(Date.now() + 86_400_000).toISOString(), eligible: items.length, processed: done.length, terminal: terminal.length, pending: 0, done, terminalDispositions: terminal, failed, stats, topHoldings: holdingsStats, checkpointActive: true, resumable: true, autoContinuing: true, requests: done.length + failed.length, success: done.length, requestFailed: failed.length, parserContracts: ["MONEYDJ_YP013000_REGION", "MONEYDJ_YP013000_SECTOR", "MONEYDJ_YP013000_HOLDING_CLASS", "MONEYDJ_YP013000_TOP_HOLDINGS"] };
  await atomic(resolve(runtimeDir, "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`);
  const partial = done.filter((item) => Number(item.top ?? 0) > 0).length;
  console.log(`SUMMARY=${JSON.stringify({target:limit,offset,attempted:items.length,success:0,partial,failed:items.length-partial,successRate:items.length?Number((partial/items.length*100).toFixed(2)):0})}`);
  console.log(JSON.stringify(checkpoint));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
