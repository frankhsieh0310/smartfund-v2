const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

// 2026-11-11（使用者核准，國會議員交易下架）: 原本查political_transactions/political_persons
// 回傳美國眾議院Clerk PTR申報資料——因為可能違反5 U.S.C. §13107(c)商業用途限制（使用者已諮詢
// 律師、確認下架這個對外功能），改成固定回傳空資料，不再查詢/計算任何東西。political_transactions
// / political_persons兩張表本身跟既有資料列完全不刪除，只是這支API不再對外提供查詢結果；也沒有
// 抓這份資料的排程（查過整個repo/.github/workflows都找不到congress/political相關的cron，這份
// 資料原本就是一次性腳本寫入的，沒有排程可以停用）。
export async function GET() {
  return Response.json(
    {
      data: {
        latest_disclosures: [], recent_buys: [], recent_sells: [],
        people_covered: 0, transactions_covered: 0, latest_disclosure_date: null,
      },
      meta: { source: "此功能已下架", note: "國會議員交易功能已下架，不再提供資料。" },
    },
    { headers },
  );
}

export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
