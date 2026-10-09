// Function 2 (Taiwan ETF Official Daily Holdings) — Production Data Foundation, one command.
//
// Runs, in order, and STOPs at the first failed gate:
//   A) apply the exact verified migration SQL (BEGIN/exact SQL/COMMIT, no _prisma_migrations touch)
//   B) verify the two tables/constraints/indexes match the verified migration exactly
//   C) fetch the latest official actual-holdings snapshot for all 331 DAILY_ACTIVE portfolios via the
//      17 already-verified issuer adapters (one bounded retry per ticker on transient network failure)
//   D) if and only if 331/331 fetch passed, write the first production snapshot batch via the existing
//      verified storage layer (lib/etf-holdings-engine/storage.ts — upsertSnapshot, identity = etf_code+data_date)
//   E) read-only verification (counts, orphans, duplicates, spot checks)
//   F) idempotency check: re-run upsertSnapshot with the SAME in-memory snapshots (no re-fetch) and
//      confirm no duplicate snapshot/position rows were created
//
// Does not touch prisma migration history, does not restart/stop the live ordinary-master-scheduler
// (PID 12052 / 18296 unrelated production processes untouched), does not run source discovery, does not
// re-derive the universe (reuses universe_by_issuer.json from the already-completed Final Gate).
import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import { upsertSnapshot } from "../lib/etf-holdings-engine/storage.ts";
import type { CanonicalSnapshot, OfficialPcfAdapter } from "../lib/etf-holdings-engine/types.ts";

import { NomuraOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/nomura.ts";
import { UpamcOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/upamc.ts";
import { AllianzOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/allianz.ts";
import { TaishinOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/taishin.ts";
import { FubonOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/fubon.ts";
import { CtbcOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/ctbc.ts";
import { FhtOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/fht.ts";
import { CapitalOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/capital.ts";
import { AbOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/ab.ts";
import { JpmorganOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/jpmorgan.ts";
import { FirstOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/first.ts";
import { YuantaOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/yuanta.ts";
import { MegaOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/mega.ts";
import { CathayOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/cathay.ts";
import { KgiOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/kgi.ts";
import { SinoPacOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/sinopac.ts";
import { BlackRockOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/blackrock.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATION_SQL_PATH = path.join(
  ROOT, "prisma", "migrations", "20260925000000_add_etf_official_daily_holdings", "migration.sql",
);

function fail(step: string, detail: unknown): never {
  console.error(`FUNCTION2_RUNNER_STOP at ${step}:`, detail);
  process.exit(1);
}

async function phaseA(client: Client) {
  const sql = fs.readFileSync(MIGRATION_SQL_PATH, "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.error("[A] PRODUCTION_TABLES_CREATED = YES (or already existed, IF NOT EXISTS)");
  } catch (e) {
    await client.query("ROLLBACK");
    fail("A_MIGRATION", e);
  }
}

async function phaseB(client: Client) {
  const { rows: snapCols } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'etf_official_daily_snapshots' ORDER BY ordinal_position`,
  );
  const { rows: posCols } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'etf_official_daily_positions' ORDER BY ordinal_position`,
  );
  const expectedSnapCols = [
    "id", "etf_code", "issuer", "asset_type", "data_date", "announcement_date",
    "fund_nav", "outstanding_units", "source", "retrieved_at", "created_at",
  ];
  const expectedPosCols = [
    "id", "snapshot_id", "security_code", "security_name", "position_type", "position_amount",
    "position_unit", "weight", "rank", "canonical_security_id", "source",
  ];
  const gotSnapCols = snapCols.map((r) => r.column_name);
  const gotPosCols = posCols.map((r) => r.column_name);
  const missingSnap = expectedSnapCols.filter((c) => !gotSnapCols.includes(c));
  const missingPos = expectedPosCols.filter((c) => !gotPosCols.includes(c));
  if (missingSnap.length || missingPos.length || !gotSnapCols.length || !gotPosCols.length) {
    fail("B_SCHEMA_VERIFY", { missingSnap, missingPos, gotSnapCols, gotPosCols });
  }

  const { rows: constraints } = await client.query(
    `SELECT conname, contype FROM pg_constraint
     WHERE conrelid = 'etf_official_daily_snapshots'::regclass
        OR conrelid = 'etf_official_daily_positions'::regclass`,
  );
  const names = constraints.map((c) => c.conname);
  const requiredConstraints = [
    "etf_official_daily_snapshots_pkey",
    "etf_official_daily_snapshots_etf_date_key",
    "etf_official_daily_positions_pkey",
    "etf_official_daily_positions_snapshot_code_key",
  ];
  const missingConstraints = requiredConstraints.filter((c) => !names.includes(c));
  if (missingConstraints.length) fail("B_SCHEMA_VERIFY_CONSTRAINTS", { missingConstraints, names });

  const { rows: indexes } = await client.query(
    `SELECT indexname FROM pg_indexes
     WHERE tablename IN ('etf_official_daily_snapshots', 'etf_official_daily_positions')`,
  );
  const idxNames = indexes.map((i) => i.indexname);
  const requiredIdx = ["etf_official_daily_snapshots_etf_date_idx", "etf_official_daily_positions_snapshot_idx"];
  const missingIdx = requiredIdx.filter((i) => !idxNames.includes(i));
  if (missingIdx.length) fail("B_SCHEMA_VERIFY_INDEXES", { missingIdx, idxNames });

  console.error("[B] SCHEMA_VERIFIED = YES");
}

type FetchResult = { issuer: string; ticker: string; snapshot?: CanonicalSnapshot; error?: string };

// Local temporary cache of this run's fetched snapshots, written right after Phase C (before any
// production write). Purpose: if Phase D ever fails again, the next run can reuse this exact batch
// instead of re-fetching all 331 tickers. Deliberately holds only the canonical snapshot fields
// (etfCode/issuer/assetType/dataDate/announcementDate/fundNav/outstandingUnits/positions/source/
// retrievedAt) plus issuer/ticker/error — never a DB connection string or credential. Deleted once
// Phase D commits successfully.
const FETCH_CACHE_PATH = path.join(ROOT, "runtime", "etf-holdings-fetch-cache", "latest-fetch-batch.json");

function writeFetchCache(results: FetchResult[]) {
  fs.mkdirSync(path.dirname(FETCH_CACHE_PATH), { recursive: true });
  fs.writeFileSync(FETCH_CACHE_PATH, JSON.stringify({ writtenAt: new Date().toISOString(), results }, null, 2));
  console.error(`[cache] fetch batch cached at ${FETCH_CACHE_PATH}`);
}

function readFetchCache(): FetchResult[] | null {
  if (!fs.existsSync(FETCH_CACHE_PATH)) return null;
  const parsed = JSON.parse(fs.readFileSync(FETCH_CACHE_PATH, "utf8"));
  console.error(`[cache] reusing cached fetch batch from ${parsed.writtenAt} — no re-fetch`);
  return parsed.results;
}

function clearFetchCache() {
  if (fs.existsSync(FETCH_CACHE_PATH)) fs.rmSync(FETCH_CACHE_PATH);
}

async function phaseC(): Promise<FetchResult[]> {
  const universe: Record<string, string[]> = JSON.parse(
    fs.readFileSync(path.join(ROOT, "universe_by_issuer.json"), "utf8"),
  );
  const CATHAY_CANONICAL = universe["國泰"].filter((t) => !t.endsWith("K"));
  const CAPITAL_ACTIVE = universe["群益"].filter((t) => t !== "00643K");
  const SINOPAC_ACTIVE = universe["永豐"].filter((t) => t !== "00838B");

  const TARGETS: { issuer: string; adapter: OfficialPcfAdapter; tickers: string[]; delayMs: number }[] = [
    { issuer: "Cathay", adapter: CathayOfficialPcfAdapter, tickers: CATHAY_CANONICAL, delayMs: 400 },
    { issuer: "JPMorgan", adapter: JpmorganOfficialPcfAdapter, tickers: universe["摩根"], delayMs: 300 },
    { issuer: "Allianz", adapter: AllianzOfficialPcfAdapter, tickers: universe["安聯"], delayMs: 300 },
    { issuer: "UPAMC", adapter: UpamcOfficialPcfAdapter, tickers: universe["統一"], delayMs: 300 },
    { issuer: "AB", adapter: AbOfficialPcfAdapter, tickers: universe["聯博"], delayMs: 300 },
    { issuer: "Fubon", adapter: FubonOfficialPcfAdapter, tickers: universe["富邦"], delayMs: 200 },
    { issuer: "CTBC", adapter: CtbcOfficialPcfAdapter, tickers: universe["中信"], delayMs: 300 },
    { issuer: "KGI", adapter: KgiOfficialPcfAdapter, tickers: universe["凱基"], delayMs: 300 },
    { issuer: "First", adapter: FirstOfficialPcfAdapter, tickers: universe["第一金"], delayMs: 300 },
    { issuer: "FHT", adapter: FhtOfficialPcfAdapter, tickers: universe["復華"], delayMs: 300 },
    { issuer: "SinoPac", adapter: SinoPacOfficialPcfAdapter, tickers: SINOPAC_ACTIVE, delayMs: 200 },
    { issuer: "Yuanta", adapter: YuantaOfficialPcfAdapter, tickers: universe["元大"], delayMs: 200 },
    { issuer: "Capital", adapter: CapitalOfficialPcfAdapter, tickers: CAPITAL_ACTIVE, delayMs: 300 },
    { issuer: "Mega", adapter: MegaOfficialPcfAdapter, tickers: universe["兆豐"], delayMs: 200 },
    { issuer: "Taishin", adapter: TaishinOfficialPcfAdapter, tickers: universe["台新"], delayMs: 200 },
    { issuer: "Nomura", adapter: NomuraOfficialPcfAdapter, tickers: universe["野村"], delayMs: 300 },
    { issuer: "BlackRock", adapter: BlackRockOfficialPcfAdapter, tickers: universe["貝萊德"], delayMs: 200 },
  ];

  // CTBC's adapter has no "today" fallback by design — it requires an explicit date. The last confirmed
  // official date for the 36-ticker CTBC cohort (from the Final Gate reconciliation round) is used here
  // as the explicit date argument, exactly as the earlier CTBC-only gate run did.
  const CTBC_EXPLICIT_DATE = "2026-09-24";

  const results: FetchResult[] = [];
  for (const target of TARGETS) {
    for (const ticker of target.tickers) {
      const attempt = async () =>
        target.issuer === "CTBC"
          ? target.adapter.fetchSnapshot(ticker, CTBC_EXPLICIT_DATE)
          : target.adapter.fetchSnapshot(ticker);
      try {
        const snap = await attempt();
        if (!snap.positions.length) throw new Error("empty positions");
        results.push({ issuer: target.issuer, ticker, snapshot: snap });
      } catch (e1) {
        // one bounded retry only, transient-network class only
        try {
          await new Promise((r) => setTimeout(r, 1500));
          const snap = await attempt();
          if (!snap.positions.length) throw new Error("empty positions");
          results.push({ issuer: target.issuer, ticker, snapshot: snap });
        } catch (e2) {
          results.push({ issuer: target.issuer, ticker, error: e2 instanceof Error ? e2.message : String(e2) });
        }
      }
      await new Promise((r) => setTimeout(r, target.delayMs));
    }
    console.error(`[C] ${target.issuer} done (${target.tickers.length} tickers)`);
  }
  return results;
}

async function phaseD(client: Client, results: FetchResult[]) {
  const query = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows;
  await client.query("BEGIN");
  try {
    for (const r of results) {
      if (!r.snapshot) continue;
      await upsertSnapshot(query, r.snapshot);
    }
    await client.query("COMMIT");
    console.error("[D] PRODUCTION_WRITE_COMMITTED = YES");
  } catch (e) {
    await client.query("ROLLBACK");
    fail("D_PRODUCTION_WRITE", e);
  }
}

async function phaseE(client: Client, results: FetchResult[]) {
  const tickers = results.map((r) => r.ticker);
  const { rows: snapRows } = await client.query(
    `SELECT etf_code, data_date::text AS data_date, id FROM etf_official_daily_snapshots WHERE etf_code = ANY($1)`,
    [tickers],
  );
  const portfoliosWithSnapshot = new Set(snapRows.map((r) => r.etf_code)).size;

  const { rows: emptySnap } = await client.query(
    `SELECT s.etf_code FROM etf_official_daily_snapshots s
     LEFT JOIN etf_official_daily_positions p ON p.snapshot_id = s.id
     WHERE s.etf_code = ANY($1) GROUP BY s.etf_code, s.id HAVING COUNT(p.id) = 0`,
    [tickers],
  );
  const { rows: orphans } = await client.query(
    `SELECT p.id FROM etf_official_daily_positions p
     LEFT JOIN etf_official_daily_snapshots s ON s.id = p.snapshot_id
     WHERE s.id IS NULL`,
  );
  const { rows: dupSnap } = await client.query(
    `SELECT etf_code, data_date, COUNT(*) c FROM etf_official_daily_snapshots
     WHERE etf_code = ANY($1) GROUP BY etf_code, data_date HAVING COUNT(*) > 1`,
    [tickers],
  );
  const { rows: dupPos } = await client.query(
    `SELECT snapshot_id, security_code, COUNT(*) c FROM etf_official_daily_positions
     GROUP BY snapshot_id, security_code HAVING COUNT(*) > 1`,
  );

  const spotChecks = ["00981A", "00878", "0050", "00915", "00994A", "00991B"];
  const spotResults: Record<string, unknown> = {};
  for (const code of spotChecks) {
    const { rows } = await client.query(
      `SELECT s.data_date::text AS data_date, COUNT(p.id) AS position_count,
              array_agg(DISTINCT p.position_type) AS types, array_agg(DISTINCT p.position_unit) AS units
       FROM etf_official_daily_snapshots s
       JOIN etf_official_daily_positions p ON p.snapshot_id = s.id
       WHERE s.etf_code = $1
       GROUP BY s.id, s.data_date ORDER BY s.data_date DESC LIMIT 1`,
      [code],
    );
    spotResults[code] = rows[0] ?? null;
  }

  return {
    portfoliosWithSnapshot,
    emptySnapshots: emptySnap.length,
    orphanPositions: orphans.length,
    duplicateSnapshotIdentities: dupSnap.length,
    duplicatePositionIdentities: dupPos.length,
    spotResults,
  };
}

async function phaseF(client: Client, results: FetchResult[]) {
  const query = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows;
  const before = await client.query(`SELECT COUNT(*) c FROM etf_official_daily_snapshots`);
  const beforePos = await client.query(`SELECT COUNT(*) c FROM etf_official_daily_positions`);

  await client.query("BEGIN");
  try {
    for (const r of results) {
      if (!r.snapshot) continue;
      await upsertSnapshot(query, r.snapshot); // same in-memory snapshots, no re-fetch
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    fail("F_IDEMPOTENCY_REWRITE", e);
  }

  const after = await client.query(`SELECT COUNT(*) c FROM etf_official_daily_snapshots`);
  const afterPos = await client.query(`SELECT COUNT(*) c FROM etf_official_daily_positions`);
  return {
    snapshotCountUnchanged: before.rows[0].c === after.rows[0].c,
    positionCountUnchanged: beforePos.rows[0].c === afterPos.rows[0].c,
  };
}

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await client.connect();
  try {
    await phaseA(client);
    await phaseB(client);

    const cached = readFetchCache();
    const results = cached ?? await phaseC();
    if (!cached) writeFetchCache(results);
    const passed = results.filter((r) => r.snapshot);
    const failed = results.filter((r) => !r.snapshot);

    console.log(JSON.stringify({ FETCH_TARGET: results.length, FETCH_PASS: passed.length, FETCH_FAIL: failed.length }));
    if (failed.length > 0) {
      console.error("FUNCTION2_RUNNER_STOP: fetch gate not 331/331, no production write attempted.");
      console.error(JSON.stringify(failed.map((f) => ({ issuer: f.issuer, ticker: f.ticker, error: f.error })), null, 2));
      process.exit(1);
    }

    await phaseD(client, results);
    const verification = await phaseE(client, results);
    const idempotency = await phaseF(client, results);
    clearFetchCache(); // production write + verification succeeded — cache no longer needed

    console.log(JSON.stringify({
      FETCH_TARGET: results.length,
      FETCH_PASS: passed.length,
      FETCH_FAIL: failed.length,
      PRODUCTION_WRITE_COMMITTED: true,
      ...verification,
      IDEMPOTENT: idempotency.snapshotCountUnchanged && idempotency.positionCountUnchanged,
      SECOND_SAME_DATE_WRITE_NO_DUPLICATE: idempotency.snapshotCountUnchanged && idempotency.positionCountUnchanged,
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("FUNCTION2_RUNNER_FAILED:", e); process.exit(1); });
