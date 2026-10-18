// New-ETF-listing / delisting detection, sourced ONLY from the official TWSE/TPEx open-data feed —
// the single source confirmed this round (direct curl, 2026-10-15) to carry BOTH 成立日期
// (establishment date) and 上市日期 (listing date) in machine-readable form for every listed ETF:
//   TWSE: https://mopsfin.twse.com.tw/opendata/t187ap47_L.csv
//   TPEx: https://mopsfin.twse.com.tw/opendata/t187ap47_O.csv  (same host serves TPEx too — the
//         tpex.org.tw openapi host that returned HTTP 403 this round is a DIFFERENT, unrelated host
//         and is NOT used here)
//
// Deliberate scope limit, disclosed rather than silently under-delivered: this CSV has no column
// literally labelled 發行人/經理公司 (manager company name) — the closest thing is 基金中文名稱, the
// fund's full official legal name, which structurally always starts with the issuer's own brand (e.g.
// "復華全球未來50主動式ETF證券投資信託基金" -> 復華, or for a TPEx umbrella-fund-style name like
// "統一股債傘型證券投資信託基金之統一前沿科技主動式ETF證券投資信託基金" -> 統一). VERIFIED live
// (2026-10-17) against every one of that day's 6 new listings, including a TPEx umbrella-fund name:
// the first 2 characters of 基金中文名稱 matched an existing provider for all 6, where the short name
// (基金簡稱) alone failed for 5 of them because its first 2 characters are "主動" (Taiwan's 2026
// actively-managed-ETF category label, not a brand). `resolveProviderByBrand` therefore matches
// against 基金中文名稱 first (the official, unmodified field), falling back to 基金簡稱 only if the
// full name is somehow missing — this is a lookup against already-verified data, never an invented
// value, and the fallback path is marked as such wherever it's surfaced. When no unique match is
// found either way, the event is still logged (so it surfaces in the App's 新商品上架 screen) but no
// etfs row is created; product_id stays null until a human (or a later, better-sourced pass) resolves
// it. This is the one explicitly-scoped gap for the ETF path.
//
// Fund (SITCA/境內) and offshore (TDCC) new-listing detection are OUT OF SCOPE for this pipeline:
// this round's research subagent could not get a direct, VERIFIED official source for either
// (SITCA's new-fund page wasn't located; TDCC's own open-data catalog was checked and confirmed to
// contain NO approval/核備-date field at all). Building either on secondhand data would violate the
// "官方來源才可引用" requirement, so neither is implemented here.

import { prisma } from "@/lib/prisma";
import { fetchYahooTwPerformance } from "@/lib/yahoo/twPerformancePage";

export type OfficialEtfRow = {
  exchange: "TWSE" | "TPEx";
  code: string;
  name: string;
  /** 基金中文名稱 -- the fund's full official legal name (not the abbreviated 基金簡稱 in `name`).
   * Used for provider/issuer resolution since it structurally embeds the real brand without the
   * "主動" category-label prefix that the short name carries for actively-managed ETFs. */
  fullName: string;
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
  const iCode = idx("基金代號"), iName = idx("基金簡稱"), iFullName = idx("基金中文名稱"), iEst = idx("成立日期"), iList = idx("上市日期");
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
      fullName: iFullName >= 0 ? (cols[iFullName] ?? "").trim() : "",
      establishedAt: iEst >= 0 ? parseRocDate(cols[iEst]) : null,
      listedAt: iList >= 0 ? parseRocDate(cols[iList]) : null,
    });
  }
  return rows;
}

async function uniqueProviderForBrand(brand: string): Promise<string | null> {
  if (!brand) return null;
  const providers = await prisma.etf.findMany({ where: { provider: { contains: brand } }, select: { provider: true }, distinct: ["provider"] });
  const unique = Array.from(new Set(providers.map((p) => p.provider)));
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Brand-prefix match against existing providers already in the DB — a lookup, not a guess.
 * Tries the official full legal name (基金中文名稱) first, since it structurally starts with the
 * real issuer brand (see OfficialEtfRow.fullName doc comment above). Falls back to the abbreviated
 * short name (基金簡稱) only if the full name is missing or doesn't resolve — that fallback is
 * disclosed to the caller via `usedFallback` so it can be surfaced as a lower-confidence match rather
 * than silently treated the same as the primary, official-field-based resolution.
 */
async function resolveProviderByBrand(fullName: string, shortName: string): Promise<{ provider: string | null; usedFallback: boolean }> {
  if (fullName) {
    const provider = await uniqueProviderForBrand(fullName.slice(0, 2));
    if (provider) return { provider, usedFallback: false };
  }
  const provider = await uniqueProviderForBrand(shortName.slice(0, 2));
  return { provider, usedFallback: true };
}

// 2026-10-17: root-cause fix for 7 ETFs (009825/6/7/9, 00990B/1B/2B) that got auto-provisioned here
// with data_source left NULL, silently excluding them from market-close-sync, etf-returns-sync,
// stock/technical, holdings and dividend pipelines (every one of those gates its universe on
// `data_source IS NOT NULL` / the `\.(TW|TWO)$` suffix regex in twUniverse.ts) until a human noticed
// via daily-health-report's ETF_DATA_SOURCE_GAP check. The suffix convention (TWSE -> .TW, TPEx ->
// .TWO) matches every other TW ETF's data_source in this table. Verified against the real Yahoo
// fetch function rather than trusted blindly -- if the guessed symbol doesn't actually resolve, leave
// data_source NULL so the health-report gap check still catches it for manual attention, instead of
// writing a plausible-looking but wrong value.
async function resolveTwDataSource(code: string, exchange: "TWSE" | "TPEx"): Promise<string | null> {
  const candidate = `${code}${exchange === "TPEx" ? ".TWO" : ".TW"}`;
  try {
    const perf = await fetchYahooTwPerformance(candidate);
    return perf ? candidate : null;
  } catch {
    return null;
  }
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
  autoProvisioned: { code: string; provider: string; providerSource: "OFFICIAL_FULL_NAME" | "FALLBACK_SHORT_NAME" }[];
  loggedOnly: { code: string; reason: string }[];
  /** Codes the official feed lists but our DB never onboarded, OLDER than the lookback window —
   * a separate pre-existing backfill gap, NOT treated as a new listing (not logged, not provisioned). */
  preexistingBackfillGapCount: number;
};

// 2026-10-18 (使用者核准的一次性補建): 讓 CLOUD_NEW_LISTING_DETECTION 支援針對明確指定的代號
// 繞過 NEW_LISTING_LOOKBACK_DAYS 的「太舊不算新上市」篩選——用於補建 65 檔已知、確認過的
// 既存缺建檔缺口（0054、0058... 等），沿用跟真正新上市完全相同的 provider／data_source 比對
// 邏輯（resolveProviderByBrand／resolveTwDataSource），不是另外寫一套。只對明確列在
// backfillCodes 裡的代號生效，不會意外放寬到其他真正太舊、原本就該排除的項目。
export async function detectNewListings(writeEnabled: boolean, backfillCodes?: ReadonlySet<string>): Promise<NewListingResult> {
  const [twse, tpex] = await Promise.all([fetchOfficialEtfList("TWSE"), fetchOfficialEtfList("TPEx")]);
  const official = [...twse, ...tpex];
  const existing = await prisma.etf.findMany({ select: { code: true } });
  // 2026-10-18 root-cause fix: this previously compared the official list's bare code
  // (e.g. "00409A") against our stored codes with an EXACT string match. VERIFIED this was the
  // source of fresh duplicate ETF rows being created daily -- when an existing ETF's own `code`
  // happens to be stored WITH a .TW/.TWO suffix (e.g. "00409A.TW", from an earlier import), the
  // exact match against the official feed's bare "00409A" fails, so this detector wrongly concludes
  // it's a brand-new listing and auto-provisions a SECOND row for the same real-world ETF (confirmed
  // live: "00409A" created 2026-10-18 01:15, 8s after this cron ran, duplicating the existing
  // "00409A.TW" row from 2026-09-11). Normalizing both sides (stripping a trailing .TW/.TWO) before
  // comparing matches the same normalization already used by the duplicate-pair scan and by
  // lib/etf-returns-sync/twUniverse.ts's TW_ELIGIBLE_SQL_CONDITION.
  const normalizeCode = (code: string) => code.replace(/\.(TW|TWO)$/, "");
  const existingCodes = new Set(existing.map((e) => normalizeCode(e.code)));
  const cutoff = new Date(Date.now() - NEW_LISTING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const result: NewListingResult = { checkedCodes: official.length, newlyDetected: [], autoProvisioned: [], loggedOnly: [], preexistingBackfillGapCount: 0 };

  for (const row of official) {
    if (existingCodes.has(normalizeCode(row.code))) continue;
    const isExplicitBackfillTarget = backfillCodes?.has(row.code) ?? false;
    const milestone = row.listedAt ?? row.establishedAt;
    if (!isExplicitBackfillTarget && (!milestone || milestone < cutoff)) { result.preexistingBackfillGapCount++; continue; }
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

    const { provider, usedFallback } = await resolveProviderByBrand(row.fullName, row.name);
    if (!provider) {
      result.loggedOnly.push({ code: row.code, reason: "provider 無法從既有資料唯一比對，待人工建檔" });
      continue;
    }
    const dataSource = await resolveTwDataSource(row.code, row.exchange);
    const created = await prisma.etf.create({
      data: {
        code: row.code,
        name: row.name,
        provider,
        exchange: row.exchange,
        currency: "TWD",
        isActive: true,
        inceptionDate: row.establishedAt ?? undefined,
        dataSource: dataSource ?? undefined,
      },
      select: { id: true },
    });
    if (!dataSource) {
      result.loggedOnly.push({ code: row.code, reason: "data_source 無法從 Yahoo 驗證對應代碼，已建立商品但待人工補上，daily-health-report 會持續列出" });
    }
    await prisma.$executeRawUnsafe(
      `UPDATE product_listing_events SET product_id = $1, updated_at = now()
       WHERE product_type = 'ETF' AND code = $2 AND event_type = 'NEW_LISTING' AND source = $3`,
      created.id, row.code, source,
    );
    result.autoProvisioned.push({ code: row.code, provider, providerSource: usedFallback ? "FALLBACK_SHORT_NAME" : "OFFICIAL_FULL_NAME" });
  }
  return result;
}

export type DelistingResult = {
  candidates: { code: string; name: string }[];
  confirmed: { code: string; name: string }[];
};

// A DELISTING_CANDIDATE older than this is treated as stale — the ETF must have reappeared in the
// official feed since (the cleanup pass below deletes the row the run it reappears), so a candidate
// surviving past this window points at a bug, not a real 2-consecutive-day miss. Guards the
// "2 consecutive misses" guarantee across time, not just within a single run.
const DELISTING_CANDIDATE_MAX_AGE_HOURS = 48;

export async function detectDelistings(writeEnabled: boolean): Promise<DelistingResult> {
  const [twse, tpex] = await Promise.all([fetchOfficialEtfList("TWSE"), fetchOfficialEtfList("TPEx")]);
  // 2026-10-18: same normalization fix as detectNewListings above -- without it, any active ETF
  // whose own `code` happens to be stored WITH a .TW/.TWO suffix would NEVER match the official
  // feed's bare codes, and after 2 consecutive daily misses would get wrongly flipped is_active=false
  // even though it's genuinely still listed. VERIFIED this hasn't fired yet in practice only because
  // the 100 known duplicate-pair "suffixed" rows all have exchange='Taiwan' (excluded by the WHERE
  // below), not because the comparison itself was safe.
  const normalizeCode = (code: string) => code.replace(/\.(TW|TWO)$/, "");
  const officialCodes = new Set([...twse, ...tpex].map((r) => normalizeCode(r.code)));
  const active = await prisma.etf.findMany({
    where: { isActive: true, exchange: { in: ["TWSE", "TPEx"] } },
    select: { id: true, code: true, name: true },
  });

  // Cleanup pass: any ETF that reappeared in today's official feed must have its stale
  // DELISTING_CANDIDATE row cleared, so a future unrelated miss can never be misread as the
  // "second consecutive" one. This is the fix for the bug this round's independent review caught:
  // without it, "miss once (any reason) -> reappear for months -> miss again (unrelated reason)"
  // was wrongly read as 2 consecutive misses and flipped a real, still-listed ETF inactive.
  if (writeEnabled) {
    const reappeared = active.filter((e) => officialCodes.has(normalizeCode(e.code))).map((e) => e.code);
    if (reappeared.length > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM product_listing_events
         WHERE product_type = 'ETF' AND event_type = 'DELISTING_CANDIDATE' AND code = ANY($1::text[])`,
        reappeared,
      );
    }
  }

  const result: DelistingResult = { candidates: [], confirmed: [] };
  for (const etf of active) {
    if (officialCodes.has(normalizeCode(etf.code))) continue;

    const priorCandidate = await prisma.$queryRawUnsafe<{ id: string; detected_at: Date }[]>(
      `SELECT id, detected_at FROM product_listing_events
       WHERE product_type = 'ETF' AND code = $1 AND event_type = 'DELISTING_CANDIDATE'
       LIMIT 1`,
      etf.code,
    );
    const freshCandidate =
      priorCandidate.length > 0 &&
      Date.now() - new Date(priorCandidate[0].detected_at).getTime() <= DELISTING_CANDIDATE_MAX_AGE_HOURS * 60 * 60 * 1000;

    if (!freshCandidate) {
      // First miss: log a candidate only. Requires a SECOND consecutive day's miss before acting,
      // so one transient CSV glitch on the official feed can never flip a still-listed ETF inactive.
      result.candidates.push({ code: etf.code, name: etf.name });
      if (!writeEnabled) continue;
      await prisma.$executeRawUnsafe(
        `INSERT INTO product_listing_events
           (id, product_type, code, name, event_type, milestone_date, milestone_kind, source, source_url, detected_at, product_id, created_at, updated_at)
         VALUES (gen_random_uuid(), 'ETF', $1, $2, 'DELISTING_CANDIDATE', NULL, NULL, 'TWSE/TPEx t187ap47 absence', NULL, now(), $3, now(), now())
         ON CONFLICT (product_type, code, event_type, source) DO UPDATE SET detected_at = now(), updated_at = now()`,
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
