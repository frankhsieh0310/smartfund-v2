// Source-of-Truth Recovery — production manifest verifier.
//
// Filesystem mode (build-time, default): confirms every file the manifest lists actually exists on
// disk before/after a build. Catches "this route silently isn't in the tree being deployed" before
// it ever reaches Vercel.
//   node scripts/recovery/verify-manifest.mjs
//
// HTTP mode (preview/production verification): confirms every route actually resolves (not 404) on
// a live deployment.
//   node scripts/recovery/verify-manifest.mjs --http https://smartfund-v2-<preview>.vercel.app
//
// Exit code 0 = every CRITICAL entry present. Exit code 1 = at least one missing — never promote a
// deployment past a non-zero exit here.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, "production-manifest.json"), "utf8"));
const httpIdx = process.argv.indexOf("--http");
const baseUrl = httpIdx >= 0 ? process.argv[httpIdx + 1] : null;

const groups = [
  ["critical_web_routes", manifest.critical_web_routes],
  ["critical_api_routes", manifest.critical_api_routes],
  ["critical_cron_routes", manifest.critical_cron_routes],
  ["critical_workflows", manifest.critical_workflows],
  ["critical_shared_libs", manifest.critical_shared_libs],
  ["critical_config_files", manifest.critical_config_files],
  ["critical_ui_components", manifest.critical_ui_components],
];

function routeFilePathToUrlPath(file) {
  // app/api/foo/[bar]/route.ts -> /api/foo/:bar (probe the static prefix; dynamic segments are
  // reported separately since they need a real id to return non-404).
  let p = file.replace(/^app/, "").replace(/\/route\.ts$/, "").replace(/\/page\.tsx$/, "");
  if (p === "") p = "/";
  return p;
}

async function checkHttp(urlPath) {
  const dynamic = /\[[^\]]+\]/.test(urlPath);
  if (dynamic) return { status: "SKIPPED_DYNAMIC", ok: true };
  try {
    const res = await fetch(new URL(urlPath, baseUrl), { method: "GET", redirect: "manual" });
    const ok = res.status !== 404;
    return { status: res.status, ok };
  } catch (e) {
    return { status: `ERROR:${e.message}`, ok: false };
  }
}

let anyFail = false;
const report = {};

for (const [groupName, files] of groups) {
  if (!files) continue;
  report[groupName] = [];
  for (const f of files) {
    if (!baseUrl) {
      const ok = existsSync(f);
      if (!ok) anyFail = true;
      report[groupName].push({ file: f, ok, mode: "fs" });
    } else {
      const urlPath = routeFilePathToUrlPath(f);
      const result = await checkHttp(urlPath);
      if (!result.ok) anyFail = true;
      report[groupName].push({ file: f, urlPath, ...result, mode: "http" });
    }
  }
}

// Cron schedule presence check (vercel.json itself, not per-route)
let vercelJsonOk = false;
if (existsSync("vercel.json")) {
  const vc = JSON.parse(readFileSync("vercel.json", "utf8"));
  const scheduled = new Set((vc.crons ?? []).map((c) => `${c.schedule}|${c.path}`));
  const requiredEntries = Object.entries(manifest.required_cron_schedule ?? {});
  const missingCrons = requiredEntries.filter(([schedule, p]) => !scheduled.has(`${schedule}|${p}`));
  vercelJsonOk = missingCrons.length === 0;
  report.cron_schedule = { ok: vercelJsonOk, missing: missingCrons };
  if (!vercelJsonOk) anyFail = true;
} else {
  report.cron_schedule = { ok: false, missing: ["vercel.json itself is missing"] };
  anyFail = true;
}

console.log(JSON.stringify(report, null, 2));
console.log(anyFail ? "MANIFEST_CHECK: FAIL" : "MANIFEST_CHECK: PASS");
process.exit(anyFail ? 1 : 0);
