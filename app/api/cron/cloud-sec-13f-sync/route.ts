// CLOUD_SEC_13F_SYNC — rebuilds the 13F ingestion pipeline that used to exist as a one-time script
// (scripts/data/institutional-holdings/*, now deleted — confirmed 2026-10-29 nothing in this repo
// still writes institutional_holdings) into a real recurring cron, scoped to the existing small,
// curated institutional_institutions universe (16 rows, CIKs already resolved by a prior manual
// load) rather than SEC's full 13F filer population.
//
// Runs daily (cheap no-op on every day that isn't right after a quarterly deadline): computes the
// most recent quarter-end whose 45-day 13F deadline has passed (2/14, 5/15, 8/14, 11/14 — see
// lib/cloud-ingestion/sec13fSync.ts), and for each institution without a filing on file for that
// period, fetches it straight from SEC EDGAR (never a scrape of a third party) and writes it into the
// SAME three-table shape the historical rows already use: institutional_filings ->
// institutional_portfolio_snapshots -> institutional_holdings, with unresolved cusips queued into the
// existing institutional_security_mapping_queue for the existing reconciliation process to pick up —
// this does not duplicate that matching logic.
//
// SHADOW MODE BY DEFAULT: unless SEC_13F_SYNC_WRITE is exactly "on", fetches and parses but writes
// nothing (same pattern as every other sync job here). All 16 institutions are small enough to check
// in a single invocation; only institutions with a genuinely new filing for the target period cost
// the extra 2 requests (filing index + information table) rather than just the 1 (submissions.json).
//
// SEC fair-access rules enforced in lib/cloud-ingestion/sec13fSync.ts: contact-email User-Agent,
// ~300ms between requests (well under the 10 req/sec limit), and a 403/429/5xx stops that
// institution's attempt rather than retrying or working around it (CLAUDE.md's standing rule).
import { randomUUID, createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { isSec13fSyncWriteEnabled } from "@/lib/cron/sec13fWriteGate";
import {
  latestExpectedReportingPeriod, recentReportingPeriods, findLatest13FFiling, findInformationTableUrl,
  parseInformationTable, sleep, SecHttpError, REQUEST_DELAY_MS,
} from "@/lib/cloud-ingestion/sec13fSync";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_SEC_13F_SYNC";
const CHECKPOINT_KEY = "cloud-sec-13f-sync:cursor";
const TIME_BUDGET_MS = 240_000;

type Institution = { id: string; cik: string; displayName: string };

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabled = isSec13fSyncWriteEnabled();
  const targetPeriod = latestExpectedReportingPeriod(new Date());

  const institutions = await prisma.$queryRawUnsafe<Institution[]>(
    `SELECT id, cik, display_name AS "displayName" FROM institutional_institutions WHERE cik IS NOT NULL ORDER BY id`,
  );

  const checkpoint = await readCheckpoint(CHECKPOINT_KEY);
  // Same falsy-empty-string cursor bug fixed this round in FUND_RETURNS_SYNC — guard explicitly
  // against "" rather than relying on JS truthiness, even though institution ids here are never
  // empty in practice.
  const afterId = checkpoint?.lastSymbol != null && checkpoint.lastSymbol !== "" ? checkpoint.lastSymbol : null;
  const startIndex = afterId ? institutions.findIndex((i) => i.id > afterId) : 0;
  const batch = startIndex === -1 ? [] : institutions.slice(startIndex);

  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "SEC_EDGAR_13F", runKey: `${JOB}:${targetPeriod}:${afterId ?? "start"}`,
    universeCount: institutions.length, batchSize: batch.length, checkpointBefore: checkpoint,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, targetPeriod });

  // 2026-11-13（ChatGPT第三輪審查第7項，使用者核准定案）: 不是只抓「這次目標期間」一次就永遠不管
  // ——13F-HR/A修正申報常常在原始申報送出之後數週到數月才補送。併入這支既有的每日cron本身，每次
  // 都重新檢查「最近兩季」（不新增一支獨立排程）。策略：以最新一次申報為準覆寫顯示數字（新插入
  // 一筆effective_version=true的filing+對應holdings），但舊版本不刪除，只把舊filing列的
  // effective_version改成false，標記為已被取代（歷史紀錄完整保留，含它當初寫入的holdings列）。
  const periods = recentReportingPeriods(new Date());

  let attempted = 0, newFilings = 0, amendmentsApplied = 0, alreadyOnFile = 0, notYetFiled = 0, failed = 0;
  let lastId: string | null = afterId;
  const failures: Array<{ institutionId: string; reason: string }> = [];
  let httpStop = false;

  outer: for (const institution of batch) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) break;
    attempted++;
    lastId = institution.id;
    for (const periodEnd of periods) {
      try {
        const existingEffective = await prisma.$queryRawUnsafe<{ id: string; accession_number: string; version_sequence: number }[]>(
          `SELECT id, accession_number, version_sequence FROM institutional_filings
           WHERE institution_id = $1 AND filing_type = '13F_HR' AND reporting_period_end = $2::date AND effective_version = true
           LIMIT 1`,
          institution.id, periodEnd,
        );
        const priorEffective = existingEffective[0] ?? null;

        const filing = await findLatest13FFiling(institution.cik, periodEnd);
        await sleep(REQUEST_DELAY_MS);
        if (!filing) { if (!priorEffective) notYetFiled++; continue; } // not a failure — may report late, or below the $100M threshold that quarter

        if (priorEffective && priorEffective.accession_number === filing.accessionNumber) { alreadyOnFile++; continue; } // already have this exact filing on file as the effective version

        const infoTableUrl = await findInformationTableUrl(institution.cik, filing.accessionNumber);
        await sleep(REQUEST_DELAY_MS);
        if (!infoTableUrl) { failures.push({ institutionId: institution.id, reason: "NO_INFORMATION_TABLE_FOUND" }); failed++; continue; }

        const xmlResponse = await fetch(infoTableUrl, { headers: { "User-Agent": process.env.SEC_USER_AGENT ?? "SmartFund data platform contact@smartfund.app" } });
        await sleep(REQUEST_DELAY_MS);
        if (!xmlResponse.ok) { failures.push({ institutionId: institution.id, reason: `INFO_TABLE_HTTP_${xmlResponse.status}` }); failed++; continue; }
        const xml = await xmlResponse.text();
        const rows = parseInformationTable(xml);
        if (!rows.length) { failures.push({ institutionId: institution.id, reason: "NO_ROWS_PARSED" }); failed++; continue; }

        const reportedPortfolioValue = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
        const isAmendmentOfExisting = priorEffective != null; // same period already had an effective filing with a DIFFERENT accession -> this is a correction
        const versionSequence = priorEffective ? priorEffective.version_sequence + 1 : 1;

        if (writeEnabled) {
          const filingId = randomUUID();
          const snapshotId = randomUUID();
          await prisma.$transaction(async (tx) => {
            if (priorEffective) {
              // 不刪除舊資料列——只把舊版本標記成「不再是目前顯示版本」，保留成歷史紀錄。
              await tx.$executeRawUnsafe(
                `UPDATE institutional_filings SET effective_version = false, status = 'SUPERSEDED', updated_at = NOW() WHERE id = $1`,
                priorEffective.id,
              );
            }
            await tx.$executeRawUnsafe(
              `INSERT INTO institutional_filings
                 (id, institution_id, filing_type, disclosure_regime, reporting_period_end, filing_date, accession_number,
                  source_document_url, is_amendment, version_sequence, effective_version, status, source, retrieved_at,
                  verification_status, parser_name, parser_version, information_table_url, source_row_count, parsed_row_count,
                  written_row_count, mapped_security_count, unmapped_security_count, reported_portfolio_value, provenance_status,
                  quality_status, created_at, updated_at)
               VALUES ($1, $2, '13F_HR', 'US_13F', $3::date, $4::date, $5,
                       $6, $10, $11, true, 'FILED', 'SEC EDGAR', NOW(),
                       'VERIFIED_OFFICIAL', 'sec-13f-information-table', '2.0.0', $7, $8, $8,
                       $8, 0, $8, $9, 'COMPLETE',
                       'FULL_ROW_COUNT_MATCH', NOW(), NOW())`,
              filingId, institution.id, periodEnd, filing.filingDate, filing.accessionNumber,
              infoTableUrl, infoTableUrl, rows.length, reportedPortfolioValue, isAmendmentOfExisting, versionSequence,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO institutional_portfolio_snapshots
                 (id, institution_id, filing_id, reporting_period_end, position_count, reported_portfolio_value, source,
                  source_url, retrieved_at, verification_status, quality_status, freshness_status, created_at)
               VALUES ($1, $2, $3, $4::date, $5, $6, 'SEC EDGAR 13F', $7, NOW(), 'VERIFIED_OFFICIAL', 'FULL_ROW_COUNT_MATCH', 'CURRENT_FILED', NOW())`,
              snapshotId, institution.id, filingId, periodEnd, rows.length, reportedPortfolioValue, infoTableUrl,
            );
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              // VERIFIED whole-dollar value, not thousands — see the comment on InfoTableRow.value.
              const valueUsd = row.value ?? 0;
              const portfolioWeight = reportedPortfolioValue > 0 ? (row.value ?? 0) / reportedPortfolioValue : null;
              const sourceKey = createHash("sha256").update(`${filing.accessionNumber}|${i}`).digest("hex");
              await tx.$executeRawUnsafe(
                `INSERT INTO institutional_holdings
                   (id, institution_id, institution_name, security_id, report_date, shares, value, source, filing_id,
                    source_key, created_at, updated_at, snapshot_id, canonical_filing_id, issuer_name, title_of_class,
                    cusip, share_or_principal_type, put_call, investment_discretion, other_manager, voting_authority_sole,
                    voting_authority_shared, voting_authority_none, source_row_id, portfolio_weight, verification_status, quality_status)
                 VALUES (gen_random_uuid()::text, $1, $2, NULL, $3::date, $4, $5, 'SEC EDGAR 13F', $6,
                         $7, NOW(), NOW(), $8, $9, $10, $11,
                         $12, $13, $14, $15, $16, $17,
                         $18, $19, $20, $21, 'VERIFIED_OFFICIAL', 'SOURCE_ROW_COMPLETE')`,
                institution.id, institution.displayName, periodEnd, row.shares, valueUsd, filing.accessionNumber,
                sourceKey, snapshotId, filingId, row.nameOfIssuer, row.titleOfClass,
                row.cusip, row.shareOrPrincipalType, row.putCall, row.investmentDiscretion, row.otherManager, row.votingSole,
                row.votingShared, row.votingNone, String(i), portfolioWeight,
              );
              // Queue every cusip for the existing reconciliation process — this route does not
              // duplicate that matching logic, same convention the historical rows already follow
              // (institutional_security_mapping_queue.status defaults to pending-style classification
              // there; NO_SECURITY_RECORD matches what the existing backlog already uses).
              if (row.cusip) {
                await tx.$executeRawUnsafe(
                  `INSERT INTO institutional_security_mapping_queue (id, holding_id, cusip, issuer_name, title_of_class, status, created_at, updated_at)
                   SELECT gen_random_uuid()::text, h.id, $1, $2, $3, 'NO_SECURITY_RECORD', NOW(), NOW()
                   FROM institutional_holdings h WHERE h.filing_id = $4 AND h.source_row_id = $5
                   ON CONFLICT DO NOTHING`,
                  row.cusip, row.nameOfIssuer, row.titleOfClass, filing.accessionNumber, String(i),
                );
              }
            }
          });
        }
        if (isAmendmentOfExisting) amendmentsApplied++; else newFilings++;
      } catch (error) {
        if (error instanceof SecHttpError) {
          failures.push({ institutionId: institution.id, reason: `HTTP_${error.httpStatus}` });
          failed++;
          httpStop = true;
          break outer; // bounded backoff: stop this run on a 403/429/5xx rather than hammering the next institution too
        }
        failures.push({ institutionId: institution.id, reason: String(error).slice(0, 300) });
        failed++;
      }
    }
  }

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: httpStop ? lastId : null, // null = full pass completed this invocation, wrap next time; otherwise resume right where the HTTP stop happened
    processed: attempted, succeeded: newFilings, failed,
  });

  const status = httpStop ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, "SEC_EDGAR_13F", startedMs, {
    status, attempted, completed: newFilings + amendmentsApplied, inserted: newFilings, updated: amendmentsApplied, failed, retryableFailures: 0,
    checkpointAfter: null,
    details: { writeEnabled, targetPeriod, periodsChecked: periods, newFilings, amendmentsApplied, alreadyOnFile, notYetFiled, failed, failures, universeCount: institutions.length },
  });

  return Response.json({ ok: true, job: JOB, runId, status, targetPeriod, periodsChecked: periods, attempted, newFilings, amendmentsApplied, alreadyOnFile, notYetFiled, failed, writeEnabled });
}
