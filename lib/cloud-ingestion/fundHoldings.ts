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

/**
 * MoneyDJ fund-holdings universe for one ROLLING invocation: mapped codes past the id cursor whose
 * MONEYDJ_PUBLIC_DISCLOSURE holdings are older than `freshDays` (or absent), ordered by fund id.
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
  freshDays: number,
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
        AND (h.max_asof IS NULL OR h.max_asof < CURRENT_DATE - ($3 || ' days')::interval)
        AND (
          sc.master_fund_id IS NULL
          OR fm.representative_fund_id = f.id
          OR NOT EXISTS (
            SELECT 1 FROM holdings rh
             WHERE rh.fund_id = fm.representative_fund_id AND rh.asset_type = 'FUND' AND rh.source = $2
               AND rh.as_of_date >= CURRENT_DATE - ($3 || ' days')::interval
          )
        )
      ORDER BY f.id
      LIMIT $4`,
    cursor,
    MONEYDJ_SOURCE,
    String(freshDays),
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
