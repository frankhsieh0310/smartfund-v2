// 2026-10-21（14點任務第7項）: App的投資日曆（src/calendar/service.ts getCalendarEvents）呼叫
// /api/calendar/events，但這個路由從來沒有被建立過，一直回404。這裡用既有、真實的資料建立它。
// VERIFIED：Prisma 的 Distribution model（map="distributions"）目前是0筆的死表，真正的資料在
// etf_distribution_events（ETF，ex_date/payment_date，announcement_date目前全部是NULL，從未
// 填過，所以DIVIDEND_EX_ANNOUNCED沒有真實資料來源可以畫，不捏造）跟
// fund_distribution_observations（FUND，127萬筆，ex_date/pay_date都有真實資料），兩個都用raw
// SQL直接查這兩張既有的表。ETF_HOLDINGS_UPDATE / FUND_HOLDINGS_UPDATE 來自 holdings 表的
// as_of_date（持股資料實際更新到哪一天，不是臆測的「下次更新時間」）。FUND_REPORT（基金月報）
// 目前沒有對應的真實資料來源，同樣不產生假事件。
import { prisma } from '@/lib/prisma';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }

type Scope = 'PORTFOLIO' | 'WATCHLIST';
type Item = { assetType: 'ETF' | 'FUND'; assetId: string; scopes: Scope[] };

function parseItems(raw: string | null): Item[] {
  if (!raw) return [];
  return raw.split(',').filter(Boolean).map((entry) => {
    const [assetType, assetId, scopeChars] = entry.split(':');
    const scopes: Scope[] = [...(scopeChars ?? '')].map((c) => (c === 'P' ? 'PORTFOLIO' : 'WATCHLIST'));
    return { assetType: assetType as 'ETF' | 'FUND', assetId: decodeURIComponent(assetId ?? ''), scopes };
  }).filter((i) => (i.assetType === 'ETF' || i.assetType === 'FUND') && i.assetId);
}

function monthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const month = url.searchParams.get('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return Response.json({ error: 'month must be YYYY-MM' }, { status: 400, headers: corsHeaders });
  const items = parseItems(url.searchParams.get('items'));
  const { start, end } = monthRange(month);

  if (items.length === 0) return Response.json({ ok: true, month, eventCount: 0, events: [] }, { headers: { ...corsHeaders, 'Cache-Control': 'private, max-age=60' } });

  const etfIds = items.filter((i) => i.assetType === 'ETF').map((i) => i.assetId);
  const fundIds = items.filter((i) => i.assetType === 'FUND').map((i) => i.assetId);
  const scopesFor = (assetType: 'ETF' | 'FUND', assetId: string) => items.find((i) => i.assetType === assetType && i.assetId === assetId)?.scopes ?? [];

  const [etfDistributions, fundDistributions, etfHoldings, fundHoldings, etfNames, fundNames] = await Promise.all([
    etfIds.length ? prisma.$queryRawUnsafe<{ etf_id: string; ex_date: Date; payment_date: Date | null; amount: string; currency: string }[]>(
      `SELECT etf_id, ex_date, payment_date, amount, currency FROM etf_distribution_events WHERE etf_id = ANY($1::text[]) AND (ex_date >= $2 AND ex_date < $3 OR payment_date >= $2 AND payment_date < $3)`,
      etfIds, start, end,
    ) : [],
    fundIds.length ? prisma.$queryRawUnsafe<{ fund_id: string; ex_date: Date; pay_date: Date | null; distribution_amount: string; distribution_currency: string }[]>(
      `SELECT fund_id, ex_date, pay_date, distribution_amount, distribution_currency FROM fund_distribution_observations WHERE fund_id = ANY($1::text[]) AND (ex_date >= $2 AND ex_date < $3 OR pay_date >= $2 AND pay_date < $3)`,
      fundIds, start, end,
    ) : [],
    etfIds.length ? prisma.holding.findMany({ where: { assetType: 'ETF', etfId: { in: etfIds }, asOfDate: { gte: start, lt: end } }, select: { etfId: true, asOfDate: true }, distinct: ['etfId', 'asOfDate'] }) : [],
    fundIds.length ? prisma.holding.findMany({ where: { assetType: 'FUND', fundId: { in: fundIds }, asOfDate: { gte: start, lt: end } }, select: { fundId: true, asOfDate: true }, distinct: ['fundId', 'asOfDate'] }) : [],
    etfIds.length ? prisma.etf.findMany({ where: { id: { in: etfIds } }, select: { id: true, code: true, name: true } }) : [],
    fundIds.length ? prisma.fund.findMany({ where: { id: { in: fundIds } }, select: { id: true, code: true, name: true } }) : [],
  ]);
  const etfNameById = new Map(etfNames.map((e) => [e.id, e]));
  const fundNameById = new Map(fundNames.map((f) => [f.id, f]));

  const events: Array<{ date: string; type: string; assetType: 'ETF' | 'FUND'; assetId: string; name: string | null; ticker: string | null; scopes: Scope[]; amount: number | null; currency: string | null }> = [];

  for (const d of etfDistributions) {
    const ref = etfNameById.get(d.etf_id);
    const scopes = scopesFor('ETF', d.etf_id);
    if (!scopes.length) continue;
    if (d.ex_date >= start && d.ex_date < end) events.push({ date: d.ex_date.toISOString().slice(0, 10), type: 'DIVIDEND_EX', assetType: 'ETF', assetId: d.etf_id, name: ref?.name ?? null, ticker: ref?.code ?? null, scopes, amount: Number(d.amount), currency: d.currency });
    if (d.payment_date && d.payment_date >= start && d.payment_date < end) events.push({ date: d.payment_date.toISOString().slice(0, 10), type: 'DIVIDEND_PAY', assetType: 'ETF', assetId: d.etf_id, name: ref?.name ?? null, ticker: ref?.code ?? null, scopes, amount: Number(d.amount), currency: d.currency });
  }
  for (const d of fundDistributions) {
    const ref = fundNameById.get(d.fund_id);
    const scopes = scopesFor('FUND', d.fund_id);
    if (!scopes.length) continue;
    if (d.ex_date >= start && d.ex_date < end) events.push({ date: d.ex_date.toISOString().slice(0, 10), type: 'DIVIDEND_EX', assetType: 'FUND', assetId: d.fund_id, name: ref?.name ?? null, ticker: ref?.code ?? null, scopes, amount: Number(d.distribution_amount), currency: d.distribution_currency });
    if (d.pay_date && d.pay_date >= start && d.pay_date < end) events.push({ date: d.pay_date.toISOString().slice(0, 10), type: 'DIVIDEND_PAY', assetType: 'FUND', assetId: d.fund_id, name: ref?.name ?? null, ticker: ref?.code ?? null, scopes, amount: Number(d.distribution_amount), currency: d.distribution_currency });
  }
  for (const h of etfHoldings) {
    const ref = etfNameById.get(h.etfId!);
    const scopes = scopesFor('ETF', h.etfId!);
    if (scopes.length && h.asOfDate) events.push({ date: h.asOfDate.toISOString().slice(0, 10), type: 'ETF_HOLDINGS_UPDATE', assetType: 'ETF', assetId: h.etfId!, name: ref?.name ?? null, ticker: ref?.code ?? null, scopes, amount: null, currency: null });
  }
  for (const h of fundHoldings) {
    const ref = fundNameById.get(h.fundId!);
    const scopes = scopesFor('FUND', h.fundId!);
    if (scopes.length && h.asOfDate) events.push({ date: h.asOfDate.toISOString().slice(0, 10), type: 'FUND_HOLDINGS_UPDATE', assetType: 'FUND', assetId: h.fundId!, name: ref?.name ?? null, ticker: ref?.code ?? null, scopes, amount: null, currency: null });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  return Response.json({ ok: true, month, eventCount: events.length, events }, { headers: { ...corsHeaders, 'Cache-Control': 'private, max-age=60' } });
}
