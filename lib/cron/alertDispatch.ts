// Item 15 dispatcher: sends TRIGGERED occurrences (written by alertEvaluate.ts) that have no
// delivery attempt yet to the rule owner's enabled APP_PUSH profiles (WatchlistNotificationProfile
// -- the same table app/api/push/devices/route.ts already writes Expo tokens into, so no new
// device-registration plumbing is needed). Reuses the Expo Push transport lib/consensus/push.ts
// already built and running for 大佬雷達 -- not a new integration, same provider, same account.
import { prisma } from "@/lib/prisma";
import { sendExpoPush, ticketToStatus, type PushMessage } from "@/lib/consensus/push";

export type AlertDispatchResult = { attempted: number; delivered: number; failed: number; noDevice: number };

export async function runAlertDispatch(writeEnabled: boolean): Promise<AlertDispatchResult> {
  // WatchlistAlertOccurrence has no declared relation to WatchlistAlertDeliveryAttempt in the Prisma
  // schema, so the "not yet delivered" filter is a manual anti-join rather than a relation filter.
  const recentOccurrences = await prisma.watchlistAlertOccurrence.findMany({
    where: { status: "TRIGGERED" },
    orderBy: { triggeredAt: "asc" },
    take: 500,
    select: { id: true, ruleId: true, assetType: true, canonicalAssetId: true, triggerValue: true, triggeredAt: true },
  });
  const alreadyAttempted = recentOccurrences.length
    ? new Set((await prisma.watchlistAlertDeliveryAttempt.findMany({ where: { alertOccurrenceId: { in: recentOccurrences.map((o) => o.id) } }, select: { alertOccurrenceId: true } })).map((a) => a.alertOccurrenceId))
    : new Set<string>();
  const pending = recentOccurrences.filter((o) => !alreadyAttempted.has(o.id)).slice(0, 200);
  const result: AlertDispatchResult = { attempted: 0, delivered: 0, failed: 0, noDevice: 0 };
  if (pending.length === 0) return result;

  const ruleIds = [...new Set(pending.map((p) => p.ruleId))];
  const rules = await prisma.watchlistAlertRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, ownerUserId: true } });
  const ownerByRule = new Map(rules.map((r) => [r.id, r.ownerUserId]));

  for (const occurrence of pending) {
    result.attempted++;
    if (!writeEnabled) continue;
    const ownerUserId = ownerByRule.get(occurrence.ruleId);
    if (!ownerUserId) continue;
    const profiles = await prisma.watchlistNotificationProfile.findMany({
      where: { userId: ownerUserId, channelType: "APP_PUSH", enabled: true },
      select: { id: true, destinationReference: true },
    });
    if (profiles.length === 0) { result.noDevice++; continue; }

    const message: PushMessage = {
      to: "", // set per-profile below
      title: "配息提醒",
      body: occurrence.triggerValue != null ? `您追蹤的標的目前數值為 ${occurrence.triggerValue}，已達到您設定的提醒條件。` : "您追蹤的標的已達到您設定的提醒條件。",
      data: { type: "CONSENSUS_FLIP", symbol: occurrence.canonicalAssetId ?? "", person_id: "", flip_signal_id: null, alert_candidate_id: occurrence.id, route: "/alerts", created_at: occurrence.triggeredAt.toISOString() },
    };

    for (const profile of profiles) {
      const attemptNumber = 1;
      try {
        const tickets = await sendExpoPush([{ ...message, to: profile.destinationReference }]);
        const status = ticketToStatus(tickets[0] ?? { status: "error" });
        await prisma.watchlistAlertDeliveryAttempt.create({
          data: {
            alertOccurrenceId: occurrence.id, profileId: profile.id, channelType: "APP_PUSH", attemptNumber,
            attemptedAt: new Date(), deliveredAt: status === "DELIVERED" ? new Date() : null, status,
            providerMessageId: tickets[0]?.id ?? null, failureCode: status !== "DELIVERED" ? status : null,
          },
        });
        if (status === "DELIVERED") result.delivered++; else result.failed++;
      } catch (e) {
        result.failed++;
        await prisma.watchlistAlertDeliveryAttempt.create({
          data: { alertOccurrenceId: occurrence.id, profileId: profile.id, channelType: "APP_PUSH", attemptNumber, attemptedAt: new Date(), status: "FAILED", failureReason: (e as Error).message },
        }).catch(() => {});
      }
    }
  }
  return result;
}
