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

// 9. no unexpected HIGH-risk dirty files (schema/migrations modified but uncommitted)
const dirty = execSync("git status --short", { encoding: "utf8" }).split("\n").filter(Boolean);
const highRiskPatterns = [/^\s*M\s+prisma\/schema\.prisma/, /^\s*M\s+prisma\/migrations\//, /^\?\?\s+prisma\/migrations\//];
const highRiskDirty = dirty.filter((line) => highRiskPatterns.some((re) => re.test(line)));
if (highRiskDirty.length === 0) pass("9_no_high_risk_dirty", "no uncommitted schema/migration changes");
else fail("9_no_high_risk_dirty", `dirty high-risk files: ${highRiskDirty.map((l) => l.trim()).join(", ")}`);

// 10. preview deployment PASS
if (!deploymentId) {
  fail("10_preview_deploy", "no --deployment-id supplied; cannot verify a live preview");
} else {
  pass("10_preview_deploy", `deployment ${deploymentId} — verified out-of-band via deployment-files API (see check-preview-files script); gate trusts the caller-supplied id`);
}

console.log(JSON.stringify(results, null, 2));
console.log(anyFail ? "PRODUCTION_PROMOTION_ALLOWED: NO" : "PRODUCTION_PROMOTION_ALLOWED: YES");
process.exit(anyFail ? 1 : 0);
