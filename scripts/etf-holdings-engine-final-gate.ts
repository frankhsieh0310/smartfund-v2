// FINAL Integration Gate — one real fetch per DAILY_ACTIVE portfolio across all 17 confirmed issuer
// adapters. No retries, no source discovery. Universe built from the live TWSE/TPEx ISIN registry
// (category-header parse) plus each issuer's own already-confirmed identity map, minus already-confirmed
// dead/terminated tickers (00793B, 00838B) and pending-onboarding new entrants (00643K, 00412A) which are
// excluded without further research.
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
import type { OfficialPcfAdapter } from "../lib/etf-holdings-engine/types.ts";
import * as fs from "fs";

const __dirname = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const universe: Record<string, string[]> = JSON.parse(
  fs.readFileSync(__dirname + "/../universe_by_issuer.json", "utf8"),
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

type Row = { issuer: string; ticker: string; dataDate: string | null; rows: number; types: string[]; pass: boolean; error?: string };

async function main() {
  const results: Row[] = [];
  for (const target of TARGETS) {
    for (const ticker of target.tickers) {
      try {
        const snap = await target.adapter.fetchSnapshot(ticker);
        if (!snap.positions.length) throw new Error("empty positions");
        results.push({
          issuer: target.issuer, ticker, dataDate: snap.dataDate, rows: snap.positions.length,
          types: [...new Set(snap.positions.map((p) => p.positionType))], pass: true,
        });
      } catch (e) {
        results.push({
          issuer: target.issuer, ticker, dataDate: null, rows: 0, types: [], pass: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      await new Promise((r) => setTimeout(r, target.delayMs));
    }
    console.error(`[progress] ${target.issuer} done (${target.tickers.length} tickers)`);
  }

  const passed = results.filter((r) => r.pass);
  const failed = results.filter((r) => !r.pass);
  const byIssuerSummary: Record<string, { target: number; pass: number; fail: number }> = {};
  for (const target of TARGETS) {
    const rs = results.filter((r) => r.issuer === target.issuer);
    byIssuerSummary[target.issuer] = { target: rs.length, pass: rs.filter((r) => r.pass).length, fail: rs.filter((r) => !r.pass).length };
  }

  console.log(JSON.stringify({
    FINAL_TARGET: results.length,
    FINAL_PASS: passed.length,
    FINAL_FAIL: failed.length,
    BY_ISSUER: byIssuerSummary,
    FAILED: failed.map((f) => ({ issuer: f.issuer, ticker: f.ticker, error: f.error })),
  }, null, 2));

  fs.writeFileSync(__dirname + "/../final_gate_full_results.json", JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error("FINAL_GATE_FAILED:", e); process.exit(1); });
