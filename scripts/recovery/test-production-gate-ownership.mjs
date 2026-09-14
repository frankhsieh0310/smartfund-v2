import assert from "node:assert/strict";
import { validateDatabaseOwnership } from "./production-gate-ownership.mjs";

function validate(ownership, modeled = [], validSources = []) {
  const valid = new Set(validSources.map(([source, table]) => `${source}|${table}`));
  return validateDatabaseOwnership({
    ownership,
    modeledTables: new Set(modeled),
    sourceFileValid: (source, table) => valid.has(`${source}|${table}`),
  });
}

const clean = (result) => Object.values(result).every((items) => items.length === 0);

assert.equal(clean(validate({ raw_sql_owned: ["events"], tables: { events: { source_files: ["db/events.sql"] } } }, [], [["db/events.sql", "events"]])), true);
assert.deepEqual(validate({ raw_sql_owned: ["events"], tables: { events: { source_files: [] } } }).rawSqlMissingSource, ["events"]);
assert.deepEqual(validate({ raw_sql_owned: ["events"], tables: { events: { source_files: ["db/missing.sql"] } } }).rawSqlMissingSource, ["events"]);
assert.deepEqual(validate({ prisma_owned: ["users"] }).prismaOwnedMissingModel, ["users"]);
assert.deepEqual(validate({ unknown: ["mystery"], tables: { mystery: { read_by_runtime: true } } }).productionCriticalUnknown, ["mystery"]);
assert.equal(clean(validate({ ingestion_owned: ["ingested_only"] })), true);

console.log("GATE_REGRESSION_TEST: PASS");
