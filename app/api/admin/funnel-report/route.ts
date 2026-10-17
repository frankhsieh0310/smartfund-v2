// 2026-10-18 固定範圍第 5 項: 使用統計漏斗 report. 內部專用 (同 cron 端點的 Bearer CRON_SECRET 慣例，
// 不是公開 App 端點，不建新的認證機制). 依來源(邀請碼/廣告管道/自然/不明)與加入週次(以該
// device_id/user_id 的 FIRST_OPEN 事件所在週為 cohort)，統計每一步驟到達人數：
// 首次開啟 -> 完成組合穿透 -> 儲存組合 -> 開始試用 -> 首次付款 -> 第二次付款(僅月繳).
// "第二次付款僅月繳": SECOND_PAYMENT_MONTHLY 本身就是只在月繳續訂時才寫入的事件 (見
// app/api/mobile/funnel-event 的呼叫端，年繳續訂永遠不會送這個事件)，這裡不用再額外過濾。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";

const headers = { "Cache-Control": "no-store" };

const FUNNEL_SQL = `
  WITH identity AS (
    -- one row per device (or user, when known) with its FIRST_OPEN cohort week and acquisition source
    SELECT DISTINCT ON (coalesce(user_id::text, device_id))
      coalesce(user_id::text, device_id) AS identity_key,
      date_trunc('week', occurred_at)::date AS cohort_week,
      source_type
    FROM usage_funnel_events
    WHERE event_type = 'FIRST_OPEN'
    ORDER BY coalesce(user_id::text, device_id), occurred_at ASC
  ), steps AS (
    SELECT i.cohort_week, i.source_type, e.event_type,
      count(DISTINCT coalesce(e.user_id::text, e.device_id))::int AS reached
    FROM identity i
    JOIN usage_funnel_events e ON coalesce(e.user_id::text, e.device_id) = i.identity_key
    GROUP BY i.cohort_week, i.source_type, e.event_type
  )
  SELECT cohort_week::text, source_type, event_type, reached FROM steps
  ORDER BY cohort_week DESC, source_type, event_type`;

const EVENT_ORDER = ["FIRST_OPEN", "COMPLETED_OVERLAP", "SAVED_PORTFOLIO", "TRIAL_STARTED", "FIRST_PAYMENT", "SECOND_PAYMENT_MONTHLY"];

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const rows = await prisma.$queryRawUnsafe<Array<{ cohort_week: string; source_type: string; event_type: string; reached: number }>>(FUNNEL_SQL);

  const byCohortSource = new Map<string, { cohortWeek: string; sourceType: string; steps: Record<string, number> }>();
  for (const r of rows) {
    const key = `${r.cohort_week}:${r.source_type}`;
    let entry = byCohortSource.get(key);
    if (!entry) {
      entry = { cohortWeek: r.cohort_week, sourceType: r.source_type, steps: Object.fromEntries(EVENT_ORDER.map((e) => [e, 0])) };
      byCohortSource.set(key, entry);
    }
    entry.steps[r.event_type] = r.reached;
  }

  return Response.json({
    ok: true,
    generated_at: new Date().toISOString(),
    eventOrder: EVENT_ORDER,
    note: "下載數不在此報表——下載數只能從 App Store Connect／Google Play Console 取得，與此處的「首次開啟」是不同的數字，需另外手動填入，不自動推算。",
    cohorts: [...byCohortSource.values()].sort((a, b) => b.cohortWeek.localeCompare(a.cohortWeek) || a.sourceType.localeCompare(b.sourceType)),
  }, { headers });
}
