import { screenerPage, sleep } from "../../lib/yahoo/productSession";

const codes = ["JPX","VSE","TAI","LSE","PCX","MEX","JKT","NAS","NYQ","BTS","ASX","HKG","KSC","KOE","SES","SHH","SHZ","MIL","PAR","GER","AMS","STO","OSL","SAO","TOR","TWO","LIS","VIE","IOB","AQS","BUD","WSE","IST","JNB","TLV","SAU","DOH","DUS","MCE","FRA","IEX","NGM","BUE","MEC"];

(async () => {
  const stats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };
  let sum = 0;
  const nonzero: Record<string, number> = {};
  for (const ex of codes) {
    const r = await screenerPage("ETF", [{ operator: "EQ", operands: ["exchange", ex] }], 0, 1, "fundnetassets", stats);
    if (r.total > 0) { nonzero[ex] = r.total; sum += r.total; }
    await sleep(200);
  }
  console.log(JSON.stringify(nonzero, null, 1));
  console.log("SUM:", sum);
})();
