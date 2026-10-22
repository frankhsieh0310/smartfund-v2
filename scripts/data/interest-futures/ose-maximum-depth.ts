import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = process.cwd();
const RUNTIME = join(ROOT, "runtime", "interest-futures");
const OUTPUT = join(RUNTIME, "professional-depth");
const MAINTENANCE_LEASE = join(RUNTIME, "ose-maximum-depth.lease");
const SOURCE = "JPX_OSE_OFFICIAL_SETTLEMENT_CSV";
const SPEC_URL = "https://www.jpx.co.jp/english/derivatives/products/interest-rate/3m-tona-futures/01.html";
const INDEX_URL = "https://www.jpx.co.jp/english/markets/derivatives/settlement-price/index.html";
const PARSER = "jpx-ose-tona-settlement-csv/3.0.0";
const prisma = new PrismaClient();

function assert(value, message) { if (!value) throw new Error(message); }
function csvRow(line) {
  const cells = []; let cell = ""; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell); return cells;
}
function isoDateFromCode(code) {
  const match = code.match(/_(\d{2})(\d{2})(\d{2})$/); assert(match, `INVALID_CONTRACT_CODE:${code}`);
  return `20${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
}
function monthDate(month) { assert(/^\d{6}$/.test(month), `INVALID_CONTRACT_MONTH:${month}`); return `${month.slice(0, 4)}-${month.slice(4)}-01T00:00:00.000Z`; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
async function atomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + "\n"); await rename(temp, path);
}
async function fetchStrip() {
  const index = await fetch(INDEX_URL, { signal: AbortSignal.timeout(30000) }); assert(index.ok, `JPX_INDEX_HTTP_${index.status}`);
  const html = await index.text(); const match = html.match(/href="([^"]+\/rb_e(\d{8})\.csv)"/i); assert(match, "JPX_SETTLEMENT_LINK_MISSING");
  const sourceUrl = new URL(match[1], INDEX_URL).toString(); const fileDate = match[2];
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) }); assert(response.ok, `JPX_CSV_HTTP_${response.status}`);
  const text = new TextDecoder("utf-8").decode(await response.arrayBuffer());
  const rows = text.split(/\r?\n/).filter((line) => line.includes("FUT_TOA3M_")).map((raw) => {
    const cells = csvRow(raw); const settlement = Number(cells[5]); assert(Number.isFinite(settlement) && settlement > 0 && settlement < 200, `INVALID_SETTLEMENT:${cells[1]}`);
    return { raw, issueCode: cells[0], contractCode: cells[1], contractMonth: cells[3], settlement, daysToExpiry: Number(cells[10]), underlying: cells[11], expiration: isoDateFromCode(cells[1]) };
  });
  assert(rows.length >= 4, `INSUFFICIENT_LISTED_STRIP:${rows.length}`);
  return { sourceUrl, fileDate, retrievedAt: new Date().toISOString(), rows };
}
async function counts() {
  const contracts = await prisma.$queryRawUnsafe("SELECT COUNT(*)::int AS count FROM futures_contracts WHERE asset_class='INTEREST_RATE_FUTURES' AND root_symbol='TOA3M'");
  const observations = await prisma.$queryRawUnsafe("SELECT COUNT(*)::int AS count FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id WHERE o.asset_class='INTEREST_RATE_FUTURES' AND c.root_symbol='TOA3M'");
  return { contracts: contracts[0].count, observations: observations[0].count };
}
async function persist(strip) {
  for (const row of strip.rows) {
    const proposedId = randomUUID();
    const contractRows = await prisma.$queryRawUnsafe(
      `INSERT INTO futures_contracts
       (id, underlying, exchange, root_symbol, contract_symbol, contract_month, expiration, currency, source, created_at, updated_at, asset_class, contract_year, last_trade_date, status, verification_status, source_url, identity_state, expiration_source_url)
       VALUES ($1::uuid,$2,'OSE','TOA3M',$3,$4,$5,'JPY',$6,NOW(),NOW(),'INTEREST_RATE_FUTURES',$7,$5,'ACTIVE','VERIFIED',$8,'VERIFIED_OFFICIAL_LISTED',$9)
       ON CONFLICT (exchange,contract_symbol) DO UPDATE SET contract_month=EXCLUDED.contract_month, expiration=EXCLUDED.expiration, last_trade_date=EXCLUDED.last_trade_date, status='ACTIVE', verification_status='VERIFIED', source_url=EXCLUDED.source_url, identity_state=EXCLUDED.identity_state, expiration_source_url=EXCLUDED.expiration_source_url, updated_at=NOW()
       RETURNING id`,
      proposedId, row.underlying, row.contractCode, new Date(monthDate(row.contractMonth)), new Date(row.expiration), SOURCE, Number(row.contractMonth.slice(0, 4)), SPEC_URL, strip.sourceUrl,
    );
    const contractId = contractRows[0].id;
    const observedAt = new Date(`${strip.fileDate.slice(0, 4)}-${strip.fileDate.slice(4, 6)}-${strip.fileDate.slice(6)}T00:00:00.000Z`);
    const sourceKey = `${SOURCE}:${row.contractCode}:${observedAt.toISOString()}`;
    const sourceRecordId = `JPX_NATIVE_ISSUE_CODE:${strip.fileDate}:${row.issueCode}`;
    const payloadChecksum = `PLATFORM_DERIVED_SHA256:${sha256(row.raw)}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO futures_observations
       (id,contract_id,observed_at,settlement,source,source_key,created_at,updated_at,asset_class,source_record_id,source_url,verification_status,quality_status,freshness_status,retrieved_at,parser_version,source_checksum,license_status,contract_identity_state,raw_checksum)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,NOW(),NOW(),'INTEREST_RATE_FUTURES',$7,$8,'VERIFIED','OFFICIAL_DAILY_SETTLEMENT','CURRENT',$9,$10,$11,'PUBLIC','VERIFIED_OFFICIAL_LISTED',$11)
       ON CONFLICT (source_key) DO UPDATE SET settlement=EXCLUDED.settlement, source_record_id=EXCLUDED.source_record_id, source_url=EXCLUDED.source_url, verification_status='VERIFIED', quality_status=EXCLUDED.quality_status, freshness_status=EXCLUDED.freshness_status, retrieved_at=EXCLUDED.retrieved_at, parser_version=EXCLUDED.parser_version, source_checksum=EXCLUDED.source_checksum, license_status='PUBLIC', contract_identity_state=EXCLUDED.contract_identity_state, raw_checksum=EXCLUDED.raw_checksum, updated_at=NOW()`,
      randomUUID(), contractId, observedAt, row.settlement, SOURCE, sourceKey, sourceRecordId, strip.sourceUrl, new Date(strip.retrievedAt), PARSER, payloadChecksum,
    );
  }
}
function curveArtifact(strip) {
  const points = strip.rows.map((row) => ({ contract: row.contractCode, contractMonth: `${row.contractMonth.slice(0, 4)}-${row.contractMonth.slice(4)}`, expiration: row.expiration, daysToExpiry: row.daysToExpiry, price: row.settlement, impliedRate: Math.round((100 - row.settlement) * 1_000_000) / 1_000_000, impliedRateFormula: "100_MINUS_FUTURES_PRICE_JPX_TONA_V1", volume: null, openInterest: null })).sort((a, b) => a.expiration.localeCompare(b.expiration));
  const spread = (a, b) => Math.round((b.impliedRate - a.impliedRate) * 10000) / 100;
  const calendarSpreads = points.slice(0, -1).map((point, index) => ({ nearContract: point.contract, farContract: points[index + 1].contract, asOfDate: `${strip.fileDate.slice(0, 4)}-${strip.fileDate.slice(4, 6)}-${strip.fileDate.slice(6)}`, impliedRateSpreadBps: spread(point, points[index + 1]), priceSpread: Math.round((point.price - points[index + 1].price) * 1_000_000) / 1_000_000, historyChanges: "TIME_DEPTH_CONSTRAINED" }));
  return { rootId: "OSE_TONA_3M", asOfDate: `${strip.fileDate.slice(0, 4)}-${strip.fileDate.slice(4, 6)}-${strip.fileDate.slice(6)}`, source: SOURCE, sourceUrl: strip.sourceUrl, retrievedAt: strip.retrievedAt, parserVersion: PARSER, verificationState: "VERIFIED", quotationConvention: "100_MINUS_3_MONTH_COMPOUNDED_TONA", quotationSource: SPEC_URL, contractUnit: "(100 minus 3-month compounded TONA) x JPY 250,000", minimumTick: 0.0025, tickValueJpy: 625, contractBpvJpy: 2500, frontProjection: { selectedContract: points[0].contract, rule: "CALENDAR_FRONT", ruleVersion: "OSE_CALENDAR_FRONT_V1", asOfDate: `${strip.fileDate.slice(0, 4)}-${strip.fileDate.slice(4, 6)}-${strip.fileDate.slice(6)}` }, curve: points, calendarSpreads, curveAnalytics: { frontNextRateSpreadBps: spread(points[0], points[1]), nextThirdRateSpreadBps: spread(points[1], points[2]), frontThirdRateSpreadBps: spread(points[0], points[2]), shape: points.at(-1).impliedRate - points[0].impliedRate > 0.01 ? "UPWARD_SLOPING" : points[0].impliedRate - points.at(-1).impliedRate > 0.01 ? "INVERTED" : "FLAT", toleranceBps: 1, formulaVersion: "OSE_TONA_CURVE_V1", sampleCount: points.length }, limitations: { history: "PUBLIC_LATEST_FILE_ONLY", ohlc: "SOURCE_NOT_AVAILABLE", volume: "SOURCE_NOT_AVAILABLE", openInterest: "SOURCE_NOT_AVAILABLE", continuousSeries: "PREREQUISITES_PENDING", rollAudit: "PREREQUISITES_PENDING" } };
}

let maintenanceLease = false;
try {
  await mkdir(OUTPUT, { recursive: true });
  const checkpoint = JSON.parse(await readFile(join(RUNTIME, "checkpoint.json"), "utf8"));
  const owner = JSON.parse(await readFile(join(RUNTIME, "runner.lock"), "utf8"));
  assert(checkpoint.pid === owner.pid, "SINGLE_WRITER_OWNER_MISMATCH"); assert(checkpoint.currentStage === "SCHEDULED_INCREMENTAL", "SUPERVISOR_NOT_DORMANT"); assert(new Date(checkpoint.nextRunAt).getTime() - Date.now() > 60_000, "SCHEDULE_WINDOW_TOO_SHORT"); process.kill(owner.pid, 0);
  const lease = await open(MAINTENANCE_LEASE, "wx"); await lease.writeFile(JSON.stringify({ pid: process.pid, supervisorPid: owner.pid, acquiredAt: new Date().toISOString() })); await lease.close(); maintenanceLease = true;
  const strip = await fetchStrip(); const before = await counts(); await persist(strip); const first = await counts(); await persist(strip); const replay = await counts();
  const duplicates = await prisma.$queryRawUnsafe("SELECT COUNT(*)::int AS count FROM (SELECT source_key FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id WHERE c.root_symbol='TOA3M' GROUP BY source_key HAVING COUNT(*)>1) d");
  const provenance = await prisma.$queryRawUnsafe("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE o.source_record_id IS NOT NULL AND o.source_url IS NOT NULL AND o.retrieved_at IS NOT NULL AND o.source_checksum IS NOT NULL AND o.parser_version IS NOT NULL AND o.verification_status='VERIFIED')::int AS complete FROM futures_observations o JOIN futures_contracts c ON c.id=o.contract_id WHERE c.root_symbol='TOA3M'");
  const artifact = curveArtifact(strip); await atomic(join(OUTPUT, "OSE_TONA_3M-curve-latest.json"), artifact); await atomic(join(OUTPUT, "maximum-depth-checkpoint.json"), { status: "ACTIVE_INCREMENTAL", supervisorPid: owner.pid, sourceBoundary: "JPX_PUBLIC_LATEST_FILE_ONLY", before, after: first, replay, duplicateGroups: duplicates[0].count, provenance: provenance[0], currentStripContracts: strip.rows.length, updatedAt: new Date().toISOString() });
  console.log(JSON.stringify({ status: "PASS", supervisorPid: owner.pid, sourceFile: strip.sourceUrl, currentStripContracts: strip.rows.length, before, after: first, replay, newRowsOnReplay: replay.observations - first.observations, duplicateGroups: duplicates[0].count, provenance: provenance[0], curvePoints: artifact.curve.length, frontContract: artifact.frontProjection.selectedContract, analytics: artifact.curveAnalytics }));
} catch (error) { console.log(JSON.stringify({ status: "FAIL", error: error?.message || String(error) })); process.exitCode = 1; }
finally { if (maintenanceLease) await unlink(MAINTENANCE_LEASE).catch(() => {}); await prisma.$disconnect(); }
