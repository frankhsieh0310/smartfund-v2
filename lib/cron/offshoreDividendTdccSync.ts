// 境外基金配息（2026-10-25，使用者核准定案，取代舊的fundclear來源）: fundclear.com.tw已經回過
// 403，使用者已決定不再修——原本想改用Yahoo，但VERIFIED Yahoo唯一能用的境外基金端點
// （FundServices.fundsPriceHistory）只有淨值歷史，完全沒有配息欄位（lib/offshore-nav-sync/
// navFetch.ts同一個端點，data keys只有closePrices/dates/priceChangePercents/
// relativePriceChangePercents，沒有任何dividend/distribution欄位），Yahoo Finance全球API對
// 這種內部fundId格式(F0...:FO)也查不到（404）——Yahoo這條路走不通，不准硬套。
//
// 改查官方：TDCC(集保結算所)政府資料開放平臺本來就有「Foreign fund dividend information」
// 資料集(data.gov.tw/en/datasets/11642)，CSV直接下載(opendata.tdcc.com.tw/getOD.ashx?id=3-5)，
// 不需要認證、沒有401/403/429問題，資料日期就是當天(VERIFIED 2026-10-25抓到的資料
// 資料日期=20261025)，欄位：基金代碼(ISIN，跟funds.isin直接對應，已驗證)、配息基準日、除息日、
// 配息發放日、配息頻率、可分配淨利益/配息、本金/配息——全部照抄CSV欄位值，不自己算。
import { prisma } from "@/lib/prisma";

const CSV_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=3-5";
export const SOURCE = "TDCC_OPENDATA_OFFSHORE_DIVIDEND";

export type TdccDividendRow = {
  dataDate: string;
  agentName: string;
  issuer: string;
  isin: string;
  fundName: string;
  currency: string;
  recordDate: string | null; // 配息基準日
  exDate: string | null; // 除息日
  amountPerUnit: string; // 單位數(CSV欄位名稱照抄，實際是每單位配息金額)
  payDate: string | null; // 配息發放日
  frequency: string;
  incomeComponent: string; // 可分配淨利益/配息
  returnOfCapitalComponent: string; // 本金/配息
};

function toIsoDate(roc: string | undefined): string | null {
  // TDCC這份CSV的日期欄位是西元YYYYMMDD(跟資料日期欄位格式一致，VERIFIED樣本"20260513"等都是
  // 西元年份，不是民國年)，不是"N/A"就直接轉ISO。
  if (!roc || roc === "N/A" || !/^\d{8}$/.test(roc)) return null;
  return `${roc.slice(0, 4)}-${roc.slice(4, 6)}-${roc.slice(6, 8)}`;
}

export async function fetchTdccOffshoreDividendCsv(): Promise<TdccDividendRow[]> {
  const res = await fetch(CSV_URL, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    throw new Error(`TDCC_RATE_LIMITED_${res.status}`);
  }
  if (!res.ok) throw new Error(`TDCC_HTTP_${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  const rows: TdccDividendRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    if (cols.length < 13) continue;
    rows.push({
      dataDate: cols[0], agentName: cols[1], issuer: cols[2], isin: cols[3], fundName: cols[4],
      currency: cols[5], recordDate: toIsoDate(cols[6]), exDate: toIsoDate(cols[7]),
      amountPerUnit: cols[8], payDate: toIsoDate(cols[9]), frequency: cols[10],
      incomeComponent: cols[11], returnOfCapitalComponent: cols[12],
    });
  }
  return rows;
}

export type SyncResult = { candidateCount: number; written: number; skippedNoFundMatch: number; skippedNoExDate: number };

export async function syncOffshoreDividendsFromTdcc(writeEnabled: boolean): Promise<SyncResult> {
  const rows = await fetchTdccOffshoreDividendCsv();
  const funds = await prisma.$queryRawUnsafe<{ id: string; isin: string }[]>(
    `SELECT id, isin FROM funds WHERE data_provider = 'tdcc-offshore' AND is_active AND isin IS NOT NULL`,
  );
  const isinToFundId = new Map(funds.map((f) => [f.isin, f.id]));

  let written = 0, skippedNoFundMatch = 0, skippedNoExDate = 0;
  const candidates: Array<{ fundId: string; row: TdccDividendRow }> = [];
  for (const row of rows) {
    const fundId = isinToFundId.get(row.isin);
    if (!fundId) { skippedNoFundMatch++; continue; }
    if (!row.exDate) { skippedNoExDate++; continue; }
    const amount = Number(row.amountPerUnit);
    if (!Number.isFinite(amount) || amount <= 0) { skippedNoExDate++; continue; }
    candidates.push({ fundId, row });
  }

  if (writeEnabled) {
    for (let i = 0; i < candidates.length; i += 500) {
      const chunk = candidates.slice(i, i + 500);
      const values = chunk.map((c) => ({
        fundId: c.fundId, exDate: c.row.exDate, recordDate: c.row.recordDate, payDate: c.row.payDate,
        amount: Number(c.row.amountPerUnit), currency: c.row.currency, frequency: c.row.frequency,
        incomeComponent: c.row.incomeComponent === "N/A" ? null : Number(c.row.incomeComponent),
        returnOfCapital: c.row.returnOfCapitalComponent === "N/A" ? null : Number(c.row.returnOfCapitalComponent),
      }));
      const result = await prisma.$executeRawUnsafe(
        `INSERT INTO fund_distribution_observations
           (id, fund_id, ex_date, record_date, pay_date, distribution_amount, distribution_currency,
            distribution_type, income_component, return_of_capital, source, created_at, updated_at)
         SELECT gen_random_uuid()::text, v->>'fundId', (v->>'exDate')::date,
                (v->>'recordDate')::date, (v->>'payDate')::date, (v->>'amount')::numeric, v->>'currency',
                v->>'frequency', (v->>'incomeComponent')::numeric, (v->>'returnOfCapital')::numeric,
                $1, now(), now()
           FROM jsonb_array_elements($2::jsonb) v
         ON CONFLICT (fund_id, share_class_id, ex_date, source, distribution_amount) DO UPDATE SET
           record_date = EXCLUDED.record_date, pay_date = EXCLUDED.pay_date,
           income_component = EXCLUDED.income_component, return_of_capital = EXCLUDED.return_of_capital,
           updated_at = now()`,
        SOURCE, JSON.stringify(values),
      );
      written += result;
    }
  }

  return { candidateCount: candidates.length, written, skippedNoFundMatch, skippedNoExDate };
}
