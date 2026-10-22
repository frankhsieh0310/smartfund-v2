import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function searchYahoo(q, onshore) {
  const query = encodeURIComponent(JSON.stringify({ onshore, q, limit: 3 }));
  const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsSearch;query=${query}?intl=tw&lang=zh-Hant-TW&region=TW&site=finance&device=desktop`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}
// strip trailing risk-disclosure parenthetical (last paren group, often very long disclaimer text)
function stripDisclaimer(name) {
  return name.replace(/[(（][^()（）]*(?:配息|本金|高風險|非投資等級|收益平準金|保證|ESG)[^()（）]*[)）]\s*$/, '').trim();
}
const prevFailed = [
  "安聯新興債券收益組合基金- HB類型(月配息)-新臺幣(避險)(本基金有一定比例之投資包含高風險非投資等級債券基金且配息來源可能為本金)",
  "柏瑞新興動態多重資產基金-N9類型(澳幣)(本基金有相當比重投資於非投資等級之高風險債券)",
  "摩根亞洲總合非投資等級債券基金-月配息型(人民幣)(本基金之配息來源可能為本金)",
  "國泰台灣高股息基金-A不配息(台幣)(本基金並無保證收益及配息)",
  "大華銀四至六年機動到期全球投資等級債券基金-USD A(本子基金有一定比重投資於非投資等級之高風險債券)",
  "野村全球正向效應成長基金-季配S類型新臺幣(本基金配息來源可能為本金且非屬環境、社會及治理相關主題基金)",
  "聯博美國傘型基金之聯博美國成長入息基金-AI類型(人民幣)(本基金配息來源可能為本金且並無保證收益及配息)",
  "富蘭克林華美高科技基金",
  "群益馬拉松基金TISA類型",
  "柏瑞美利堅多重資產收益基金-N9類型(本基金有相當比重投資於非投資等級之高風險債券)",
  "柏瑞利率對策多重資產基金-N9類型(美元)(本基金有相當比重投資於非投資等級之高風險債券)",
  "瀚亞全球非投資等級債券基金S類型-人民幣(本基金配息來源可能為本金)",
  "國泰台灣領袖 50 ETF 基金(本基金之配息來源可能為收益平準金)",
  "富邦台美雙星多重資產基金-NB類型(人民幣)(本基金有相當比重投資於非投資等級之高風險債券且配息來源可能為本金)",
  "聯邦台灣精彩50ETF基金(本基金之配息來源可能為收益平準金)",
  "路博邁全球策略收益債券基金T月配(澳幣)(本基金有一定比重得投資於非投資等級之高風險債券且配息來源可能為本金)",
  "華南永昌永昌基金-TISA類型",
  "東方匯理全球淨零碳排企業債券基金-AD 月配型(人民幣避險)(本基金有一定比重得投資於非投資等級之高風險債券且配息來源可能為本金)",
  "柏瑞ESG量化全球股票收益基金-I類型(美元)",
];
let found = 0;
for (const name of prevFailed) {
  const stripped = stripDisclaimer(name);
  try {
    const r = await searchYahoo(stripped, "1");
    const hit = (r.funds || [])[0];
    console.log(`"${stripped}" -> ${hit ? 'FOUND: ' + hit.name : 'none'} (total=${r.pagination?.resultsTotal ?? 0})`);
    if (hit) found++;
  } catch (e) { console.log(`"${stripped}" -> ERROR ${e.message}`); }
  await sleep(1100);
}
console.log(`\nRetry with disclaimer stripped: ${found}/${prevFailed.length} found`);
await prisma.$disconnect();
