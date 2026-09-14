// Global (official issuer) ETF holdings — fetch + persist.
//
// Minimal reusable extraction of scripts/data/etf-holdings/run-ishares-holdings.ts (a CLI main()
// bound to argv, local Prisma, and runtime/*.json staging). The iShares latest-holdings.csv URL
// set, the CSV parser, the `securities` match, and the `holdings` (asset_type='ETF') write —
// DELETE-and-replace keyed on (etf_id, as_of_date) — are reproduced verbatim. KEEP IN SYNC.
//
// BlackRock and iShares are one issuer sharing the iShares latest-holdings.csv feed; the production
// source string on the `holdings` table is BLACKROCK_OFFICIAL_CSV for the whole feed. The
// etf_holding_snapshots path in the CLI never landed data for this source (migration-gated), so the
// cloud worker writes only to `holdings` — the path that is actually live in production.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

export const ISHARES_HOLDINGS_SOURCE = "BLACKROCK_OFFICIAL_CSV";
export const ISHARES_WEIGHT_METHOD = "ISSUER_REPORTED";
export const GLOBAL_ETF_PROVIDERS = ["ISHARES", "BLACKROCK", "ALL"] as const;
export type GlobalEtfProvider = (typeof GLOBAL_ETF_PROVIDERS)[number];

export type IsharesProduct = { code: string; sourceUrl: string };

export class GlobalEtfHttpError extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number) {
    super(`GLOBAL_ETF_HTTP_${httpStatus}`);
    this.name = "GlobalEtfHttpError";
    this.httpStatus = httpStatus;
  }
}

// ---- iShares product universe: config file + the proven representative cohort ----
let cachedProducts: IsharesProduct[] | null = null;
export function getIsharesUniverse(): IsharesProduct[] {
  if (cachedProducts) return cachedProducts;
  const representative: IsharesProduct[] = [
    { code: "IVV", sourceUrl: "https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv" },
    { code: "IWM", sourceUrl: "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/latest-holdings.csv" },
  ];
  let configured: IsharesProduct[] = [];
  try {
    const registry = JSON.parse(
      readFileSync(path.join(process.cwd(), "config", "ishares-bond-etf-products.json"), "utf8"),
    );
    if (Array.isArray(registry.products)) {
      configured = registry.products
        .filter((p: unknown): p is IsharesProduct => Boolean((p as IsharesProduct)?.code && (p as IsharesProduct)?.sourceUrl))
        .map((p: IsharesProduct) => ({ code: String(p.code).toUpperCase(), sourceUrl: p.sourceUrl }));
    }
  } catch {
    /* config optional */
  }
  const byCode = new Map<string, IsharesProduct>();
  for (const p of [...representative, ...configured]) byCode.set(p.code.toUpperCase(), { ...p, code: p.code.toUpperCase() });
  cachedProducts = [...byCode.values()];
  return cachedProducts;
}

// ---- CSV parse (verbatim from run-ishares-holdings.ts) ----
function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  const expression = /(?:^|,)("(?:[^"]|"")*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(line))) cells.push(match[1].startsWith('"') ? match[1].slice(1, -1).replaceAll('""', '"') : match[1]);
  return cells;
}
const numeric = (value: string | undefined): number | null => {
  const cleaned = (value ?? "").replaceAll(",", "").replaceAll("%", "").trim();
  return cleaned && cleaned !== "-" && Number.isFinite(Number(cleaned)) ? Number(cleaned) : null;
};
const holdingType = (assetClass: string, name: string): string => {
  const value = `${assetClass} ${name}`.toUpperCase();
  if (/CASH|CURRENCY|MONEY MARKET/.test(value)) return "CASH";
  if (/BOND|FIXED INCOME|TREASURY|NOTE/.test(value)) return "BOND";
  if (/FUTURE/.test(value)) return "FUTURE";
  if (/OPTION/.test(value)) return "OPTION";
  if (/SWAP/.test(value)) return "SWAP";
  if (/FORWARD/.test(value)) return "FX_FORWARD";
  if (/EQUITY|STOCK/.test(value)) return "EQUITY";
  return "OTHER";
};
const safeKey = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);

export type IsharesHoldingRow = {
  rank: number;
  holdingType: string;
  ticker: string | null;
  name: string;
  isin: string | null;
  cusip: string | null;
  sedol: string | null;
  sector: string | null;
  assetClass: string;
  weight: number | null;
  quantity: number | null;
  price: number | null;
  marketValue: number | null;
  notional: number | null;
  exchange: string | null;
  country: string | null;
  currency: string | null;
};
export type IsharesHoldings = { code: string; sourceUrl: string; asOfIso: string; checksum: string; rows: IsharesHoldingRow[] };

export async function fetchIsharesHoldings(product: IsharesProduct): Promise<IsharesHoldings> {
  const response = await fetch(product.sourceUrl, {
    redirect: "follow",
    headers: { "user-agent": "SmartFund-ETF-Holdings/2.1", accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 403 || response.status === 429) throw new GlobalEtfHttpError(response.status);
  if (!response.ok) throw new Error(`GLOBAL_ETF_HTTP_${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const checksum = createHash("sha256").update(body).digest("hex");
  const text = body.toString("utf8").replace(/^﻿/, "");
  if (!text.startsWith("iShares ")) throw new Error(`ISHARES_NOT_CSV:${product.code}`);
  const lines = text.split(/\r?\n/);
  const asOfRaw = parseCsvRow(lines.find((line) => line.startsWith("Fund Holdings as of,")) ?? "")[1];
  const headerIndex = lines.findIndex(
    (line) => line.startsWith("Ticker,Name,Sector,Asset Class,") || line.startsWith("Name,Sector,Asset Class,"),
  );
  if (!asOfRaw || headerIndex < 0) throw new Error("ISHARES_CSV_INVALID");
  const asOfIso = new Date(`${asOfRaw} 12:00:00 UTC`).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfIso)) throw new Error("ISHARES_CSV_ASOF_UNPARSEABLE");
  const header = parseCsvRow(lines[headerIndex]);
  const column = (name: string) => header.indexOf(name);
  const sourceRows = lines
    .slice(headerIndex + 1)
    .filter(Boolean)
    .map(parseCsvRow)
    .filter((row) => row.length >= header.length && Boolean(row[column("Name")] || row[column("Ticker")]));
  const rows: IsharesHoldingRow[] = sourceRows.map((row, rank) => {
    const ticker = row[column("Ticker")] || null;
    const name = row[column("Name")] || ticker || "UNKNOWN HOLDING";
    const assetClass = row[column("Asset Class")] || "Other";
    return {
      rank: rank + 1,
      holdingType: holdingType(assetClass, name),
      ticker,
      name,
      isin: column("ISIN") >= 0 ? row[column("ISIN")] || null : null,
      cusip: column("CUSIP") >= 0 ? row[column("CUSIP")] || null : null,
      sedol: column("SEDOL") >= 0 ? row[column("SEDOL")] || null : null,
      sector: row[column("Sector")] || null,
      assetClass,
      weight: numeric(row[column("Weight (%)")]),
      quantity: numeric(row[column("Quantity")]) ?? numeric(row[column("Par Value")]),
      price: numeric(row[column("Price")]),
      marketValue: numeric(row[column("Market Value")]),
      notional: numeric(row[column("Notional Value")]),
      exchange: row[column("Exchange")] || null,
      country: row[column("Location")] || null,
      currency: row[column("Currency")] || row[column("Market Currency")] || null,
    };
  });
  if (!rows.length) throw new Error("ISHARES_CSV_NO_ROWS");
  return { code: product.code, sourceUrl: product.sourceUrl, asOfIso, checksum, rows };
}

/**
 * Persist into `holdings` (asset_type='ETF') for one ETF + as-of date, exactly as
 * run-ishares-holdings.ts does: DELETE the (etf_id, as_of_date) slice then re-INSERT. This is
 * inherently semantic-date idempotent — a re-run for the same date yields the same row count and
 * never accumulates. Older-dated slices are left intact (point-in-time history). Read-back verified.
 * Security mapping is best-effort (exact isin/cusip/sedol, or ticker+exchange with a single match);
 * a mapping miss leaves security_id NULL and never fails the ETF.
 */
export async function persistIsharesHoldings(
  prisma: PrismaClient,
  input: { etfId: string; assetId: string | null; data: IsharesHoldings },
): Promise<{ written: number; matched: number; unmatched: number }> {
  const { etfId, assetId, data } = input;
  const reportDate = `${data.asOfIso}`;

  const tickers = [...new Set(data.rows.flatMap((r) => (r.ticker ? [r.ticker.toUpperCase()] : [])))];
  const isins = data.rows.flatMap((r) => (r.isin ? [r.isin] : []));
  const cusips = data.rows.flatMap((r) => (r.cusip ? [r.cusip] : []));
  const sedols = data.rows.flatMap((r) => (r.sedol ? [r.sedol] : []));
  const candidates =
    tickers.length || isins.length || cusips.length || sedols.length
      ? await prisma.$queryRawUnsafe<
          Array<{ id: string; ticker: string | null; exchange: string | null; isin: string | null; cusip: string | null; sedol: string | null }>
        >(
          `SELECT id, ticker, exchange, isin, cusip, sedol FROM securities
            WHERE UPPER(ticker) = ANY($1::text[]) OR isin = ANY($2::text[]) OR cusip = ANY($3::text[]) OR sedol = ANY($4::text[])`,
          tickers,
          isins,
          cusips,
          sedols,
        )
      : [];

  let matched = 0;
  const records = data.rows.map((row) => {
    const hits = candidates.filter(
      (s) =>
        (row.isin && s.isin === row.isin) ||
        (row.cusip && s.cusip === row.cusip) ||
        (row.sedol && s.sedol === row.sedol) ||
        (row.ticker && row.exchange && s.ticker?.toUpperCase() === row.ticker.toUpperCase() && s.exchange === row.exchange),
    );
    const security = hits.length === 1 ? hits[0] : null;
    if (security) matched++;
    return {
      id: randomUUID(),
      rank: row.rank,
      holding_name: row.name,
      holding_code: row.ticker,
      ticker: row.ticker,
      isin: row.isin,
      cusip: row.cusip,
      weight: row.weight ?? 0,
      sector: row.sector,
      country: row.country,
      asset_id: assetId,
      security_id: security?.id ?? null,
      shares: row.quantity,
      market_value: row.marketValue,
      currency: row.currency,
      source: ISHARES_HOLDINGS_SOURCE,
      source_record_id: `${data.code}:${data.asOfIso}:${row.rank}:${safeKey(row.ticker || row.name)}`,
      weight_method: ISHARES_WEIGHT_METHOD,
    };
  });

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM holdings WHERE etf_id = $1 AND as_of_date = $2::date AND asset_type = 'ETF' AND source = $3`,
      etfId,
      reportDate,
      ISHARES_HOLDINGS_SOURCE,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO holdings
         (id, asset_type, etf_id, as_of_date, rank, holding_name, holding_code, ticker, isin, cusip, weight,
          sector, country, asset_id, security_id, shares, market_value, currency, source, source_record_id, weight_method, created_at)
       SELECT x.id, 'ETF', $1, $2::date, x.rank, x.holding_name, x.holding_code, x.ticker, x.isin, x.cusip, x.weight,
              x.sector, x.country, x.asset_id, x.security_id, x.shares, x.market_value, x.currency, x.source, x.source_record_id, x.weight_method, NOW()
       FROM jsonb_to_recordset($3::jsonb) AS x(
         id text, rank int, holding_name text, holding_code text, ticker text, isin text, cusip text, weight numeric,
         sector text, country text, asset_id text, security_id text, shares numeric, market_value numeric, currency text,
         source text, source_record_id text, weight_method text)`,
      etfId,
      reportDate,
      JSON.stringify(records),
    );
  });

  const readBack = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint count FROM holdings WHERE etf_id = $1 AND as_of_date = $2::date AND asset_type = 'ETF' AND source = $3`,
    etfId,
    reportDate,
    ISHARES_HOLDINGS_SOURCE,
  );
  const written = Number(readBack[0]?.count ?? 0);
  if (written !== data.rows.length) throw new Error(`ISHARES_READ_BACK_FAILED:${written}/${data.rows.length}`);
  return { written, matched, unmatched: data.rows.length - matched };
}
