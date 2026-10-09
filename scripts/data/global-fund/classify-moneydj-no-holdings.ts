import { PrismaClient } from "@prisma/client";
import { load } from "cheerio";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const engine = resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if (process.platform === "win32" && !process.env.PRISMA_QUERY_ENGINE_LIBRARY) process.env.PRISMA_QUERY_ENGINE_LIBRARY = engine;
const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const archive = resolve("runtime/global-fund/moneydj-full-extraction/archive");

const rows = await db.$queryRawUnsafe<Array<{ fundId: string; code: string; active: boolean }>>(`
SELECT m.fund_id "fundId",m.moneydj_code code,f.is_active active
FROM fund_mappings m JOIN funds f ON f.id=m.fund_id
WHERE m.moneydj_code IS NOT NULL AND m.moneydj_code<>'1'
  AND coalesce(m.status,'')<>'SECOND_PASS_NORMALIZED_SHARE_CLASS_EXACT'
  AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.fund_id=m.fund_id)
  AND NOT EXISTS (SELECT 1 FROM fund_holdings h WHERE h.fund_id=m.fund_id)
ORDER BY m.fund_id
`);
const files = await readdir(archive);
const byCode = new Map<string, string[]>();
for (const file of files) {
  const code = file.split("-")[0];
  const list = byCode.get(code) ?? [];
  list.push(file);
  byCode.set(code, list);
}
const counts: Record<string, number> = {
  NO_TOP_HOLDINGS_ON_PAGE: 0,
  SOURCE_FORMAT_VARIANT: 0,
  HTTP_ERROR: 0,
  DELISTED_OR_INACTIVE: 0,
  OTHER: 0,
};
const variants: Record<string, number> = { BLANK_WEIGHT_CELLS: 0, NUMERIC_WEIGHT_WITHOUT_PERCENT: 0, MULTI_COLUMN_LAYOUT: 0, OTHER_LAYOUT: 0 };
const samples: Array<{ code: string; variant: string }> = [];
for (const row of rows) {
  if (!row.active) { counts.DELISTED_OR_INACTIVE++; continue; }
  const candidates = byCode.get(row.code) ?? [];
  if (!candidates.length) { counts.HTTP_ERROR++; continue; }
  const html = await readFile(resolve(archive, candidates.sort().at(-1)!), "utf8");
  const $ = load(html);
  const disclosure = $("table").filter((_, element) => $(element).text().includes("投資明細")).first();
  if (!disclosure.length) { counts.NO_TOP_HOLDINGS_ON_PAGE++; continue; }
  const text = disclosure.text().replace(/\s+/g, " ");
  if (!text.includes("資料月份")) { counts.SOURCE_FORMAT_VARIANT++; continue; }
  const parsable = disclosure.find("tr").toArray().some((tr) => {
    const cells = $(tr).children("td").map((_, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
    return cells.length === 2 && /^\d+(?:\.\d+)?%$/.test(cells[1] ?? "");
  });
  if (!parsable) {
    counts.SOURCE_FORMAT_VARIANT++;
    const rows = disclosure.find("tr").toArray().map((tr) => $(tr).children("td").map((_, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get()).filter((cells) => cells.some(Boolean));
    const detail = rows.filter((cells) => cells.length >= 2 && !cells.join(" ").includes("資料月份") && !cells.join(" ").includes("投資名稱"));
    const variant = detail.length && detail.every((cells) => !String(cells.at(-1) ?? "").trim()) ? "BLANK_WEIGHT_CELLS"
      : detail.some((cells) => /^\d+(?:\.\d+)?$/.test(String(cells.at(-1) ?? "").trim())) ? "NUMERIC_WEIGHT_WITHOUT_PERCENT"
      : detail.some((cells) => cells.length > 2) ? "MULTI_COLUMN_LAYOUT" : "OTHER_LAYOUT";
    variants[variant]++;
    if (samples.length < 30) samples.push({ code: row.code, variant });
  }
  else counts.OTHER++;
}
console.log(JSON.stringify({ total: rows.length, ...counts, variants, samples }));
await db.$disconnect();
