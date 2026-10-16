// 排行中心分類 — 官方分類優先版。改用證交所/櫃買自己發布的「基金類型」欄位（同一份
// mopsfin.twse.com.tw/opendata/t187ap47_L.csv / _O.csv，新上市偵測管線也在用），不是 Morningstar
// 的自由文字分類（VERIFIED 上一輪：對我們實際會顯示的中文命名ETF幾乎全是NULL，官方這欄位反而
// 100%有值）。「股票」「債券」兩種官方類型可以直接判斷；「指數股票型期貨信託基金」
// （VERIFIED：期元大S&P黃金/白銀/石油官方就是這個類型）與「槓桿/反向指數股票型基金」
// （VERIFIED：同時涵蓋股票指數槓反與商品槓反，官方類型本身無法區分）這兩種需要用名稱關鍵字
// 當備援才能分出股票/商品——完全照使用者指示：「官方分類優先，關鍵字只當備援並標明」。
import type { AssetCategoryBucket } from "./categoryClassification";

const BOND_NAME_PATTERN = /債/;
const COMMODITY_NAME_PATTERN = /原油|黃金|白銀|商品|石油|布蘭特|天然氣|農產品/;

type OfficialRow = { code: string; name: string; fundType: string };

let cache: { at: number; byCode: Map<string, OfficialRow> } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — official list changes at most daily

function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function fetchOfficialTypes(url: string): Promise<OfficialRow[]> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (SmartMatch data pipeline)" } });
  if (!res.ok) throw new Error(`OFFICIAL_ETF_TYPE_HTTP_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const iCode = header.indexOf("基金代號"), iName = header.indexOf("基金簡稱"), iType = header.indexOf("基金類型");
  if (iCode < 0 || iType < 0) return [];
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    return { code: (cols[iCode] ?? "").trim(), name: (cols[iName] ?? "").trim(), fundType: (cols[iType] ?? "").trim() };
  }).filter((r) => r.code);
}

async function getOfficialTypeMap(): Promise<Map<string, OfficialRow>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.byCode;
  const [twse, tpex] = await Promise.all([
    fetchOfficialTypes("https://mopsfin.twse.com.tw/opendata/t187ap47_L.csv").catch(() => []),
    fetchOfficialTypes("https://mopsfin.twse.com.tw/opendata/t187ap47_O.csv").catch(() => []),
  ]);
  const byCode = new Map<string, OfficialRow>();
  for (const r of [...twse, ...tpex]) byCode.set(r.code, r);
  cache = { at: Date.now(), byCode };
  return byCode;
}

export type EtfClassification = { bucket: AssetCategoryBucket; basis: "OFFICIAL" | "KEYWORD_FALLBACK" | "UNCLASSIFIED" };

/** Classifies ONE ETF given its code+name. Returns basis so callers can disclose which rows were
 * officially classified vs keyword-fallback. Never guesses silently. */
export async function classifyEtfOfficial(code: string, name: string): Promise<EtfClassification> {
  const map = await getOfficialTypeMap();
  const row = map.get(code);
  if (!row) {
    // Not in the official feed at all (shouldn't normally happen for an active TW ETF) — fall
    // back to name-keyword, same as before.
    if (BOND_NAME_PATTERN.test(name)) return { bucket: "BOND", basis: "KEYWORD_FALLBACK" };
    if (COMMODITY_NAME_PATTERN.test(name)) return { bucket: "COMMODITY", basis: "KEYWORD_FALLBACK" };
    return { bucket: "UNCLASSIFIED", basis: "UNCLASSIFIED" };
  }
  const t = row.fundType;
  if (t.includes("債券")) return { bucket: "BOND", basis: "OFFICIAL" };
  if (t === "指數股票型期貨信託基金") {
    // Official type confirms "futures trust" but not WHICH underlying -- VERIFIED this round all
    // 3 of our known futures-trust-type ETFs are commodity (gold/silver/oil), but that's not a
    // logical guarantee, so keyword still decides, just within an official-confirmed subset.
    if (COMMODITY_NAME_PATTERN.test(name)) return { bucket: "COMMODITY", basis: "OFFICIAL" };
    return { bucket: "UNCLASSIFIED", basis: "KEYWORD_FALLBACK" };
  }
  if (t.includes("槓桿") || t.includes("反向")) {
    // Official type genuinely can't disambiguate (covers both equity-index and commodity
    // leveraged/inverse products) -- keyword is the real decider here, disclosed as fallback.
    if (COMMODITY_NAME_PATTERN.test(name)) return { bucket: "COMMODITY", basis: "KEYWORD_FALLBACK" };
    return { bucket: "STOCK", basis: "KEYWORD_FALLBACK" };
  }
  if (t.includes("平衡")) return { bucket: "MIXED", basis: "OFFICIAL" };
  if (t.includes("股票")) return { bucket: "STOCK", basis: "OFFICIAL" };
  return { bucket: "UNCLASSIFIED", basis: "UNCLASSIFIED" };
}

/** Batch version for the ranking API: classifies a list of {code,name} rows in one pass (one
 * cached fetch of the official lists, not one fetch per row). */
export async function classifyEtfsOfficial(rows: { code: string; name: string }[]): Promise<Map<string, EtfClassification>> {
  const map = await getOfficialTypeMap();
  const result = new Map<string, EtfClassification>();
  for (const r of rows) {
    const row = map.get(r.code);
    if (!row) {
      if (BOND_NAME_PATTERN.test(r.name)) result.set(r.code, { bucket: "BOND", basis: "KEYWORD_FALLBACK" });
      else if (COMMODITY_NAME_PATTERN.test(r.name)) result.set(r.code, { bucket: "COMMODITY", basis: "KEYWORD_FALLBACK" });
      else result.set(r.code, { bucket: "UNCLASSIFIED", basis: "UNCLASSIFIED" });
      continue;
    }
    const t = row.fundType;
    if (t.includes("債券")) { result.set(r.code, { bucket: "BOND", basis: "OFFICIAL" }); continue; }
    if (t === "指數股票型期貨信託基金") {
      result.set(r.code, COMMODITY_NAME_PATTERN.test(r.name) ? { bucket: "COMMODITY", basis: "OFFICIAL" } : { bucket: "UNCLASSIFIED", basis: "KEYWORD_FALLBACK" });
      continue;
    }
    if (t.includes("槓桿") || t.includes("反向")) {
      result.set(r.code, COMMODITY_NAME_PATTERN.test(r.name) ? { bucket: "COMMODITY", basis: "KEYWORD_FALLBACK" } : { bucket: "STOCK", basis: "KEYWORD_FALLBACK" });
      continue;
    }
    if (t.includes("平衡")) { result.set(r.code, { bucket: "MIXED", basis: "OFFICIAL" }); continue; }
    if (t.includes("股票")) { result.set(r.code, { bucket: "STOCK", basis: "OFFICIAL" }); continue; }
    result.set(r.code, { bucket: "UNCLASSIFIED", basis: "UNCLASSIFIED" });
  }
  return result;
}
