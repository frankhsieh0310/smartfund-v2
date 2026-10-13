// Curated FX P0 universe (Step 16 baseline, kept as a smoke-test fixture — see FX_PAIRS/
// seedFxUniverse) + the full-universe discovery/activation layer added when the task expanded
// scope from "19 curated pairs" to "all Yahoo-direct pairs".
//
// Reuses existing fx_currencies / fx_pairs / fx_pair_aliases / fx_coverage tables (migrated
// 2026-08-05 / 2026-08-09) — no schema change, no destructive writes. Legacy data found already
// in these tables (528 fx_pairs = the full C(33,2) combinatorial cross of a 33-currency set,
// ~12.9M fx_candles) is left untouched; this file only ADDS rows (idempotent upserts) and tags
// per-pair Yahoo-direct validity via fx_coverage so the production ingestion query
// (lib/cron/fxUpdate.ts) can select "all active Yahoo-direct pairs" without hard-coding a list.

import { prisma } from "@/lib/prisma";

export const FX_CURRENCIES: Array<{ code: string; name: string }> = [
  { code: "USD", name: "美元" },
  { code: "TWD", name: "新台幣" },
  { code: "EUR", name: "歐元" },
  { code: "JPY", name: "日圓" },
  { code: "GBP", name: "英鎊" },
  { code: "AUD", name: "澳幣" },
  { code: "NZD", name: "紐幣" },
  { code: "CAD", name: "加幣" },
  { code: "CHF", name: "瑞士法郎" },
  { code: "CNY", name: "人民幣（在岸）" },
  { code: "CNH", name: "人民幣（離岸）" },
  { code: "HKD", name: "港幣" },
  { code: "SGD", name: "新加坡幣" },
  { code: "KRW", name: "韓元" },
];

// base/quote per task spec. providerSymbol = the literal string sent to Yahoo (validated live via
// spark PoC on 2026-09-12 — all 19 returned ok:true in one batched request). Yahoo may echo a
// different "canonical" meta.symbol for some pairs (e.g. requesting "USDJPY=X" comes back with
// meta.symbol="JPY=X") — that quirk is recorded in fx_pair_aliases, not assumed in advance.
//
// KEPT AS A FIXTURE, NOT THE PRODUCTION SCOPE (Step 7 of the full-universe round): production
// ingestion (lib/cron/fxUpdate.ts) now reads the DB's fx_coverage-validated Yahoo-direct universe,
// not this list. This stays for smoke tests / local validation only.
export const FX_PAIRS: Array<{ base: string; quote: string }> = [
  { base: "USD", quote: "TWD" },
  { base: "EUR", quote: "USD" },
  { base: "USD", quote: "JPY" },
  { base: "GBP", quote: "USD" },
  { base: "AUD", quote: "USD" },
  { base: "NZD", quote: "USD" },
  { base: "USD", quote: "CAD" },
  { base: "USD", quote: "CHF" },
  { base: "USD", quote: "CNY" },
  { base: "USD", quote: "CNH" },
  { base: "USD", quote: "HKD" },
  { base: "USD", quote: "SGD" },
  { base: "USD", quote: "KRW" },
  { base: "EUR", quote: "JPY" },
  { base: "EUR", quote: "GBP" },
  { base: "EUR", quote: "CHF" },
  { base: "EUR", quote: "AUD" },
  { base: "GBP", quote: "JPY" },
  { base: "AUD", quote: "JPY" },
];

// Additional currencies confirmed live (2026-09-12) as valid Yahoo direct USD-crosses during the
// full-universe discovery pass — Yahoo's search/screener endpoints don't enumerate a bulk FX
// instrument list, so these were found via targeted candidate-and-validate (Step 3), not assumed.
export const DISCOVERED_CURRENCIES: Array<{ code: string; name: string }> = [
  { code: "ILS", name: "以色列新謝克爾" }, { code: "RUB", name: "俄羅斯盧布" }, { code: "ARS", name: "阿根廷披索" },
  { code: "CLP", name: "智利披索" }, { code: "COP", name: "哥倫比亞披索" }, { code: "PEN", name: "秘魯索爾" },
  { code: "PKR", name: "巴基斯坦盧比" }, { code: "BDT", name: "孟加拉塔卡" }, { code: "LKR", name: "斯里蘭卡盧比" },
  { code: "EGP", name: "埃及鎊" }, { code: "KWD", name: "科威特第納爾" }, { code: "BHD", name: "巴林第納爾" },
  { code: "OMR", name: "阿曼里亞爾" }, { code: "JOD", name: "約旦第納爾" }, { code: "MAD", name: "摩洛哥迪爾漢" },
  { code: "NGN", name: "奈及利亞奈拉" }, { code: "KES", name: "肯亞先令" }, { code: "RON", name: "羅馬尼亞列伊" },
  { code: "BGN", name: "保加利亞列弗" }, { code: "ISK", name: "冰島克朗" }, { code: "UAH", name: "烏克蘭赫夫納" },
  { code: "DOP", name: "多明尼加披索" }, { code: "CRC", name: "哥斯大黎加科朗" }, { code: "VES", name: "委內瑞拉主權玻利瓦" },
];
// All validated as USD/XXX direct Yahoo instruments. Cross-pairs among these 24 (and against the
// existing 33-currency set) were NOT enumerated this round — C(57,2) would be ~1,600 combinations,
// well beyond a single targeted-validation pass. Left as Step 11 (recurring discovery) follow-up.
export const DISCOVERED_PAIRS: Array<{ base: string; quote: string }> = DISCOVERED_CURRENCIES.map((c) => ({ base: "USD", quote: c.code }));

export const canonicalPairId = (base: string, quote: string) => `${base}${quote}`; // e.g. "USDTWD" (URL-safe, no "/")
export const displayPair = (base: string, quote: string) => `${base}/${quote}`;
export const yahooFxSymbol = (base: string, quote: string) => `${base}${quote}=X`;

export type FxSeedResult = { currencies: number; pairs: number; aliases: number };

async function upsertCurrencyAndPair(p: { base: string; quote: string }) {
  const symbol = canonicalPairId(p.base, p.quote);
  const providerSymbol = yahooFxSymbol(p.base, p.quote);
  const usdCross = p.base === "USD" || p.quote === "USD";
  await prisma.fxPair.upsert({
    where: { symbol },
    create: { symbol, baseCurrency: p.base, quoteCurrency: p.quote, classification: usdCross ? "USD_MAJOR" : "CROSS", providerSymbol, displayPair: displayPair(p.base, p.quote), usdCross, active: true },
    update: { providerSymbol, displayPair: displayPair(p.base, p.quote), active: true },
  });
  // Reuse the pre-existing "YAHOO_CHART" provider convention (found live in fx_pair_aliases: rows
  // already exist for majors, created 2026-08, EXACT_BASE_QUOTE mapping, same "BASEQUOTE=X" format)
  // instead of inventing a second provider tag for the same identity.
  await prisma.fxPairAlias.upsert({
    where: { provider_providerSymbol: { provider: "YAHOO_CHART", providerSymbol } },
    create: { pairSymbol: symbol, provider: "YAHOO_CHART", providerSymbol, mappingMethod: "EXACT_BASE_QUOTE", invertedAlias: false, source: "TARGETED_VALIDATION_SPARK_POC_2026_09_12", verifiedAt: new Date() },
    update: { pairSymbol: symbol, verifiedAt: new Date() },
  });
  return symbol;
}

// Idempotent upsert — safe to rerun. Does not touch fx_forward_* (out of scope, Step 19).
export async function seedFxUniverse(): Promise<FxSeedResult> {
  let currencies = 0, pairs = 0, aliases = 0;
  for (const c of FX_CURRENCIES) {
    await prisma.fxCurrency.upsert({ where: { code: c.code }, create: { code: c.code, name: c.name, kind: "FIAT", active: true }, update: { name: c.name, active: true } });
    currencies++;
  }
  for (const p of FX_PAIRS) { await upsertCurrencyAndPair(p); pairs++; aliases++; }
  return { currencies, pairs, aliases };
}

export type FxUniverseCoverageResult = { newCurrencies: number; newPairs: number; markedValid: number; markedInvalid: number };

// Full-universe activation (Step 5-7): (a) adds the 24 newly discovered currencies/pairs on top of
// the existing 33-currency / 528-pair legacy set (never removing or rewriting legacy rows), then
// (b) tags EVERY pair (legacy + new) with a fx_coverage row (capability="YAHOO_DIRECT") recording
// whether Yahoo actually serves it directly — this is what lib/cron/fxUpdate.ts now reads instead
// of a hard-coded symbol list. validationResults keys by pairSymbol (base+quote canonical id).
export async function activateFullYahooDirectUniverse(
  validationResults: Record<string, { ok: boolean; canonicalSymbol: string | null }>,
): Promise<FxUniverseCoverageResult> {
  let newCurrencies = 0, newPairs = 0;
  for (const c of DISCOVERED_CURRENCIES) {
    await prisma.fxCurrency.upsert({ where: { code: c.code }, create: { code: c.code, name: c.name, kind: "FIAT", active: true }, update: { name: c.name, active: true } });
    newCurrencies++;
  }
  for (const p of DISCOVERED_PAIRS) { await upsertCurrencyAndPair(p); newPairs++; }

  let markedValid = 0, markedInvalid = 0;
  const entries = Object.entries(validationResults);
  for (const [pairSymbol, r] of entries) {
    const status = r.ok ? "VALID" : "INVALID";
    await prisma.fxCoverage.upsert({
      where: { pairSymbol_capability_interval: { pairSymbol, capability: "YAHOO_DIRECT", interval: "" } },
      create: { pairSymbol, capability: "YAHOO_DIRECT", interval: "", status, provider: "YAHOO_CHART", qualityStatus: r.ok ? "OK" : "NO_DIRECT_DATA", details: { canonicalSymbol: r.canonicalSymbol } },
      update: { status, qualityStatus: r.ok ? "OK" : "NO_DIRECT_DATA", details: { canonicalSymbol: r.canonicalSymbol }, checkedAt: new Date() },
    });
    if (r.ok) markedValid++; else markedInvalid++;
  }
  return { newCurrencies, newPairs, markedValid, markedInvalid };
}

// Production scope (Step 7): every fx_pair that is active AND has a fx_coverage
// (capability="YAHOO_DIRECT", status="VALID") row. No hard-coded symbol list.
export async function getActiveYahooDirectPairSymbols(): Promise<string[]> {
  const rows = await prisma.fxCoverage.findMany({ where: { capability: "YAHOO_DIRECT", status: "VALID" }, select: { pairSymbol: true } });
  const validSet = new Set(rows.map((r) => r.pairSymbol));
  if (validSet.size === 0) return [];
  const active = await prisma.fxPair.findMany({ where: { active: true, symbol: { in: [...validSet] } }, select: { symbol: true }, orderBy: { symbol: "asc" } });
  return active.map((a) => a.symbol);
}
