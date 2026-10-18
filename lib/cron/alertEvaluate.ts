// Item 15 (配息提醒) evaluation engine — first real metrics: DIVIDEND_YIELD (ETF/FUND) and
// DAYS_TO_EX_DATE (ETF only). Before this, app/api/alerts/route.ts had full CRUD for
// WatchlistAlertRule but nothing ever read a rule, computed a value, or wrote an occurrence (see
// docs/specs/dividend-reminder-engine-scope.md) — this is that missing evaluator, not a rewrite of
// the existing CRUD/schema, which stays untouched.
//
// Data sources, both real, no invented numbers:
//   DIVIDEND_YIELD: etfs.dividend_yield / funds.dividend_yield_a (same fields the 配息專區 screen
//     and rankings already show).
//   DAYS_TO_EX_DATE: MIN(etf_upcoming_exrights.ex_date) WHERE ex_date >= today for that ETF --
//     officially-announced, not-yet-paid dates from TWSE/TPEx's own pre-announcement tables
//     (lib/cron/exDateSync.ts), not the historical-only etf_distribution_events.
//     Domestic/offshore funds have no forward-looking ex-date source in this schema (checked this
//     round) so FUND does not get DAYS_TO_EX_DATE — not invented, not approximated.
import { prisma } from "@/lib/prisma";
import { createHash } from "node:crypto";

export type AlertCondition = {
  id: string;
  assetId: string | null;
  assetType: string | null;
  metric: string | null;
  operator: string | null;
  threshold: number | null;
  compareMetric: string | null;
};
type RuleParameters = { schemaVersion: number; logic: "AND" | "OR"; conditions: AlertCondition[] };

const SUPPORTED_METRICS = new Set(["DIVIDEND_YIELD", "DAYS_TO_EX_DATE"]);

export type EvaluatedRule = {
  ruleId: string;
  ruleVersionId: string;
  ownerUserId: string;
  assetType: string;
  canonicalAssetId: string | null;
  value: number | null;
  // 2026-10-18 (item 15 follow-up, found while wiring DAYS_TO_EX_DATE back in): the real metric
  // that produced `value`, not a hardcoded placeholder -- a rule evaluating DAYS_TO_EX_DATE must
  // not have its occurrence payload claim "DIVIDEND_YIELD_OR_DAYS_TO_EX_DATE" when it's actually
  // one or the other.
  metric: string | null;
  triggered: boolean;
  skippedReason?: string;
};

function compare(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case "ABOVE": return value > threshold;
    case "BELOW": return value < threshold;
    case "EQUALS": return value === threshold;
    default: return false; // CROSS_ABOVE/CROSS_BELOW/etc. need prior-value history, out of scope for this first pass
  }
}

async function resolveEtf(assetId: string) {
  return prisma.etf.findFirst({
    where: { isActive: true, OR: [{ id: assetId }, { code: { equals: assetId, mode: "insensitive" } }] },
    select: { id: true, dividendYield: true },
  });
}
async function resolveFund(assetId: string) {
  return prisma.fund.findFirst({
    where: { isActive: true, OR: [{ id: assetId }, { code: { equals: assetId, mode: "insensitive" } }] },
    select: { id: true, dividendYieldA: true },
  });
}
async function daysToNextExDate(etfId: string): Promise<number | null> {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  // Reads etf_upcoming_exrights (officially-announced, not-yet-paid dates from TWSE/TPEx's own
  // pre-announcement tables), NOT etf_distribution_events -- see that model's doc comment in
  // prisma/schema.prisma for why the two are kept separate.
  const row = await prisma.etfUpcomingExRight.findFirst({
    where: { etfId, exDate: { gte: today } },
    orderBy: { exDate: "asc" },
    select: { exDate: true },
  });
  if (!row) return null;
  return Math.round((row.exDate.getTime() - today.getTime()) / 86_400_000);
}

async function currentValue(assetType: string, assetId: string, metric: string): Promise<number | null> {
  if (metric === "DIVIDEND_YIELD") {
    if (assetType === "ETF") {
      const etf = await resolveEtf(assetId);
      return etf?.dividendYield != null ? Number(etf.dividendYield) : null;
    }
    if (assetType === "FUND") {
      const fund = await resolveFund(assetId);
      return fund?.dividendYieldA != null ? Number(fund.dividendYieldA) : null;
    }
    return null;
  }
  if (metric === "DAYS_TO_EX_DATE") {
    if (assetType !== "ETF") return null;
    const etf = await resolveEtf(assetId);
    if (!etf) return null;
    return daysToNextExDate(etf.id);
  }
  return null;
}

export function dedupeKey(ruleId: string, ruleVersionId: string, dayIso: string): string {
  return createHash("sha256").update(`${ruleId}:${ruleVersionId}:${dayIso}`).digest("hex");
}

/** Pure per-rule evaluation step (no writes) -- kept separate from the writer so it's unit-testable. */
export async function evaluateRule(rule: {
  id: string; ownerUserId: string; assetType: string; canonicalAssetId: string | null; currentVersionId: string | null;
}, parametersJson: unknown): Promise<EvaluatedRule | null> {
  if (!rule.currentVersionId || !rule.canonicalAssetId) return null;
  const params = parametersJson as RuleParameters | null;
  if (!params || !Array.isArray(params.conditions)) return null;
  const relevant = params.conditions.filter((c) => c.metric && SUPPORTED_METRICS.has(c.metric));
  if (relevant.length === 0) return null;

  const results: { triggered: boolean; value: number | null; metric: string }[] = [];
  for (const c of relevant) {
    if (!c.assetId || !c.assetType || !c.operator || c.threshold === null) { results.push({ triggered: false, value: null, metric: c.metric! }); continue; }
    const value = await currentValue(c.assetType, c.assetId, c.metric!);
    results.push({ triggered: value !== null && compare(value, c.operator, c.threshold), value, metric: c.metric! });
  }
  const logic = params.logic === "OR" ? "OR" : "AND";
  const triggered = logic === "OR" ? results.some((r) => r.triggered) : results.every((r) => r.triggered) && results.length > 0;
  const firstResult = results.find((r) => r.value !== null) ?? null;

  return { ruleId: rule.id, ruleVersionId: rule.currentVersionId, ownerUserId: rule.ownerUserId, assetType: rule.assetType, canonicalAssetId: rule.canonicalAssetId, value: firstResult?.value ?? null, metric: firstResult?.metric ?? null, triggered };
}

export type AlertEvaluateResult = { attempted: number; triggeredNew: number; skippedCooldown: number; errors: number };

export async function runAlertEvaluate(writeEnabled: boolean): Promise<AlertEvaluateResult> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const rules = await prisma.watchlistAlertRule.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, ownerUserId: true, assetType: true, canonicalAssetId: true, currentVersionId: true, cooldownSeconds: true, severity: true, watchlistId: true, watchlistItemId: true },
  });
  const versionIds = rules.map((r) => r.currentVersionId).filter((id): id is string => Boolean(id));
  const versions = versionIds.length ? await prisma.watchlistAlertRuleVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, parameters: true } }) : [];
  const versionById = new Map(versions.map((v) => [v.id, v.parameters]));
  const states = await prisma.watchlistAlertRuleState.findMany({ where: { ruleId: { in: rules.map((r) => r.id) } } });
  const stateByRuleId = new Map(states.map((s) => [s.ruleId, s]));

  const result: AlertEvaluateResult = { attempted: 0, triggeredNew: 0, skippedCooldown: 0, errors: 0 };

  for (const rule of rules) {
    if (!rule.currentVersionId) continue;
    const params = versionById.get(rule.currentVersionId);
    let evaluated: EvaluatedRule | null;
    try {
      evaluated = await evaluateRule(rule, params);
    } catch {
      result.errors++;
      continue;
    }
    if (!evaluated) continue;
    result.attempted++;
    if (!writeEnabled) continue;

    const state = stateByRuleId.get(rule.id);
    if (evaluated.triggered && state?.cooldownUntil && state.cooldownUntil > now) { result.skippedCooldown++; continue; }

    await prisma.watchlistAlertRuleState.upsert({
      where: { ruleId: rule.id },
      create: {
        ruleId: rule.id, ruleVersionId: rule.currentVersionId, lastEvaluatedAt: now,
        lastValue: evaluated.value, currentConditionState: evaluated.triggered ? "TRIGGERED" : "OK",
        lastTriggeredAt: evaluated.triggered ? now : null,
        cooldownUntil: evaluated.triggered && rule.cooldownSeconds > 0 ? new Date(now.getTime() + rule.cooldownSeconds * 1000) : null,
        triggerCount: evaluated.triggered ? 1 : 0,
        evaluationVersion: "alertEvaluate.v1", dataAvailability: evaluated.value !== null ? "AVAILABLE" : "NOT_AVAILABLE",
      },
      update: {
        ruleVersionId: rule.currentVersionId, lastEvaluatedAt: now, lastValue: evaluated.value,
        currentConditionState: evaluated.triggered ? "TRIGGERED" : "OK",
        ...(evaluated.triggered ? { lastTriggeredAt: now, triggerCount: { increment: 1 } } : {}),
        cooldownUntil: evaluated.triggered && rule.cooldownSeconds > 0 ? new Date(now.getTime() + rule.cooldownSeconds * 1000) : null,
        evaluationVersion: "alertEvaluate.v1", dataAvailability: evaluated.value !== null ? "AVAILABLE" : "NOT_AVAILABLE",
      },
    });

    if (!evaluated.triggered) continue;
    const key = dedupeKey(rule.id, rule.currentVersionId, today);
    try {
      await prisma.watchlistAlertOccurrence.create({
        data: {
          ruleId: rule.id, ruleVersionId: rule.currentVersionId, watchlistId: rule.watchlistId, watchlistItemId: rule.watchlistItemId,
          assetType: rule.assetType, canonicalAssetId: rule.canonicalAssetId, triggeredAt: now, triggerType: "THRESHOLD",
          severity: rule.severity ?? "INFO", triggerValue: evaluated.value, thresholdValue: null,
          payload: { metric: evaluated.metric ?? "UNKNOWN", value: evaluated.value },
          source: "alertEvaluate.v1", inputAsOfDate: now, inputObservedAt: now, evaluationAt: now,
          freshnessStatus: "CURRENT", verificationStatus: "VERIFIED", dedupeKey: key, status: "TRIGGERED",
        },
      });
      result.triggeredNew++;
    } catch (e) {
      // unique dedupeKey violation -- already fired today, not an error
      if (!(e instanceof Error && e.message.includes("dedupeKey"))) result.errors++;
    }
  }
  return result;
}
