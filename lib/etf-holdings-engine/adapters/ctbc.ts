// CTBC (中國信託) Investment Trust — official JSON API, no headless browser, no cookies. Verified
// 2026-09-25 via static read of the official bundle (assets/index-*.js) plus a real atomic proof call:
//
//   1. POST https://www.ctbcinvestments.com.tw/API/home/AuthToken   body: { token: "www.ctbcinvestments.com" }
//   2. immediately POST https://www.ctbcinvestments.com.tw/API/etf/Buyback
//        query: ?token=<Data.token from step 1>
//        body:  { token: <same>, FID, StartDate }
//
// The AuthToken value has a short server-side TTL — confirmed empirically: splitting the two calls across
// separate round-trips (a few seconds apart) invalidates it ("Token 無效或過期"), while calling them
// back-to-back in one execution succeeds. So a token is fetched fresh for every single Buyback call — it
// is never cached or reused across ETFs. No cookie is read or sent (the app itself never sets
// withCredentials, and its own origin differs from the API's .com.tw origin, so cookies play no role by
// its own design).
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const API_BASE = "https://www.ctbcinvestments.com.tw/API";
const AUTH_SEED = "www.ctbcinvestments.com";

// ticker -> official FID, captured verbatim from the live official ETF-picker <select> on
// https://www.ctbcinvestments.com/Etf/Buyback (36/36, one-time read, never guessed). Re-derive from the
// same dropdown if the issuer adds/removes an ETF — do not hand-edit individual entries.
const FID_MAP: Record<string, string> = {
  "00406A": "E0038", "00752": "E0001", "00753L": "E0002", "00772B": "E0003",
  "00773B": "E0004", "00795B": "E0005", "00847B": "E0008", "00848B": "E0009",
  "00849B": "E0010", "00862B": "E0011", "00863B": "E0012", "00864B": "E0013",
  "00882": "E0014", "00884B": "E0016", "00891": "E0017", "00894": "E0018",
  "00896": "E0019", "00902": "E0020", "00912": "E0021", "00917": "E0022",
  "00928": "E0023", "00934": "E0024", "00941": "E0025", "00948B": "E0026",
  "00954": "E0027", "00955": "E0028", "00956": "E0029", "00963": "E0030",
  "00964": "E0031", "009800": "E0032", "009801": "E0033", "009819": "E0037",
  "00981D": "E0035", "009828": "E0039", "00983A": "E0034", "00995A": "E0036",
};

type BuybackDetailRow = { code_: string; name_: string; qty_: string; weights_: string; cur_?: string };
type BuybackDetailGroup = { Code: string; Name: string; Data: BuybackDetailRow[] };
type BuybackResponse = {
  ResultCode: number;
  ResultMsg: string;
  Data: {
    Data: Array<{ ETF_ID: string; FID: string; 公告日: string; 基金淨資產價值: string; 已發行受益權單位總數: string }>;
    Detail: BuybackDetailGroup[];
  } | null;
};

function num(s: string | number | undefined | null): number {
  if (s == null) return 0;
  return Number(String(s).replace(/[,%]/g, "").trim()) || 0;
}

function positionTypeOf(code: string): { type: CanonicalPosition["positionType"]; unit: CanonicalPosition["positionUnit"] } {
  if (code === "STOCK") return { type: "EQUITY", unit: "SHARES" };
  if (code === "BOND") return { type: "BOND", unit: "PAR_VALUE" };
  if (code === "FUTURE") return { type: "FUTURE", unit: "CONTRACTS" };
  if (code === "OPTION") return { type: "OPTION", unit: "CONTRACTS" };
  return { type: "OTHER", unit: "OTHER" }; // MARGIN, CASH, and any other official group
}

async function fetchAuthToken(signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${API_BASE}/home/AuthToken?token=${encodeURIComponent(AUTH_SEED)}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ token: AUTH_SEED }),
    signal,
  });
  if (!r.ok) throw new Error(`CTBC_HTTP_${r.status}_AUTHTOKEN`);
  const j = await r.json();
  if (j.ResultCode !== 0 || !j.Data?.token) throw new Error(`CTBC_AUTHTOKEN_FAILED — ${j.ResultMsg ?? "no token in response"}`);
  return j.Data.token as string;
}

export const CtbcOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "CTBC",

  async fetchSnapshot(etfCode: string, date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const fid = FID_MAP[etfCode];
    if (!fid) throw new Error(`CTBC_UNMAPPED_ETF_${etfCode} — not in the official FID map, never guessed`);
    if (!date) throw new Error(`CTBC_DATE_REQUIRED_${etfCode} — this adapter does not default to today; caller must pass an explicit official data date`);

    // Fetch a fresh token and immediately use it — no logging/wait/other network work in between.
    const token = await fetchAuthToken(signal);
    const r = await fetch(`${API_BASE}/etf/Buyback?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ token, FID: fid, StartDate: date }),
      signal,
    });
    if (!r.ok) throw new Error(`CTBC_HTTP_${r.status}_${etfCode}`);
    const j: BuybackResponse = await r.json();
    if (j.ResultCode !== 0) throw new Error(`CTBC_BUYBACK_FAILED_${etfCode}_${date} — ${j.ResultMsg}`);
    const meta = j.Data?.Data?.[0];
    if (!meta) throw new Error(`CTBC_NO_ENTRY_${etfCode}_${date}`);

    const positions: CanonicalPosition[] = [];
    for (const group of j.Data?.Detail ?? []) {
      const { type, unit } = positionTypeOf(group.Code);
      for (const row of group.Data ?? []) {
        // STOCK/BOND/FUTURE/OPTION/ETF rows always carry a real official code_ (confirmed across the
        // full 36-ETF CTBC universe). MARGIN/CASH rows never do — the official "CASH" group bundles
        // several distinct real line items (現金 per currency held, 應收(付)證券款, etc.), and more than
        // one can share the same currency, so currency alone isn't enough either. group.Code + the row's
        // own name_ + currency (cur_) together were confirmed unique within every group across the full
        // 36-ETF CTBC universe — built only from official fields, never from amount/weight.
        const securityCode = row.code_ || `OTHER:${group.Code}:${row.name_}:${row.cur_ ?? ""}`;
        positions.push({
          securityCode, securityName: row.name_,
          positionType: type, positionAmount: num(row.qty_), positionUnit: unit,
          weight: num(row.weights_), canonicalSecurityId: null,
        });
      }
    }
    if (!positions.length) throw new Error(`CTBC_NO_HOLDINGS_${etfCode}_${date}`);

    const dataDate = meta.公告日.replaceAll("/", "-");
    return {
      etfCode,
      issuer: "CTBC",
      assetType: positions.some((p) => p.positionType === "EQUITY") ? "EQUITY" : positions.some((p) => p.positionType === "BOND") ? "BOND" : "OTHER",
      dataDate,
      announcementDate: dataDate,
      fundNav: num(meta.基金淨資產價值),
      outstandingUnits: num(meta.已發行受益權單位總數),
      positions,
      source: "CTBC_OFFICIAL_API",
      retrievedAt: new Date().toISOString(),
    };
  },
};
