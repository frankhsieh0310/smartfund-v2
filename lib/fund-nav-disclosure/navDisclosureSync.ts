// 2026-11-07（使用者核准定案，「淨值未公開」cron）: 併進既有的淨值同步排程（sitca-nav-sync /
// offshore-nav-tdcc-sync），不新增cron entry。兩邊各自呼叫這裡的共用函式，用「這次官方CSV實際
// 確認有公開淨值的fund id清單」跟「這次候選的全部fund id清單」算出要寫入 funds.nav_disclosed /
// nav_disclosure_checked_at 的結果：
//   - 這次CSV確認有公開淨值 -> true。
//   - CSV沒確認（代表官方今天的檔案裡這檔基金的淨值是"-"或整筆缺漏，SitcaRawRow/TdccRow本身就不
//     會把"-"值解析進候選清單）-> 再查fund_history近30天有沒有淨值，決定true/false，呼應前端
//     navDisclosure.ts的判斷門檻（兩邊常數FRESH_WITHIN_DAYS = NAV_DISCLOSURE_FALLBACK_STALE_DAYS
//     保持一致，改一邊要記得改另一邊）。
//
// SHADOW MODE BY DEFAULT：FUND_NAV_DISCLOSURE_SYNC_WRITE 不是精確等於"on"（trim後比較，見
// CLAUDE.md的環境變數規則）就不寫入，只回傳計算結果供log/debug用。

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.ts";
import type { QueryFn } from "../sitca-nav-sync/navWriter.ts";

export const FRESH_WITHIN_DAYS = 30;

export function isNavDisclosureWriteEnabled(): boolean {
  return process.env.FUND_NAV_DISCLOSURE_SYNC_WRITE?.trim() === "on";
}

export interface DisclosureCandidate {
  fundId: string;
  disclosed: boolean;
}

export async function computeDisclosureCandidates(
  allCandidateFundIds: string[],
  confirmedDisclosedFundIds: ReadonlySet<string>,
): Promise<DisclosureCandidate[]> {
  const unique = [...new Set(allCandidateFundIds)];
  const confirmed = unique.filter((id) => confirmedDisclosedFundIds.has(id));
  const unconfirmed = unique.filter((id) => !confirmedDisclosedFundIds.has(id));
  const out: DisclosureCandidate[] = confirmed.map((fundId) => ({ fundId, disclosed: true }));
  if (unconfirmed.length) {
    const rows = await prisma.$queryRaw<Array<{ id: string; fresh: boolean }>>(
      Prisma.sql`SELECT f.id,
        EXISTS(
          SELECT 1 FROM fund_history h
           WHERE h.fund_id = f.id AND h.nav IS NOT NULL AND h.date >= CURRENT_DATE - ${FRESH_WITHIN_DAYS}
        ) AS fresh
        FROM funds f WHERE f.id IN (${Prisma.join(unconfirmed)})`,
    );
    for (const r of rows) out.push({ fundId: r.id, disclosed: r.fresh });
  }
  return out;
}

export async function writeDisclosureBatch(
  query: QueryFn,
  candidates: DisclosureCandidate[],
  writeEnabled: boolean,
): Promise<{ written: number; writeErrorCount: number }> {
  if (!writeEnabled || candidates.length === 0) return { written: 0, writeErrorCount: 0 };
  let written = 0;
  let writeErrorCount = 0;
  for (const c of candidates) {
    try {
      await query(`UPDATE funds SET nav_disclosed = $1, nav_disclosure_checked_at = now() WHERE id = $2`, [c.disclosed, c.fundId]);
      written++;
    } catch {
      writeErrorCount++;
    }
  }
  return { written, writeErrorCount };
}

// 兩邊cron共用的一站式入口：算完直接寫（若開關開著），回傳結果給呼叫端塞進details/log。
export async function runFundNavDisclosureSync(
  query: QueryFn,
  allCandidateFundIds: string[],
  confirmedDisclosedFundIds: ReadonlySet<string>,
): Promise<{ candidateCount: number; confirmedDisclosedCount: number; written: number; writeErrorCount: number; writeEnabled: boolean }> {
  const writeEnabled = isNavDisclosureWriteEnabled();
  const candidates = await computeDisclosureCandidates(allCandidateFundIds, confirmedDisclosedFundIds);
  const { written, writeErrorCount } = await writeDisclosureBatch(query, candidates, writeEnabled);
  return {
    candidateCount: candidates.length,
    confirmedDisclosedCount: candidates.filter((c) => c.disclosed).length,
    written, writeErrorCount, writeEnabled,
  };
}
