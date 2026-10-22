// PREPARED, NOT WIRED IN — Taiwan ETF Official Daily Holdings, once-per-trading-day ingestion.
//
// Extension-point finding (read-only inspection of scripts/data/orchestrator/run-ordinary-master-scheduler.ts
// and config/ordinary-master-scheduler.json): that scheduler's model is a continuous supervisor pool —
// each "asset" entry is a long-running child process with its own heartbeat file, serialized behind a
// single DB-concurrency slot (maxDbConcurrency: 1), polled every 60s. It has no notion of "run once at a
// fixed local time and exit." Registering this engine as another entry in that assets[] array would make
// it behave like a perpetually-running/restarting supervisor, not a once/day-at-17:00 job — a semantic
// mismatch with what this engine needs, not a natural fit. So this round does NOT edit
// config/ordinary-master-scheduler.json or run-ordinary-master-scheduler.ts, and does NOT restart the
// live master (PID 12052 / 18296 untouched).
//
// This file is a separate, self-contained daily-cadence process: it wakes up, checks whether it's past
// 17:00 Asia/Taipei and hasn't run today, and if so calls the SAME verified engine
// (17 issuer adapters + lib/etf-holdings-engine/storage.ts upsertSnapshot) exactly once, then goes back
// to sleep. It shares the storage layer and adapters with scripts/finish-function2-production.ts —
// no second data system. It is NOT started by this round; it is prepared code only.
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
const RUN_MARKER_DIR = path.join(ROOT, "runtime", "etf-official-holdings-scheduler");
const CTBC_EXPLICIT_DATE = "2026-09-24"; // see note in finish-function2-production.ts — replace with the
// adapter's own listAvailableDates()[0] once a proper "latest CTBC date" resolver exists; not in scope here.

function taipeiNow(): Date {
  // Asia/Taipei has no DST — a fixed +08:00 offset is exact, unlike relying on the host's local TZ.
  const utc = Date.now();
  return new Date(utc + 8 * 60 * 60 * 1000);
}

function todayTaipeiKey(): string {
  const t = taipeiNow();
  return t.toISOString().slice(0, 10); // YYYY-MM-DD in the Taipei-shifted clock
}

async function alreadyRanToday(): Promise<boolean> {
  const marker = path.join(RUN_MARKER_DIR, `${todayTaipeiKey()}.done`);
  return fs.existsSync(marker);
}

async function markRanToday(): Promise<void> {
  fs.mkdirSync(RUN_MARKER_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUN_MARKER_DIR, `${todayTaipeiKey()}.done`), new Date().toISOString());
}

async function runOnce(client: Client) {
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

  const query = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows;

  for (const target of TARGETS) {
    for (const ticker of target.tickers) {
      const attempt = async (): Promise<CanonicalSnapshot> =>
        target.issuer === "CTBC"
          ? target.adapter.fetchSnapshot(ticker, CTBC_EXPLICIT_DATE)
          : target.adapter.fetchSnapshot(ticker);
      try {
        let snap: CanonicalSnapshot;
        try {
          snap = await attempt();
        } catch {
          await new Promise((r) => setTimeout(r, 1500));
          snap = await attempt(); // one bounded retry, transient network only
        }
        if (!snap.positions.length) throw new Error("empty positions");
        // idempotent upsert: same (etf_code, data_date) never duplicates
        await upsertSnapshot(query, snap);
      } catch (e) {
        // logged and skipped — one failed ticker never blocks the rest of the batch; the next
        // scheduled trading-day run picks it up naturally. No retry loop, no wait/poll.
        console.error(`[etf-holdings-daily] SKIP ${target.issuer} ${ticker}:`, e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, target.delayMs));
    }
  }
}

async function main() {
  if (await alreadyRanToday()) {
    console.error("[etf-holdings-daily] already ran for", todayTaipeiKey(), "— no-op");
    return;
  }
  const now = taipeiNow();
  if (now.getUTCHours() < 17) {
    console.error("[etf-holdings-daily] before 17:00 Asia/Taipei — nothing to do yet");
    return;
  }
  const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await client.connect();
  try {
    await runOnce(client);
    await markRanToday();
    console.error("[etf-holdings-daily] run complete for", todayTaipeiKey());
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("[etf-holdings-daily] FAILED:", e); process.exit(1); });
