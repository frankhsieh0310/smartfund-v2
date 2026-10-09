import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { boundedDbRetry, futuresDatabaseUrl, MAX_DB_CONCURRENCY } from "../../../lib/data-platform/runtime/boundedFuturesDb.ts";

const cwd = process.cwd();
const once = process.argv.includes("--once");
const db = new PrismaClient({ datasources: { db: { url: futuresDatabaseUrl() } } });
const pageUrl = "https://www.jpx.co.jp/english/markets/derivatives/settlement-price/index.html";
const checkpointFile = resolve(cwd, "runtime/futures-market-data-expansion/jpx-settlement-checkpoint.json");
const parserVersion = "jpx-public-settlement-v1";
const intervalMs = 6 * 60 * 60 * 1000;
const commodityRoots = new Set(["GLD", "GLDM", "GLDR", "PLT", "PLTM", "PLTR", "SLV", "PLD", "RSS", "TSR", "SNR", "CRN", "SBN", "AZK", "GAS", "KRO", "GAO", "DBAI", "CGAS", "CKRO", "EEB", "ECB", "EWB", "EEP", "ECP", "EWP", "EEBW", "EWBW", "EEPW", "EWPW", "EEBY", "ECBY", "EWBY", "EEPY", "ECPY", "EWPY", "CMEP", "LNG"]);
const rootAliases: Record<string, string> = { "225": "NK225", TPX: "TOPIX", JBL: "JGB10Y", JBM: "JGB5Y", JBS: "JGB20Y", TOA3M: "TONA3M" };

type RecordRow = { issueCode: string; issueName: string; contractMonth: string; settlement: string; days: number; underlying: string };
const now = () => new Date().toISOString();
function uuid(seed: string) { const h = createHash("sha256").update(seed).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; }
async function atomic(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, path); }
function csv(line: string) { const out: string[] = []; let value = "", quoted = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') { if (quoted && line[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; } else if (c === "," && !quoted) { out.push(value); value = ""; } else value += c; } out.push(value); return out; }
function parseDate(value: string) { if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`; if (!/^\d{6}$/.test(value)) return null; const yy = Number(value.slice(0, 2)), mm = value.slice(2, 4), dd = value.slice(4, 6); return `20${String(yy).padStart(2, "0")}-${mm}-${dd}`; }
function addDays(date: string, days: number) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function rootCode(issueName: string) { const m = /^FUT_([^_]+)_/.exec(issueName); return m?.[1] ?? ""; }
function classify(code: string, underlying: string) { if (commodityRoots.has(code)) return /Electricity|Petroleum|Oil|Gas|LNG|Kerosene/i.test(underlying) ? "ENERGY_FUTURES" : "COMMODITY_FUTURES"; if (/JGB|TONA/i.test(underlying)) return "INTEREST_RATE_FUTURES"; if (/USD|CNH|EUR\//i.test(underlying)) return "FX_FUTURES"; return "EQUITY_INDEX_FUTURES"; }
function exchange(code: string) { return commodityRoots.has(code) ? "TOCOM" : "OSE"; }
function currency(code: string) { return "JPY"; }

async function fetchRows() {
  const page = await fetch(pageUrl, { headers: { "User-Agent": "SmartFund official-public-data-ingestion/1.0" } });
  if (!page.ok) throw new Error(`JPX_PAGE_HTTP_${page.status}`);
  const html = await page.text();
  const match = html.match(/href="([^"]*\/rb_e(\d{8})\.csv)"/i);
  if (!match) throw new Error("JPX_PUBLIC_CSV_LINK_NOT_FOUND");
  const sourceUrl = new URL(match[1], pageUrl).href, observedDate = `${match[2].slice(0, 4)}-${match[2].slice(4, 6)}-${match[2].slice(6, 8)}`;
  const response = await fetch(sourceUrl, { headers: { "User-Agent": "SmartFund official-public-data-ingestion/1.0" } });
  if (!response.ok) throw new Error(`JPX_CSV_HTTP_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = new TextDecoder("shift_jis").decode(bytes);
  const rows: RecordRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const v = csv(line);
    if (!/^\w+$/.test(v[0] ?? "") || !/^FUT_/.test(v[1] ?? "") || (v[2] ?? "") !== "" || !v[5] || !Number.isFinite(Number(v[5]))) continue;
    rows.push({ issueCode: v[0], issueName: v[1], contractMonth: v[3], settlement: v[5], days: Number(v[10]), underlying: v[11] || rootCode(v[1]) });
  }
  if (rows.length < 25) throw new Error(`JPX_FUTURES_ROW_GUARD:${rows.length}`);
  return { rows, sourceUrl, observedDate, checksum: createHash("sha256").update(bytes).digest("hex") };
}

async function counts() {
  const [x] = await boundedDbRetry(() => db.$queryRawUnsafe<any[]>(`SELECT (SELECT count(*)::int FROM futures_product_roots) roots,(SELECT count(*)::int FROM futures_contracts) contracts,(SELECT count(*)::int FROM futures_observations) observations,(SELECT count(DISTINCT c.root_id)::int FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id WHERE o.settlement IS NOT NULL) settlement_products,(SELECT count(DISTINCT root_id)::int FROM futures_contracts WHERE expiration IS NOT NULL OR last_trade_date IS NOT NULL) expiry_ready`));
  return x;
}

async function cycle() {
  const before = await counts(), source = await fetchRows();
  const result = { rootsAdded: 0, contractsAdded: 0, observationsAdded: 0, batchesCompleted: 0 };
  for (let offset = 0; offset < source.rows.length; offset += 20) {
    const batch = source.rows.slice(offset, offset + 20);
    await boundedDbRetry(() => db.$transaction(async tx => {
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('smartfund:FUTURES_JPX_PUBLIC_SETTLEMENT'))::text AS locked`);
    let rootsAdded = 0, contractsAdded = 0, observationsAdded = 0;
    for (const row of batch) {
      const completed = await tx.$queryRawUnsafe<any[]>(`SELECT 1 FROM futures_observations WHERE source='JPX_OFFICIAL_PUBLIC_SETTLEMENT_CSV' AND source_record_id=$1 AND observed_at=$2::date LIMIT 1`, row.issueCode, source.observedDate);
      if (completed.length) continue;
      const rawCode = rootCode(row.issueName), rootSymbol = rootAliases[rawCode] ?? rawCode, venue = exchange(rawCode), assetClass = classify(rawCode, row.underlying);
      const rootId = uuid(`futures-root:${venue}:${rootSymbol}`), contractId = uuid(`futures-contract:${venue}:${row.issueName}`);
      const priorRoot = await tx.$queryRawUnsafe<any[]>(`SELECT id::text FROM futures_product_roots WHERE asset_class=$1 AND exchange=$2 AND root_symbol=$3`, assetClass, venue, rootSymbol);
      await tx.$executeRawUnsafe(`INSERT INTO futures_product_roots(id,commodity_id,asset_class,official_product_name,root_symbol,exchange,currency,country,jurisdiction,timezone,status,source,source_url,verification_status,license_status,product_state,missing_reason,created_at,updated_at) VALUES($1::uuid,NULL,$2,$3,$4,$5,$6,'JP','JP','Asia/Tokyo','ACTIVE','JPX_OFFICIAL_PUBLIC_SETTLEMENT_CSV',$7,'VERIFIED_OFFICIAL','PUBLIC_OFFICIAL','PRODUCTION_READY','NONE',NOW(),NOW()) ON CONFLICT(asset_class,exchange,root_symbol) DO UPDATE SET official_product_name=EXCLUDED.official_product_name,status='ACTIVE',source=EXCLUDED.source,source_url=EXCLUDED.source_url,verification_status='VERIFIED_OFFICIAL',license_status='PUBLIC_OFFICIAL',product_state='PRODUCTION_READY',missing_reason='NONE',updated_at=NOW()`, rootId, assetClass, `${row.underlying} Futures`, rootSymbol, venue, currency(rawCode), source.sourceUrl);
      const [canonicalRoot] = await tx.$queryRawUnsafe<any[]>(`SELECT id::text FROM futures_product_roots WHERE asset_class=$1 AND exchange=$2 AND root_symbol=$3`, assetClass, venue, rootSymbol);
      if (!priorRoot.length) rootsAdded++;
      const priorContract = await tx.$queryRawUnsafe<any[]>(`SELECT id::text FROM futures_contracts WHERE exchange=$1 AND contract_symbol=$2`, venue, row.issueName);
      const suffix = row.issueName.match(/_(\d{6,8})$/)?.[1] ?? "", lastTrade = parseDate(suffix), expiration = Number.isFinite(row.days) ? addDays(source.observedDate, row.days) : lastTrade;
      const cm = row.contractMonth.match(/\d{6}/)?.[0] ?? suffix.match(/^\d{6}/)?.[0] ?? source.observedDate.replaceAll("-", "").slice(0, 6);
      const contractMonthDate = `${cm.slice(0, 4)}-${cm.slice(4, 6)}-01`;
      await tx.$executeRawUnsafe(`INSERT INTO futures_contracts(id,underlying,exchange,root_symbol,contract_symbol,contract_month,expiration,currency,source,asset_class,root_id,contract_year,last_trade_date,final_settlement_date,delivery_month,status,verification_status,source_url,created_at,updated_at) VALUES($1::uuid,$2,$3,$4,$5,$6::date,$7::date,$8,'JPX_OFFICIAL_PUBLIC_SETTLEMENT_CSV',$9,$10::uuid,EXTRACT(YEAR FROM $6::date)::int,$11::date,$7::date,$12,'ACTIVE','VERIFIED_OFFICIAL',$13,NOW(),NOW()) ON CONFLICT(exchange,contract_symbol) DO UPDATE SET underlying=EXCLUDED.underlying,root_symbol=EXCLUDED.root_symbol,contract_month=EXCLUDED.contract_month,expiration=EXCLUDED.expiration,currency=EXCLUDED.currency,source=EXCLUDED.source,asset_class=EXCLUDED.asset_class,root_id=EXCLUDED.root_id,contract_year=EXCLUDED.contract_year,last_trade_date=EXCLUDED.last_trade_date,final_settlement_date=EXCLUDED.final_settlement_date,delivery_month=EXCLUDED.delivery_month,status='ACTIVE',verification_status='VERIFIED_OFFICIAL',source_url=EXCLUDED.source_url,updated_at=NOW()`, contractId, row.underlying, venue, rootSymbol, row.issueName, contractMonthDate, expiration, currency(rawCode), assetClass, canonicalRoot.id, lastTrade, cm, source.sourceUrl);
      const [canonicalContract] = await tx.$queryRawUnsafe<any[]>(`SELECT id::text FROM futures_contracts WHERE exchange=$1 AND contract_symbol=$2`, venue, row.issueName);
      if (!priorContract.length) contractsAdded++;
      const sourceKey = `JPX:${row.issueCode}:${source.observedDate}`;
      const priorObservation = await tx.$queryRawUnsafe<any[]>(`SELECT id::text FROM futures_observations WHERE source_key=$1`, sourceKey);
      await tx.$executeRawUnsafe(`INSERT INTO futures_observations(id,contract_id,observed_at,settlement,asset_class,source_record_id,source_url,verification_status,quality_status,freshness_status,source,source_key,retrieved_at,parser_version,source_checksum,license_status,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3::date,$4::numeric,$5,$6,$7,'VERIFIED_OFFICIAL','OFFICIAL_CONTRACT_GRAIN','MARKET_CLOSED','JPX_OFFICIAL_PUBLIC_SETTLEMENT_CSV',$8,NOW(),$9,$10,'PUBLIC_OFFICIAL',NOW(),NOW()) ON CONFLICT(contract_id,observed_at) DO UPDATE SET settlement=EXCLUDED.settlement,source_record_id=EXCLUDED.source_record_id,source_url=EXCLUDED.source_url,verification_status='VERIFIED_OFFICIAL',quality_status='OFFICIAL_CONTRACT_GRAIN',freshness_status='MARKET_CLOSED',source='JPX_OFFICIAL_PUBLIC_SETTLEMENT_CSV',retrieved_at=NOW(),parser_version=EXCLUDED.parser_version,source_checksum=EXCLUDED.source_checksum,license_status='PUBLIC_OFFICIAL',updated_at=NOW()`, uuid(`obs:${sourceKey}`), canonicalContract.id, source.observedDate, row.settlement, assetClass, row.issueCode, source.sourceUrl, sourceKey, parserVersion, source.checksum);
      await tx.$executeRawUnsafe(`INSERT INTO futures_settlements(id,contract_id,settlement_date,settlement_price,settlement_type,source,source_record_id,source_url,verification_status,ingested_at) VALUES($1::uuid,$2::uuid,$3::date,$4::numeric,'DAILY_OFFICIAL','JPX_OFFICIAL_PUBLIC_SETTLEMENT_CSV',$5,$6,'VERIFIED_OFFICIAL',NOW()) ON CONFLICT(contract_id,settlement_date,source) DO UPDATE SET settlement_price=EXCLUDED.settlement_price,source_record_id=EXCLUDED.source_record_id,source_url=EXCLUDED.source_url,verification_status='VERIFIED_OFFICIAL',ingested_at=NOW()`, uuid(`settlement:${sourceKey}`), canonicalContract.id, source.observedDate, row.settlement, row.issueCode, source.sourceUrl);
      if (!priorObservation.length) observationsAdded++;
    }
    result.rootsAdded += rootsAdded; result.contractsAdded += contractsAdded; result.observationsAdded += observationsAdded; result.batchesCompleted++;
  }, { maxWait: 30000, timeout: 60000 }));
  }
  const after = await counts();
  const [readback] = await boundedDbRetry(() => db.$queryRawUnsafe<any[]>(`SELECT count(*)::int rows,count(DISTINCT c.root_id)::int roots,count(DISTINCT c.id)::int contracts FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id WHERE o.source='JPX_OFFICIAL_PUBLIC_SETTLEMENT_CSV' AND o.observed_at=$1::date AND o.verification_status='VERIFIED_OFFICIAL'`, source.observedDate));
  if (readback.rows !== source.rows.length) throw new Error(`READBACK_FAILED:${readback.rows}/${source.rows.length}`);
  const nextRunAt = once ? null : new Date(Date.now() + intervalMs).toISOString();
  await atomic(checkpointFile, { asset: "FUTURES", worker: "FUTURES_JPX_PUBLIC_SETTLEMENT_EXPANSION", pid: process.pid, state: once ? "COMPLETE" : "SCHEDULED_WAIT", max_db_concurrency: MAX_DB_CONCURRENCY, source_url: source.sourceUrl, observed_date: source.observedDate, source_rows: source.rows.length, before, result, after, readback: { status: "PASS", ...readback }, checkpoint: `JPX:${source.observedDate}:ROWS:${readback.rows}:READBACK_PASS`, next_run_at: nextRunAt, auto_continuing: !once, updated_at: now() });
  console.log(JSON.stringify({ before, result, after, readback, sourceUrl: source.sourceUrl, nextRunAt }));
}

async function main() { do { await cycle(); if (once) break; await new Promise(resolvePromise => setTimeout(resolvePromise, intervalMs)); } while (true); }
main().catch(async error => { await atomic(checkpointFile, { asset: "FUTURES", worker: "FUTURES_JPX_PUBLIC_SETTLEMENT_EXPANSION", pid: process.pid, state: "BLOCKED", last_error: String(error), next_run_at: null, auto_continuing: false, updated_at: now() }); console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
