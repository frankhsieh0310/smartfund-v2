// Batch-updates the ~3,711 "approved by TDCC but not syncing" offshore funds (found by this round's
// QA audit -- see docs/specs/offshore-fund-classification.md) from TDCC's own official single-file
// open-data NAV export (lib/offshore-nav-sync/tdccBatchSource.ts), instead of scraping Yahoo奇摩
// individually for each one (~3.3s/fund x 3,711 funds would be 1.4-3.4 hours/day, see that same doc).
// One HTTP GET covers the whole universe, so this is cheap enough to run on Vercel on a normal cron
// schedule -- no desktop Task Scheduler fallback needed.
//
// Only touches funds this job can identify with HIGH confidence: an EXACT fund-name match against the
// CSV, scoped to funds.data_provider = 'yahoo' (the already-known stale population) so this never
// touches a fund some other pipeline owns. Uses the SAME fund_history + funds.latest_nav* write target
// as the existing offshore-nav-sync (lib/offshore-nav-sync/navWriter.ts's forward-only-date rule), via
// a dedicated writeTdccNavBatch that tags last_nav_source = 'TDCC_OPENDATA_NAV' instead of
// 'YAHOO_FUND_PRICE_HISTORY', so the two sources are never confused in later audits.
//
// SHADOW MODE BY DEFAULT: unless OFFSHORE_NAV_TDCC_SYNC_WRITE is exactly "on", fetches/matches but
// writes nothing. Scheduled twice daily at 10:30/18:30 Taipei (vercel.json) -- opening the write path
// is still a separate, explicit user decision made after confirming a clean first shadow run. Manually
// cross-checked 2 funds live against fundclear.com.tw's own search UI 2026-10-14 (both exact match) --
// see lib/offshore-nav-sync/tdccBatchSource.ts's header comment.
//
// Fund-ownership split from offshore-nav-sync (round-4, user-approved): offshore-nav-sync's own
// 876-fund Yahoo mapping (lib/offshore-nav-sync/mapping.ts's loadMapping()) is the pre-existing,
// actively-synced population -- this job explicitly excludes every fundId in that mapping, so the same
// fund is never written by both pipelines. See lib/offshore-nav-sync/tdccBatchSource.ts's
// excludeOverlapWithYahooMapping() and its test.
import { prisma } from "@/lib/prisma";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { fetchTdccNavCsv, parseTdccNavCsv, excludeOverlapWithYahooMapping, TDCC_NAV_SOURCE } from "@/lib/offshore-nav-sync/tdccBatchSource";
import { writeTdccNavBatch } from "@/lib/offshore-nav-sync/navWriter";
import { loadMapping } from "@/lib/offshore-nav-sync/mapping";
import type { OffshoreNavCandidate } from "@/lib/offshore-nav-sync/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "OFFSHORE_NAV_TDCC_SYNC";
const query = (sql: string, params: any[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function isWriteEnabled(): boolean {
  return process.env.OFFSHORE_NAV_TDCC_SYNC_WRITE === "on";
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabled = isWriteEnabled();
  const today = new Date().toISOString().slice(0, 10);

  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: TDCC_NAV_SOURCE, runKey: `${JOB}:${today}`, universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true });

  const [rawCandidateFunds, yahooMapping] = await Promise.all([
    query(`SELECT id, name FROM funds WHERE data_provider = 'yahoo' AND updated_at < CURRENT_DATE - INTERVAL '14 days'`, []),
    loadMapping(query),
  ]);
  const candidateFunds = excludeOverlapWithYahooMapping(rawCandidateFunds, yahooMapping.map((m) => m.fundId));

  const csvText = await fetchTdccNavCsv();
  const byName = parseTdccNavCsv(csvText);

  const candidates: OffshoreNavCandidate[] = [];
  let matched = 0;
  for (const f of candidateFunds) {
    const row = byName.get(f.name);
    if (row) {
      matched++;
      candidates.push({ fundId: f.id, navDate: row.navDate, nav: row.nav });
    }
  }

  const result = writeEnabled
    ? await writeTdccNavBatch(query, candidates, new Date().toISOString())
    : { written: 0, writeErrorCount: 0, writeErrorFundIds: [] };

  await finishRun(runId, JOB, TDCC_NAV_SOURCE, startedMs, {
    status: "COMPLETED", attempted: candidateFunds.length, completed: result.written, inserted: result.written,
    updated: 0, failed: result.writeErrorCount, retryableFailures: 0, checkpointAfter: null,
    details: {
      writeEnabled, rawStaleCandidateCount: rawCandidateFunds.length, yahooMappingExcludedCount: rawCandidateFunds.length - candidateFunds.length,
      staleCandidateCount: candidateFunds.length, csvUniqueFundNames: byName.size, matched, writableRowCount: matched,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, writeEnabled,
    rawStaleCandidateCount: rawCandidateFunds.length, yahooMappingExcludedCount: rawCandidateFunds.length - candidateFunds.length,
    staleCandidateCount: candidateFunds.length, csvUniqueFundNames: byName.size, matched,
    writableRowCount: matched, written: result.written, writeErrorCount: result.writeErrorCount,
  });
}
