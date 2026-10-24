// 美國公債（2026-10-25，使用者核准定案，取代Railway上的smartfund-bond-us-treasury服務）。
// 不移植Railway那套（spawn子程序＋本機檔案系統durable-archive＋worker-ownership治理，
// 根本不適合Vercel無狀態serverless環境，已經跟使用者說明過）。改用美國財政部官方公開資料：
// 1. 公債拍賣：Treasury FiscalData API（api.fiscaldata.treasury.gov/.../accounting/od/
//    auctions_query）——VERIFIED treasury_auctions這張表既有資料的source欄位本來就是
//    "US_TREASURY_FISCAL_DATA"，schema完全對得上，不需要新表。
// 2. 公債殖利率：Treasury官網自己的每日公債利率CSV（home.treasury.gov/.../
//    daily-treasury-rates.csv），VERIFIED現場抓到2026/10/23最新資料，涵蓋1Mo~30Yr全部年期。
//    寫進既有treasury_fiscal_observations（country='US'的通用財政指標表，本來就有在用），
//    metric_code用"TREASURY_YIELD_<年期>"，不是硬塞進market_master/bond_benchmark_series
//    那條Yahoo-provider的管線（語意不同，不要混）。
// 全部欄位照抄官方數字，不自己計算。
import { prisma } from "@/lib/prisma";

export const AUCTIONS_SOURCE = "US_TREASURY_FISCAL_DATA";
export const YIELD_SOURCE = "US_TREASURY_DAILY_RATES_CSV";

// 2026-10-25（使用者核准，防止猜欄位）: VERIFIED現場抓一筆真實auctions_query回應、列出全部
// 欄位名稱——Treasury的API根本沒有"high_rate"/"direct_bidder_accepted_pct"/
// "indirect_bidder_accepted_pct"這幾個欄位，只有direct_bidder_accepted/indirect_bidder_accepted
// （原始得標金額，不是比例）。我們DB的direct_bidder_pct/indirect_bidder_pct/high_rate這幾欄
// 既有資料本來就是null（查過8/12那筆既有紀錄），不自己拿accepted/total_accepted算百分比
// 去填——維持原本「沒有欄位就是null」的狀態，不補算。
type AuctionRow = {
  record_date: string; cusip: string; security_type: string; security_term: string;
  auction_date: string; issue_date: string; maturity_date: string;
  offering_amt: string | null; total_accepted: string | null;
  high_yield: string | null; bid_to_cover_ratio: string | null;
};

export async function fetchTreasuryAuctions(sinceDate: string): Promise<AuctionRow[]> {
  const url = `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query?filter=auction_date:gte:${sinceDate}&sort=auction_date&page[size]=500`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new Error(`TREASURY_RATE_LIMITED_${res.status}`);
  if (!res.ok) throw new Error(`TREASURY_HTTP_${res.status}`);
  const json = await res.json();
  return (json.data ?? []) as AuctionRow[];
}

export async function syncTreasuryAuctions(writeEnabled: boolean): Promise<{ candidateCount: number; written: number }> {
  const latest = await prisma.$queryRawUnsafe<{ latest: string | null }[]>(
    `SELECT max(auction_date)::text latest FROM treasury_auctions WHERE country = 'US'`,
  );
  const since = latest[0]?.latest ?? "2026-01-01";
  const rows = await fetchTreasuryAuctions(since);
  const usable = rows.filter((r) => r.cusip && r.auction_date && r.issue_date && r.security_type);
  let written = 0;
  if (writeEnabled && usable.length > 0) {
    for (let i = 0; i < usable.length; i += 200) {
      const chunk = usable.slice(i, i + 200);
      const result = await prisma.$executeRawUnsafe(
        `INSERT INTO treasury_auctions
           (id, country, security_type, cusip, auction_date, issue_date, maturity_date, term,
            amount_offered, amount_accepted, high_yield, bid_to_cover,
            currency, source, source_auction_id, created_at, updated_at)
         SELECT gen_random_uuid()::text, 'US', v->>'security_type', v->>'cusip',
                (v->>'auction_date')::date, (v->>'issue_date')::date,
                NULLIF(v->>'maturity_date','null')::date,
                v->>'security_term',
                NULLIF(v->>'offering_amt','null')::numeric, NULLIF(v->>'total_accepted','null')::numeric,
                NULLIF(v->>'high_yield','null')::numeric,
                NULLIF(v->>'bid_to_cover_ratio','null')::numeric,
                'USD', $1, (v->>'cusip')||':'||(v->>'auction_date'), now(), now()
           FROM jsonb_array_elements($2::jsonb) v
         ON CONFLICT (source, source_auction_id) DO UPDATE SET
           amount_accepted = EXCLUDED.amount_accepted, high_yield = EXCLUDED.high_yield,
           bid_to_cover = EXCLUDED.bid_to_cover, updated_at = now()`,
        AUCTIONS_SOURCE, JSON.stringify(chunk),
      );
      written += result;
    }
  }
  return { candidateCount: usable.length, written };
}

const YIELD_TENOR_COLUMNS = ["1 Mo", "1.5 Month", "2 Mo", "3 Mo", "4 Mo", "6 Mo", "1 Yr", "2 Yr", "3 Yr", "5 Yr", "7 Yr", "10 Yr", "20 Yr", "30 Yr"];

export async function fetchTreasuryYieldCsv(year: number): Promise<Array<{ date: string; values: Record<string, number | null> }>> {
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new Error(`TREASURY_RATE_LIMITED_${res.status}`);
  if (!res.ok) throw new Error(`TREASURY_HTTP_${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  const header = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
  const rows: Array<{ date: string; values: Record<string, number | null> }> = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.replace(/"/g, "").trim());
    const [mm, dd, yyyy] = cols[0].split("/");
    if (!mm || !dd || !yyyy) continue;
    const iso = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    const values: Record<string, number | null> = {};
    for (let i = 1; i < header.length; i++) {
      const tenor = header[i];
      if (!YIELD_TENOR_COLUMNS.includes(tenor)) continue;
      const raw = cols[i];
      values[tenor] = raw === "" || raw === "N/A" ? null : Number(raw);
    }
    rows.push({ date: iso, values });
  }
  return rows;
}

function tenorMetricCode(tenor: string): string {
  return `TREASURY_YIELD_${tenor.toUpperCase().replace(/\s+/g, "_")}`;
}

export async function syncTreasuryYieldCurve(writeEnabled: boolean): Promise<{ candidateCount: number; written: number }> {
  const latest = await prisma.$queryRawUnsafe<{ latest: string | null }[]>(
    `SELECT max(observation_date)::text latest FROM treasury_fiscal_observations WHERE country = 'US' AND source = $1`,
    YIELD_SOURCE,
  );
  const currentYear = new Date().getUTCFullYear();
  const rows = await fetchTreasuryYieldCsv(currentYear);
  const sinceDate = latest[0]?.latest ?? "2000-01-01";
  const candidates: Array<{ date: string; tenor: string; value: number }> = [];
  for (const row of rows) {
    if (row.date <= sinceDate.slice(0, 10)) continue;
    for (const tenor of YIELD_TENOR_COLUMNS) {
      const v = row.values[tenor];
      if (v !== null && v !== undefined && Number.isFinite(v)) candidates.push({ date: row.date, tenor, value: v });
    }
  }
  let written = 0;
  if (writeEnabled && candidates.length > 0) {
    for (let i = 0; i < candidates.length; i += 500) {
      const chunk = candidates.slice(i, i + 500);
      const result = await prisma.$executeRawUnsafe(
        `INSERT INTO treasury_fiscal_observations
           (id, country, metric_code, metric_name, official_field, observation_date, value, unit, currency,
            frequency, source, source_record_id, created_at, updated_at, source_url, verification_status, quality_status)
         SELECT gen_random_uuid()::text, 'US', v->>'metricCode', 'US Treasury Par Yield - '||(v->>'tenor'),
                v->>'tenor', (v->>'date')::date, (v->>'value')::numeric, 'PERCENT_PER_ANNUM', 'USD',
                'DAILY', $1, (v->>'date')||':'||(v->>'tenor'), now(), now(),
                'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv',
                'SOURCE_RECORDED', 'PASS'
           FROM jsonb_array_elements($2::jsonb) v
         ON CONFLICT (country, metric_code, observation_date, source) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        YIELD_SOURCE,
        JSON.stringify(chunk.map((c) => ({ date: c.date, tenor: c.tenor, value: c.value, metricCode: tenorMetricCode(c.tenor) }))),
      );
      written += result;
    }
  }
  return { candidateCount: candidates.length, written };
}
