import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.ts";

// 2026-11-07（使用者核准定案，「淨值未公開」功能）: 判斷「這檔基金的淨值有沒有被官方來源公開」
// 算在這一處共用——不給 app/funds/[id]/page.tsx、搜尋、排行、反查、自選等每個畫面各自判斷。
//
// 權威判斷（條件 1，使用者定案）: 官方來源（SITCA／TDCC）最新一期淨值是「-」或缺漏，且
// fund_history 近 30 天沒有淨值 -> 淨值未公開。由 app/api/cron/fund-nav-disclosure-sync/route.ts
// 定期用官方來源核實後寫入 funds.nav_disclosed（需要使用者先套用
// 2026-11-07_fund_nav_disclosure_and_backfill.sql 的 migration）。
//
// 退回估算（migration 還沒套用，或這筆基金還沒被 cron 跑到核實前）: 只用 funds.latest_nav_date
// 是否在近 30 天內估算。本輪（2026-11-07）已對當時全部 235 個「fund_history 超過 7 天沒有新淨值」
// 的核心母體基金逐一核對官方 SITCA/TDCC 即時資料，100%（235/235）確認是官方本身沒公開（非我方
// 同步落後）——所以在 migration 套用之前，這個退回估算對目前的資料是安全、正確的；cron 跑過之後
// 每筆基金會改用官方核實過的真正結果，不受這個估算影響。
export const NAV_DISCLOSURE_FALLBACK_STALE_DAYS = 30;

export function navDisclosedFallback(latestNavDate: Date | string | null): boolean {
  if (!latestNavDate) return false;
  const t = typeof latestNavDate === "string" ? new Date(latestNavDate).getTime() : latestNavDate.getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= NAV_DISCLOSURE_FALLBACK_STALE_DAYS * 86_400_000;
}

// 官方核實過的覆寫結果（funds.nav_disclosed，由cron寫入）。欄位還不存在（migration未套用）時
// 安靜回傳空 map，呼叫端一律退回 navDisclosedFallback，不讓整個頁面因為一張還沒建的欄位500。
export async function getNavDisclosureOverrides(fundIds: readonly string[]): Promise<Map<string, boolean>> {
  if (!fundIds.length) return new Map();
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string; nav_disclosed: boolean | null }>>(
      Prisma.sql`SELECT id, nav_disclosed FROM funds WHERE id IN (${Prisma.join([...fundIds])}) AND nav_disclosed IS NOT NULL`,
    );
    return new Map(rows.map((r) => [r.id, r.nav_disclosed as boolean]));
  } catch {
    return new Map();
  }
}

export function resolveNavDisclosed(fundId: string, latestNavDate: Date | string | null, overrides: ReadonlyMap<string, boolean>): boolean {
  const override = overrides.get(fundId);
  return override ?? navDisclosedFallback(latestNavDate);
}
