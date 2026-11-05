// 2026-11-05（使用者核准）：write-probe「同一次故障只推送一次，持續故障超過1小時最多再提醒一次，
// 恢復時不推送」的純判斷邏輯，抽出來讓route.ts的DB查詢結果可以直接餵進來單元測試——route.ts本身
// 連DB、沒辦法在不寫入正式環境的前提下直接測試這段判斷邏輯。
export const REMINDER_AFTER_MS = 60 * 60 * 1000; // 1小時

export type RecentRun = { status: string; startedAt: string; reminderSent?: boolean };

export type WriteProbeIncidentDecision = {
  isNewIncident: boolean;
  incidentStartedAt: Date;
  reminderAlreadySent: boolean;
  shouldNotify: boolean;
  /** 這次finishRun要寫進details的reminder_sent值。 */
  reminderSentToWrite: boolean;
};

/** recentRunsNewestFirst：同一個job最近的run，由新到舊排序，不含這次正在處理的run本身。 */
export function decideWriteProbeNotification(recentRunsNewestFirst: RecentRun[], now: Date): WriteProbeIncidentDecision {
  const failureStreak: RecentRun[] = [];
  for (const r of recentRunsNewestFirst) {
    if (r.status === "FAILED") failureStreak.push(r);
    else break;
  }
  const isNewIncident = failureStreak.length === 0;
  const incidentStartedAt = isNewIncident ? now : new Date(failureStreak[failureStreak.length - 1].startedAt);
  const reminderAlreadySent = failureStreak.some((r) => r.reminderSent === true);
  const elapsedMs = now.getTime() - incidentStartedAt.getTime();
  const shouldSendOneHourReminder = !isNewIncident && !reminderAlreadySent && elapsedMs >= REMINDER_AFTER_MS;
  return {
    isNewIncident,
    incidentStartedAt,
    reminderAlreadySent,
    shouldNotify: isNewIncident || shouldSendOneHourReminder,
    reminderSentToWrite: shouldSendOneHourReminder || reminderAlreadySent,
  };
}
