// New domestic / offshore FUND listing detection — separate from newListingDetection.ts (ETFs),
// because neither official feed here carries an establishment/approval date (confirmed this round:
// SITCA's own daily NAV CSV has no 成立日期 field; TDCC's offshore NAV dataset 3-4 has no 核備日
// field either — both are pure NAV feeds). Research this round also checked sfb.gov.tw, data.gov.tw,
// and fundclear.com.tw for any date-bearing new-fund source and found nothing live and
// machine-readable; a 2020-era FSC dataset (申請日期/核准日期 fields) exists but has not been
// updated since 2020-05-29 and is unusable.
//
// Because there is no date to filter a one-time "backfill gap" out of a true "new today" signal (the
// trick that works for ETFs via 上市日期), this uses a BASELINE-SEED pattern instead: the first time
// this pipeline ever runs for a given source, it silently records every code/name currently seen as
// a KNOWN_BASELINE row (no NEW_LISTING fired — firing on first run would misreport every
// already-existing-but-never-onboarded fund as "new"). From the second run onward, anything not in
// `funds` AND not already in the baseline is genuinely new since yesterday and gets a NEW_LISTING
// event with milestone_date = NULL (honest "官方未公告" — the TDCC/SITCA feeds cannot supply a date).
import { prisma } from "@/lib/prisma";
import { fetchSitcaRows } from "@/lib/sitca-nav-sync/sitcaFetch";
import { fetchTdccNavCsv, parseTdccNavCsv } from "@/lib/offshore-nav-sync/tdccBatchSource";

const DOMESTIC_SOURCE = "SITCA nav.csv (基金統編 diff)";
const OFFSHORE_SOURCE = "TDCC opendata 3-4 (基金名稱 diff)";

type ProductType = "DOMESTIC_FUND" | "OFFSHORE_FUND";

async function knownKeys(productType: ProductType, source: string): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ code: string }[]>(
    `SELECT DISTINCT code FROM product_listing_events
     WHERE product_type = $1 AND source = $2 AND event_type IN ('KNOWN_BASELINE', 'NEW_LISTING')`,
    productType, source,
  );
  return new Set(rows.map((r) => r.code));
}

async function hasAnyBaseline(productType: ProductType, source: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM product_listing_events WHERE product_type = $1 AND source = $2 LIMIT 1`,
    productType, source,
  );
  return rows.length > 0;
}

async function seedBaseline(productType: ProductType, source: string, items: { key: string; name: string }[]) {
  for (const item of items) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO product_listing_events
         (id, product_type, code, name, event_type, milestone_date, milestone_kind, source, source_url, detected_at, product_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'KNOWN_BASELINE', NULL, NULL, $4, NULL, now(), NULL, now(), now())
       ON CONFLICT (product_type, code, event_type, source) DO NOTHING`,
      productType, item.key, item.name, source,
    );
  }
}

async function logNewFund(productType: ProductType, source: string, item: { key: string; name: string }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO product_listing_events
       (id, product_type, code, name, event_type, milestone_date, milestone_kind, source, source_url, detected_at, product_id, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'NEW_LISTING', NULL, '官方未公告（來源僅提供淨值，無成立／核備日期欄位）', $4, NULL, now(), NULL, now(), now())
     ON CONFLICT (product_type, code, event_type, source) DO UPDATE SET updated_at = now()`,
    productType, item.key, item.name, source,
  );
}

export type NewFundResult = {
  isFirstRun: boolean;
  seeded: number;
  newlyDetected: { key: string; name: string }[];
};

/** Domestic funds: identity key is 基金統編 (== funds.code for ~95% of rows per sitcaFetch.ts's own
 * verified comment; the remaining 5% have no code match at all and are intentionally left out of
 * this detector — they're not resolvable to a `funds` row either way, so "new" vs "existing" can't
 * be determined for them from this CSV alone). */
export async function detectNewDomesticFunds(writeEnabled: boolean): Promise<NewFundResult> {
  const rows = await fetchSitcaRows();
  const bySeen = new Map<string, string>(); // taxId -> name, de-duped
  for (const r of rows) bySeen.set(r.taxId, r.name);

  const existingFundCodes = new Set((await prisma.fund.findMany({ select: { code: true } })).map((f) => f.code).filter((c): c is string => c !== null));
  const isFirstRun = !(await hasAnyBaseline("DOMESTIC_FUND", DOMESTIC_SOURCE));
  const known = isFirstRun ? new Set<string>() : await knownKeys("DOMESTIC_FUND", DOMESTIC_SOURCE);

  const candidates = [...bySeen.entries()]
    .filter(([taxId]) => !existingFundCodes.has(taxId) && !known.has(taxId))
    .map(([taxId, name]) => ({ key: taxId, name }));

  if (!writeEnabled) return { isFirstRun, seeded: isFirstRun ? bySeen.size : 0, newlyDetected: isFirstRun ? [] : candidates };

  if (isFirstRun) {
    await seedBaseline("DOMESTIC_FUND", DOMESTIC_SOURCE, [...bySeen.entries()].map(([taxId, name]) => ({ key: taxId, name })));
    return { isFirstRun: true, seeded: bySeen.size, newlyDetected: [] };
  }
  for (const c of candidates) await logNewFund("DOMESTIC_FUND", DOMESTIC_SOURCE, c);
  return { isFirstRun: false, seeded: 0, newlyDetected: candidates };
}

/** Offshore funds: funds.code is NULL for most offshore funds (per tdccBatchSource.ts's own
 * documented reason), so identity here is exact fund NAME — the same join key
 * lib/offshore-nav-sync/tdccBatchSource.ts already uses for NAV writes. */
export async function detectNewOffshoreFunds(writeEnabled: boolean): Promise<NewFundResult> {
  const csvText = await fetchTdccNavCsv();
  const byName = parseTdccNavCsv(csvText);

  const existingFundNames = new Set((await prisma.fund.findMany({ select: { name: true } })).map((f) => f.name));
  const isFirstRun = !(await hasAnyBaseline("OFFSHORE_FUND", OFFSHORE_SOURCE));
  const known = isFirstRun ? new Set<string>() : await knownKeys("OFFSHORE_FUND", OFFSHORE_SOURCE);

  const candidates = [...byName.keys()]
    .filter((name) => !existingFundNames.has(name) && !known.has(name))
    .map((name) => ({ key: name, name }));

  if (!writeEnabled) return { isFirstRun, seeded: isFirstRun ? candidates.length : 0, newlyDetected: isFirstRun ? [] : candidates };

  if (isFirstRun) {
    await seedBaseline("OFFSHORE_FUND", OFFSHORE_SOURCE, [...byName.keys()].map((name) => ({ key: name, name })));
    return { isFirstRun: true, seeded: byName.size, newlyDetected: [] };
  }
  for (const c of candidates) await logNewFund("OFFSHORE_FUND", OFFSHORE_SOURCE, c);
  return { isFirstRun: false, seeded: 0, newlyDetected: candidates };
}
