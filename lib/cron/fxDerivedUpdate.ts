// FX derived-cross cloud updater — Yahoo-direct-over-derived, DB-only, zero external requests.
//
// Ports the exact 2-leg triangulation algorithm already proven in
// scripts/data/fx/run-derived-cross-rates.ts (the Windows-local legacy derived writer, left running
// as-is — this is a NEW cloud copy of its math, not a replacement of that script's own process).
// Same anchor list, same "asOf = MIN(leg1.quotedAt, leg2.quotedAt)" rule, same "never overwrite a
// row a direct source owns" guard. Two things added that the legacy version didn't have:
//   1. An explicit forward-only stale guard on quotedAt (legacy's SQL upsert had no such check).
//   2. An application-level check that a target's existing fx_latest_quotes row is DERIVED_CROSS_RATE
//      before touching it (legacy relied on a SQL "... DO UPDATE ... WHERE source = $2" clause with
//      the same effect; this is the same guarantee, just enforced in JS before the write).
//
// Input: fx_latest_quotes rows NOT sourced DERIVED_CROSS_RATE, joined to fx_pairs for base/quote
// currency, within a 4-day freshness window (same window as the legacy script's `inputs()`).
// Output: fx_latest_quotes upserts, source=DERIVED_CROSS_RATE, for pairs NOT in the
// fx_coverage(YAHOO_DIRECT, VALID) set (Step 3: direct always wins, derive only what direct can't
// cover). No Yahoo calls — the whole computation is a DB read + arithmetic + DB write.

import { prisma } from "@/lib/prisma";
import { getActiveYahooDirectPairSymbols } from "@/lib/cloud-ingestion/fxUniverse";

const SOURCE = "DERIVED_CROSS_RATE";
const FORMULA_VERSION = "FX_CROSS_2LEG_V1"; // matches legacy VERSION constant verbatim
const ANCHORS = ["USD", "EUR", "JPY", "GBP", "CHF", "AUD", "CAD", "CNY", "CNH"]; // ported verbatim
const FRESHNESS_WINDOW_MS = 4 * 24 * 60 * 60 * 1000; // 4 days, matches legacy inputs()
const ALIGNMENT_TOLERANCE_MS = 6 * 60 * 60 * 1000; // 6h, matches legacy route()

type PairIdentity = { symbol: string; baseCurrency: string; quoteCurrency: string };
type SourceQuote = { pairSymbol: string; baseCurrency: string; quoteCurrency: string; mid: number; quotedAt: Date };
type Leg = { pair: string; invert: boolean; value: number; at: Date };
export type FxRoute = { target: PairIdentity; anchor: string; leg1: Leg; leg2: Leg; value: number; asOf: Date };

function edge(quotes: SourceQuote[], a: string, b: string): Leg | undefined {
  const q = quotes.find((x) => (x.baseCurrency === a && x.quoteCurrency === b) || (x.baseCurrency === b && x.quoteCurrency === a));
  if (!q || !(q.mid > 0 && Number.isFinite(q.mid))) return undefined;
  return { pair: q.pairSymbol, invert: q.baseCurrency !== a, value: q.baseCurrency === a ? q.mid : 1 / q.mid, at: q.quotedAt };
}

// A/B = (A/anchor) / (B/anchor), picking whichever anchor gives the two closest-in-time legs.
export function findRoute(target: PairIdentity, quotes: SourceQuote[]): FxRoute | undefined {
  const candidates = [...new Set([...ANCHORS, ...quotes.flatMap((q) => [q.baseCurrency, q.quoteCurrency])])].filter(
    (c) => c !== target.baseCurrency && c !== target.quoteCurrency,
  );
  let best: FxRoute | undefined;
  let bestDiff = Infinity;
  for (const anchor of candidates) {
    const leg1 = edge(quotes, target.baseCurrency, anchor);
    const leg2 = edge(quotes, target.quoteCurrency, anchor);
    if (!leg1 || !leg2) continue;
    const diff = Math.abs(leg1.at.getTime() - leg2.at.getTime());
    if (diff > ALIGNMENT_TOLERANCE_MS) continue;
    const value = leg1.value / leg2.value;
    if (!(value > 0 && Number.isFinite(value))) continue;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { target, anchor, leg1, leg2, value, asOf: new Date(Math.min(leg1.at.getTime(), leg2.at.getTime())) };
    }
  }
  return best;
}

async function loadSourceQuotes(pairsBySymbol: Map<string, PairIdentity>): Promise<SourceQuote[]> {
  const rows = await prisma.fxLatestQuote.findMany({
    where: { source: { not: SOURCE }, mid: { gt: 0 }, quotedAt: { gte: new Date(Date.now() - FRESHNESS_WINDOW_MS) } },
    select: { pairSymbol: true, mid: true, quotedAt: true },
  });
  const out: SourceQuote[] = [];
  for (const r of rows) {
    const p = pairsBySymbol.get(r.pairSymbol);
    if (!p) continue;
    out.push({ pairSymbol: r.pairSymbol, baseCurrency: p.baseCurrency, quoteCurrency: p.quoteCurrency, mid: Number(r.mid), quotedAt: r.quotedAt });
  }
  return out;
}

export type FxDerivedResult = {
  targetPairs: number;
  updated: number;
  staleSkipped: number;
  noNewData: number;
  skippedNoRoute: number;
  skippedDirectRowExists: number;
};

// Runs over ALL 162 derived-only pairs in one DB-only pass — no per-pair scheduler, no Yahoo calls.
export async function updateDerivedFxQuotes(): Promise<FxDerivedResult> {
  const directSymbols = new Set(await getActiveYahooDirectPairSymbols());
  const allPairs = await prisma.fxPair.findMany({ where: { active: true }, select: { symbol: true, baseCurrency: true, quoteCurrency: true } });
  const pairsBySymbol = new Map(allPairs.map((p) => [p.symbol, p]));
  // Step 3: direct always wins — never derive a pair fx_coverage already marks YAHOO_DIRECT/VALID.
  const targets = allPairs.filter((p) => !directSymbols.has(p.symbol));

  const quotes = await loadSourceQuotes(pairsBySymbol);
  const existing = await prisma.fxLatestQuote.findMany({ where: { pairSymbol: { in: targets.map((t) => t.symbol) } }, select: { pairSymbol: true, source: true, quotedAt: true } });
  const existingByPair = new Map(existing.map((e) => [e.pairSymbol, e]));

  let updated = 0, staleSkipped = 0, noNewData = 0, skippedNoRoute = 0, skippedDirectRowExists = 0;
  for (const target of targets) {
    const r = findRoute(target, quotes);
    if (!r) { skippedNoRoute++; continue; } // missing/stale/invalid/zero leg -> skip, never fabricate
    const ex = existingByPair.get(target.symbol);
    // Direct-over-derived guard: a direct writer's row is never touched by the derived updater.
    if (ex && ex.source !== SOURCE) { skippedDirectRowExists++; continue; }
    if (ex) {
      // Step 5: forward-only. asOf can never regress vs. what's already stored.
      if (r.asOf.getTime() < ex.quotedAt.getTime()) { staleSkipped++; continue; }
      if (r.asOf.getTime() === ex.quotedAt.getTime()) { noNewData++; continue; }
    }
    await prisma.fxLatestQuote.upsert({
      where: { pairSymbol: target.symbol },
      create: { pairSymbol: target.symbol, mid: r.value, source: SOURCE, quotedAt: r.asOf, metadata: { anchor: r.anchor, leg1Pair: r.leg1.pair, leg2Pair: r.leg2.pair, formulaVersion: FORMULA_VERSION, directOrDerived: "DERIVED" } },
      update: { mid: r.value, source: SOURCE, quotedAt: r.asOf, ingestedAt: new Date(), metadata: { anchor: r.anchor, leg1Pair: r.leg1.pair, leg2Pair: r.leg2.pair, formulaVersion: FORMULA_VERSION, directOrDerived: "DERIVED" } },
    });
    updated++;
  }

  return { targetPairs: targets.length, updated, staleSkipped, noNewData, skippedNoRoute, skippedDirectRowExists };
}

// Used by the weekly discovery pass to decide whether a pair that just lost YAHOO_DIRECT coverage
// is still quotable at all (via derivation) before ever considering it for active=false.
export async function pairHasViableDerivedRoute(target: PairIdentity): Promise<boolean> {
  const allPairs = await prisma.fxPair.findMany({ where: { active: true }, select: { symbol: true, baseCurrency: true, quoteCurrency: true } });
  const pairsBySymbol = new Map(allPairs.map((p) => [p.symbol, p]));
  const quotes = await loadSourceQuotes(pairsBySymbol);
  return !!findRoute(target, quotes);
}
