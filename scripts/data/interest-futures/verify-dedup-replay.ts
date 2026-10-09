import { readFile } from "node:fs/promises";
import { join } from "node:path";

const path = join(process.cwd(), "runtime", "interest-futures", "data", "OSE_TONA_3M.ndjson");
const rows = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const key = (row) => [row.contractId || `${row.exchange}:${row.contractCode}`, row.observationTimestamp || row.observedAt || row.timestamp, row.observationType || "SETTLEMENT", row.source].join("|");
const canonical = new Map(rows.map((row) => [key(row), row]));
const before = canonical.size;
for (const replayed of rows) canonical.set(key(replayed), replayed);
console.log(JSON.stringify({ entity: "OSE_TONA_3M", sourceRowsReplayed: rows.length, before, after: canonical.size, newDuplicateRows: canonical.size - before, result: canonical.size === before ? "PASS" : "FAIL" }));
