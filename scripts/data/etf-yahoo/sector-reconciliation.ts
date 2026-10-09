// READ-ONLY Yahoo Global ETF Sector Completeness Reconciliation.
// No DB writes, no Yahoo writes — reuses the same fetchQuoteSummary/topHoldings path as
// lib/yahoo/etfEnrich.ts (production's real enrichment code) purely for reading, and compares
// against etf_sector_allocations + etf_yahoo_observations(metric_type='SECTOR_ALLOCATION').
//
// Usage: tsx scripts/data/etf-yahoo/sector-reconciliation.ts
// Progress + final result written to scripts/data/etf-yahoo/.sector-reconciliation-progress.json

import { readFileSync, writeFileSync, existsSync, readFileSync as rf } from "node:fs";
import pg from "pg";
import { fetchQuoteSummary, sleep, type RateStats } from "../../../lib/yahoo/productSession";

const url = readFileSync(new URL("../../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)![1];
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4 });
const query = async (sql: string, params: unknown[] = []): Promise<any[]> => (await pool.query(sql, params as any[])).rows;

const PROGRESS_FILE = new URL(".sector-reconciliation-progress.json", import.meta.url);
const RESULTS_FILE = new URL(".sector-reconciliation-results.ndjson", import.meta.url);

const wt = (v: any): number | null => {
  const raw = v && typeof v === "object" && "raw" in v ? v.raw : v;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const f = v && typeof v === "object" ? v.fmt : v;
  if (typeof f !== "string") return null;
  const n = Number(f.replace("%", "").replaceAll(",", "").trim());
  return Number.isFinite(n) ? n / 100 : null;
};
const allocRows = (v: any): Array<{ name: string; weight: number }> =>
  (Array.isArray(v) ? v : []).flatMap((e: any) =>
    Object.entries(e ?? {}).flatMap(([k, raw]) => {
      const name = String(k ?? "").trim();
      const weight = wt(raw);
      return name && weight != null && weight >= 0 && weight <= 1 ? [{ name, weight }] : [];
    }),
  );

function normSector(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function compareAllocations(
  yahoo: Array<{ name: string; weight: number }>,
  db: Map<string, number>,
): "MATCHED" | "MISMATCH" {
  const TOL = 0.01; // 1 percentage point tolerance (weights are 0..1 ratios)
  const dbNorm = new Map<string, number>();
  for (const [k, v] of db) dbNorm.set(normSector(k), v);
  let anyMismatch = false;
  for (const row of yahoo) {
    const key = normSector(row.name);
    const dbWeight = dbNorm.get(key);
    if (dbWeight == null) { anyMismatch = true; continue; }
    if (Math.abs(dbWeight - row.weight) > TOL) anyMismatch = true;
  }
  // sector present in DB but not in current Yahoo payload also counts as mismatch (stale DB set)
  const yahooKeys = new Set(yahoo.map((r) => normSector(r.name)));
  for (const k of dbNorm.keys()) if (!yahooKeys.has(k)) anyMismatch = true;
  return anyMismatch ? "MISMATCH" : "MATCHED";
}

async function main() {
  console.error("Loading universe...");
  const testLimit = process.env.RECON_TEST_LIMIT ? Number(process.env.RECON_TEST_LIMIT) : null;
  const universe = await query(`
    SELECT id::text, code,
           CASE WHEN data_source ~ '^[A-Za-z0-9.^=-]{1,15}$' THEN data_source
                WHEN code ~ '^[A-Za-z0-9.^=-]{1,15}$' THEN code ELSE NULL END AS symbol
      FROM etfs
     WHERE is_active = true
     ORDER BY id
     ${testLimit ? `LIMIT ${testLimit}` : ""}
  `);
  console.error(`Universe: ${universe.length} active ETFs${testLimit ? " (TEST LIMIT)" : ""}`);

  console.error("Preloading DB sector coverage (etf_sector_allocations, latest observation per ETF)...");
  const dbSectorRows = await query(`
    SELECT DISTINCT ON (etf_id, sector_name) etf_id, sector_name, weight::float8 AS weight, observation_date
      FROM etf_sector_allocations
     ORDER BY etf_id, sector_name, observation_date DESC
  `);
  const dbSectors = new Map<string, Map<string, number>>();
  for (const r of dbSectorRows) {
    if (!dbSectors.has(r.etf_id)) dbSectors.set(r.etf_id, new Map());
    dbSectors.get(r.etf_id)!.set(r.sector_name, r.weight);
  }
  console.error(`etf_sector_allocations covers ${dbSectors.size} distinct ETFs (${dbSectorRows.length} rows)`);

  console.error("Preloading SECTOR_ALLOCATION observations (fallback source)...");
  const obsRows = await query(`
    SELECT DISTINCT ON (etf_id) etf_id, json_value, as_of_date
      FROM etf_yahoo_observations
     WHERE metric_type = 'SECTOR_ALLOCATION' AND json_value IS NOT NULL AND json_value <> '[]'::jsonb
     ORDER BY etf_id, as_of_date DESC
  `);
  const dbObsSectors = new Map<string, Map<string, number>>();
  for (const r of obsRows) {
    const rows = allocRows(r.json_value);
    if (rows.length) {
      const m = new Map<string, number>();
      for (const row of rows) m.set(row.name, row.weight);
      dbObsSectors.set(r.etf_id, m);
    }
  }
  console.error(`etf_yahoo_observations(SECTOR_ALLOCATION, non-empty) covers ${dbObsSectors.size} distinct ETFs`);

  console.error("Checking for duplicate active ETF symbols (structural DB duplicates)...");
  const dupRows = await query(`
    SELECT code, count(*)::int n FROM etfs WHERE is_active = true GROUP BY code HAVING count(*) > 1
  `);
  const dupCodes = new Set(dupRows.map((r) => r.code));
  console.error(`Duplicate active codes: ${dupCodes.size}`);

  // resume support
  let startIdx = 0;
  const counts = {
    YAHOO_FETCHED: 0, YAHOO_WITH_SECTOR: 0, YAHOO_NO_SECTOR: 0, YAHOO_FETCH_FAILED: 0,
    MATCHED: 0, MISSING_IN_DB: 0, MISMATCH: 0, DUPLICATE_IN_DB: 0,
  };
  const gaps: Array<{ etfId: string; code: string; symbol: string }> = [];
  if (existsSync(PROGRESS_FILE)) {
    try {
      const p = JSON.parse(rf(PROGRESS_FILE, "utf8"));
      if (p.nextIdx && p.counts) {
        startIdx = p.nextIdx;
        Object.assign(counts, p.counts);
        if (Array.isArray(p.gaps)) gaps.push(...p.gaps);
        console.error(`Resuming from index ${startIdx}/${universe.length}`);
      }
    } catch { /* ignore corrupt progress file, start fresh */ }
  }

  const stats: RateStats = { calls: 0, rateLimited: 0, crumbRefresh: 0, failures: {} };
  const t0 = Date.now();
  const CONC = 5;

  const resultsStream = existsSync(RESULTS_FILE) && startIdx > 0 ? "a" : "w";
  const fdAppend = (line: string) => {
    require("node:fs").appendFileSync(RESULTS_FILE, line + "\n");
  };
  if (resultsStream === "w") writeFileSync(RESULTS_FILE, "");

  const saveProgress = (nextIdx: number) => {
    writeFileSync(PROGRESS_FILE, JSON.stringify({ nextIdx, total: universe.length, counts, gaps: gaps.slice(0, 200), stats, elapsed_s: Math.round((Date.now() - t0) / 1000) }, null, 1));
  };

  for (let i = startIdx; i < universe.length; i += CONC) {
    const batch = universe.slice(i, i + CONC);
    await Promise.all(batch.map(async (etf) => {
      const sym = String(etf.symbol ?? "").trim();
      if (!sym) { counts.YAHOO_FETCH_FAILED++; return; }
      if (dupCodes.has(etf.code)) counts.DUPLICATE_IN_DB++;

      const hqs = await fetchQuoteSummary(sym, ["topHoldings"], stats).catch(() => null);
      if (!hqs) {
        counts.YAHOO_FETCH_FAILED++;
        fdAppend(JSON.stringify({ etfId: etf.id, code: etf.code, symbol: sym, class: "YAHOO_FETCH_FAILED" }));
        return;
      }
      counts.YAHOO_FETCHED++;
      const th = hqs.result?.topHoldings ?? {};
      const yahooSectors = allocRows(th.sectorWeightings);
      if (!yahooSectors.length) {
        counts.YAHOO_NO_SECTOR++;
        fdAppend(JSON.stringify({ etfId: etf.id, code: etf.code, symbol: sym, class: "YAHOO_NO_SECTOR_DATA" }));
        return;
      }
      counts.YAHOO_WITH_SECTOR++;
      const dbMap = dbSectors.get(etf.id) ?? dbObsSectors.get(etf.id) ?? null;
      if (!dbMap || dbMap.size === 0) {
        counts.MISSING_IN_DB++;
        gaps.push({ etfId: etf.id, code: etf.code, symbol: sym });
        fdAppend(JSON.stringify({ etfId: etf.id, code: etf.code, symbol: sym, class: "MISSING_IN_DB", yahooSectors }));
        return;
      }
      const verdict = compareAllocations(yahooSectors, dbMap);
      counts[verdict]++;
      fdAppend(JSON.stringify({ etfId: etf.id, code: etf.code, symbol: sym, class: verdict }));
    }));
    if ((i / CONC) % 20 === 0) {
      saveProgress(Math.min(i + CONC, universe.length));
      const elapsed = (Date.now() - t0) / 1000;
      const done = i + batch.length;
      const rate = done / elapsed;
      const etaMin = rate > 0 ? Math.round((universe.length - done) / rate / 60) : -1;
      console.error(`…${done}/${universe.length}  fetched=${counts.YAHOO_FETCHED} withSector=${counts.YAHOO_WITH_SECTOR} noSector=${counts.YAHOO_NO_SECTOR} failed=${counts.YAHOO_FETCH_FAILED} missing=${counts.MISSING_IN_DB} mismatch=${counts.MISMATCH} matched=${counts.MATCHED}  rate=${rate.toFixed(1)}/s  eta=${etaMin}min`);
    }
    await sleep(80);
  }

  saveProgress(universe.length);
  const completeness = counts.YAHOO_WITH_SECTOR > 0
    ? (((counts.MATCHED) / counts.YAHOO_WITH_SECTOR) * 100).toFixed(2)
    : "0.00";

  console.log(JSON.stringify({
    GLOBAL_ETF_TOTAL: universe.length,
    ...counts,
    DB_WITH_SECTOR: dbSectors.size + [...dbObsSectors.keys()].filter((k) => !dbSectors.has(k)).length,
    YAHOO_SECTOR_COMPLETENESS_PERCENT: completeness,
    GLOBAL_ETF_SECTOR_COMPLETE: counts.MISSING_IN_DB === 0 && counts.MISMATCH === 0 ? "YES" : "NO",
    runtime_s: Math.round((Date.now() - t0) / 1000),
    stats,
  }, null, 2));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
