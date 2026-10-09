import * as fs from "fs";
const p = process.env.SCAN_OUT_PATH!;
const issuer = process.env.ISSUER!;
const limit = Number(process.env.LIMIT ?? "5");
const j = JSON.parse(fs.readFileSync(p, "utf8"));
const filtered = j.COLLISION_INVENTORY.filter((c: any) => c.issuer === issuer).slice(0, limit);
console.log(JSON.stringify(filtered, null, 2));
