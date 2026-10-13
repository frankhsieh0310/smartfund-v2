// Fund NAV — provider registry + persistence for the cloud worker.
//
// SITCA (中華民國證券投資信託暨顧問商業同業公會) official daily NAV CSV is the one cloud-ready,
// mass-coverage source: a single fetch of https://www.sitca.org.tw/MemberK0000/F/03/nav.csv, parsed
// by the existing adapter (scripts/data/global-fund/adapters/sitca-fsc-nav.ts). Records join to
// `funds` by an EXACT NFKC + whitespace-normalized `基金名稱` == `funds.name` with a single active
// fund (not fuzzy — ambiguous / unmatched names are skipped and counted).
//
// Yahoo fund: fund_provider_mappings.provider='yahoo' provider_code values are Morningstar secIds
// (F00001...), not Yahoo symbols — yahoo-finance2 .quote() returns quoteType UNKNOWN for all. Not
// usable without a real Yahoo-symbol mapping. FundClear: no ingestion parser/scheduler exists in the
// repo (the 4,140 rows were a one-time 2026-07-24 bulk import). Both are deferred.

import { randomUUID } from "node:crypto";
import Papa from "papaparse";
import type { PrismaClient } from "@prisma/client";

export const FUND_NAV_PROVIDERS = ["SITCA", "YAHOO", "FUNDCLEAR", "ALL"] as const;
export type FundNavProvider = (typeof FUND_NAV_PROVIDERS)[number];

// Verbatim from scripts/data/global-fund/adapters/sitca-fsc-nav.ts (that tree is excluded from the
// Next build via tsconfig "scripts/**"). KEEP IN SYNC.
export const SITCA_FSC_NAV_SOURCE = "SITCA_FSC_OFFICIAL_DAILY_NAV_CSV";
export const SITCA_FSC_NAV_URL = "https://www.sitca.org.tw/MemberK0000/F/03/nav.csv";

export type SitcaFundNavRecord = {
  source: typeof SITCA_FSC_NAV_SOURCE;
  sourceRecordId: string;
  code: string;
  name: string;
  company: string;
  currency: string;
  nav: string;
  navDate: Date;
};

function sitcaSourceRecordId(company: string, code: string, name: string): string {
  return `${company.trim()}|${code.trim()}|${name.trim().normalize("NFKC")}`;
}

export function parseSitcaFscNav(csv: string): SitcaFundNavRecord[] {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`SITCA_CSV_PARSE_ERROR:${parsed.errors[0]?.message}`);
  const records: SitcaFundNavRecord[] = [];
  for (const row of parsed.data) {
    const code = row["基金代號"]?.trim();
    const name = row["基金名稱"]?.trim();
    const nav = row["基金淨值"]?.trim();
    const rawDate = row["日期"]?.trim();
    const company = row["公司名稱"]?.trim();
    if (!code || !name || !nav || !rawDate || !company || name.toUpperCase().includes("ETF")) continue;
    if (!/^\d{8}$/.test(rawDate) || !Number.isFinite(Number(nav)) || Number(nav) <= 0) continue;
    records.push({
      source: SITCA_FSC_NAV_SOURCE,
      sourceRecordId: sitcaSourceRecordId(company, code, name),
      code,
      name,
      company,
      currency: row["幣別"]?.trim() || "TWD",
      nav,
      navDate: new Date(`${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}T00:00:00.000Z`),
    });
  }
  if (!records.length) throw new Error("SITCA_MUTUAL_FUND_NAV_RECORDS_NOT_FOUND");
  return records;
}

export const YAHOO_FUND_NAV_STATUS = {
  cloudReady: false,
  reason:
    "fund_provider_mappings.provider='yahoo' provider_code = Morningstar secIds (F00001…), not Yahoo symbols; " +
    "yahoo-finance2 quote() -> quoteType UNKNOWN for all sampled. Needs a real Yahoo-symbol mapping.",
};
export const FUNDCLEAR_STATUS = {
  recoverable: false,
  rootCause:
    "No FundClear NAV parser or scheduler in the repo. `last_nav_source='fundclear'` on 4,140 funds is a " +
    "single 2026-07-24 bulk import, never a maintained pipeline. Recovery needs a new parser (out of scope).",
};

export class FundNavHttpError extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number) {
    super(`FUND_NAV_HTTP_${httpStatus}`);
    this.name = "FundNavHttpError";
    this.httpStatus = httpStatus;
  }
}

/** Exact key for the SITCA name -> funds.name join. */
export function nfkcNameKey(name: string): string {
  return String(name ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

export async function fetchSitcaNavRecords(): Promise<SitcaFundNavRecord[]> {
  const response = await fetch(SITCA_FSC_NAV_URL, {
    headers: { "user-agent": "Mozilla/5.0 SmartFund NAV/1.0" },
    signal: AbortSignal.timeout(45_000),
  });
  if (response.status === 403 || response.status === 429) throw new FundNavHttpError(response.status);
  if (!response.ok) throw new Error(`FUND_NAV_HTTP_${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());
  let csv = buf.toString("utf8");
  if (!/基金代號|基金名稱/.test(csv)) csv = new TextDecoder("big5").decode(buf);
  return parseSitcaFscNav(csv);
}

/**
 * Newer-only NAV write. Upserts `fund_history` on (fund_id, date); moves funds.latest_nav* forward
 * ONLY when navDate is strictly after funds.latest_nav_date (or it is NULL). A same-date value from a
 * different source is NOT overwritten (deterministic: the incumbent stays until a strictly newer date
 * arrives). Returns { historyWritten, navMoved }.
 */
export async function persistFundNav(
  prisma: PrismaClient,
  input: { fundId: string; nav: number; navDate: string; currency: string | null; source: string },
): Promise<{ historyWritten: boolean; navMoved: boolean }> {
  const { fundId, nav, navDate, currency, source } = input;
  await prisma.$executeRawUnsafe(
    `INSERT INTO fund_history (id, fund_id, date, nav, created_at)
     VALUES ($1, $2, $3::date, $4, NOW())
     ON CONFLICT (fund_id, date) DO UPDATE SET nav = EXCLUDED.nav`,
    randomUUID(),
    fundId,
    navDate,
    nav,
  );
  const moved = await prisma.$executeRawUnsafe(
    `UPDATE funds
        SET latest_nav = $2,
            latest_nav_date = $3::date,
            nav_updated_at = NOW(),
            last_nav_source = $4,
            currency = COALESCE(currency, $5),
            updated_at = NOW()
      WHERE id = $1
        AND (latest_nav_date IS NULL OR latest_nav_date < $3::date)`,
    fundId,
    nav,
    navDate,
    source,
    currency,
  );
  return { historyWritten: true, navMoved: Number(moved) > 0 };
}
