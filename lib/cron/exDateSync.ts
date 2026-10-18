// Item 15 data source: officially-announced upcoming ex-dividend/ex-rights dates for ETFs, from
// TWSE's and TPEx's own pre-announcement tables (see lib/ex-date-sync/*.ts for VERIFIED source
// details). Writes to the SEPARATE etf_upcoming_exrights table (not etf_distribution_events --
// see that model's doc comment in prisma/schema.prisma), which
// lib/cron/alertEvaluate.ts's daysToNextExDate() reads from for DAYS_TO_EX_DATE.
import { prisma } from "@/lib/prisma";
import { fetchTwseExRightRows, type TwseExRightRow } from "@/lib/ex-date-sync/twseExRight";
import { fetchTpexExRightRows, type TpexExRightRow } from "@/lib/ex-date-sync/tpexExRight";

export type ExDateSyncResult = {
  twseRows: number; tpexRows: number;
  matchedEtfs: number; unmatchedCodes: string[];
  upserted: number; skippedTbd: number; errors: number;
  // 2026-10-18: per-step timing, added after the route's first production run timed out at 60s
  // with no error (status stuck IN_PROGRESS) and no visibility into which step actually took the
  // time -- see CLAUDE.md's 2026-10-18 entry.
  timingMs: { fetchSourcesMs: number; etfListMs: number; upsertLoopMs: number; totalMs: number };
};

type NormalizedRow = { code: string; exDate: Date; kind: string; cashDividend: number | null; source: string; sourceRecordId: string };

function normalize(twse: TwseExRightRow[], tpex: TpexExRightRow[]): NormalizedRow[] {
  const out: NormalizedRow[] = [];
  for (const r of twse) out.push({ code: r.code, exDate: r.exDate, kind: r.kind, cashDividend: r.cashDividend, source: "TWSE_EXRIGHT_PREPOST", sourceRecordId: `${r.code}:${r.exDate.toISOString().slice(0, 10)}` });
  for (const r of tpex) out.push({ code: r.code, exDate: r.exDate, kind: r.kind, cashDividend: r.cashDividend, source: "TPEX_EXRIGHT_PREPOST", sourceRecordId: `${r.code}:${r.exDate.toISOString().slice(0, 10)}` });
  return out;
}

export async function runExDateSync(writeEnabled: boolean, log: (msg: string) => void = () => {}): Promise<ExDateSyncResult> {
  const t0 = Date.now();
  log(`[exDateSync] fetching TWSE+TPEx sources...`);
  const [twse, tpex] = await Promise.all([fetchTwseExRightRows(), fetchTpexExRightRows()]);
  const fetchSourcesMs = Date.now() - t0;
  log(`[exDateSync] sources fetched in ${fetchSourcesMs}ms (twse=${twse.length} tpex=${tpex.length})`);
  const rows = normalize(twse, tpex);

  const t1 = Date.now();
  const etfs = await prisma.etf.findMany({ where: { isActive: true }, select: { id: true, code: true } });
  const etfListMs = Date.now() - t1;
  log(`[exDateSync] etf list fetched in ${etfListMs}ms (count=${etfs.length})`);
  const etfByCode = new Map(etfs.map((e) => [e.code, e.id]));

  const result: ExDateSyncResult = {
    twseRows: twse.length, tpexRows: tpex.length, matchedEtfs: 0, unmatchedCodes: [], upserted: 0, skippedTbd: 0, errors: 0,
    timingMs: { fetchSourcesMs, etfListMs, upsertLoopMs: 0, totalMs: 0 },
  };
  const seenUnmatched = new Set<string>();

  const t2 = Date.now();
  for (const row of rows) {
    const etfId = etfByCode.get(row.code);
    if (!etfId) {
      if (!seenUnmatched.has(row.code)) { seenUnmatched.add(row.code); result.unmatchedCodes.push(row.code); }
      continue; // not an ETF we track (ordinary stock, or an ETF code we haven't onboarded) -- not an error
    }
    result.matchedEtfs++;
    if (row.cashDividend === null) { result.skippedTbd++; continue; } // honest "amount TBD" -- don't invent a placeholder
    if (!writeEnabled) continue;
    try {
      await prisma.etfUpcomingExRight.upsert({
        where: { etfId_exDate_source: { etfId, exDate: row.exDate, source: row.source } },
        create: { etfId, exDate: row.exDate, kind: row.kind, cashDividend: row.cashDividend, source: row.source, sourceRecordId: row.sourceRecordId },
        update: { kind: row.kind, cashDividend: row.cashDividend, sourceRecordId: row.sourceRecordId },
      });
      result.upserted++;
    } catch {
      result.errors++;
    }
  }
  result.timingMs.upsertLoopMs = Date.now() - t2;
  result.timingMs.totalMs = Date.now() - t0;
  log(`[exDateSync] upsert loop done in ${result.timingMs.upsertLoopMs}ms (matched=${result.matchedEtfs} upserted=${result.upserted} errors=${result.errors}); total=${result.timingMs.totalMs}ms`);
  return result;
}
