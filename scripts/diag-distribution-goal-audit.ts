// READ-ONLY audit — replicates app/api/mobile/etf-distribution-goal/route.ts's exact logic for 3
// named real ETFs, to report actual computed values without modifying any code.
import { Client } from "pg";

type Frequency = "MONTHLY" | "QUARTERLY" | "SEMI_ANNUAL" | "ANNUAL" | "IRREGULAR";
const FREQ_MULTIPLIER: Partial<Record<Frequency, number>> = { MONTHLY: 12, QUARTERLY: 4, SEMI_ANNUAL: 2, ANNUAL: 1 };
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

async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await c.connect();
  const codes = ["0056", "00919", "00878"];
  for (const code of codes) {
    const rows = await c.query(
      `SELECT e.id::text AS etf_id, e.code, e.name, e.currency AS etf_currency, e.latest_price,
              d.ex_date::text AS ex_date, d.amount::float AS amount, d.currency AS dist_currency
         FROM etfs e JOIN etf_distribution_events d ON d.etf_id = e.id
        WHERE e.code = $1 AND e.is_active = true
          AND d.ex_date >= (CURRENT_DATE - INTERVAL '15 months') AND d.amount > 0
        ORDER BY d.ex_date DESC`,
      [code],
    );
    if (!rows.rows.length) { console.log(code, "NO_ROWS"); continue; }
    const meta = rows.rows[0];
    const price = meta.latest_price != null ? Number(meta.latest_price) : null;
    const currency = meta.etf_currency;
    const matching = rows.rows.filter((r: any) => r.dist_currency === currency);
    const todayKey = new Date().toISOString().slice(0, 10);
    const start12 = new Date(); start12.setUTCMonth(start12.getUTCMonth() - 12);
    const start12Key = start12.toISOString().slice(0, 10);
    const trailing12 = matching.filter((r: any) => r.ex_date >= start12Key && r.ex_date <= todayKey);
    const latestEvent = matching[0] ?? null;
    const frequency = inferFrequency(matching.map((r: any) => r.ex_date));

    let yieldPct: number | null = null, isEstimated = false;
    let amount12m = 0, count12m = 0;
    if (trailing12.length > 0) {
      amount12m = trailing12.reduce((s: number, r: any) => s + r.amount, 0);
      count12m = trailing12.length;
      yieldPct = price ? (amount12m / price) * 100 : null;
    } else if (latestEvent) {
      const mult = FREQ_MULTIPLIER[frequency];
      if (mult && price) { yieldPct = ((latestEvent.amount * mult) / price) * 100; isEstimated = true; }
    }

    console.log(JSON.stringify({
      code, name: meta.name, price, currency, count12m, amount12m: amount12m || null,
      latestDistribution: latestEvent?.amount ?? null, latestExDate: latestEvent?.ex_date ?? null,
      frequency, isEstimated, distribution_yield_12m: yieldPct !== null ? Math.round(yieldPct * 100) / 100 : null,
    }, null, 2));
  }
  await c.end();
}
main().catch((e) => console.error("FAILED:", e));
