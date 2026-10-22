import { readFileSync, existsSync } from "node:fs";
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
  for (const c of CANDIDATES) {
    const sym = `USD${c}=X`;
    try {
      const r = await fetchYahooFxSpark([sym]);
      console.log(sym, "ok=", r[0]?.ok, "canonical=", r[0]?.canonicalSymbol, "price=", r[0]?.regularMarketPrice);
    } catch (e) { console.log(sym, "ERROR", e); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
