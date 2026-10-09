// READ-ONLY verification: reuses the EXISTING fetchMoneydjEtfHoldings (lib/cloud-ingestion/moneydjEtfHoldings.ts)
// unmodified, against the 40 confirmed Taiwan active ETFs. No new scraper, no retry system, no writes.
import { fetchMoneydjEtfHoldings, MoneydjEtfHttpError, buildMoneydjEtfId } from "../lib/cloud-ingestion/moneydjEtfHoldings";

const ETFS: Array<{ code: string; exchange: "TWSE" | "TPEx" }> = [
  ...["00980A","00982A","00981A","00983A","00984A","00985A","00986A","00982D","00983D","00989A",
      "00988A","00991A","00990A","00987A","00992A","00994A","00995A","00993A","00984D","00996A",
      "00400A","00401A","00997A","00999A","00403A","00402A","00404A","00405A","00406A","00407A",
      "00408A","00410A","00409A"].map((code) => ({ code, exchange: "TWSE" as const })),
  ...["00411A","00980D","00981D","00985D","00986D","00987D","00998A"].map((code) => ({ code, exchange: "TPEx" as const })),
];

async function runOnce(label: string) {
  const results: any[] = [];
  for (const { code, exchange } of ETFS) {
    const t0 = Date.now();
    try {
      const data = await fetchMoneydjEtfHoldings({ code, exchange, dataSource: null });
      const secs = (Date.now() - t0) / 1000;
      results.push({
        code, httpStatus: 200, fetchSuccess: true,
        dataDate: data.holdingsDate, holdingRows: data.holdings.length,
        hasCode: data.holdings.some((h) => h.rawSymbol), hasName: data.holdings.every((h) => h.securityName),
        hasShares: data.holdings.some((h) => h.shares != null), hasWeight: data.holdings.every((h) => h.weight != null),
        fullPortfolio: data.holdings.length > 10, fetchSeconds: secs,
      });
    } catch (e: any) {
      const secs = (Date.now() - t0) / 1000;
      const status = e instanceof MoneydjEtfHttpError ? e.httpStatus : (e.message === "HOLDINGS_UNAVAILABLE" ? "PARSER_FAILURE" : "ERROR");
      results.push({ code, httpStatus: status, fetchSuccess: false, error: e.message, fetchSeconds: secs });
    }
    await new Promise((r) => setTimeout(r, 300)); // polite spacing, not a retry system
  }
  console.log(`=== ${label} ===`);
  console.log(JSON.stringify(results));
  return results;
}

async function main() {
  const run1 = await runOnce("RUN1");
  const run2 = await runOnce("RUN2");
  console.log("=== SUMMARY ===");
  console.log(JSON.stringify({
    run1Pass: run1.filter((r) => r.fetchSuccess).length,
    run2Pass: run2.filter((r) => r.fetchSuccess).length,
    fullPortfolioPass: run1.filter((r) => r.fullPortfolio).length,
    sharesPass: run1.filter((r) => r.hasShares).length,
    weightPass: run1.filter((r) => r.hasWeight).length,
    count403: run1.filter((r) => r.httpStatus === 403).length + run2.filter((r) => r.httpStatus === 403).length,
    count429: run1.filter((r) => r.httpStatus === 429).length + run2.filter((r) => r.httpStatus === 429).length,
    countParserFailure: run1.filter((r) => r.httpStatus === "PARSER_FAILURE").length + run2.filter((r) => r.httpStatus === "PARSER_FAILURE").length,
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
