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
  const secret = process.env.CRON_SECRET;
  if (!secret) { console.error("NO_CRON_SECRET_FOUND"); process.exit(1); }
  const url = process.argv[2];
  const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
  const body = await res.text();
  console.log("STATUS:", res.status);
  console.log("BODY:", body);
}
main().catch((e) => { console.error(e); process.exit(1); });
