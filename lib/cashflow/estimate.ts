// Distribution / cash-flow estimate for up to 10 ETF/Fund positions, from REAL distribution history only.
// - Annual estimate = actual distributions in the trailing 12 months × shares. Never one payment × 12,
//   never a hard-coded or projected future payment.
// - The month distribution places each trailing-12M payment in the calendar month of its source date
//   (pay date when the source has it, otherwise ex date). It is "what was actually paid in each month",
//   not a forecast of future pay dates.
// - Frequency is shown only when the product record itself states it; it is never inferred from gaps.
// - Amount mode converts to shares with the latest real price/NAV row; no price → no conversion.

import type { PrismaClient } from "@prisma/client";

export const MAX_CASHFLOW_ITEMS = 10;
export type CashflowKind = "ETF" | "FUND";
export type CashflowMode = "SHARES" | "AMOUNT";
export type CashflowInput = { kind: CashflowKind; id: string; value: number };
export type FrequencyCode = "MONTHLY" | "QUARTERLY" | "SEMI_ANNUAL" | "ANNUAL";

export type DistributionEvent = { exDate: string; payDate: string | null; amountPerUnit: number; currency: string | null; source: string | null };

export type EstimateStatus = "OK" | "NO_DATA" | "ONLY_ONE_RECORD" | "NO_PAYMENT_IN_12M" | "NO_PRICE";

const EXPECTED_PER_YEAR: Record<FrequencyCode, number> = { MONTHLY: 12, QUARTERLY: 4, SEMI_ANNUAL: 2, ANNUAL: 1 };

export function parseCashflowParams(itemsRaw: string | null, modeRaw: string | null): { items: CashflowInput[]; mode: CashflowMode } | { error: string } {
  const mode = (modeRaw ?? "").toUpperCase();
  if (mode !== "SHARES" && mode !== "AMOUNT") return { error: "INVALID_MODE — expected SHARES or AMOUNT" };
  const items: CashflowInput[] = [];
  for (const part of (itemsRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, id, v] = part.split(":");
    const kind = (k ?? "").toUpperCase();
    const value = Number(v);
    if ((kind !== "ETF" && kind !== "FUND") || !id) return { error: `INVALID_ITEM '${part}' — expected ETF|FUND:<id>:<value>` };
    if (!Number.isFinite(value) || value <= 0) return { error: `INVALID_VALUE '${part}' — value must be a positive number` };
    if (items.some((i) => i.kind === kind && i.id === id)) return { error: `DUPLICATE_ITEM '${part}'` };
    items.push({ kind, id, value });
  }
  if (items.length < 1) return { error: "NEED_AT_LEAST_1_ITEM" };
  if (items.length > MAX_CASHFLOW_ITEMS) return { error: `AT_MOST_${MAX_CASHFLOW_ITEMS}_ITEMS` };
  return { items, mode };
}

/** Frequency only from the product's own stated value; anything unrecognised stays unknown. */
export function confirmedFrequency(raw: string | null | undefined): FrequencyCode | null {
  const s = (raw ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (s === "monthly") return "MONTHLY";
  if (s === "quarterly") return "QUARTERLY";
  if (s === "semiannual" || s === "semiannually") return "SEMI_ANNUAL";
  if (s === "annual" || s === "annually" || s === "yearly") return "ANNUAL";
  return null;
}

const round = (n: number, d = 4) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export function trailingWindowStart(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y - 1, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

/** One row per ex-date; an official (non-Yahoo) record wins over a Yahoo one for the same ex-date. */
export function dedupeEvents(events: DistributionEvent[]): DistributionEvent[] {
  const rank = (e: DistributionEvent) => (e.source?.startsWith("YAHOO") ? 0 : 1) + (e.payDate ? 0.5 : 0);
  const byDate = new Map<string, DistributionEvent>();
  for (const e of events) {
    const cur = byDate.get(e.exDate);
    if (!cur || rank(e) > rank(cur)) byDate.set(e.exDate, e);
  }
  return [...byDate.values()].sort((a, b) => a.exDate.localeCompare(b.exDate));
}

export type ItemInput = {
  ref: string;
  kind: CashflowKind;
  id: string;
  name: string | null;
  ticker: string | null;
  currency: string | null;
  frequencyRaw: string | null;
  price: { value: number; date: string | null } | null;
  events: DistributionEvent[];
  value: number; // shares or amount, per mode
};

export function estimateItem(input: ItemInput, mode: CashflowMode, today: string) {
  const events = dedupeEvents(input.events);
  const windowStart = trailingWindowStart(today);
  const inWindow = events.filter((e) => e.exDate > windowStart && e.exDate <= today);
  const frequency = confirmedFrequency(input.frequencyRaw);
  const shares = mode === "SHARES" ? input.value : input.price && input.price.value > 0 ? input.value / input.price.value : null;
  const currency = inWindow[0]?.currency ?? events[events.length - 1]?.currency ?? input.currency;

  let status: EstimateStatus;
  if (events.length === 0) status = "NO_DATA";
  else if (events.length === 1) status = "ONLY_ONE_RECORD";
  else if (inWindow.length === 0) status = "NO_PAYMENT_IN_12M";
  else if (shares == null) status = "NO_PRICE";
  else status = "OK";

  const perUnit12m = inWindow.reduce((s, e) => s + e.amountPerUnit, 0);
  const estimable = status === "OK";
  const annual = estimable ? round(perUnit12m * shares!, 2) : null;

  // calendar-month distribution of the actual trailing-12M payments (source date only)
  const months: Array<{ month: number; amount: number; count: number; dateBasis: Array<"PAY_DATE" | "EX_DATE"> }> = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, amount: 0, count: 0, dateBasis: [] }));
  if (estimable) {
    for (const e of inWindow) {
      const date = e.payDate ?? e.exDate;
      const bucket = months[Number(date.slice(5, 7)) - 1];
      bucket.amount = round(bucket.amount + e.amountPerUnit * shares!, 2);
      bucket.count += 1;
      const basis = e.payDate ? "PAY_DATE" : "EX_DATE";
      if (!bucket.dateBasis.includes(basis)) bucket.dateBasis.push(basis);
    }
  }
  const expected = frequency ? EXPECTED_PER_YEAR[frequency] : null;
  return {
    ref: input.ref,
    assetType: input.kind,
    id: input.id,
    name: input.name,
    ticker: input.ticker,
    currency,
    inputValue: input.value,
    shares: shares == null ? null : round(shares, 4),
    price: input.price,
    frequency, // null = source does not state it
    status,
    historyCount: events.length,
    historyStart: events[0]?.exDate ?? null,
    lastDistributionDate: events[events.length - 1]?.exDate ?? null,
    basis: {
      type: "TRAILING_12M_ACTUAL" as const,
      windowStart,
      windowEnd: today,
      paymentCount: inWindow.length,
      perUnit: round(perUnit12m, 6),
      // fewer records than the stated frequency implies -> the trailing total may be understated
      possiblyIncomplete: estimable && expected != null && inWindow.length < expected,
      expectedCount: expected,
      historyShorterThan12m: events.length > 0 && events[0].exDate > windowStart,
    },
    annualEstimate: annual,
    avgMonthly: annual == null ? null : round(annual / 12, 2),
    months,
  };
}

export type ItemEstimate = ReturnType<typeof estimateItem>;

/** Combines per currency — amounts in different currencies are never added together. */
export function combineEstimates(items: ItemEstimate[]) {
  const byCurrency = new Map<string, { annual: number; months: number[]; contributors: Array<{ ref: string; annual: number }> }>();
  for (const it of items) {
    if (it.annualEstimate == null) continue;
    const cur = it.currency ?? "UNKNOWN";
    const agg = byCurrency.get(cur) ?? { annual: 0, months: Array<number>(12).fill(0), contributors: [] as Array<{ ref: string; annual: number }> };
    agg.annual = round(agg.annual + it.annualEstimate, 2);
    it.months.forEach((m, i) => (agg.months[i] = round(agg.months[i] + m.amount, 2)));
    agg.contributors.push({ ref: it.ref, annual: it.annualEstimate });
    byCurrency.set(cur, agg);
  }
  return [...byCurrency.entries()].map(([currency, a]) => ({
    currency,
    annualEstimate: a.annual,
    avgMonthly: round(a.annual / 12, 2),
    months: a.months.map((amount, i) => ({ month: i + 1, amount })),
    contributions: a.contributors
      .sort((x, y) => y.annual - x.annual)
      .map((c) => ({ ref: c.ref, annual: c.annual, sharePct: a.annual > 0 ? round((c.annual / a.annual) * 100, 2) : 0 })),
  }));
}

const query = (prisma: PrismaClient, sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;
const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

async function loadItem(prisma: PrismaClient, input: CashflowInput): Promise<ItemInput | null> {
  const ref = `${input.kind}:${input.id}`;
  if (input.kind === "ETF") {
    const rows = await query(prisma, `SELECT code, name, currency, distribution_freq AS freq, latest_price, price_updated_at::date::text AS pdate FROM etfs WHERE id::text = $1`, [input.id]);
    const r = rows[0];
    if (!r) return null;
    const hist = (await query(prisma, `SELECT date::text AS d, COALESCE(close, price) AS p FROM etf_history WHERE etf_id::text = $1 AND COALESCE(close, price) IS NOT NULL ORDER BY date DESC LIMIT 1`, [input.id]))[0];
    const price = hist && num(hist.p) ? { value: num(hist.p)!, date: hist.d as string } : num(r.latest_price) ? { value: num(r.latest_price)!, date: (r.pdate as string) ?? null } : null;
    const events = (await query(prisma, `SELECT ex_date::text AS ex, payment_date::text AS pay, amount, currency, source FROM etf_distribution_events WHERE etf_id::text = $1 AND amount IS NOT NULL AND ex_date IS NOT NULL`, [input.id])).map((e) => ({ exDate: e.ex, payDate: e.pay, amountPerUnit: Number(e.amount), currency: e.currency, source: e.source }));
    return { ref, kind: "ETF", id: input.id, name: r.name, ticker: r.code, currency: r.currency, frequencyRaw: r.freq, price, events, value: input.value };
  }
  const rows = await query(prisma, `SELECT code, name, currency, distribution_freq AS freq, latest_nav, latest_nav_date::text AS ndate FROM funds WHERE id::text = $1`, [input.id]);
  const r = rows[0];
  if (!r) return null;
  const price = num(r.latest_nav) ? { value: num(r.latest_nav)!, date: (r.ndate as string) ?? null } : null;
  const events = (await query(prisma, `SELECT ex_date::text AS ex, pay_date::text AS pay, distribution_amount AS amount, distribution_currency AS currency, source FROM fund_distribution_observations WHERE fund_id::text = $1 AND distribution_amount IS NOT NULL AND ex_date IS NOT NULL`, [input.id])).map((e) => ({ exDate: e.ex, payDate: e.pay, amountPerUnit: Number(e.amount), currency: e.currency, source: e.source }));
  return { ref, kind: "FUND", id: input.id, name: r.name, ticker: r.code ?? null, currency: r.currency, frequencyRaw: r.freq, price, events, value: input.value };
}

export async function buildCashflowEstimate(prisma: PrismaClient, inputs: CashflowInput[], mode: CashflowMode, today = new Date().toISOString().slice(0, 10)) {
  const loaded = await Promise.all(inputs.map(async (i) => ({ input: i, item: await loadItem(prisma, i) })));
  const estimates = loaded.flatMap(({ item }) => (item ? [estimateItem(item, mode, today)] : []));
  const notFound = loaded.filter((l) => !l.item).map((l) => `${l.input.kind}:${l.input.id}`);
  return {
    ok: true,
    mode,
    asOf: today,
    itemCount: inputs.length,
    items: estimates,
    notFound,
    totals: combineEstimates(estimates),
    notEstimated: estimates.filter((e) => e.status !== "OK").map((e) => ({ ref: e.ref, ticker: e.ticker, name: e.name, status: e.status })),
  };
}
