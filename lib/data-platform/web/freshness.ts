import type { FreshnessStatus } from "./types.ts";
import { getLatestConfirmedTwTradingDate } from "../../market-calendar/twseHolidayCalendar.ts";

export type FreshnessPolicy = "MARKET_DAY" | "PUBLICATION_AWARE" | "CONTINUOUS";

function latestCompletedBusinessDay(now: Date): Date {
  const result = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = result.getUTCDay();
  if (day === 0) result.setUTCDate(result.getUTCDate() - 2);
  if (day === 6) result.setUTCDate(result.getUTCDate() - 1);
  return result;
}

export function freshnessStatus(asOf: Date | null | undefined, policy: FreshnessPolicy, now = new Date()): FreshnessStatus {
  if (!asOf) return "UNKNOWN";
  const ageMs = now.getTime() - asOf.getTime();
  if (policy === "PUBLICATION_AWARE") return ageMs <= 45 * 86_400_000 ? "HEALTHY_WAITING" : "STALE";
  if (policy === "CONTINUOUS") return ageMs <= 24 * 3_600_000 ? "CURRENT" : "STALE";
  return asOf.getTime() >= latestCompletedBusinessDay(now).getTime() ? "CURRENT" : "STALE";
}

// 2026-10-24（使用者核准定案，見CLAUDE.md「資料新鮮度判斷」）: TWSE/TPEx 掛牌商品的 MARKET_DAY
// 新鮮度不跟「今天」或猜出來的應該交易日比較（freshnessStatus 的 latestCompletedBusinessDay
// 只跳過週六週日，不知道颱風等臨時休市）——跟兩邊交易所官方 live confirm 的「實際最新一天有
// 資料的日期」比較。官方自己都還沒更新，我們現有的資料就還算最新，不算過期。非 TWSE/TPEx 的
// 商品（例如美股 ETF）或非 MARKET_DAY policy，一律退回原本的 freshnessStatus()。
export async function twAwareFreshnessStatus(exchange: string | null | undefined, asOf: Date | null | undefined, policy: FreshnessPolicy, now = new Date()): Promise<FreshnessStatus> {
  if (policy !== "MARKET_DAY" || (exchange !== "TWSE" && exchange !== "TPEx")) return freshnessStatus(asOf, policy, now);
  if (!asOf) return "UNKNOWN";
  const confirmed = await getLatestConfirmedTwTradingDate(now);
  if (confirmed === null) return "CURRENT"; // inconclusive live check -- don't guess stale
  return asOf.toISOString().slice(0, 10) >= confirmed ? "CURRENT" : "STALE";
}
