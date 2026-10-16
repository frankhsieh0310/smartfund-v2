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
    if (!taxId || !name || !navRaw || !rawDate || !currency) continue;
    if (!/^\d{8}$/.test(rawDate)) continue;
    const nav = Number(navRaw);
    if (!Number.isFinite(nav) || nav <= 0) continue;
    rows.push({
      taxId, name, nav, currency,
      navDate: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`,
    });
  }
  if (!rows.length) throw new Error("SITCA_NAV_ROWS_NOT_FOUND");
  return rows;
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
