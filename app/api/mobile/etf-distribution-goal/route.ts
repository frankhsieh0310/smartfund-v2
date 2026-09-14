// Read-only, public: normalized ETF distribution rows for the 配息目標試算 (DividendGoalPage) feature
// in tw-industry-radar. Reuses etf_distribution_events (populated by lib/yahoo/etfHistory.ts as the
// Yahoo ETF full sweep progresses — no separate table, no schema change). Same product rules as the
// existing Fund calculation in the App: 近12月實際配息優先，缺 12M 資料才 fallback 到「最新一次配息 ×
// 推估年配次數」並標 is_estimated=true；幣別不一致或沒有價格一律不計算，不假裝有結果。
//
// Bounded query: only looks back 15 months (12 for the trailing-yield window + a little headroom for
// frequency inference on annual-payers), not the whole distribution history — see the existing index
// etf_distribution_events_etf_id_ex_date_idx. No vendor/source column is ever returned to the client.

import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

type DistEvent = { ex_date: string; amount: number; currency: string };
type Frequency = "MONTHLY" | "QUARTERLY" | "SEMI_ANNUAL" | "ANNUAL" | "IRREGULAR";
const FREQ_MULTIPLIER: Partial<Record<Frequency, number>> = { MONTHLY: 12, QUARTERLY: 4, SEMI_ANNUAL: 2, ANNUAL: 1 };

// Same bounded-lookback median-gap inference as the Fund side's frequencyForDividends in App.tsx —
// last up to 12 event-to-event gaps, not the fund/ETF name.
function inferFrequency(datesDesc: string[]): Frequency {
  const ts = datesDesc.map((d) => new Date(`${d}T00:00:00Z`).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 2) return "IRREGULAR";
  const gaps = ts.slice(1).map((t, i) => (t - ts[i]) / 86_400_000).slice(-12).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median >= 20 && median <= 45) return "MONTHLY";
  if (median >= 70 && median <= 120) return "QUARTERLY";
  if (median >= 150 && median <= 220) return "SEMI_ANNUAL";
  if (median >= 300 && median <= 430) return "ANNUAL";
  return "IRREGULAR";
}

export async function GET() {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT e.id::text AS etf_id, e.code, e.data_source, e.name, e.name_en, e.currency AS etf_currency,
            e.latest_price, e.price_updated_at::text AS price_date,
            d.ex_date::text AS ex_date, d.amount::float AS amount, d.currency AS dist_currency
       FROM etfs e
       JOIN etf_distribution_events d ON d.etf_id = e.id
      WHERE e.is_active = true AND d.ex_date >= (CURRENT_DATE - INTERVAL '15 months') AND d.amount > 0
      ORDER BY e.id, d.ex_date DESC`,
  )) as Array<{
    etf_id: string; code: string; data_source: string | null; name: string; name_en: string | null;
    etf_currency: string; latest_price: string | number | null; price_date: string | null;
    ex_date: string; amount: number; dist_currency: string;
  }>;

  const byEtf = new Map<string, { meta: (typeof rows)[number]; events: DistEvent[] }>();
  for (const r of rows) {
    if (!byEtf.has(r.etf_id)) byEtf.set(r.etf_id, { meta: r, events: [] });
    byEtf.get(r.etf_id)!.events.push({ ex_date: r.ex_date, amount: r.amount, currency: r.dist_currency });
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  const start12 = new Date();
  start12.setUTCMonth(start12.getUTCMonth() - 12);
  const start12Key = start12.toISOString().slice(0, 10);

  const assets: Array<Record<string, unknown>> = [];
  for (const { meta, events } of byEtf.values()) {
    const symbol = meta.data_source ?? meta.code;
    const price = meta.latest_price != null ? Number(meta.latest_price) : null;
    const currency = meta.etf_currency;
    // B: distribution currency must match price currency; no FX conversion — mismatched events are
    // simply excluded from the calculation rather than guessed at.
    const matching = events.filter((e) => e.currency === currency); // already ex_date DESC from SQL
    const trailing12 = matching.filter((e) => e.ex_date >= start12Key && e.ex_date <= todayKey);
    const latestEvent = matching[0] ?? null;
    const frequency = inferFrequency(matching.map((e) => e.ex_date));

    if (price == null || !(price > 0)) continue; // B: price <= 0 -> not calculated

    let yieldPct: number | null = null, isEstimated = false, basisDate: string | null = null;
    let amount12m: number | null = null, count12m = 0;
    if (trailing12.length > 0) {
      amount12m = trailing12.reduce((s, e) => s + e.amount, 0);
      count12m = trailing12.length;
      yieldPct = (amount12m / price) * 100;
      isEstimated = false;
      basisDate = latestEvent?.ex_date ?? null;
    } else if (latestEvent) {
      const mult = FREQ_MULTIPLIER[frequency];
      if (mult) {
        yieldPct = ((latestEvent.amount * mult) / price) * 100;
        isEstimated = true;
        basisDate = latestEvent.ex_date;
      }
    }
    if (yieldPct == null) continue; // C/D: no reliable 12M actual and no annualizable fallback -> skip, never fake 0%

    assets.push({
      asset_id: meta.etf_id,
      asset_type: "ETF",
      symbol,
      name: meta.name_en || meta.name,
      currency,
      latest_nav_or_price: price,
      latest_price_date: meta.price_date,
      distribution_yield_12m: Math.round(yieldPct * 100) / 100,
      distribution_amount_12m: isEstimated ? null : amount12m,
      distribution_count_12m: isEstimated ? 0 : count12m,
      latest_distribution_amount: latestEvent?.amount ?? null,
      latest_distribution_date: latestEvent?.ex_date ?? null,
      distribution_frequency: frequency,
      is_estimated: isEstimated,
      data_basis: isEstimated ? "LATEST_DISTRIBUTION_ANNUALIZED" : "TRAILING_12M_ACTUAL",
      // G: ETF has no reliable capital-source field — never borrow the Fund rule; always false/unknown here.
      capital_source_warning: false,
      source_date: basisDate,
    });
  }

  return Response.json({ assets, generated_at: new Date().toISOString() }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
