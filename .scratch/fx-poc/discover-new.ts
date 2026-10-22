import { readFileSync, existsSync, writeFileSync } from "node:fs";
for (const file of [".env", ".env.local"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const key = m[1]; let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
async function main() {
  const { fetchYahooFxSpark } = await import("../../lib/services/dataProviders/yahoo/yahooClient");
  const CANDIDATES = ["ILS","RUB","ARS","CLP","COP","PEN","PKR","BDT","LKR","EGP","KWD","BHD","OMR","JOD","MAD","NGN","KES","RON","BGN","ISK","UAH","DOP","CRC","VES"];
  const symbols = CANDIDATES.map(c => `USD${c}=X`);
  const r = await fetchYahooFxSpark(symbols);
  for (const x of r) console.log(x.requestedSymbol, "ok=", x.ok, "canonical=", x.canonicalSymbol, "price=", x.regularMarketPrice, "currency=", x.currency);
  writeFileSync(".scratch/fx-poc/discover-new-result.json", JSON.stringify(r, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
