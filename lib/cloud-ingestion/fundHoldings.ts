// Fund holdings — provider registry for the cloud worker.
//
// MoneyDJ fund disclosure reuses lib/cloud-ingestion/moneydjFundDisclosure.ts (contract mirror of
// scripts/data/global-fund/run-fund-moneydj-disclosure.ts) — already idempotent via the
// (fund_id, source, filing_id, source_record_id) conflict key where filing_id carries the 資料月份,
// so a re-run of the same month upserts in place (no accumulation).
//
// SEC EDGAR N-PORT: the repo's run-fund-nport-regulatory-recovery.ts spawns child `tsx` resolvers,
// applies a Prisma migration per run, uses local runtime/*.json, and writes a security-master path
// (securities + security_regulatory_evidence) rather than `holdings`. The XML fetch + cheerio parse
// are bounded and cloud-safe on their own, but a cloud N-PORT *holdings* ingester needs its own
// design (SEC submissions API -> accession -> primary_doc.xml -> invstOrSec rows into `holdings`,
// checkpointed by fund). Not attempted this round.

import type { PrismaClient } from "@prisma/client";
import { MONEYDJ_SOURCE } from "./moneydjFundDisclosure";

export const FUND_HOLDINGS_PROVIDERS = ["MONEYDJ", "NPORT", "ALL"] as const;
export type FundHoldingsProvider = (typeof FUND_HOLDINGS_PROVIDERS)[number];

export const NPORT_CLOUD_COMPATIBLE = false;
export const NPORT_DEFERRAL_REASON =
  "N-PORT ingester spawns tsx child resolvers, applies a migration per run, uses local fs state, and " +
  "targets securities/security_regulatory_evidence not holdings. Needs a dedicated cloud design next round.";

export type MoneydjFundTarget = {
  fundId: string;
  moneydjCode: string;
  canonicalName: string;
  dbDate: string | null;
  masterFundId: string | null;
  isRepresentative: boolean;
};

// 2026-11-05（使用者核准定案）: 基金月報「目標資料截止日」是上個月底，不是「距今N天」的滾動窗口
// ——原本的freshDays(25天)雖然方向大致正確，但不是使用者實際定義的規則，而且對「這個月還沒公布
// 的基金」沒有任何節流，造成同一檔基金一天被排程打24次（見route.ts的呼叫頻率修正）。這裡改成直接
// 拿「上個月最後一天」當作比較基準：資料已經是上個月底（或更新）的基金，本月完全不再是候選；
// 還沒拿到的，繼續留在候選池裡，交給route.ts的「每天只跑一次、每檔基金3秒間隔」節流。
export function targetMonthEndIso(now: Date = new Date()): string {
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const firstOfThisMonthUTC = new Date(Date.UTC(taipei.getUTCFullYear(), taipei.getUTCMonth(), 1));
  const lastOfPrevMonthUTC = new Date(firstOfThisMonthUTC.getTime() - 24 * 60 * 60 * 1000);
  return lastOfPrevMonthUTC.toISOString().slice(0, 10);
}

/**
 * MoneyDJ fund-holdings universe for one ROLLING invocation: mapped codes past the id cursor whose
 * MONEYDJ_PUBLIC_DISCLOSURE holdings are still older than `targetMonthEnd`（上個月底）, ordered by
 * fund id.
 *
 * Master-fund aware (Phase 1): a fund linked to a fund_master is only in scope if it is the master's
 * representative_fund_id, OR the representative currently has no fresh holdings (fallback). Every
 * other linked share class is skipped as MASTER_NON_REPRESENTATIVE — it reads holdings through the
 * master. Funds with no master keep the per-code behaviour.
 */
export async function nextMoneydjFundTargets(
  prisma: PrismaClient,
  cursor: string,
  batch: number,
  targetMonthEnd: string,
): Promise<MoneydjFundTarget[]> {
  return prisma.$queryRawUnsafe<MoneydjFundTarget[]>(
    `SELECT f.id AS "fundId", m.moneydj_code AS "moneydjCode", f.name AS "canonicalName",
            to_char(h.max_asof, 'YYYY-MM-DD') AS "dbDate",
            sc.master_fund_id AS "masterFundId",
            (sc.master_fund_id IS NULL OR fm.representative_fund_id = f.id) AS "isRepresentative"
       FROM fund_mappings m
       JOIN funds f ON f.id = m.fund_id
       LEFT JOIN fund_share_classes sc ON sc.fund_id = f.id AND sc.master_fund_id IS NOT NULL
       LEFT JOIN fund_master fm ON fm.id = sc.master_fund_id
       LEFT JOIN LATERAL (
         SELECT MAX(as_of_date) AS max_asof
           FROM holdings
          WHERE fund_id = f.id AND asset_type = 'FUND' AND source = $2
       ) h ON TRUE
      WHERE m.moneydj_code IS NOT NULL
        AND f.id > $1
        AND (h.max_asof IS NULL OR h.max_asof < $3::date)
        AND (
          sc.master_fund_id IS NULL
          OR fm.representative_fund_id = f.id
          OR NOT EXISTS (
            SELECT 1 FROM holdings rh
             WHERE rh.fund_id = fm.representative_fund_id AND rh.asset_type = 'FUND' AND rh.source = $2
               AND rh.as_of_date >= $3::date
          )
        )
      ORDER BY f.id
      LIMIT $4`,
    cursor,
    MONEYDJ_SOURCE,
    targetMonthEnd,
    batch,
  );
}

export async function moneydjFundUniverseCount(prisma: PrismaClient): Promise<number> {
  // Master-aware: non-representative linked share classes are not fetched (they read through master).
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n
       FROM fund_mappings m
       JOIN funds f ON f.id = m.fund_id
       LEFT JOIN fund_share_classes sc ON sc.fund_id = f.id AND sc.master_fund_id IS NOT NULL
       LEFT JOIN fund_master fm ON fm.id = sc.master_fund_id
      WHERE m.moneydj_code IS NOT NULL
        AND (sc.master_fund_id IS NULL OR fm.representative_fund_id = f.id)`,
  );
  return Number(rows[0]?.n ?? 0);
}
