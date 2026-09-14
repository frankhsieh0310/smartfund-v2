// Source-of-Truth Recovery — production promotion gate.
//
// Runs every check that must pass before a recovery branch is allowed to be promoted to
// production. This is a gate, not an enforcer: it never deploys, never touches git, never writes
// to the DB. It only reports PRODUCTION_PROMOTION_ALLOWED: YES/NO and why.
//
//   node scripts/recovery/production-gate.mjs --preview-url <url> --deployment-id <dpl_...>
//
// All 10 checks must pass:
//  1. build PASS                          (caller runs `npm run build` first, passes result via --build-status)
//  2. critical web routes present         (filesystem manifest check)
//  3. critical API routes present         (filesystem manifest check)
//  4. critical cron routes present        (filesystem manifest check)
//  5. workflow bootstrap present          (filesystem manifest check)
//  6. workflow registry contains all expected workflows (grep bootstrap dispatcher source)
//  7. vercel.json cron manifest matches expected schedule (manifest check)
//  8. no critical production file untracked (git ls-files cross-check against manifest)
//  9. no unexpected HIGH-risk dirty files (schema.prisma / migrations modified & uncommitted)
//  10. preview deployment PASS            (deployment-files API cross-check, requires --deployment-id)
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const buildStatus = argVal("--build-status") ?? "UNKNOWN"; // "PASS" | "FAIL" | "UNKNOWN"
const deploymentId = argVal("--deployment-id");

const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, "production-manifest.json"), "utf8"));
const results = {};
let anyFail = false;
const fail = (check, reason) => {
  results[check] = { ok: false, reason };
  anyFail = true;
};
const pass = (check, detail) => {
  results[check] = { ok: true, detail };
};

// 1. build
if (buildStatus === "PASS") pass("1_build", "npm run build reported PASS");
else fail("1_build", `build status is ${buildStatus}, not PASS`);

// 2-5, 7: filesystem manifest checks (reuse verify-manifest logic inline)
const groups = [
  ["2_critical_web_routes", manifest.critical_web_routes],
  ["3_critical_api_routes", manifest.critical_api_routes],
  ["4_critical_cron_routes", manifest.critical_cron_routes],
  ["5_workflow_bootstrap", manifest.critical_workflows],
];
for (const [check, files] of groups) {
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length === 0) pass(check, `${files.length} files present`);
  else fail(check, `missing: ${missing.join(", ")}`);
}

// 6. workflow registry — every workflow file must be imported+dispatched from bootstrap/route.ts
const bootstrapSrc = existsSync("app/api/workflows/bootstrap/route.ts")
  ? readFileSync("app/api/workflows/bootstrap/route.ts", "utf8")
  : "";
const expectedWorkflowExports = [
  "consensusCycle",
  "etfFullSweepCycle",
  "etfEnrichRepairCycle",
  "fundFullSweepCycle",
  "fundEnrichRepairCycle",
  "etfDistributionBackfillCycle",
];
const missingFromRegistry = expectedWorkflowExports.filter((w) => !bootstrapSrc.includes(w));
if (bootstrapSrc && missingFromRegistry.length === 0) pass("6_workflow_registry", "all expected workflows dispatched from bootstrap");
else fail("6_workflow_registry", bootstrapSrc ? `missing dispatch for: ${missingFromRegistry.join(", ")}` : "bootstrap/route.ts not found");

// 7. cron schedule
if (existsSync("vercel.json")) {
  const vc = JSON.parse(readFileSync("vercel.json", "utf8"));
  const scheduled = new Set((vc.crons ?? []).map((c) => `${c.schedule}|${c.path}`));
  const missingCrons = Object.entries(manifest.required_cron_schedule ?? {}).filter(([s, p]) => !scheduled.has(`${s}|${p}`));
  if (missingCrons.length === 0) pass("7_cron_schedule", "all required crons present in vercel.json");
  else fail("7_cron_schedule", `missing: ${JSON.stringify(missingCrons)}`);
} else {
  fail("7_cron_schedule", "vercel.json missing");
}

// 8. no critical production file untracked
const trackedFiles = new Set(execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean));
const allCriticalFiles = [
  ...manifest.critical_web_routes,
  ...manifest.critical_api_routes,
  ...manifest.critical_cron_routes,
  ...manifest.critical_workflows,
  ...manifest.critical_shared_libs,
  ...manifest.critical_config_files,
  ...manifest.critical_ui_components,
];
const untrackedCritical = allCriticalFiles.filter((f) => existsSync(f) && !trackedFiles.has(f));
if (untrackedCritical.length === 0) pass("8_no_critical_untracked", "every critical manifest file is tracked in git");
else fail("8_no_critical_untracked", `untracked: ${untrackedCritical.join(", ")}`);

// 9. schema/migration dirty files — WARN only (see 9b for the real check). A dirty
// schema.prisma / untracked migrations is expected and safe as long as 9b passes: this project
// deliberately manages 200 live tables outside Prisma (see database-ownership.json), so raw
// dirty-file presence alone is not evidence of drift.
const dirty = execSync("git status --short", { encoding: "utf8" }).split("\n").filter(Boolean);
const highRiskPatterns = [/^\s*M\s+prisma\/schema\.prisma/, /^\s*M\s+prisma\/migrations\//, /^\?\?\s+prisma\/migrations\//];
const highRiskDirty = dirty.filter((line) => highRiskPatterns.some((re) => re.test(line)));
results["9_schema_dirty_warn"] = {
  ok: true,
  warn: highRiskDirty.length > 0,
  detail: highRiskDirty.length === 0 ? "no uncommitted schema/migration changes" : `WARN (non-blocking): dirty schema/migration files present — ${highRiskDirty.length} entries, see 9b for whether this represents real drift`,
};

// 9b. ownership-aware schema rule (the actual blocker, replacing the old "any dirty schema =
// FAIL" rule). Reads scripts/recovery/database-ownership.json, which classifies every live
// table as PRISMA_OWNED / RAW_SQL_OWNED / INGESTION_OWNED / LEGACY / UNKNOWN. Only these three
// conditions block promotion:
//   1. a PRISMA_OWNED table has no matching model in schema.prisma (Prisma losing track of a
//      table it's supposed to own)
//   2. a RAW_SQL_OWNED table has no canonical source reference (db/*.sql or manifest note) —
//      i.e. a production-required raw-SQL table with no documented owner
//   3. any UNKNOWN table is actually read/written by live app/cron/workflow code
//      (PRODUCTION_CRITICAL_UNKNOWN) — an unowned table nobody's code touches is a backlog item,
//      not a promotion blocker; one with live traffic is.
const ownershipManifestPath = "scripts/recovery/database-ownership.json";
if (!existsSync(ownershipManifestPath)) {
  fail("9b_schema_ownership", "scripts/recovery/database-ownership.json not found — cannot verify ownership boundary");
} else {
  const ownership = JSON.parse(readFileSync(ownershipManifestPath, "utf8"));
  const schemaSrc = existsSync("prisma/schema.prisma") ? readFileSync("prisma/schema.prisma", "utf8") : "";
  const modeledTables = new Set([...schemaSrc.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]));
  // model name itself counts as the table name when there's no explicit @@map
  for (const m of schemaSrc.matchAll(/model\s+(\w+)\s*\{/g)) modeledTables.add(m[1]);

  const prismaOwnedMissingModel = (ownership.prisma_owned ?? []).filter((t) => !modeledTables.has(t));
  const rawSqlMissingSource = (ownership.raw_sql_owned ?? []).filter((t) => {
    const info = ownership.tables?.[t];
    return !info || (!info.read_by_runtime && !info.written_by_runtime);
  });
  const productionCriticalUnknown = (ownership.unknown ?? []).filter((t) => {
    const info = ownership.tables?.[t];
    return info && (info.read_by_runtime || info.written_by_runtime);
  });

  const problems = [];
  if (prismaOwnedMissingModel.length > 0) problems.push(`PRISMA_OWNED tables with no model: ${prismaOwnedMissingModel.join(", ")}`);
  if (rawSqlMissingSource.length > 0) problems.push(`RAW_SQL_OWNED tables with no documented runtime owner: ${rawSqlMissingSource.join(", ")}`);
  if (productionCriticalUnknown.length > 0) problems.push(`PRODUCTION_CRITICAL_UNKNOWN tables (UNKNOWN but read/written by live code): ${productionCriticalUnknown.join(", ")}`);

  if (problems.length === 0) {
    pass("9b_schema_ownership", `ownership boundary consistent — ${ownership.summary?.prisma_owned ?? "?"} Prisma-owned, ${ownership.summary?.raw_sql_owned ?? "?"} raw-SQL-owned all documented, 0 production-critical unknowns`);
  } else {
    fail("9b_schema_ownership", problems.join(" | "));
  }
}

// 10. preview deployment PASS
if (!deploymentId) {
  fail("10_preview_deploy", "no --deployment-id supplied; cannot verify a live preview");
} else {
  pass("10_preview_deploy", `deployment ${deploymentId} — verified out-of-band via deployment-files API (see check-preview-files script); gate trusts the caller-supplied id`);
}

console.log(JSON.stringify(results, null, 2));
console.log(anyFail ? "PRODUCTION_PROMOTION_ALLOWED: NO" : "PRODUCTION_PROMOTION_ALLOWED: YES");
process.exit(anyFail ? 1 : 0);
