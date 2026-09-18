// MoneyDJ fund disclosed-holdings fetch + persist.
//
// Contract mirror of scripts/data/global-fund/run-fund-moneydj-disclosure.ts. That file is a CLI
// `main()` with no exported parser/service, so the fetch URL, the big5 + cheerio parse (資料月份 +
// two-cell "<name> | <weight>%" rows), the `holdings` upsert conflict target
// (holdings_fund_source_filing_record_key), the `filing_id` / `source_record_id` / `weight_method`
// shapes, and the pg advisory lock key are reproduced here verbatim. KEEP IN SYNC with that file
// (and prefer extracting a shared parser next round — TODO_MASTER_FUND_DEDUP is also still open).

import { load } from "cheerio";
import type { PrismaClient } from "@prisma/client";

// Must match scripts/data/global-fund/run-fund-moneydj-disclosure.ts exactly so cloud + local
// writes share the same dedup key and never double-ingest.
export const MONEYDJ_SOURCE = "MONEYDJ_PUBLIC_DISCLOSURE";
export const MONEYDJ_ADVISORY_LOCK = "smartfund:fund-moneydj-disclosure:v1";

export type DisclosedHolding = { name: string; weight: number };
export type MoneydjDisclosure = {
  url: string;
  date: string; // YYYY-MM-DD (資料月份)
  holdings: DisclosedHolding[];
  scope: "TOP_10_DISCLOSED" | "TOP_5_DISCLOSED" | "OTHER_PARTIAL_DISCLOSURE";
};

export class MoneydjHttpError extends Error {
  readonly httpStatus: number;
  readonly retryAfter: string | null;
  constructor(httpStatus: number, retryAfter: string | null) {
    super(`MONEYDJ_HTTP_${httpStatus}`);
    this.name = "MoneydjHttpError";
    this.httpStatus = httpStatus;
    this.retryAfter = retryAfter;
  }
}

export async function fetchMoneydjDisclosure(moneydjCode: string): Promise<MoneydjDisclosure> {
  const url = `https://www.moneydj.com/funddj/yp/yp013000.djhtm?a=${encodeURIComponent(moneydjCode)}&topc=`;
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 SmartFund Fund Research/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 403 || response.status === 429) {
    throw new MoneydjHttpError(response.status, response.headers.get("retry-after"));
  }
  if (!response.ok) throw new Error(`MONEYDJ_HTTP_${response.status}`);

  const html = new TextDecoder("big5").decode(await response.arrayBuffer());
  const $ = load(html);
  const text = $("body").text();
  const date = text.match(/資料月份：\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]?.replaceAll("/", "-");
  if (!date) throw new Error("MONEYDJ_DISCLOSURE_DATE_MISSING");
  // 2026-09-18 fix: a disclosed holdings date is always a past reporting period, never a future one —
  // confirmed one filing (fund_id 1608ffc8..., 10 rows) previously landed as_of_date=2028-07-31, a
  // 2-year-future value with no plausible source explanation, uncaught because this regex extraction
  // had no sanity bound at all. A small forward buffer covers legitimate month-end publish timing.
  const maxPlausibleDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  if (date > maxPlausibleDate) throw new Error(`MONEYDJ_DISCLOSURE_DATE_IMPLAUSIBLE_FUTURE:${date}`);

  const holdings: DisclosedHolding[] = [];
  $("tr").each((_, row) => {
    const cells = $(row)
      .find("td")
      .map((__, cell) => $(cell).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);
    if (cells.length !== 2) return;
    const weightMatch = cells[1].match(/^(\d+(?:\.\d+)?)%$/);
    if (!weightMatch || cells[0].includes("投資名稱")) return;
    const weight = Number(weightMatch[1]);
    if (cells[0] && Number.isFinite(weight)) holdings.push({ name: cells[0], weight });
  });
  if (!holdings.length) throw new Error("MONEYDJ_DISCLOSED_HOLDINGS_MISSING");

  const scope =
    holdings.length === 10
      ? "TOP_10_DISCLOSED"
      : holdings.length === 5
        ? "TOP_5_DISCLOSED"
        : "OTHER_PARTIAL_DISCLOSURE";
  return { url, date, holdings: holdings.slice(0, 20), scope };
}

/**
 * Idempotent persist of one fund's disclosed holdings. A new 資料月份 => new filing_id => new rows;
 * re-running the same month rewrites identical rows (ON CONFLICT upsert). Never deletes prior data.
 * Returns { rowsPersisted, isNewMonth }.
 */
export async function persistMoneydjDisclosure(
  prisma: PrismaClient,
  input: { fundId: string; shareClassId: string | null; moneydjCode: string; disclosure: MoneydjDisclosure },
): Promise<{ rowsPersisted: number; isNewMonth: boolean }> {
  const { fundId, shareClassId, moneydjCode, disclosure } = input;
  const filingId = `moneydj:${moneydjCode.toLowerCase()}:${disclosure.date}`;

  const priorMonth = await prisma.$queryRawUnsafe<Array<{ max: Date | null }>>(
    `SELECT MAX(as_of_date) AS max FROM holdings WHERE fund_id = $1 AND source = $2`,
    fundId,
    MONEYDJ_SOURCE,
  );
  const priorMax = priorMonth[0]?.max ? new Date(priorMonth[0].max).toISOString().slice(0, 10) : null;
  const isNewMonth = !priorMax || disclosure.date > priorMax;

  await prisma.$transaction(
    async (tx) => {
      const lock = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
        MONEYDJ_ADVISORY_LOCK,
      );
      if (!lock[0]?.locked) throw new Error("MONEYDJ_DISCLOSURE_SINGLE_WRITER_LOCKED");
      for (const [index, holding] of disclosure.holdings.entries()) {
        await tx.$executeRawUnsafe(
          `INSERT INTO holdings
             (id, asset_type, fund_id, share_class_id, as_of_date, rank, holding_name, holding_code,
              weight, security_id, source, source_record_id, filing_id, weight_method, created_at)
           VALUES ($1, 'FUND', $2, $3, $4::date, $5, $6, NULL, $7, NULL, $8, $9, $10, $11, CURRENT_TIMESTAMP)
           ON CONFLICT (fund_id, source, filing_id, source_record_id)
             WHERE fund_id IS NOT NULL AND source IS NOT NULL AND filing_id IS NOT NULL AND source_record_id IS NOT NULL
           DO UPDATE SET rank = EXCLUDED.rank, holding_name = EXCLUDED.holding_name,
                         weight = EXCLUDED.weight, weight_method = EXCLUDED.weight_method`,
          globalThis.crypto.randomUUID(),
          fundId,
          shareClassId,
          disclosure.date,
          index + 1,
          holding.name,
          holding.weight,
          MONEYDJ_SOURCE,
          `${disclosure.date}:${index + 1}:${holding.name}`,
          filingId,
          disclosure.scope,
        );
      }
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  const readback = await prisma.$queryRawUnsafe<Array<{ rows: number }>>(
    `SELECT COUNT(*)::int AS rows FROM holdings WHERE fund_id = $1 AND source = $2 AND filing_id = $3`,
    fundId,
    MONEYDJ_SOURCE,
    filingId,
  );
  const rowsPersisted = Number(readback[0]?.rows ?? 0);
  if (rowsPersisted !== disclosure.holdings.length) throw new Error("MONEYDJ_DISCLOSURE_READBACK_FAILED");
  return { rowsPersisted, isNewMonth };
}
