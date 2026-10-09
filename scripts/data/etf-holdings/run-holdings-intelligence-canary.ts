import { runHoldingsIntelligence } from "./holdings-intelligence.ts";

runHoldingsIntelligence({ canaryCode: process.argv.find(value => value.startsWith("--etf="))?.slice(6) || "IVV" })
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error); process.exitCode = 1; });
