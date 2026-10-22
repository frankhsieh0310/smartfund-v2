// Bounded diagnosis only — one ETF (00752), inspecting the FULL raw official JSON row shape (not just
// the 4 fields the adapter currently maps) to see if CTBC's API carries any other field that could
// distinguish the 3 same-named "現金" rows. No DB write, no adapter change yet.
const API_BASE = "https://www.ctbcinvestments.com.tw/API";
const AUTH_SEED = "www.ctbcinvestments.com";

async function main() {
  const authR = await fetch(`${API_BASE}/home/AuthToken?token=${encodeURIComponent(AUTH_SEED)}`, {
    method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ token: AUTH_SEED }),
  });
  const authJ = await authR.json();
  const token = authJ.Data.token;

  const r = await fetch(`${API_BASE}/etf/Buyback?token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ token, FID: "E0001", StartDate: "2026-09-24" }),
  });
  const j = await r.json();
  for (const group of j.Data.Detail) {
    console.log(`=== group Code=${group.Code} Name=${group.Name} ===`);
    console.log(JSON.stringify(group.Data, null, 2));
  }
}
main();
