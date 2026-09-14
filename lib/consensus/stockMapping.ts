// SmartMatch 共識雷達 — map an extracted symbol to a canonical stocks row (Phase K).
//
// A ticker like AAPL / AMD / 2330 exists on many exchanges in `stocks` (primary + cross-listings +
// unrelated foreign issuers sharing the code). Rules:
//   - prefer the primary US listing for US-context mentions (NASDAQ / NYSE / NYSE American),
//   - else prefer a row whose country matches the person's country hint,
//   - else prefer a company_name that actually matches the mentioned company,
//   - if still ambiguous -> stock_id = NULL, keep the raw symbol, DO NOT force a match.

import { prisma } from "@/lib/prisma";

const US_PRIMARY = new Set(["NASDAQ", "NYSE", "NYSE ARCA", "NYSEARCA", "NYSE AMERICAN", "AMEX", "BATS", "CBOE"]);

export type ResolvedStock = {
  symbol: string;
  stockId: string | null;
  exchange: string | null;
  companyName: string | null;
  ambiguous: boolean;
};

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9.]/g, "");

export async function resolveSymbol(
  rawSymbol: string,
  opts: { companyHint?: string | null; countryHint?: string | null } = {},
): Promise<ResolvedStock> {
  const symbol = norm(rawSymbol);
  if (!symbol) return { symbol: rawSymbol, stockId: null, exchange: null, companyName: null, ambiguous: true };

  // exact ticker OR exact yahoo_symbol
  const rows = await prisma.stock.findMany({
    where: {
      isActive: true,
      OR: [
        { ticker: { equals: symbol, mode: "insensitive" } },
        { yahooSymbol: { equals: symbol, mode: "insensitive" } },
        { yahooSymbol: { equals: `${symbol}`, mode: "insensitive" } },
      ],
    },
    select: { id: true, ticker: true, yahooSymbol: true, exchange: true, country: true, companyName: true },
    take: 40,
  });
  if (rows.length === 0) return { symbol, stockId: null, exchange: null, companyName: null, ambiguous: false };
  if (rows.length === 1) {
    const r = rows[0];
    return { symbol, stockId: r.id, exchange: r.exchange, companyName: r.companyName, ambiguous: false };
  }

  const company = (opts.companyHint ?? "").toLowerCase().replace(/\b(inc|corp|co|ltd|plc|sa|nv|ag|the|company|holdings?|group)\b/g, "").replace(/[^a-z0-9]/g, "");
  const country = (opts.countryHint ?? "").toUpperCase();

  const scored = rows
    .map((r) => {
      let score = 0;
      if (US_PRIMARY.has(r.exchange.toUpperCase())) score += 5;
      if (r.yahooSymbol.toUpperCase() === symbol) score += 3; // bare symbol == primary yahoo id
      if (country && r.country.toUpperCase() === country) score += 3;
      if (company && r.companyName.toLowerCase().replace(/[^a-z0-9]/g, "").includes(company.slice(0, 8))) score += 4;
      return { r, score };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const tie = scored[1] && scored[1].score === top.score;
  if (tie || top.score === 0) {
    return { symbol, stockId: null, exchange: null, companyName: null, ambiguous: true };
  }
  return { symbol, stockId: top.r.id, exchange: top.r.exchange, companyName: top.r.companyName, ambiguous: false };
}
