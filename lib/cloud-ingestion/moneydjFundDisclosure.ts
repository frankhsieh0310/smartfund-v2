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

// 2026-10-19（使用者核准範圍）: 三種「沒有真正持股資料寫入」的情況必須用不同的錯誤類別區分，
// 不准再全部當同一種「MISSING」籠統排除健康報告異常——只有 genuinely-no-data 這一種才是真的
// 可以不計入異常的「來源無資料」。
//
//   1. MoneydjHoldingsNotDisclosedError：頁面在這支基金自己的「-投資明細」區塊裡，明確顯示
//      「目前無投資明細資料」這段文字——這是 MoneyDJ 官方自己講的「這支基金本來就沒有這份資料」，
//      唯一真正該算「來源無資料、不算異常」的情況。
//   2. MoneydjHoldingsNameOnlyError：頁面有「投資名稱」欄位、確實列出個股/債券名稱，但「比例」
//      欄位整欄是空的（例如只公佈前五/十大個股名稱，不公佈權重）。這不是「沒有資料」，是「有資料
//      但沒有比例」——不准自己估算比例，也不能用舊的 NOT NULL weight 欄位硬塞一個假數字，所以
//      目前仍然不會寫進 holdings 表（需要先把 weight 欄位改成可為 NULL 的 migration，需要另外
//      核准），但要用這個專屬錯誤類別清楚標示「這是已知、可辨識的資料型態，不是解析失敗」，跟
//      下面第 3 類「真的解析不出來」分開看。
//   3. 其餘情況（Error("MONEYDJ_HOLDINGS_PARSE_FAILED")）：頁面上找不到「目前無投資明細資料」
//      這段文字，也抽不出任何一筆持股——代表頁面格式跟現有兩種已知格式都對不上，是真正的解析
//      程式錯誤，一律算異常、列出基金代號。
export class MoneydjHoldingsNotDisclosedError extends Error {
  constructor() {
    super("MONEYDJ_HOLDINGS_NOT_DISCLOSED");
    this.name = "MoneydjHoldingsNotDisclosedError";
  }
}

export class MoneydjHoldingsNameOnlyError extends Error {
  readonly names: string[];
  constructor(names: string[]) {
    super("MONEYDJ_HOLDINGS_NAME_ONLY_NO_WEIGHT");
    this.name = "MoneydjHoldingsNameOnlyError";
    this.names = names;
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

  // Collect holdings rows first, and remember which <table> each one lives in — the disclosure date
  // must come from that SAME table's own text, never from anywhere else on the page. A code MoneyDJ
  // doesn't recognize (e.g. an ISIN passed where it expects its own short fund code) can render a
  // fallback page that still has an unrelated "資料月份：" string elsewhere (nav, footer, an ad), and a
  // whole-body regex has no way to tell that apart from the real one next to the actual holdings.
  //
  // 2026-10-19: MoneyDJ renders holdings in (at least) two different table layouts, and the original
  // code here only handled one of them. Verified live against a 10-fund random sample pulled from 30h
  // of CLOUD_MONEYDJ_FUND MONEYDJ_DISCLOSED_HOLDINGS_MISSING failures: 9 of 10 actually had a real
  // holdings table on the page, wrongly discarded by this parser -- only 1 of 10 (a bond fund) had no
  // holdings table at all (genuinely correct as no-data).
  //   Format A (2 <td> per <tr>, "投資名稱 | 比例"): weight cell is "N.NN%" -- the pre-existing branch
  //   below handles this correctly as-is. A blank/&nbsp; weight cell here (funds that only publish
  //   top 5/10 holding NAMES, no weight at all) is tracked separately as nameOnlyNames, below.
  //   Format B (4 or 8 <td> per <tr>, two side-by-side groups of "投資名稱 | 投資(千股) | 比例 | 增減"):
  //   this is the MORE COMMON real-world layout (confirmed on equity, balanced, and bond-with-named-
  //   issues funds alike). The 比例 (percentage) cell here is a BARE NUMBER with NO "%" suffix (e.g.
  //   "9.49") -- the "%"-suffixed value lives in the separate 增減 (day-change) column, not 比例. Not
  //   handled at all before this fix (cells.length was never 2, so the whole row was skipped).
  // The page has several OTHER tables above the real holdings block (region/industry/category
  // breakdowns) whose rows can accidentally look numeric-shaped too. Scope strictly to the
  // table(s) whose own direct text contains "投資明細" (the "<fund name>-投資明細" caption row) --
  // never scan every <tr> on the whole page, or those earlier tables produce false-positive rows.
  const holdings: DisclosedHolding[] = [];
  const nameOnlyNames: string[] = [];
  const holdingsTables = new Set<ReturnType<typeof $>>();
  // Locate the OUTER wrapper table(s) that actually carry a "<fund name>-投資明細" caption cell --
  // cheerio/htmlparser2 may insert an implicit <tbody>, so walk up from the caption <td> itself
  // (closest("table")) rather than assuming <tr> is a direct child of <table>.
  const captionCandidates = $("td").filter((_, el) => $(el).text().includes("投資明細"));
  const scopedTables = new Set<ReturnType<typeof $>>();
  captionCandidates.each((_, el) => {
    const $table = $(el).closest("table");
    if ($table.length) scopedTables.add($table);
  });
  scopedTables.forEach(($table) => {
    $table.find("tr").each((__, row) => {
      const rawCells = $(row)
        .find("td")
        .map((___, cell) => $(cell).text().replace(/\s+/g, " ").trim())
        .get();

      // Format A: exactly 2 cells, "投資名稱 | N.NN%".
      if (rawCells.length === 2) {
        const [name, pctCell] = rawCells;
        if (!name || name.includes("投資名稱")) return;
        const weightMatch = pctCell.match(/^(\d+(?:\.\d+)?)%$/);
        if (weightMatch) {
          const weight = Number(weightMatch[1]);
          if (Number.isFinite(weight)) {
            holdings.push({ name, weight });
            holdingsTables.add($table);
          }
          return;
        }
        // Name present, weight cell blank/unparseable (not even an unformatted number) -- a known,
        // recognized "names only, no weight disclosed" row shape. Track separately; never fabricate
        // a weight for it.
        if (pctCell === "" || pctCell === " ") nameOnlyNames.push(name);
        return;
      }

      // Format B: repeating 4-cell groups, "投資名稱 | 投資(千股) | 比例(無%) | 增減". Handles both
      // a single group (4 cells, odd fund out at the end) and the common 2-group/8-cell row.
      if (rawCells.length > 0 && rawCells.length % 4 === 0) {
        for (let i = 0; i < rawCells.length; i += 4) {
          const name = rawCells[i];
          const pctCell = rawCells[i + 2];
          if (!name || name.includes("投資名稱")) continue;
          const weightMatch = pctCell.match(/^(\d+(?:\.\d+)?)$/);
          if (!weightMatch) continue;
          const weight = Number(weightMatch[1]);
          if (Number.isFinite(weight)) {
            holdings.push({ name, weight });
            holdingsTables.add($table);
          }
        }
      }
    });
  });
  if (!holdings.length) {
    // Genuinely no data: MoneyDJ's own page says so, inside this fund's own 投資明細 block.
    const explicitlyNoData = [...scopedTables].some(($table) => $table.text().includes("目前無投資明細資料"));
    if (explicitlyNoData) throw new MoneydjHoldingsNotDisclosedError();
    // Known shape, just no weight -- not a parse bug, but nothing valid to persist yet either
    // (holdings.weight is NOT NULL; making it nullable needs a separate, approved schema change).
    if (nameOnlyNames.length) throw new MoneydjHoldingsNameOnlyError(nameOnlyNames);
    // Neither of the above: page format doesn't match anything recognized. A real parser bug.
    throw new Error("MONEYDJ_HOLDINGS_PARSE_FAILED");
  }

  // Date must be found inside one of the tables that actually held a matched row — not the page body.
  let date: string | undefined;
  for (const table of holdingsTables) {
    // The caption is sometimes just outside the <table> tag itself, so also check the immediate
    // parent — still bounded to this specific holdings block, not the whole page.
    const scope = table.text() + " " + table.parent().text();
    const match = scope.match(/資料月份：\s*(\d{4}\/\d{2}\/\d{2})/);
    if (match) { date = match[1].replaceAll("/", "-"); break; }
  }
  // No reliable date found in the holdings table itself: do not fall back to the page body, do not
  // guess, do not use today's fetch date. The caller must treat this as "date unavailable", not
  // persist a fabricated as_of_date.
  if (!date) throw new Error("MONEYDJ_DISCLOSURE_DATE_MISSING");
  if (new Date(date).getTime() > Date.now()) throw new Error(`MONEYDJ_DISCLOSURE_DATE_IMPLAUSIBLE:${date}`);

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
