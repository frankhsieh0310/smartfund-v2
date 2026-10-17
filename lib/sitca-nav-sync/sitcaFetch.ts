// Task Z: a SEPARATE fetch+parse of the SITCA CSV, independent of lib/cloud-ingestion/fundNav.ts's
// own parseSitcaFscNav (which only extracts 基金代號, not 基金統編 — the field this pipeline's
// code-matching actually needs; VERIFIED live: 基金統編 == funds.code for 95.4% of rows, while
// 基金代號 and 受益憑證代號 are both different code spaces that don't match funds.code at all).
// Deliberately does not import or modify fundNav.ts / cloud-fund-nav — this is its own independent
// fetch, by design, so this new pipeline can never affect the existing one.
import Papa from "papaparse";
import type { SitcaRawRow } from "./matching";

export const SITCA_FSC_NAV_URL = "https://www.sitca.org.tw/MemberK0000/F/03/nav.csv";

export function parseSitcaCsv(csv: string): SitcaRawRow[] {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`SITCA_CSV_PARSE_ERROR:${parsed.errors[0]?.message}`);

  const rows: SitcaRawRow[] = [];
  for (const row of parsed.data) {
    const taxId = row["基金統編"]?.trim();
    const name = row["基金名稱"]?.trim();
    const navRaw = row["基金淨值"]?.trim();
    const rawDate = row["日期"]?.trim();
    const currency = row["幣別"]?.trim();
    const company = row["公司名稱"]?.trim() ?? "";
    if (!taxId || !name || !navRaw || !rawDate || !currency) continue;
    if (!/^\d{8}$/.test(rawDate)) continue;
    const nav = Number(navRaw);
    if (!Number.isFinite(nav) || nav <= 0) continue;
    rows.push({
      taxId, name, nav, currency, company,
      navDate: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`,
    });
  }
  if (!rows.length) throw new Error("SITCA_NAV_ROWS_NOT_FOUND");
  return rows;
}

// 2026-10-18: a brand-new fund (e.g. a just-launched TISA share class) can sit on SITCA's own list
// with 基金淨值 = "-" for days before its first real NAV publishes -- parseSitcaCsv above correctly
// filters those out for NAV-WRITING purposes (nothing to write yet), but that same filter was also
// silently hiding these funds from lib/cron/newFundListingDetection.ts's EXISTENCE check, which only
// needs 基金統編/名稱/公司名稱, not a valid NAV. This sibling parser keeps every row that has those
// three identity fields regardless of whether a NAV has published yet, so a fund's `funds` row can
// be created as soon as SITCA lists it -- the existing daily NAV sync (parseSitcaCsv-based) then
// naturally fills in `latest_nav` itself once a real number appears, no extra code needed.
export type SitcaIdentityRow = { taxId: string; name: string; company: string };

export function parseSitcaIdentityCsv(csv: string): SitcaIdentityRow[] {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`SITCA_CSV_PARSE_ERROR:${parsed.errors[0]?.message}`);
  const rows: SitcaIdentityRow[] = [];
  for (const row of parsed.data) {
    const taxId = row["基金統編"]?.trim();
    const name = row["基金名稱"]?.trim();
    const company = row["公司名稱"]?.trim();
    if (!taxId || !name || !company) continue;
    rows.push({ taxId, name, company });
  }
  if (!rows.length) throw new Error("SITCA_IDENTITY_ROWS_NOT_FOUND");
  return rows;
}

export async function fetchSitcaIdentityRows(): Promise<SitcaIdentityRow[]> {
  const res = await fetch(SITCA_FSC_NAV_URL, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(45_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    const err = new Error(`SITCA_RATE_LIMITED_${res.status}`);
    (err as any).rateLimited = true;
    (err as any).httpStatus = res.status;
    throw err;
  }
  if (!res.ok) throw new Error(`SITCA_HTTP_${res.status}`);
  const text = await res.text();
  return parseSitcaIdentityCsv(text);
}

// 2026-10-16: 20s was too tight -- production_scheduler_runs shows this fetch aborting at ~22.3s
// and ~22.4s runtime on 2026-10-15 and 2026-10-14 respectively (status=FAILED, error="The operation
// was aborted due to timeout"), both times the SITCA server itself just being slow, not a real
// outage -- the job's own hourly retry succeeded minutes later each day. lib/cloud-ingestion/
// fundNav.ts's independent fetch of this SAME endpoint already uses 45s; matching that budget here
// instead of guessing a new number, since this route's own maxDuration (300s) has plenty of room.
export async function fetchSitcaRows(): Promise<SitcaRawRow[]> {
  const res = await fetch(SITCA_FSC_NAV_URL, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(45_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    const err = new Error(`SITCA_RATE_LIMITED_${res.status}`);
    (err as any).rateLimited = true;
    (err as any).httpStatus = res.status;
    throw err;
  }
  if (!res.ok) throw new Error(`SITCA_HTTP_${res.status}`);
  const text = await res.text();
  return parseSitcaCsv(text);
}
