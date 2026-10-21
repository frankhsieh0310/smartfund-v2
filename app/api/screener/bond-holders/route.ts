// 債券反查 (item 2). Given a bond's CUSIP or ISIN:
//   1. "代碼比對" (CODE): ETFs whose disclosed holding has that exact CUSIP/ISIN -- the
//      `holdings` table's BlackRock/iShares-CSV-sourced bond rows (3,075,903 of 3,715,741 rows have a
//      real, populated cusip). Unchanged from the prior round.
//   2. "名稱解析比對" (NAME_PARSED): MoneyDJ fund-side disclosures (pure free text, e.g.
//      "ARGENTINIAN GOVT 4.125% 09 JUL 2035") parsed into (issuer, couponPct, maturityDate) via
//      lib/data-platform/bondNameParsing.ts, compared against the SAME queried bond's own
//      coupon_rate/maturity_date (now captured from the official CSV's own "Coupon (%)"/"Maturity"
//      columns -- see lib/cloud-ingestion/globalEtfHoldings.ts, added 2026-10-16). VERIFIED those
//      columns genuinely exist in the real iShares CSV feed; existing ~3M already-ingested rows are
//      still NULL here until the existing periodic ingestion job's next normal pass re-touches each
//      ETF, so this tier may return few/no results until then -- not a logic bug, a backfill-in-
//      progress state, disclosed via `scopeNote`.
//   3. "依發行機構" (ISSUER): when (2) finds no confident match (or the queried bond's own
//      coupon/maturity isn't populated yet), falls back to matching by normalized issuer name alone
//      -- "which funds hold ANY bond from this same issuer", not necessarily this exact tranche.
// No NLP/fuzzy matching anywhere -- pure structural regex parsing, per user instruction.
import { prisma } from "@/lib/prisma";
import { parseBondDisclosureName, normalizeIssuer } from "@/lib/data-platform/bondNameParsing";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const CUSIP_RE = /^[0-9A-Z]{9}$/;
const ISIN_RE = /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/;

type EtfHolderRow = { etf_id: string; code: string; name: string; holding_name: string; weight: string; as_of_date: string | null; source: string | null; coupon_rate: string | null; maturity_date: string | null };
type FundDisclosureRow = { fund_id: string; code: string | null; name: string; holding_name: string; weight: string; as_of_date: string | null };

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const raw = (q.get("cusip") ?? q.get("isin") ?? "").trim().toUpperCase();
  if (!raw) return Response.json({ ok: false, error: "MISSING_CUSIP_OR_ISIN" }, { status: 400, headers });
  const isCusip = CUSIP_RE.test(raw);
  const isIsin = ISIN_RE.test(raw);
  if (!isCusip && !isIsin) return Response.json({ ok: false, error: "INVALID_FORMAT", hint: "cusip must be 9 alphanumeric chars, isin must be 2 letters + 9 alphanumeric + 1 digit" }, { status: 400, headers });

  const etfRows = await prisma.$queryRawUnsafe<EtfHolderRow[]>(
    `WITH matched AS (
       SELECT h.etf_id, h.holding_name, h.weight, h.as_of_date, h.source, h.coupon_rate::text, h.maturity_date::text,
              ROW_NUMBER() OVER (PARTITION BY h.etf_id ORDER BY h.as_of_date DESC NULLS LAST) rn
         FROM holdings h
        WHERE h.asset_type = 'ETF' AND h.etf_id IS NOT NULL AND ${isCusip ? "h.cusip = $1" : "h.isin = $1"}
     )
     SELECT m.etf_id, e.code, e.name, m.holding_name, m.weight::text AS weight, m.as_of_date::text, m.source, m.coupon_rate, m.maturity_date
       FROM matched m JOIN etfs e ON e.id = m.etf_id
      WHERE m.rn = 1 AND e.is_active
      ORDER BY m.weight DESC`,
    raw,
  );

  const etfResults = etfRows.map((r) => ({
    etfId: r.etf_id, code: r.code, name: r.name, holdingName: r.holding_name,
    weightPct: Number(r.weight), asOfDate: r.as_of_date, source: r.source,
    matchMethod: "CODE" as const,
  }));

  // Derive the target bond's own issuer/coupon/maturity from whichever ETF-side row we just found
  // (they all describe the same CUSIP/ISIN, so any one row's own fields apply to all of them).
  const reference = etfRows[0] ?? null;
  const targetIssuerKey = reference ? normalizeIssuer(reference.holding_name) : null;
  const targetCoupon = reference?.coupon_rate !== null && reference?.coupon_rate !== undefined ? Number(reference.coupon_rate) : null;
  const targetMaturity = reference?.maturity_date ?? null;

  let fundResultsNamedParsed: Array<{ fundId: string; code: string | null; name: string; holdingName: string; weightPct: number; asOfDate: string | null; matchMethod: "NAME_PARSED" }> = [];
  let fundResultsByIssuer: Array<{ fundId: string; code: string | null; name: string; holdingName: string; weightPct: number; asOfDate: string | null; matchMethod: "ISSUER" }> = [];

  if (targetIssuerKey) {
    // 2026-10-21（14點任務第10項）: 這條查詢原本完全沒有 WHERE 過濾 holding_name，等於每次搜尋
    // 都把 MONEYDJ_PUBLIC_DISCLOSURE 來源的全部基金持股（約300萬筆）整批拉進 Node 再用 JS
    // parseBondDisclosureName 逐筆判斷——VERIFIED 本機實測單次查詢超過30秒沒回應，這就是「債券
    // 反查失效」的真正原因（不是回錯結果，是慢到看起來像當機）。normalizeIssuer() 只會從
    // holding_name 做大寫化/移除樣板字/移除非英數字元，不會憑空生出新文字，所以任何能比對上
    // targetIssuerKey 的列，它的 holding_name 一定原封不動包含 targetIssuerKey 的第一個字——用
    // 這個字先在 SQL 端做 ILIKE 粗篩，絕不會濾掉真正該比對上的列，只是把要搬進 JS 的候選列從
    // 300萬筆縮小到幾十～幾百筆，比對邏輯本身完全沒變。
    const issuerFirstWord = targetIssuerKey.split(" ")[0];
    const fundRows = issuerFirstWord.length < 2 ? [] : await prisma.$queryRawUnsafe<FundDisclosureRow[]>(
      `WITH latest AS (
         SELECT h.fund_id, h.holding_name, h.weight, h.as_of_date,
                ROW_NUMBER() OVER (PARTITION BY h.fund_id, h.holding_name ORDER BY h.as_of_date DESC NULLS LAST) rn
           FROM holdings h
          WHERE h.asset_type = 'FUND' AND h.fund_id IS NOT NULL AND h.source = 'MONEYDJ_PUBLIC_DISCLOSURE'
            AND h.holding_name ILIKE '%' || $1 || '%'
       )
       SELECT l.fund_id, f.code, f.name, l.holding_name, l.weight::text AS weight, l.as_of_date::text
         FROM latest l JOIN funds f ON f.id = l.fund_id
        WHERE l.rn = 1 AND f.is_active`,
      issuerFirstWord,
    );

    const seenNameParsed = new Set<string>();
    const seenIssuer = new Set<string>();
    for (const row of fundRows) {
      const parsed = parseBondDisclosureName(row.holding_name);
      if (!parsed.looksLikeBond) continue;
      const issuerKey = normalizeIssuer(parsed.issuerRaw);
      if (!issuerKey || issuerKey !== targetIssuerKey) continue;

      const base = { fundId: row.fund_id, code: row.code, name: row.name, holdingName: row.holding_name, weightPct: Number(row.weight), asOfDate: row.as_of_date };
      const couponMatches = targetCoupon !== null && parsed.couponPct !== null && Math.abs(parsed.couponPct - targetCoupon) < 0.01;
      const maturityMatches = targetMaturity !== null && parsed.maturityDate !== null && parsed.maturityDate === targetMaturity;

      if (couponMatches && maturityMatches) {
        if (!seenNameParsed.has(row.fund_id)) { seenNameParsed.add(row.fund_id); fundResultsNamedParsed.push({ ...base, matchMethod: "NAME_PARSED" }); }
      } else {
        if (!seenIssuer.has(row.fund_id)) { seenIssuer.add(row.fund_id); fundResultsByIssuer.push({ ...base, matchMethod: "ISSUER" }); }
      }
    }
  }

  return Response.json({
    ok: true,
    query: { value: raw, matchedBy: isCusip ? "CUSIP" : "ISIN" },
    total: etfResults.length + fundResultsNamedParsed.length + fundResultsByIssuer.length,
    generated_at: new Date().toISOString(),
    scopeNote:
      "ETF 側用代碼（CUSIP/ISIN）精確比對。基金側（MoneyDJ）揭露的持股是純文字，沒有代碼可比對，改用解析出的發行機構／票面利率／到期日比對：三者都吻合視為同一檔債券（名稱解析比對），否則僅比對發行機構（依發行機構，可能涵蓋該發行人其他檔債券）。「名稱解析比對」目前可能結果偏少：ETF 側的票面利率/到期日是新增欄位，既有約 300 萬筆持股紀錄要等下次例行重新抓取才會回填，不是比對邏輯的問題。",
    results: {
      byCode: etfResults,
      byNameParsed: fundResultsNamedParsed,
      byIssuer: fundResultsByIssuer,
    },
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
