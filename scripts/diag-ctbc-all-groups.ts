// Bounded diagnosis — CTBC only (36 tickers, the affected issuer), to see every distinct group.Code
// used for non-security (blank code_) rows, and whether cur_ reliably disambiguates same-named rows
// within a group. No DB write, no adapter change yet.
const API_BASE = "https://www.ctbcinvestments.com.tw/API";
const AUTH_SEED = "www.ctbcinvestments.com";

const FID_MAP: Record<string, string> = {
  "00406A": "E0038", "00752": "E0001", "00753L": "E0002", "00772B": "E0003",
  "00773B": "E0004", "00795B": "E0005", "00847B": "E0008", "00848B": "E0009",
  "00849B": "E0010", "00862B": "E0011", "00863B": "E0012", "00864B": "E0013",
  "00882": "E0014", "00884B": "E0016", "00891": "E0017", "00894": "E0018",
  "00896": "E0019", "00902": "E0020", "00912": "E0021", "00917": "E0022",
  "00928": "E0023", "00934": "E0024", "00941": "E0025", "00948B": "E0026",
  "00954": "E0027", "00955": "E0028", "00956": "E0029", "00963": "E0030",
  "00964": "E0031", "009800": "E0032", "009801": "E0033", "009819": "E0037",
  "00981D": "E0035", "009828": "E0039", "00983A": "E0034", "00995A": "E0036",
};

async function main() {
  const groupCodeInfo = new Map<string, Set<string>>(); // group.Code -> set of names seen
  let anyStockOrBondBlankCode = false;
  let anyGroupWithinDuplicateCurCollision: string[] = [];

  for (const [ticker, fid] of Object.entries(FID_MAP)) {
    const authR = await fetch(`${API_BASE}/home/AuthToken?token=${encodeURIComponent(AUTH_SEED)}`, {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ token: AUTH_SEED }),
    });
    const token = (await authR.json()).Data.token;
    const r = await fetch(`${API_BASE}/etf/Buyback?token=${encodeURIComponent(token)}`, {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ token, FID: fid, StartDate: "2026-09-24" }),
    });
    const j = await r.json();
    for (const group of j.Data?.Detail ?? []) {
      if (!groupCodeInfo.has(group.Code)) groupCodeInfo.set(group.Code, new Set());
      groupCodeInfo.get(group.Code)!.add(group.Name);
      for (const row of group.Data ?? []) {
        if ((group.Code === "STOCK" || group.Code === "BOND") && !row.code_) anyStockOrBondBlankCode = true;
      }
      // within this group, check (cur_ + name_) uniqueness
      const seen = new Map<string, number>();
      for (const row of group.Data ?? []) {
        const key = `${row.cur_ ?? ""}|${row.name_ ?? ""}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      const dupWithinCurName = [...seen.entries()].filter(([, c]) => c > 1);
      if (dupWithinCurName.length) anyGroupWithinDuplicateCurCollision.push(`${ticker}/${group.Code}: ${JSON.stringify(dupWithinCurName)}`);
    }
    await new Promise((r2) => setTimeout(r2, 250));
  }

  console.log(JSON.stringify({
    groupCodes: [...groupCodeInfo.entries()].map(([code, names]) => ({ code, names: [...names] })),
    anyStockOrBondBlankCode,
    anyGroupWithinDuplicateCurCollision,
  }, null, 2));
}
main();
