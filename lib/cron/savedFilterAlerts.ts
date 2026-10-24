// 選股反查：儲存條件並在符合時提醒（2026-10-24，使用者核准定案）。不硬接既有的
// UserCriteria/CriteriaCondition系統（上一階段已經查過，那套是為不同流程設計的，schema勉強接會
// 很脆弱）——改成重用已經在跑、已經VERIFIED真的會推播的WatchlistAlertRule/
// WatchlistAlertOccurrence/alert-dispatch這條既有管線（「跟一般提醒同一套」，使用者這次明確
// 指示）：每個開啟提醒的SavedFilter，比對這次跟上次（存在filters.lastMatchedTickers裡）的符合
// 清單，有新股票符合就建一筆occurrence，交給既有的alert-dispatch cron送推播，不用另外接新的
// 推播通道。
import { prisma } from "@/lib/prisma";
import { createHash } from "node:crypto";
import { parseScreenerConditions, runStockScreenerQuery } from "@/lib/screener/stockScreener";

type SavedFilterState = {
  query?: string;
  market?: string | null;
  alertEnabled?: boolean;
  lastMatchedTickers?: string[];
  ruleId?: string;
  ruleVersionId?: string;
};

export type SavedFilterAlertResult = { attempted: number; newMatchesFound: number; occurrencesCreated: number; failed: number };

export async function runSavedFilterAlerts(writeEnabled: boolean): Promise<SavedFilterAlertResult> {
  const result: SavedFilterAlertResult = { attempted: 0, newMatchesFound: 0, occurrencesCreated: 0, failed: 0 };
  const filters = await prisma.savedFilter.findMany({ where: { assetType: "STOCK" } });

  for (const sf of filters) {
    const state = (sf.filters ?? {}) as SavedFilterState;
    if (!state.alertEnabled || !state.query) continue;
    result.attempted++;

    try {
      const params = new URLSearchParams(state.query);
      const conditions = parseScreenerConditions(params);
      if (conditions.length === 0) continue;
      const market = state.market === "TW" || state.market === "US" ? state.market : null;
      const rows = await runStockScreenerQuery(conditions, market, 50);
      const currentTickers = rows.map((r) => r.ticker);
      const previousTickers = new Set(state.lastMatchedTickers ?? []);
      const newRows = rows.filter((r) => !previousTickers.has(r.ticker));

      if (newRows.length > 0) {
        result.newMatchesFound += newRows.length;
        if (writeEnabled) {
          let ruleId = state.ruleId;
          let ruleVersionId = state.ruleVersionId;
          if (!ruleId || !ruleVersionId) {
            const rule = await prisma.watchlistAlertRule.create({
              data: { ownerUserId: sf.userId, assetType: "STOCK", canonicalAssetId: null, ruleFamily: "TECHNICAL", ruleKind: "SAVED_FILTER_MATCH", scopeType: "MULTI_ASSET", deliveryChannels: ["APP_PUSH"], status: "ACTIVE" },
            });
            const version = await prisma.watchlistAlertRuleVersion.create({
              data: { ruleId: rule.id, versionNumber: 1, parameters: { savedFilterId: sf.id, query: state.query, market }, effectiveFrom: new Date(), createdBy: sf.userId },
            });
            await prisma.watchlistAlertRule.update({ where: { id: rule.id }, data: { currentVersionId: version.id } });
            ruleId = rule.id;
            ruleVersionId = version.id;
          }
          const today = new Date().toISOString().slice(0, 10);
          for (const row of newRows) {
            const dedupeKey = createHash("sha256").update(`savedFilter:${sf.id}:${row.ticker}:${today}`).digest("hex");
            try {
              await prisma.watchlistAlertOccurrence.create({
                data: {
                  ruleId, ruleVersionId, assetType: "STOCK", canonicalAssetId: row.ticker,
                  triggeredAt: new Date(), triggerType: "SCREENER_MATCH", severity: "INFO",
                  payload: { savedFilterId: sf.id, savedFilterName: sf.name, ticker: row.ticker, name: row.name },
                  source: "savedFilterAlerts.v1", inputAsOfDate: new Date(), inputObservedAt: new Date(), evaluationAt: new Date(),
                  freshnessStatus: "CURRENT", verificationStatus: "VERIFIED", dedupeKey, status: "TRIGGERED",
                },
              });
              result.occurrencesCreated++;
            } catch (e) {
              if (!(e instanceof Error && e.message.includes("dedupeKey"))) result.failed++;
            }
          }
          await prisma.savedFilter.update({
            where: { id: sf.id },
            data: { filters: { ...state, lastMatchedTickers: currentTickers, ruleId, ruleVersionId }, lastRunAt: new Date(), runCount: { increment: 1 } },
          });
        }
      } else if (writeEnabled) {
        // 沒有新符合也要更新lastRunAt/runCount（新鮮度追蹤：使用者/支援人員可以看出這個條件
        // 是不是真的每天有在跑，不是卡住沒動靜）。lastMatchedTickers本身不會變。
        await prisma.savedFilter.update({ where: { id: sf.id }, data: { lastRunAt: new Date(), runCount: { increment: 1 } } });
      }
    } catch {
      result.failed++;
    }
  }
  return result;
}
