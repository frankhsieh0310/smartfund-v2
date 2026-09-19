// "My investment calendar": confirmed events for the ETF/Fund products a user follows. Every event date
// is a SOURCE date (ex/pay date, holdings report/effective date, document date). Fetch/ingest
// timestamps (retrieved_at, imported_at, created_at) are never read here, rows without a source date
// produce no event, and nothing is inferred (no last-buy-date, no guessed monthly-report day).

import type { PrismaClient } from "@prisma/client";

export type CalendarKind = "ETF" | "FUND";
export type CalendarScope = "PORTFOLIO" | "WATCHLIST";
export type CalendarEventType = "DIVIDEND_EX" | "DIVIDEND_PAY" | "ETF_HOLDINGS_UPDATE" | "FUND_HOLDINGS_UPDATE" | "FUND_REPORT";
export type CalendarItem = { kind: CalendarKind; id: string; scopes: CalendarScope[] };

export type CalendarEvent = {
  date: string; // YYYY-MM-DD, the source event date
  type: CalendarEventType;
  assetType: CalendarKind;
  assetId: string;
  name: string | null;
  ticker: string | null;
  scopes: CalendarScope[];
  amount: number | null; // dividend events only
  currency: string | null; // dividend events only
};

export const MAX_CALENDAR_ITEMS = 60;

export function monthRange(month: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const next = mo === 12 ? { y: y + 1, mo: 1 } : { y, mo: mo + 1 };
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start: `${y}-${pad(mo)}-01`, end: `${next.y}-${pad(next.mo)}-01` };
}

/** items=ETF:<id>:P|W|PW,… (P = in my portfolio, W = on my watchlist) */
export function parseCalendarParams(month: string | null, itemsRaw: string | null): { month: string; items: CalendarItem[] } | { error: string } {
  if (!month || !monthRange(month)) return { error: "INVALID_MONTH — expected YYYY-MM" };
  const items: CalendarItem[] = [];
  for (const part of (itemsRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, id, sc] = part.split(":");
    const kind = (k ?? "").toUpperCase();
    if ((kind !== "ETF" && kind !== "FUND") || !id) return { error: `INVALID_ITEM '${part}' — expected ETF|FUND:<id>:<P|W|PW>` };
    const scopes: CalendarScope[] = [];
    if ((sc ?? "").toUpperCase().includes("P")) scopes.push("PORTFOLIO");
    if ((sc ?? "").toUpperCase().includes("W")) scopes.push("WATCHLIST");
    if (!scopes.length) return { error: `INVALID_SCOPE '${part}' — expected P, W or PW` };
    const existing = items.find((i) => i.kind === kind && i.id === id);
    if (existing) existing.scopes = [...new Set([...existing.scopes, ...scopes])];
    else items.push({ kind, id, scopes });
  }
  if (items.length > MAX_CALENDAR_ITEMS) return { error: `AT_MOST_${MAX_CALENDAR_ITEMS}_ITEMS` };
  return { month, items };
}

const query = (prisma: PrismaClient, sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;
const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export async function buildCalendar(prisma: PrismaClient, month: string, items: CalendarItem[]) {
  const range = monthRange(month)!;
  const etfIds = items.filter((i) => i.kind === "ETF").map((i) => i.id);
  const fundIds = items.filter((i) => i.kind === "FUND").map((i) => i.id);
  const events: CalendarEvent[] = [];

  const profiles = new Map<string, { name: string | null; ticker: string | null }>();
  if (etfIds.length) {
    for (const r of await query(prisma, `SELECT id::text AS id, name, code FROM etfs WHERE id::text = ANY($1::text[])`, [etfIds])) profiles.set(`ETF:${r.id}`, { name: r.name, ticker: r.code });
  }
  if (fundIds.length) {
    for (const r of await query(prisma, `SELECT id::text AS id, name, code FROM funds WHERE id::text = ANY($1::text[])`, [fundIds])) profiles.set(`FUND:${r.id}`, { name: r.name, ticker: r.code });
  }
  const scopesOf = new Map(items.map((i) => [`${i.kind}:${i.id}`, i.scopes]));
  const seen = new Set<string>(); // the same ex/pay date may be reported by two sources (e.g. Yahoo + an official notice): show it once
  const push = (kind: CalendarKind, id: string, type: CalendarEventType, date: string, amount: number | null = null, currency: string | null = null) => {
    const key = `${kind}:${id}`;
    const p = profiles.get(key);
    if (!p || !scopesOf.has(key) || !date) return; // unknown product / not one of the user's products / no source date
    const dedupeKey = `${key}|${type}|${date.slice(0, 10)}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    events.push({ date: date.slice(0, 10), type, assetType: kind, assetId: id, name: p.name, ticker: p.ticker, scopes: scopesOf.get(key)!, amount, currency });
  };

  if (etfIds.length) {
    // dividends: source ex / payment dates only
    for (const r of await query(
      prisma,
      `SELECT etf_id::text AS id, ex_date::text AS ex, payment_date::text AS pay, amount, currency
         FROM etf_distribution_events
        WHERE etf_id::text = ANY($1::text[])
          AND ((ex_date >= $2::date AND ex_date < $3::date) OR (payment_date >= $2::date AND payment_date < $3::date))`,
      [etfIds, range.start, range.end],
    )) {
      if (r.ex && r.ex >= range.start && r.ex < range.end) push("ETF", r.id, "DIVIDEND_EX", r.ex, num(r.amount), r.currency);
      if (r.pay && r.pay >= range.start && r.pay < range.end) push("ETF", r.id, "DIVIDEND_PAY", r.pay, num(r.amount), r.currency);
    }
    // holdings updates: the snapshot's own report/effective/publication DATE — never retrieved_at
    for (const r of await query(
      prisma,
      `SELECT DISTINCT etf_id::text AS id, COALESCE(report_date, effective_date, publication_date::date)::text AS d
         FROM etf_holding_snapshots
        WHERE etf_id::text = ANY($1::text[])
          AND COALESCE(report_date, effective_date, publication_date::date) >= $2::date
          AND COALESCE(report_date, effective_date, publication_date::date) < $3::date`,
      [etfIds, range.start, range.end],
    )) push("ETF", r.id, "ETF_HOLDINGS_UPDATE", r.d);
  }

  if (fundIds.length) {
    for (const r of await query(
      prisma,
      `SELECT fund_id::text AS id, ex_date::text AS ex, pay_date::text AS pay, distribution_amount AS amount, distribution_currency AS currency
         FROM fund_distribution_observations
        WHERE fund_id::text = ANY($1::text[])
          AND ((ex_date >= $2::date AND ex_date < $3::date) OR (pay_date >= $2::date AND pay_date < $3::date))`,
      [fundIds, range.start, range.end],
    )) {
      if (r.ex && r.ex >= range.start && r.ex < range.end) push("FUND", r.id, "DIVIDEND_EX", r.ex, num(r.amount), r.currency);
      if (r.pay && r.pay >= range.start && r.pay < range.end) push("FUND", r.id, "DIVIDEND_PAY", r.pay, num(r.amount), r.currency);
    }
    // holdings as-of dates recorded with the holdings themselves
    for (const r of await query(
      prisma,
      `SELECT DISTINCT fund_id::text AS id, as_of_date::text AS d FROM holdings
        WHERE asset_type = 'FUND' AND fund_id::text = ANY($1::text[]) AND as_of_date >= $2::date AND as_of_date < $3::date`,
      [fundIds, range.start, range.end],
    )) push("FUND", r.id, "FUND_HOLDINGS_UPDATE", r.d);
    // monthly report / factsheet documents that carry their own document date
    for (const r of await query(
      prisma,
      `SELECT DISTINCT fund_id::text AS id, document_date::text AS d FROM fund_documents
        WHERE document_type = 'FACTSHEET' AND document_date IS NOT NULL AND fund_id::text = ANY($1::text[])
          AND document_date >= $2::date AND document_date < $3::date`,
      [fundIds, range.start, range.end],
    )) push("FUND", r.id, "FUND_REPORT", r.d);
  }

  const order: Record<CalendarEventType, number> = { DIVIDEND_EX: 0, DIVIDEND_PAY: 1, ETF_HOLDINGS_UPDATE: 2, FUND_HOLDINGS_UPDATE: 3, FUND_REPORT: 4 };
  events.sort((a, b) => a.date.localeCompare(b.date) || order[a.type] - order[b.type] || (a.name ?? "").localeCompare(b.name ?? ""));
  return { ok: true, month, range: { start: range.start, endExclusive: range.end }, itemCount: items.length, eventCount: events.length, events };
}
