// Bounded diagnosis only — raw official response inspection for the two duplicate "現金" rows found in
// 00860B / 009823. No DB write, no schema change, no full-331 refetch.
const BASE = "https://www.capitalfund.com.tw/CFWeb/api";

async function main() {
  const listR = await fetch(`${BASE}/etf/list`, { method: "POST" });
  const listJ = await listR.json();
  const map = new Map<string, string>(listJ.data.funds.map((f: any) => [f.stockNo, f.fundNo]));

  for (const ticker of ["00860B", "009823"]) {
    const fundId = map.get(ticker);
    const r = await fetch(`${BASE}/etf/buyback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fundId }),
    });
    const j = await r.json();
    console.log(`=== ${ticker} (fundId=${fundId}) raw assets[] ===`);
    console.log(JSON.stringify(j.data.assets, null, 2));
    console.log(`=== ${ticker} raw rps[] (first 3) ===`);
    console.log(JSON.stringify(j.data.rps.slice(0, 3), null, 2));
    await new Promise((res) => setTimeout(res, 400));
  }
}
main();
