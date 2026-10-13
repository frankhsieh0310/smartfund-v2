import { getForumPool } from "../pgPool.ts";
import { logModerationAction } from "./moderation.ts";

export class AlreadyReportedError extends Error {}

const AUTO_HIDE_REPORT_THRESHOLD = 3;

export type ReportTargetType = "POST" | "REPLY";

/**
 * Records a report and, once a target accumulates AUTO_HIDE_REPORT_THRESHOLD distinct reporters,
 * auto-hides it (status HIDDEN) and writes an append-only moderation_log row with actor 'SYSTEM'.
 * Runs in one transaction so the report-count increment and the auto-hide decision are consistent
 * under concurrent reports.
 */
export async function reportContent(params: {
  targetType: ReportTargetType;
  targetId: string;
  reporterId: string;
  reason: string;
}): Promise<{ autoHidden: boolean }> {
  const client = await getForumPool().connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO forum.reports (target_type, target_id, reporter_id, reason) VALUES ($1, $2, $3, $4)`,
      [params.targetType, params.targetId, params.reporterId, params.reason],
    );

    const table = params.targetType === "POST" ? "forum.posts" : "forum.replies";
    const countResult = await client.query<{ report_count: number }>(
      `UPDATE ${table} SET report_count = report_count + 1 WHERE id = $1 RETURNING report_count`,
      [params.targetId],
    );
    const reportCount = Number(countResult.rows[0]?.report_count ?? 0);

    let autoHidden = false;
    if (reportCount >= AUTO_HIDE_REPORT_THRESHOLD) {
      const updateResult = await client.query(
        `UPDATE ${table} SET status = 'HIDDEN', updated_at = now() WHERE id = $1 AND status NOT IN ('HIDDEN', 'DELETED')`,
        [params.targetId],
      );
      if ((updateResult.rowCount ?? 0) > 0) {
        autoHidden = true;
        await logModerationAction(client, {
          actionType: "HIDE",
          targetType: params.targetType,
          targetRef: params.targetId,
          actorRef: "SYSTEM",
          reportCountAtAction: reportCount,
        });
      }
    }

    await client.query("COMMIT");
    return { autoHidden };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e instanceof Error && "code" in e && (e as { code?: string }).code === "23505") {
      throw new AlreadyReportedError("你已經檢舉過這則內容了。");
    }
    throw e;
  } finally {
    client.release();
  }
}
