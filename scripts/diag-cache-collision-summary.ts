import * as fs from "fs";
import * as path from "path";
const ROOT = path.resolve(import.meta.dirname, "..");
const p = path.join(process.env.SCAN_OUT_PATH!);
const j = JSON.parse(fs.readFileSync(p, "utf8"));
const byIssuer: Record<string, Set<string>> = {};
const byCodeShape: Record<string, number> = {};
for (const c of j.COLLISION_INVENTORY) {
  (byIssuer[c.issuer] ??= new Set()).add(c.ticker);
  const shape = /^[0-9A-Za-z]{2,10}$/.test(c.securityCode) ? "code-like" : "description-like";
  byCodeShape[shape] = (byCodeShape[shape] ?? 0) + 1;
}
for (const [issuer, set] of Object.entries(byIssuer)) console.log(issuer, set.size, [...set]);
console.log("---shape---", byCodeShape);
