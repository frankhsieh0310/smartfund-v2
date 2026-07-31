import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const endpoints = [
  ["historical-ratios", "https://financialmodelingprep.com/stable/ratios?symbol=AAPL"],
  ["income-statement", "https://financialmodelingprep.com/stable/income-statement?symbol=AAPL"],
  ["historical-prices", "https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=AAPL"],
  ["bulk-ratios", "https://financialmodelingprep.com/stable/ratios-bulk"],
] as const;
async function main() {
  const outcomes = [];
  for (const [name, url] of endpoints) {
    const started = Date.now(); const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "SmartFund provider audit contact@smartfund.app" } }); const text = await response.text();
    outcomes.push({ name, url, status: response.status, contentType: response.headers.get("content-type"), elapsedMs: Date.now() - started, sample: text.slice(0, 500), conclusion: response.status === 401 ? "API_KEY_REQUIRED_NO_COVERAGE_MEASURABLE" : response.ok ? "AUTHORIZED_RESPONSE" : "ENDPOINT_ERROR" });
  }
  const report = { generatedAt: new Date().toISOString(), outcomes, commercialLicense: "PENDING_PLAN_SELECTION", price: "PENDING_PLAN_SELECTION", perMinuteLimit: "PENDING_AUTHORIZED_PLAN", delistedCoverage: "NOT_MEASURABLE_WITHOUT_API_KEY", source: "FMP stable API runtime audit" };
  const output = resolve("debug", "financial", "fmp-historical-pe-audit.json"); await mkdir(resolve("debug", "financial"), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: "COMPLETE", output, outcomes }));
}
main();
