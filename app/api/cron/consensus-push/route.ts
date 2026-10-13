// Cloud consensus push worker (Phase 8) — deliver viewpoint-flip alerts. No AI.
//
// Per invocation:
//   undelivered push-eligible alert candidates (bounded)
//     -> resolve eligible installations (notifications_enabled, valid token, category pref,
//        watchlist_only -> symbol subscription match, no existing delivery row)
//     -> write an in-app notification for EVERY eligible install (push permission not required)
//     -> for installs with a valid push_token: create a PENDING delivery + Expo push message
//   send via Expo Push Service, persist DELIVERED / INVALID_TOKEN / FAILED,
//   mark invalid installation tokens, mark candidate.delivered_at + flip.notified_at when settled.
// Idempotent: unique(alert_candidate_id, installation_id) on deliveries + on in-app notifications;
// a candidate that is fully settled is excluded from the next run. Running 3x => stable counts.
//
// Trigger: workflow step after consensus-flips -> GET Authorization: Bearer <CRON_SECRET>.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import {
  buildFlipCopy, sendExpoPush, ticketToStatus, hashToken, type PushMessage,
  MAX_ALERTS_PER_RUN, MAX_DELIVERIES_PER_RUN,
} from "@/lib/consensus/push";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_CONSENSUS_PUSH";
const CP_KEY = "consensus-push";
const query = <T = never>(sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<T[]>;

type Candidate = {
  id: string; flip_signal_id: string; person_id: string; symbol: string;
  title: string; body: string; flip_type: string; person: string; strength: string; relation_type: string;
};
type Install = { installation_id: string; push_token: string | null; owner_user_id: string | null };

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const runKey = `consensus-push:${new Date().toISOString().slice(0, 13)}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "CONSENSUS", runKey, universeCount: 0, batchSize: MAX_ALERTS_PER_RUN, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, task: "consensus-push", skipped: true });

  try {
    const cp = await readCheckpoint(CP_KEY);
    const candidates = (await query(
      `select ac.id, ac.flip_signal_id, ac.person_id, ac.symbol, ac.title, ac.body,
              f.flip_type, p.display_name as person, f.strength, f.relation_type
         from consensus_alert_candidates ac
         join consensus_flip_signals f on f.id = ac.flip_signal_id
         join consensus_people p on p.id = ac.person_id
        where ac.delivered_at is null
          and f.push_eligible and f.strength = 'STRONG' and f.relation_type = 'DIRECT'
          and coalesce(f.source_grade,'C') in ('A','B')
        order by ac.created_at asc
        limit ${MAX_ALERTS_PER_RUN}`,
      [],
    )) as unknown as Candidate[];

    const pushMessages: PushMessage[] = [];
    const messageMeta: Array<{ candidateId: string; installationId: string }> = [];
    let inappCreated = 0, deliveriesCreated = 0, skippedNoToken = 0;

    for (const c of candidates) {
      if (deliveriesCreated >= MAX_DELIVERIES_PER_RUN) break;
      const installs = (await query(
        `select i.installation_id, i.push_token, i.owner_user_id
           from consensus_push_installations i
          where i.notifications_enabled and not i.invalid_token
            and coalesce(i.preferences->>'flip','true') = 'true'
            and (
              coalesce(i.preferences->>'watchlist_only','true') <> 'true'
              or exists (select 1 from consensus_push_symbol_subscriptions s
                          where s.installation_id = i.installation_id and s.is_active and s.symbol = $1)
            )
            and not exists (select 1 from consensus_inapp_notifications n
                             where n.installation_id = i.installation_id and n.alert_candidate_id = $2)`,
        [c.symbol, c.id],
      )) as unknown as Install[];

      const copy = buildFlipCopy({ symbol: c.symbol, person: c.person, flipType: c.flip_type });
      for (const inst of installs) {
        if (deliveriesCreated >= MAX_DELIVERIES_PER_RUN) break;
        // in-app record for every eligible install
        await query(
          `insert into consensus_inapp_notifications
             (installation_id, owner_user_id, category, symbol, title, body, route, flip_signal_id, alert_candidate_id)
           values ($1,$2,'CONSENSUS_FLIP',$3,$4,$5,$6::jsonb,$7,$8)
           on conflict (installation_id, alert_candidate_id) do nothing`,
          [inst.installation_id, inst.owner_user_id, c.symbol, copy.title, copy.body,
           JSON.stringify({ screen: "consensus", symbol: c.symbol, flip_signal_id: c.flip_signal_id }),
           c.flip_signal_id, c.id],
        );
        inappCreated++;

        if (!inst.push_token) { skippedNoToken++; continue; }
        const ins = (await query<{ id: string }>(
          `insert into consensus_push_deliveries (alert_candidate_id, installation_id, push_token_hash, status, attempt_count)
           values ($1,$2,$3,'PENDING',1)
           on conflict (alert_candidate_id, installation_id) do nothing
           returning id`,
          [c.id, inst.installation_id, hashToken(inst.push_token)],
        )) as unknown as Array<{ id: string }>;
        if (!ins[0]) continue; // already had a delivery row -> no double push
        deliveriesCreated++;
        pushMessages.push({
          to: inst.push_token,
          title: copy.title,
          body: copy.body,
          channelId: "consensus-flip",
          data: {
            type: "CONSENSUS_FLIP", symbol: c.symbol, person_id: c.person_id,
            flip_signal_id: c.flip_signal_id, alert_candidate_id: c.id,
            route: `consensus/${c.symbol}`, created_at: new Date().toISOString(),
          },
        });
        messageMeta.push({ candidateId: c.id, installationId: inst.installation_id });
      }
    }

    // send in chunks of 100
    let delivered = 0, failed = 0, invalidTokens = 0;
    for (let i = 0; i < pushMessages.length; i += 100) {
      const chunk = pushMessages.slice(i, i + 100);
      const meta = messageMeta.slice(i, i + 100);
      let tickets;
      try { tickets = await sendExpoPush(chunk); }
      catch (e) {
        // transport failure -> leave deliveries PENDING for the next run
        for (const m of meta) await query(
          `update consensus_push_deliveries set error = $3, attempt_count = attempt_count + 1
            where alert_candidate_id = $1 and installation_id = $2`,
          [m.candidateId, m.installationId, `send error: ${(e as Error).message}`.slice(0, 240)],
        );
        continue;
      }
      for (let k = 0; k < chunk.length; k++) {
        const t = tickets[k] ?? { status: "error" as const, message: "no ticket" };
        const status = ticketToStatus(t);
        const m = meta[k];
        await query(
          `update consensus_push_deliveries
              set status = $3, provider_message_id = $4, error = $5,
                  delivered_at = case when $3 = 'DELIVERED' then now() else delivered_at end
            where alert_candidate_id = $1 and installation_id = $2`,
          [m.candidateId, m.installationId, status, t.id ?? null, t.status === "error" ? (t.message ?? t.details?.error ?? "error") : null],
        );
        if (status === "DELIVERED") delivered++;
        else if (status === "INVALID_TOKEN") {
          invalidTokens++;
          await query(`update consensus_push_installations set invalid_token = true, notifications_enabled = false, updated_at = now() where installation_id = $1`, [m.installationId]);
        } else failed++;
      }
    }

    // settle candidates whose deliveries are all resolved (or which had 0 token deliveries)
    const settled = (await query<{ id: string; flip_signal_id: string }>(
      `update consensus_alert_candidates ac set delivered_at = now()
         from consensus_flip_signals f
        where f.id = ac.flip_signal_id and ac.delivered_at is null
          and not exists (select 1 from consensus_push_deliveries d
                           where d.alert_candidate_id = ac.id and d.status in ('PENDING'))
          and exists (select 1 from consensus_inapp_notifications n where n.alert_candidate_id = ac.id)
        returning ac.id, ac.flip_signal_id`,
      [],
    )) as unknown as Array<{ id: string; flip_signal_id: string }>;
    for (const s of settled) {
      await query(`update consensus_flip_signals set notified_at = coalesce(notified_at, now()) where id = $1`, [s.flip_signal_id]);
    }

    const nowIso = new Date().toISOString();
    await writeCheckpoint(JOB, CP_KEY, runId, {
      lastSymbol: nowIso, processed: (cp?.processed ?? 0) + candidates.length,
      succeeded: (cp?.succeeded ?? 0) + delivered, failed: (cp?.failed ?? 0) + failed,
    });

    const details = {
      candidates: candidates.length, inappCreated, deliveriesCreated, skippedNoToken,
      pushSent: pushMessages.length, delivered, failed, invalidTokens, settledCandidates: settled.length,
      expoConfigured: Boolean(process.env.EXPO_ACCESS_TOKEN) || "no-token-ok", runtimeMs: Date.now() - started,
    };
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: "COMPLETED", attempted: candidates.length, completed: delivered + inappCreated,
      inserted: deliveriesCreated, updated: settled.length, failed, retryableFailures: failed,
      checkpointAfter: null, details,
    });
    return Response.json({ ok: true, task: "consensus-push", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1,
      retryableFailures: 1, checkpointAfter: null, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "consensus-push", error: (e as Error).message }, { status: 500 });
  }
}
