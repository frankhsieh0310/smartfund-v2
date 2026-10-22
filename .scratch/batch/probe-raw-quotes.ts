import { getAuth } from "../../lib/services/dataProviders/yahoo/yahooClient";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

(async () => {
  const auth = await getAuth();
  const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/screener${auth ? `?crumb=${encodeURIComponent(auth.crumb)}` : ""}`, {
    method: "POST",
    headers: { "user-agent": UA, accept: "application/json", "content-type": "application/json", ...(auth ? { cookie: auth.cookie } : {}) },
    body: JSON.stringify({
      size: 25, offset: 0, sortField: "fundnetassets", sortType: "DESC", quoteType: "ETF",
      topOperator: "AND", query: { operator: "AND", operands: [{ operator: "GT", operands: ["fundnetassets", 0] }] },
      userId: "", userIdType: "guid",
    }),
  });
  const j = await r.json();
  const quotes = j?.finance?.result?.[0]?.quotes ?? [];
  for (const q of quotes.slice(0, 25)) {
    console.log(q.symbol, "| exchange=", q.exchange, "| fullExchangeName=", q.fullExchangeName, "| market=", q.market, "| region=", q.region);
  }
})();
