// MoneyDJ ETF disclosed-holdings fetch + persist.
//
// Minimal reusable extraction of scripts/data/etf-moneydj/run-etf-moneydj-holdings-bounded.ts
// (that file is a CLI `main()` bound to argv + a local Prisma client, with no exported parser).
// The moneydjId builder, the Basic0007 URL, the cheerio parse (個股名稱 + 投資比例 table,
// 資料日期：YYYY/MM/DD), the snapshot/row upsert shape, the source string, and the parser
// version are reproduced here verbatim. KEEP IN SYNC with that file.

import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { PrismaClient } from "@prisma/client";

export const MONEYDJ_ETF_SOURCE = "MONEYDJ_ETF_PUBLIC";
export const MONEYDJ_ETF_PARSER_VERSION = "moneydj-basic0007-v1";

export type MoneydjEtfMapping = { code: string; exchange: string | null; dataSource: string | null };
export type MoneydjEtfHolding = {
  securityName: string;
  rawSymbol: string | null;
  weight: number;
  shares: number | null;
  effectiveDate: string; // YYYY-MM-DD
};
export type MoneydjEtfHoldings = {
  moneydjId: string;
  sourceUrl: string;
  checksum: string;
  holdingsDate: string; // YYYY-MM-DD (資料日期)
  holdings: MoneydjEtfHolding[];
};

export class MoneydjEtfHttpError extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number) {
    super(`MONEYDJ_ETF_HTTP_${httpStatus}`);
    this.name = "MoneydjEtfHttpError";
    this.httpStatus = httpStatus;
  }
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const num = (s: string): number | null => {
  const n = Number(String(s ?? "").replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function buildMoneydjEtfId(mapping: MoneydjEtfMapping): string {
  const { code, exchange, dataSource } = mapping;
  if (exchange === "TWSE") return `${code}.TW`;
  if (exchange === "TPEx" || exchange === "TPEX") return `${code}.TWO`;
  if (dataSource && /^[A-Za-z0-9.^=-]+$/.test(dataSource)) return dataSource;
  return code;
}

export function moneydjEtfUrl(moneydjId: string): string {
  return `https://www.moneydj.com/ETF/X/Basic/Basic0007.xdjhtm?etfid=${encodeURIComponent(moneydjId)}`;
}

// Parse contract — verbatim from run-etf-moneydj-holdings-bounded.ts `parse()`.
function parseHtml(html: string): { asOfDate: string; rows: MoneydjEtfHolding[] } | null {
  const $ = load(html);
  let table: unknown = null;
  $("table").each((_, t) => {
    const h = clean($(t).find("tr").first().text());
    if (/個股名稱/.test(h) && /投資比例/.test(h)) table = t;
  });
  if (!table) return null;
  const el = table as Parameters<typeof $>[0];
  const context = clean(
    $(el as never).prevAll().slice(0, 8).text() + " " + $(el as never).parent().prevAll().slice(0, 5).text(),
  );
  const matches = [...context.matchAll(/資料日期[：:]\s*(20\d{2})\/(\d{2})\/(\d{2})/g)];
  const m = matches.at(-1);
  if (!m) return null;
  const asOfDate = `${m[1]}-${m[2]}-${m[3]}`;
  const rows: MoneydjEtfHolding[] = [];
  $(el as never)
    .find("tr")
    .slice(1)
    .each((_, tr) => {
      const c = $(tr)
        .find("th,td")
        .map((__, x) => clean($(x).text()))
        .get();
      if (c.length < 2) return;
      const weight = num(c[1]);
      if (weight == null) return;
      const sm = c[0].match(/\(([^()]+)\)\s*$/);
      rows.push({
        securityName: clean(c[0].replace(/\([^()]+\)\s*$/, "")),
        rawSymbol: sm?.[1] ?? null,
        weight,
        shares: num(c[2] ?? ""),
        effectiveDate: asOfDate,
      });
    });
  return rows.length ? { asOfDate, rows } : null;
}

export async function fetchMoneydjEtfHoldings(mapping: MoneydjEtfMapping): Promise<MoneydjEtfHoldings> {
  const moneydjId = buildMoneydjEtfId(mapping);
  const sourceUrl = moneydjEtfUrl(moneydjId);
  const response = await fetch(sourceUrl, {
    headers: { "user-agent": "Mozilla/5.0 SmartFund Holdings MVP/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 403 || response.status === 429) throw new MoneydjEtfHttpError(response.status);
  if (!response.ok) throw new Error(`MONEYDJ_ETF_HTTP_${response.status}`);
  const html = await response.text();
  const parsed = parseHtml(html);
  if (!parsed) throw new Error("HOLDINGS_UNAVAILABLE");
  const checksum = createHash("sha256").update(html).digest("hex");
  return { moneydjId, sourceUrl, checksum, holdingsDate: parsed.asOfDate, holdings: parsed.rows };
}

/**
 * Idempotent persist, keyed on the SEMANTIC identity (etfId, effectiveDate, MONEYDJ_ETF_SOURCE) —
 * a re-run for the same ETF + holdings month reuses the existing snapshot and upserts its rows, so
 * it never piles up duplicate snapshots even when the page bytes (and therefore the checksum) drift.
 * This is stricter than the legacy CLI runner, which keys on (etfId, effectiveDate, sourceUrl,
 * checksum) and would create a fresh snapshot per re-fetch. Never deletes prior snapshots/rows.
 */
export async function persistMoneydjEtfHoldings(
  prisma: PrismaClient,
  input: { etfId: string; data: MoneydjEtfHoldings },
): Promise<{ snapshotId: string; rowsWritten: number; reusedSnapshot: boolean }> {
  const { etfId, data } = input;
  const effectiveDate = new Date(`${data.holdingsDate}T00:00:00Z`);
  const newId = () => globalThis.crypto.randomUUID();

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.etfHoldingSnapshot.findFirst({
        where: { etfId, effectiveDate, source: MONEYDJ_ETF_SOURCE },
        select: { id: true },
        orderBy: { retrievedAt: "desc" },
      });
      let snapshot: { id: string };
      let reusedSnapshot = false;
      if (existing) {
        reusedSnapshot = true;
        snapshot = await tx.etfHoldingSnapshot.update({
          where: { id: existing.id },
          data: {
            retrievedAt: new Date(),
            sourceUrl: data.sourceUrl,
            checksum: data.checksum,
            sourceRowCount: data.holdings.length,
            parsedRowCount: data.holdings.length,
            canonicalRowCount: data.holdings.length,
          },
          select: { id: true },
        });
      } else {
        snapshot = await tx.etfHoldingSnapshot.create({
          data: {
            id: newId(),
            etfId,
            effectiveDate,
            source: MONEYDJ_ETF_SOURCE,
            sourceType: "PUBLIC_DATA_PROVIDER",
            sourceUrl: data.sourceUrl,
            retrievedAt: new Date(),
            checksum: data.checksum,
            sourceRowCount: data.holdings.length,
            parsedRowCount: data.holdings.length,
            canonicalRowCount: data.holdings.length,
            verificationStatus: "SOURCE_PARSED",
            licenseStatus: "PUBLIC_TERMS_REVIEW_REQUIRED",
            completenessStatus: "TOP_HOLDINGS_ONLY",
            qualityStatus: "PASS",
            parserVersion: MONEYDJ_ETF_PARSER_VERSION,
            archiveLineage: { provider: "MoneyDJ", moneydjId: data.moneydjId },
          },
          select: { id: true },
        });
      }
      const currentRowIds = data.holdings.map((row, i) => `${i + 1}:${row.rawSymbol ?? row.securityName}`);
      // When reusing a snapshot, drop rows that are no longer in the current parse so the row set
      // stays exactly the current holdings (no accumulation across re-fetches of a mutated page).
      if (reusedSnapshot) {
        await tx.etfHoldingRow.deleteMany({
          where: { snapshotId: snapshot.id, sourceRowId: { notIn: currentRowIds } },
        });
      }
      let rowsWritten = 0;
      for (const [i, row] of data.holdings.entries()) {
        const sourceRowId = currentRowIds[i];
        await tx.etfHoldingRow.upsert({
          where: { snapshotId_sourceRowId: { snapshotId: snapshot.id, sourceRowId } },
          create: {
            id: newId(),
            snapshotId: snapshot.id,
            etfId,
            effectiveDate,
            holdingType: "SECURITY",
            holdingName: row.securityName,
            ticker: row.rawSymbol,
            quantity: row.shares,
            weight: row.weight,
            sourceRowId,
            verificationStatus: "SOURCE_PARSED",
            qualityStatus: "PASS",
            rawRow: row,
          },
          update: {
            holdingName: row.securityName,
            ticker: row.rawSymbol,
            quantity: row.shares,
            weight: row.weight,
            rawRow: row,
          },
        });
        rowsWritten++;
      }
      return { snapshotId: snapshot.id, rowsWritten, reusedSnapshot };
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}
