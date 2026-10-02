// STEP 3: 336-ETF real batch validation. Resolves the 17-confirmed-issuer universe straight from the
// official TWSE/TPEx ISIN registry (issuer-name matching, same technique as the earlier universe-
// intersection round), then calls each ETF's real issuer adapter exactly once. No Production write, no
// retry loop — one real attempt per ETF, first real error recorded on failure.
import * as cheerio from "cheerio";
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
import { closeSharedBrowser } from "../lib/etf-holdings-engine/adapters/browserUtil.ts";
import type { CanonicalSnapshot, OfficialPcfAdapter } from "../lib/etf-holdings-engine/types.ts";

const ADAPTERS_BY_ISSUER_KEYWORD: Record<string, OfficialPcfAdapter> = {
  "野村": NomuraOfficialPcfAdapter,
  "統一": UpamcOfficialPcfAdapter,
  "安聯": AllianzOfficialPcfAdapter,
  "台新": TaishinOfficialPcfAdapter,
  "富邦": FubonOfficialPcfAdapter,
  "中信": CtbcOfficialPcfAdapter,
  "復華": FhtOfficialPcfAdapter,
  "群益": CapitalOfficialPcfAdapter,
  "聯博": AbOfficialPcfAdapter,
  "摩根": JpmorganOfficialPcfAdapter,
  "第一金": FirstOfficialPcfAdapter,
  "元大": YuantaOfficialPcfAdapter,
  "兆豐": MegaOfficialPcfAdapter,
  "國泰": CathayOfficialPcfAdapter,
  "凱基": KgiOfficialPcfAdapter,
  "永豐": SinoPacOfficialPcfAdapter,
  "貝萊德": BlackRockOfficialPcfAdapter,
};

const ISSUER_KEYWORDS = Object.keys(ADAPTERS_BY_ISSUER_KEYWORD);

type UniverseRow = { code: string; name: string; market: "TWSE" | "TPEX"; isActive: boolean; issuer: string };

function parseIsinTable(html: string): { code: string; name: string }[] {
  const $ = cheerio.load(html);
  const out: { code: string; name: string }[] = [];
  let inEtf = false;
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td").map((__, td) => $(td).text().trim()).get();
    if (cells.length === 1 && cells[0] === "ETF") { inEtf = true; return; }
    if (cells.length === 1 && cells[0] && cells[0] !== "ETF") { if (inEtf) inEtf = false; return; }
    if (inEtf && cells.length >= 4) {
      const parts = cells[0].split("　");
      out.push({ code: parts[0], name: (parts[1] ?? "").trim() });
    }
  });
  return out;
}

async function resolveUniverse(): Promise<UniverseRow[]> {
  const [twseRes, tpexRes] = await Promise.all([
    fetch("https://isin.twse.com.tw/isin/C_public.jsp?strMode=2"),
    fetch("https://isin.twse.com.tw/isin/C_public.jsp?strMode=4"),
  ]);
  const twseBuf = await twseRes.arrayBuffer();
  const tpexBuf = await tpexRes.arrayBuffer();
  const decoder = new TextDecoder("big5");
  const twseRows = parseIsinTable(decoder.decode(twseBuf)).map((r) => ({ ...r, market: "TWSE" as const }));
  const tpexRows = parseIsinTable(decoder.decode(tpexBuf)).map((r) => ({ ...r, market: "TPEX" as const }));

  const all = [...twseRows, ...tpexRows];
  const universe: UniverseRow[] = [];
  for (const row of all) {
    const issuer = ISSUER_KEYWORDS.find((kw) => row.name.includes(kw));
    if (!issuer) continue;
    universe.push({ code: row.code, name: row.name, market: row.market, isActive: row.name.includes("主動"), issuer });
  }
  return universe;
}

type FetchOutcome = {
  etfCode: string; issuer: string; assetType: string | null; dataDate: string | null;
  positionRows: number; positionTypes: string[]; fullPortfolio: boolean; hasWeight: boolean; hasUnits: boolean;
  fetchPass: boolean; error: string | null;
};

async function fetchOne(row: UniverseRow): Promise<FetchOutcome> {
  const adapter = ADAPTERS_BY_ISSUER_KEYWORD[row.issuer];
  try {
    const snap: CanonicalSnapshot = await adapter.fetchSnapshot(row.code);
    const types = [...new Set(snap.positions.map((p) => p.positionType))];
    return {
      etfCode: row.code, issuer: row.issuer, assetType: snap.assetType, dataDate: snap.dataDate,
      positionRows: snap.positions.length, positionTypes: types,
      fullPortfolio: snap.positions.length > 5,
      hasWeight: snap.positions.every((p) => p.weight > 0) || snap.positions.some((p) => p.weight > 0),
      hasUnits: snap.outstandingUnits > 0,
      fetchPass: true, error: null,
    };
  } catch (e: any) {
    return {
      etfCode: row.code, issuer: row.issuer, assetType: null, dataDate: null,
      positionRows: 0, positionTypes: [], fullPortfolio: false, hasWeight: false, hasUnits: false,
      fetchPass: false, error: String(e?.message ?? e).slice(0, 200),
    };
  }
}

async function main() {
  let universe = await resolveUniverse();
  const limit = process.env.BATCH_LIMIT ? Number(process.env.BATCH_LIMIT) : null;
  if (limit) universe = universe.slice(0, limit);
  console.log(`TARGET_ETFS_RESOLVED: ${universe.length}`);

  const results: FetchOutcome[] = [];
  const concurrency = 4;
  for (let i = 0; i < universe.length; i += concurrency) {
    const batch = universe.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fetchOne));
    results.push(...batchResults);
    console.error(`progress: ${Math.min(i + concurrency, universe.length)}/${universe.length}`);
  }

  await closeSharedBrowser();

  const pass = results.filter((r) => r.fetchPass);
  const failed = results.filter((r) => !r.fetchPass);
  const byIssuer: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    byIssuer[r.issuer] ??= { pass: 0, total: 0 };
    byIssuer[r.issuer].total++;
    if (r.fetchPass) byIssuer[r.issuer].pass++;
  }

  console.log(JSON.stringify({
    TARGET_ETFS: universe.length,
    FETCH_PASS: pass.length,
    FETCH_FAILED: failed.length,
    FETCH_COVERAGE_PERCENT: universe.length ? ((pass.length / universe.length) * 100).toFixed(1) : "0.0",
    EQUITY_ETFS: pass.filter((r) => r.assetType === "EQUITY").length,
    BOND_ETFS: pass.filter((r) => r.assetType === "BOND").length,
    MULTI_ASSET_ETFS: pass.filter((r) => r.assetType === "MULTI_ASSET").length,
    OTHER_ETFS: pass.filter((r) => r.assetType === "OTHER").length,
    POSITION_TYPES_FOUND: [...new Set(pass.flatMap((r) => r.positionTypes))],
    BY_ISSUER: byIssuer,
    FAILURES: failed.map((f) => ({ etfCode: f.etfCode, issuer: f.issuer, error: f.error })),
  }, null, 2));
}

main().catch((e) => { console.error("BATCH_FAILED:", e); process.exit(1); });
