// 2026-10-19 root-cause fix for the health report's NO_RUN_IN_LAST_24H false positives: VERIFIED
// live that TW_ETF_DAY_CHANGE／YAHOO_COMMODITY_TECHNICAL／INSTITUTIONAL_UPDATE are all weekday/
// time-window-limited schedules (Vercel cron for the first two, Windows Task Scheduler for the
// third, confirmed healthy via `schtasks /query /xml` — Last Result 0, CalendarTrigger Mon-Fri
// 15:00 Taipei). A flat "has anything run in the last 24h" check fires a false alarm whenever the
// health report (itself fixed at 08:30 Taipei / 00:30 UTC) runs before that day's own scheduled
// window, or right after a weekend gap these jobs correctly skip. This registry gives each job its
// REAL schedule so the check can ask "is a run overdue relative to its own trigger", not "did
// anything happen in a generic 24h window".
//
// Deliberately NOT covered here (kept on the existing flat-24h fallback in checks.ts): jobs driven
// by a self-perpetuating Vercel Workflow loop rather than a fixed cron cadence
// (YAHOO_ETF_FULL_SWEEP, YAHOO_FUND_FULL_SWEEP, CLOUD_CONSENSUS_INGEST) and CLOUD_FUND_NAV:SITCA
// (job_id format mismatch already flagged in daily-health-report/route.ts's own comment, unrelated
// to this fix, not attempted today) — a single cron expression can't honestly represent "resumes a
// multi-pass cycle on its own pace", so forcing one in here would just trade one kind of false
// positive for another, less honest one.
export type CronSchedule = { expr: string }; // standard 5-field: minute hour day month dow (UTC)

export const JOB_SCHEDULES: Record<string, CronSchedule[]> = {
  ETF_RETURNS_SYNC: [{ expr: "*/10 * * * *" }],
  ETF_RETURNS_SYNC_TW: [{ expr: "*/15 * * * *" }],
  US_FUND_NAV_SYNC: [{ expr: "*/15 23,0,1,2,3 * * *" }],
  SITCA_NAV_SYNC: [{ expr: "33 * * * *" }],
  OFFSHORE_NAV_SYNC: [{ expr: "*/15 1-3 * * *" }, { expr: "0 4 * * *" }],
  // Windows Task Scheduler (tw-industry-radar's "\1500 Institutional Update"), Mon-Fri 15:00 Taipei
  // = 07:00 UTC. Not a Vercel/GitHub Actions cron -- confirmed live via schtasks /query /xml.
  INSTITUTIONAL_UPDATE: [{ expr: "0 7 * * 1-5" }],
  // 2026-10-19: CLOUD_ETF_PRICE / CLOUD_MONEYDJ_FUND deliberately NOT registered here, even though
  // .github/workflows/cloud-data-ingestion.yml documents them as hourly at fixed minute offsets
  // (:17 / :37). VERIFIED live: CLOUD_ETF_PRICE's real run history shows irregular ~2-5 hour gaps
  // between invocations (not hourly), confirmed by directly querying production_scheduler_runs --
  // this is GitHub Actions' own well-known scheduled-workflow reliability characteristic (delayed/
  // skipped triggers under platform load), not a regression from today's changes. Modeling it as a
  // strict hourly cron here would create a new, noisy false-positive pattern. Left on the existing
  // flat-24h fallback in checks.ts instead -- same treatment as the self-looping workflow jobs below.
  // Worth separate follow-up (checking the GitHub Actions run history directly, possibly tightening
  // or re-triggering the workflow), but out of scope for tonight's fix given the deadline.
  FUND_RETURNS_SYNC: [{ expr: "41 * * * *" }, { expr: "11 * * * *" }],
  TW_ETF_DAY_CHANGE: [{ expr: "*/15 6-8 * * 1-5" }],
  YAHOO_COMMODITY_TECHNICAL: [{ expr: "30 21 * * 1-5" }],
  HOLDINGS_ALT_SOURCE_SYNC: [{ expr: "52 * * * *" }],
  // SEC EDGAR financial incremental (GitHub Actions), daily.
  CLOUD_SEC_FINANCIAL_INCREMENTAL: [{ expr: "0 13 * * *" }],
  TW_PURCHASABLE_CLASSIFY: [{ expr: "0 0 * * *" }],
  MARKET_CLOSE_SYNC_SHADOW: [{ expr: "*/15 * * * *" }],
};

type FieldMatcher = (value: number) => boolean;

function parseField(field: string, min: number, max: number): FieldMatcher {
  if (field === "*") return () => true;
  const options = field.split(",").map((part) => {
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = Number(stepStr);
      const [rangeStart, rangeEnd] = base === "*" ? [min, max] : base.includes("-") ? base.split("-").map(Number) : [Number(base), max];
      return (v: number) => v >= rangeStart && v <= rangeEnd && (v - rangeStart) % step === 0;
    }
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      return (v: number) => v >= start && v <= end;
    }
    const n = Number(part);
    return (v: number) => v === n;
  });
  return (v: number) => options.some((fn) => fn(v));
}

function cronMatches(expr: string, d: Date): boolean {
  const [minuteF, hourF, domF, monthF, dowF] = expr.trim().split(/\s+/);
  const minute = parseField(minuteF, 0, 59);
  const hour = parseField(hourF, 0, 23);
  const dom = parseField(domF, 1, 31);
  const month = parseField(monthF, 1, 12);
  const dow = parseField(dowF, 0, 6);
  return (
    minute(d.getUTCMinutes()) &&
    hour(d.getUTCHours()) &&
    (domF === "*" || dom(d.getUTCDate())) &&
    (monthF === "*" || month(d.getUTCMonth() + 1)) &&
    (dowF === "*" || dow(d.getUTCDay()))
  );
}

/** Steps backward minute-by-minute from `now` (bounded to `lookbackMinutes`) to find the most recent
 * minute matching ANY of the job's cron expressions -- i.e. the last time this job should have
 * fired. Returns null if nothing matched within the lookback window (schedule misconfigured, or job
 * not in the registry -- callers should fall back to the flat 24h check in that case). */
export function lastScheduledOccurrence(jobId: string, now: Date, lookbackMinutes = 7 * 24 * 60): Date | null {
  const schedules = JOB_SCHEDULES[jobId];
  if (!schedules || schedules.length === 0) return null;
  const cursor = new Date(now);
  cursor.setUTCSeconds(0, 0);
  for (let i = 0; i <= lookbackMinutes; i++) {
    if (schedules.some((s) => cronMatches(s.expr, cursor))) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() - 1);
  }
  return null;
}
