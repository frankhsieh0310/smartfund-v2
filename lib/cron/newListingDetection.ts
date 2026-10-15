// New-ETF-listing / delisting detection, sourced ONLY from the official TWSE/TPEx open-data feed —
// the single source confirmed this round (direct curl, 2026-10-15) to carry BOTH 成立日期
// (establishment date) and 上市日期 (listing date) in machine-readable form for every listed ETF:
//   TWSE: https://mopsfin.twse.com.tw/opendata/t187ap47_L.csv
//   TPEx: https://mopsfin.twse.com.tw/opendata/t187ap47_O.csv  (same host serves TPEx too — the
//         tpex.org.tw openapi host that returned HTTP 403 this round is a DIFFERENT, unrelated host
//         and is NOT used here)
//
// Deliberate scope limit, disclosed rather than silently under-delivered: this CSV has no
// asset-manager/company-name column, so a brand-new ETF's required `provider` field (etfs.provider
// is NOT NULL) cannot be read off this source directly. Auto-provisioning (actually inserting an
// etfs row) only happens when the new ETF's 基金簡稱 brand prefix uniquely matches the brand prefix
// of an existing `etfs.provider` value already in the DB (e.g. "元大..." -> "元大證券投資信託股份
// 有限公司") — this is a lookup against already-verified data, never an invented value. When no
// unique match is found, the event is still logged (so it surfaces in the App's 新商品上架 screen)
// but no etfs row is created; product_id stays null until a human (or a later, better-sourced pass)
// resolves it. This is the one explicitly-scoped gap for the ETF path.
//
// Fund (SITCA/境內) and offshore (TDCC) new-listing detection are OUT OF SCOPE for this pipeline:
// this round's research subagent could not get a direct, VERIFIED official source for either
// (SITCA's new-fund page wasn't located; TDCC's own open-data catalog was checked and confirmed to
// contain NO approval/核備-date field at all). Building either on secondhand data would violate the
// "官方來源才可引用" requirement, so neither is implemented here.

import { prisma } from "@/lib/prisma";

export type OfficialEtfRow = {
  exchange: "TWSE" | "TPEx";
  code: string;
  name: string;
  establishedAt: Date | null;
  listedAt: Date | null;
};

const SOURCES: Record<"TWSE" | "TPEx", { url: string; label: string }> = {
  TWSE: { url: "https://mopsfin.twse.com.tw/opendata/t187ap47_L.csv", label: "TWSE t187ap47_L" },
  TPEx: { url: "https://mopsfin.twse.com.tw/opendata/t187ap47_O.csv", label: "TPEx t187ap47_O" },
};

/** "1150826" (ROC year 115 = AD 2026) -> Date(2026-08-26). Blank/unparsable -> null. */
export function parseRocDate(raw: string | undefined): Date | null {
  const s = (raw ?? "").trim().replace(/^"|"$/g, "");
  if (!/^\d{6,7}$/.test(s)) return null;
  const mm = s.slice(-4, -2);
  const dd = s.slice(-2);
  const rocYear = Number(s.slice(0, s.length - 4));
  if (!Number.isFinite(rocYear) || rocYear <= 0) return null;
  const year = rocYear + 1911;
  const d = new Date(Date.UTC(year, Number(mm) - 1, Number(dd)));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export async function fetchOfficialEtfList(exchange: "TWSE" | "TPEx"): Promise<OfficialEtfRow[]> {
  const { url } = SOURCES[exchange];
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (SmartMatch data pipeline)" } });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    throw new Error(`${exchange} official feed returned ${res.status} — stopping, not retrying/bypassing`);
  }
  if (!res.ok) throw new Error(`${exchange} official feed HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const iCode = idx("基金代號"), iName = idx("基金簡稱"), iEst = idx("成立日期"), iList = idx("上市日期");
  if (iCode < 0 || iName < 0) throw new Error(`${exchange} official feed header missing expected columns`);
  const rows: OfficialEtfRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const code = (cols[iCode] ?? "").trim();
    if (!code) continue;
    rows.push({
      exchange,
      code,
      name: (cols[iName] ?? "").trim(),
      establishedAt: iEst >= 0 ? parseRocDate(cols[iEst]) : null,
      listedAt: iList >= 0 ? parseRocDate(cols[iList]) : null,
    });
  }
  return rows;
}

/** Brand-prefix match against existing providers already in the DB — a lookup, not a guess. */
async function resolveProviderByBrand(shortName: string): Promise<string | null> {
  const brand = shortName.slice(0, 2);
  if (!brand) return null;
  const providers = await prisma.etf.findMany({ where: { provider: { contains: brand } }, select: { provider: true }, distinct: ["provider"] });
  const unique = Array.from(new Set(providers.map((p) => p.provider)));
  return unique.length === 1 ? unique[0] : null;
}

// How far back a 上市日期 can be and still count as a genuine "new listing" rather than a
// pre-existing ETF our own `etfs` table simply never onboarded. Confirmed via a real dry-run
// (2026-10-15) against production: WITHOUT this filter, 65 decades-old-to-years-old ETFs (e.g.
// 0054 元大台商50, listed 2008-07-16) that are missing from our DB for unrelated backfill reasons
// would have been wrongly logged/auto-provisioned as NEW_LISTING. 120 days comfortably covers any
// gap even if this daily cron were down for weeks, while excluding the real backfill gap.
const NEW_LISTING_LOOKBACK_DAYS = 120;

export type NewListingResult = {
  checkedCodes: number;
  newlyDetected: { exchange: string; code: string; name: string }[];
  autoProvisioned: { code: string; provider: string }[];
  loggedOnly: { code: string; reason: string }[];
  /** Codes the official feed lists but our DB never onboarded, OLDER than the lookback window —
   * a separate pre-existing backfill gap, NOT treated as a new listing (not logged, not provisioned). */
  preexistingBackfillGapCount: number;
};

export async function detectNewListings(writeEnabled: boolean): Promise<NewListingResult> {
  const [twse, tpex] = await Promise.all([fetchOfficialEtfList("TWSE"), fetchOfficialEtfList("TPEx")]);
  const official = [...twse, ...tpex];
  const existing = await prisma.etf.findMany({ select: { code: true } });
  const existingCodes = new Set(existing.map((e) => e.code));
  const cutoff = new Date(Date.now() - NEW_LISTING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const result: NewListingResult = { checkedCodes: official.length, newlyDetected: [], autoProvisioned: [], loggedOnly: [], preexistingBackfillGapCount: 0 };

  for (const row of official) {
    if (existingCodes.has(row.code)) continue;
    const milestone = row.listedAt ?? row.establishedAt;
    if (!milestone || milestone < cutoff) { result.preexistingBackfillGapCount++; continue; }
    result.newlyDetected.push({ exchange: row.exchange, code: row.code, name: row.name });
    if (!writeEnabled) continue;

    const source = SOURCES[row.exchange].label;
    await prisma.$executeRawUnsafe(
      `INSERT INTO product_listing_events
         (id, product_type, code, name, event_type, milestone_date, milestone_kind, source, source_url, detected_at, product_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'ETF', $1, $2, 'NEW_LISTING', $3, '上市日期', $4, $5, now(), NULL, now(), now())
       ON CONFLICT (product_type, code, event_type, source) DO UPDATE SET
         name = EXCLUDED.name, milestone_date = EXCLUDED.milestone_date, updated_at = now()`,
      row.code, row.name, row.listedAt ?? row.establishedAt, source, SOURCES[row.exchange].url,
    );

    const provider = await resolveProviderByBrand(row.name);
    if (!provider) {
      result.loggedOnly.push({ code: row.code, reason: "provider 無法從既有資料唯一比對，待人工建檔" });
      continue;
    }
    const created = await prisma.etf.create({
      data: {
        code: row.code,
        name: row.name,
        provider,
        exchange: row.exchange,
        currency: "TWD",
        isActive: true,
        inceptionDate: row.establishedAt ?? undefined,
      },
      select: { id: true },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE product_listing_events SET product_id = $1, updated_at = now()
       WHERE product_type = 'ETF' AND code = $2 AND event_type = 'NEW_LISTING' AND source = $3`,
      created.id, row.code, source,
    );
    result.autoProvisioned.push({ code: row.code, provider });
  }
  return result;
}

export type DelistingResult = {
  candidates: { code: string; name: string }[];
  confirmed: { code: string; name: string }[];
};

export async function detectDelistings(writeEnabled: boolean): Promise<DelistingResult> {
  const [twse, tpex] = await Promise.all([fetchOfficialEtfList("TWSE"), fetchOfficialEtfList("TPEx")]);
  const officialCodes = new Set([...twse, ...tpex].map((r) => r.code));
  const active = await prisma.etf.findMany({
    where: { isActive: true, exchange: { in: ["TWSE", "TPEx"] } },
    select: { id: true, code: true, name: true },
  });

  const result: DelistingResult = { candidates: [], confirmed: [] };
  for (const etf of active) {
    if (officialCodes.has(etf.code)) continue;

    const priorCandidate = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM product_listing_events
       WHERE product_type = 'ETF' AND code = $1 AND event_type = 'DELISTING_CANDIDATE'
       LIMIT 1`,
      etf.code,
    );

    if (priorCandidate.length === 0) {
      // First miss: log a candidate only. Requires a SECOND consecutive day's miss before acting,
      // so one transient CSV glitch on the official feed can never flip a still-listed ETF inactive.
      result.candidates.push({ code: etf.code, name: etf.name });
      if (!writeEnabled) continue;
      await prisma.$executeRawUnsafe(
        `INSERT INTO product_listing_events
           (id, product_type, code, name, event_type, milestone_date, milestone_kind, source, source_url, detected_at, product_id, created_at, updated_at)
         VALUES (gen_random_uuid(), 'ETF', $1, $2, 'DELISTING_CANDIDATE', NULL, NULL, 'TWSE/TPEx t187ap47 absence', NULL, now(), $3, now(), now())
         ON CONFLICT (product_type, code, event_type, source) DO UPDATE SET updated_at = now()`,
        etf.code, etf.name, etf.id,
      );
      continue;
    }

    // Second consecutive miss: confirm delisting. Flip is_active only — never delete the row.
    result.confirmed.push({ code: etf.code, name: etf.name });
    if (!writeEnabled) continue;
    await prisma.etf.update({ where: { id: etf.id }, data: { isActive: false } });
    await prisma.$executeRawUnsafe(
      `INSERT INTO product_listing_events
         (id, product_type, code, name, event_type, milestone_date, milestone_kind, source, source_url, detected_at, product_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'ETF', $1, $2, 'DELISTING', CURRENT_DATE, '下市日期(推定)', 'TWSE/TPEx t187ap47 absence (2 consecutive checks)', NULL, now(), $3, now(), now())
       ON CONFLICT (product_type, code, event_type, source) DO UPDATE SET updated_at = now()`,
      etf.code, etf.name, etf.id,
    );
  }
  return result;
}
