import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "runtime", "etf-holdings", "coverage", "etf-coverage-matrix.json");
const value = JSON.parse(await fs.readFile(file, "utf8"));
for (const row of value.rows) {
  const representative = ["IVV", "IWM", "AGG"].includes(row.code);
  const hasHoldings = Number(row.holdingCount) > 0;
  const dates = Number(row.distinctEffectiveDates);
  Object.assign(row, {
    IDENTITY_STATE: "READY",
    CURRENT_HOLDINGS_STATE: hasHoldings ? "READY" : "SOURCE_CONSTRAINED",
    PIT_STATE: dates >= 2 ? "READY" : hasHoldings ? "TIME_DEPTH_CONSTRAINED" : "SOURCE_CONSTRAINED",
    PROVENANCE_STATE: representative ? "READY" : "SOURCE_CONSTRAINED",
    MAPPING_STATE: representative ? (row.code === "AGG" ? "READY" : "MAPPING_CONSTRAINED") : "NOT_APPLICABLE",
    SOURCE_STATE: representative ? "READY" : "SOURCE_CONSTRAINED",
    SCHEMA_STATE: "CONFIGURATION_CONSTRAINED",
    DETAIL_STATE: representative ? "CONFIGURATION_CONSTRAINED" : "SOURCE_CONSTRAINED",
  });
}
value.generatedAt = new Date().toISOString();
const temporary = `${file}.${process.pid}.tmp`;
await fs.writeFile(temporary, JSON.stringify(value, null, 2));
await fs.rename(temporary, file);
const fields = ["IDENTITY_STATE", "CURRENT_HOLDINGS_STATE", "PIT_STATE", "PROVENANCE_STATE", "MAPPING_STATE", "SOURCE_STATE", "SCHEMA_STATE", "DETAIL_STATE"];
const allowed = new Set(["READY", "SOURCE_CONSTRAINED", "LICENSE_CONSTRAINED", "ACCESS_CONSTRAINED", "TIME_DEPTH_CONSTRAINED", "MAPPING_CONSTRAINED", "CONFIGURATION_CONSTRAINED", "NOT_APPLICABLE", "NOT_READY"]);
const unknown = value.rows.reduce((n: number, row: any) => n + fields.filter(field => !allowed.has(row[field])).length, 0);
const sample = [...value.rows].sort((a, b) => createHash("sha256").update(a.etfId).digest("hex").localeCompare(createHash("sha256").update(b.etfId).digest("hex"))).slice(0, 10);
console.log(JSON.stringify({ rows: value.rows.length, unknown, sample: sample.map(row => ({ code: row.code, states: fields.map(field => row[field]) })) }));
