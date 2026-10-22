// Read-only live validation. No fixtures, ingestion, or writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { prisma } from "../../lib/prisma";
import { getYahooDirectYield } from "../../lib/yahoo/distributionYield";
import { GET as etfGoal } from "../../app/api/mobile/etf-distribution-goal/route";
import { GET as fundGoal } from "../../app/api/mobile/fund-distribution-goal/route";
import { GET as ranking } from "../../app/api/rankings/etf-dividend/route";

async function main() {
  const appPath = process.argv[2];
  assert.ok(appPath, "Pass the existing App.tsx path");
  const a = await (await etfGoal()).json();
  const b = await (await ranking(new Request("http://local/api?limit=500"))).json();
  for (const code of ["0056", "00919", "00878"]) {
    const yahoo = await getYahooDirectYield(`${code}.TW`);
    const f5 = a.assets.find((x: any) => x.symbol === code)?.yahoo_yield_pct;
    const f6 = b.data.find((x: any) => x.code === code)?.yahooYield;
    assert.equal(f5, yahoo); assert.equal(f6, yahoo);
    console.log(JSON.stringify({ code, yahoo, function5: f5, function6: f6 }));
  }
  const c = await (await fundGoal(new Request("http://local/api?limit=5"))).json();
  const d = await (await ranking(new Request("http://local/api?type=fund&limit=5"))).json();
  for (const row of c.assets) {
    const yahoo = await getYahooDirectYield(row.symbol);
    const f6 = d.data.find((x: any) => x.code === row.symbol)?.yahooYield;
    assert.equal(row.yahoo_yield_pct, yahoo);
    if (yahoo != null) assert.equal(f6, yahoo);
    console.log(JSON.stringify({ code: row.symbol, name: row.name, yahoo, function5: row.yahoo_yield_pct, function6: f6 }));
  }
  const app = fs.readFileSync(appPath, "utf8");
  const rowStart = app.indexOf("function yahooAssetToGoalRow(");
  const rowEnd = app.indexOf("function DividendGoalResultCard", rowStart);
  const modeStart = app.indexOf("    const actualFirst =", app.indexOf("function DividendGoalPage("));
  const modeEnd = app.indexOf("    const emptyNote", modeStart);
  assert.ok(rowStart >= 0 && modeStart >= 0 && modeEnd > modeStart);
  const cases = [{ ...a.assets.find((x: any) => x.symbol === "00919"), type: "ETF" }];
  const fund = c.assets.find((x: any) => x.yahoo_yield_pct > 0);
  if (fund) cases.push({ ...fund, type: "基金" });
  for (const asset of cases) {
    const context: any = { asset, principal: 1000000, monthlyTarget: 10000, principalValid: true };
    vm.createContext(context);
    const source = app.slice(rowStart, rowEnd) + "\nconst base=[yahooAssetToGoalRow(asset,asset.type)];\n" + app.slice(modeStart, modeEnd) + "\nglobalThis.results={a:principalResults[0],b:monthlyResults[0],c:bothResults[0]};";
    vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    const r = context.results, pct = asset.yahoo_yield_pct;
    assert.ok(Math.abs(r.a.annual - 1000000 * pct / 100) < 1e-6);
    assert.ok(Math.abs(r.b.requiredPrincipal - 12000000 / pct) < 1e-6);
    assert.equal(r.c.status, pct >= 12 ? "達標" : pct >= 10.8 ? "接近" : "未達標");
    console.log(JSON.stringify({ modeCase: asset.symbol, yield: pct, annual: r.a.annual, monthly: r.a.monthlyAvg, requiredPrincipal: r.b.requiredPrincipal, status: r.c.status, modeA: "PASS", modeB: "PASS", modeC: "PASS" }));
  }
  const goal = app.slice(app.indexOf("function DividendGoalPage("), app.indexOf("type InAppNotif"));
  const rank = app.slice(app.indexOf("function DividendPage("), app.indexOf("// ---- shared Fund + ETF"));
  assert.ok(!/estimateDividendYield|useFundDividendRows|TRAILING_12M_ACTUAL/.test(goal + rank));
  console.log(JSON.stringify({ focused: "PASS", etfCoverage: a.assets.length, fundChecked: c.assets.length, fundWithYield: c.assets.filter((x: any) => x.yahoo_yield_pct != null).length }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
