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
import { fetchTdccNavCsv, parseTdccNavCsv, excludeOverlapWithYahooMapping, filterNewerThanStored, filterNewerThanStoredByCode, indexByCode, TDCC_NAV_SOURCE } from "@/lib/offshore-nav-sync/tdccBatchSource";
import { writeTdccNavBatch } from "@/lib/offshore-nav-sync/navWriter";
import { loadMapping } from "@/lib/offshore-nav-sync/mapping";

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

  // Task X8: no more `updated_at < 14 days ago` filter here -- every data_provider='yahoo' fund is a
  // candidate every run, and filterNewerThanStored() below (plus navWriter.ts's own SQL-level guard)
  // decides writability purely by comparing the CSV's navDate against the fund's own stored
  // latest_nav_date, so a fund with a genuinely newer NAV is never stuck waiting out a staleness
  // window again.
  const [rawCandidateFunds, codeCandidateFunds, yahooMapping] = await Promise.all([
    query(`SELECT id, name, latest_nav_date::text AS "latestNavDate" FROM funds WHERE data_provider = 'yahoo'`, []),
    // Task (this round): fund 107 and 24 siblings (data_provider='tdcc-offshore') were excluded from
    // every NAV pipeline — this query's old WHERE clause never selected them at all, even though
    // their NAV is sitting in this exact CSV right now. These funds carry TDCC's own 基金代碼
    // directly in `funds.code` (not a name match, which is why the 'yahoo' population above uses
    // name — those funds have no code), so they get their own code-matched branch below rather than
    // being folded into the name-matched population.
    query(`SELECT id, code, latest_nav_date::text AS "latestNavDate" FROM funds WHERE data_provider = 'tdcc-offshore' AND code IS NOT NULL`, []),
    loadMapping(query),
  ]);
  const candidateFunds = excludeOverlapWithYahooMapping(rawCandidateFunds, yahooMapping.map((m) => m.fundId));

  const csvText = await fetchTdccNavCsv();
  const byName = parseTdccNavCsv(csvText);
  const byCode = indexByCode(byName);

  const nameMatchedCount = candidateFunds.filter((f) => byName.has(f.name)).length;
  const codeMatchedCount = codeCandidateFunds.filter((f) => byCode.has(f.code)).length;
  const nameCandidates = filterNewerThanStored(candidateFunds, byName);
  const codeCandidates = filterNewerThanStoredByCode(codeCandidateFunds, byCode);
  const candidates = [...nameCandidates, ...codeCandidates];
  const matched = candidates.length;

  const result = writeEnabled
    ? await writeTdccNavBatch(query, candidates, new Date().toISOString())
    : { written: 0, writeErrorCount: 0, writeErrorFundIds: [] };

  await finishRun(runId, JOB, TDCC_NAV_SOURCE, startedMs, {
    status: "COMPLETED", attempted: candidateFunds.length + codeCandidateFunds.length, completed: result.written, inserted: result.written,
    updated: 0, failed: result.writeErrorCount, retryableFailures: 0, checkpointAfter: null,
    details: {
      writeEnabled, rawCandidateCount: rawCandidateFunds.length, yahooMappingExcludedCount: rawCandidateFunds.length - candidateFunds.length,
      candidateCount: candidateFunds.length, csvUniqueFundNames: byName.size, nameMatchedCount, writableRowCount: nameCandidates.length,
      codeCandidateCount: codeCandidateFunds.length, codeMatchedCount, codeWritableRowCount: codeCandidates.length,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, writeEnabled,
    rawCandidateCount: rawCandidateFunds.length, yahooMappingExcludedCount: rawCandidateFunds.length - candidateFunds.length,
    candidateCount: candidateFunds.length, csvUniqueFundNames: byName.size, nameMatchedCount,
    writableRowCount: nameCandidates.length, codeCandidateCount: codeCandidateFunds.length, codeMatchedCount, codeWritableRowCount: codeCandidates.length,
    written: result.written, writeErrorCount: result.writeErrorCount,
  });
}
